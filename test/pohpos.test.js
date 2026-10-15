// Phases 1, 2, 4, 5: Proof of History, slots/epochs/leader schedule, open staking, slashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain, devnetKeys, MemoryStorage, epochOf } from '../src/chain/blockchain.js';
import { PohRecorder, verifyPoh, pohSeed } from '../src/chain/poh.js';
import { voteDigest } from '../src/chain/staking.js';
import { signTx, txHash } from '../src/chain/tx.js';
import { schnorrSign } from '../src/crypto/secp256k1.js';
import { Wallet } from '../src/wallet/wallet.js';
import { UNIT, SLOTS_PER_EPOCH, TICKS_PER_SLOT, LEADER_SLOTS, MIN_VALIDATOR_STAKE, UNBONDING_EPOCHS, SLASH_BPS, REPORTER_REWARD_BPS } from '../src/chain/params.js';

async function setup() {
  const keys = devnetKeys('pohpos-test');
  const chain = await new Blockchain({ keys, storage: new MemoryStorage() }).init();
  const fund = (w, vox) => chain.submitTx(signTx({ type: 'transfer', from: keys.faucet.pubHex, to: w.address, amount: (BigInt(vox) * UNIT).toString(), fee: '10000', nonce: chain.pending.account(keys.faucet.address).nonce }, keys.faucet.secret));
  const nonce = (w) => chain.pending.account(w.address).nonce;
  return { keys, chain, fund, nonce };
}

// Build (not commit) a block as the leader of the next local slot, for tamper tests.
function nextBlock(chain, keys, txs = []) {
  for (const tx of txs) chain.submitTx(tx);
  const prev = chain.tip;
  for (let gap = 1; gap < 64; gap++) {
    const leader = chain.leaderFor(prev.slot + gap);
    const key = keys.validators.find((v) => v.pubHex === leader.pub);
    const rec = new PohRecorder(prev.pohEnd);
    if (gap > 1) rec.tick((gap - 1) * TICKS_PER_SLOT);
    return { block: chain.buildBlock(prev.slot + gap, key, rec), gap, key };
  }
}

test('phase 1: PoH chain verifies, and any tampering is detected', () => {
  const rec = new PohRecorder(pohSeed('x'));
  rec.tick(3);
  const tx = 'ab'.repeat(32);
  const seg = rec.segment([tx]);
  const v = verifyPoh(pohSeed('x'), seg.entries);
  assert.equal(v.ticks, 3);
  assert.equal(v.end, seg.end);
  assert.deepEqual(v.mixins, [tx]);
  assert.equal(rec.end, seg.entries[0].h, 'segment() leaves the live recorder untouched');
  const bad = structuredClone(seg.entries); bad[0].t = 2; // claim fewer ticks
  assert.throws(() => verifyPoh(pohSeed('x'), bad), /mismatch/);
  const bad2 = structuredClone(seg.entries); bad2[1].m = 'cd'.repeat(32); // swap the mixed-in tx
  assert.throws(() => verifyPoh(pohSeed('x'), bad2), /mismatch/);
  assert.throws(() => verifyPoh(pohSeed('y'), seg.entries), /mismatch/, 'must continue from the parent hash');
  assert.throws(() => verifyPoh(pohSeed('x'), seg.entries, { maxTicks: 2 }), /too long/);
});

test('phase 1-2: blocks must carry valid PoH, prove skipped slots, and come from the slot leader', async () => {
  const { keys, chain, fund } = await setup();
  const a = Wallet.generate(), b = Wallet.generate();
  fund(a, 10); fund(b, 10);
  const { block, key } = nextBlock(chain, keys);
  assert.equal(block.txs.length, 2);
  assert.deepEqual(verifyPoh(chain.tip.pohEnd, block.poh.entries).mixins, block.txs.map(txHash), 'PoH mixes in exactly the block txs, in order');

  // Reordered txs: tx root / PoH mix-ins no longer match.
  const reordered = structuredClone(block);
  reordered.txs.reverse();
  assert.throws(() => chain.validateBlock(reordered), /tx root|PoH/);
  // Tampered PoH entries.
  const forged = structuredClone(block);
  forged.poh.entries[forged.poh.entries.length - 1].h = 'f'.repeat(64);
  assert.throws(() => chain.validateBlock(forged), /PoH/);

  // Claiming a far slot without the hashes to prove it elapsed.
  const far = chain.tip.slot + 30;
  const leader = keys.validators.find((v) => v.pubHex === chain.leaderFor(far).pub);
  const lazy = chain.buildBlock(far, leader, new PohRecorder(chain.tip.pohEnd));
  assert.throws(() => chain.validateBlock(lazy), /PoH must prove/);

  // A validator that isn't the slot's leader can't produce for it.
  const other = keys.validators.find((v) => v.pubHex !== key.pubHex);
  const imposter = chain.buildBlock(block.slot, other, new PohRecorder(chain.tip.pohEnd));
  if (chain.leaderFor(block.slot).pub !== other.pubHex) assert.throws(() => chain.validateBlock(imposter), /wrong leader/);

  chain.validateBlock(block); // the honest block is fine
  assert.ok(chain.produceBlock());
  assert.equal(chain.state.account(a.address).balance, 10n * UNIT);
  const t = chain.getTx(chain.addrIndex.get(a.address)[0]);
  assert.equal(t.slot, chain.tip.slot);
  assert.ok(Number.isInteger(t.pohIndex));
});

test('phase 2: leader schedule is stake-weighted, deterministic and fixed per epoch', async () => {
  const { keys, chain } = await setup();
  const replica = await new Blockchain({ keys, storage: new MemoryStorage() }).init();
  const counts = new Map();
  for (let s = 1; s < SLOTS_PER_EPOCH * 4; s++) {
    const l = chain.leaderFor(s);
    assert.equal(l.pub, replica.leaderFor(s).pub, 'every node computes the same schedule');
    if (s % LEADER_SLOTS !== 0) assert.equal(l.pub, chain.leaderFor(s - 1).pub, 'leaders hold consecutive slots');
    counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
  }
  assert.equal(counts.size, 4, 'all validators lead some slots');
  assert.ok(counts.get('aurora') > counts.get('draco'), 'more stake → more slots (30% vs 20%)');
});

test('phase 4: register, delegate, earn rewards, enter the schedule next epoch, unbond', async () => {
  const { keys, chain, fund, nonce } = await setup();
  const op = Wallet.generate(), del = Wallet.generate();
  fund(op, 600_000); fund(del, 50_000);
  chain.produceBlock();
  assert.throws(() => chain.submitTx(op.registerValidator({ name: 'too-poor', amount: MIN_VALIDATOR_STAKE - 1n, nonce: nonce(op) })), /minimum/);
  assert.throws(() => chain.submitTx(op.registerValidator({ name: 'Bad Name', amount: MIN_VALIDATOR_STAKE, nonce: nonce(op) })), /name/);
  chain.submitTx(op.registerValidator({ name: 'agent-node', commissionBps: 2000, amount: 500_000n * UNIT, nonce: nonce(op) }));
  chain.produceBlock();
  chain.submitTx(del.stake({ validator: op.pubHex, amount: 20_000n * UNIT, nonce: nonce(del) }));
  chain.produceBlock();
  const v = chain.state.validators.get(op.pubHex);
  assert.equal(v.selfStake, 500_000n * UNIT);
  assert.equal(v.delegated, 20_000n * UNIT);
  assert.ok(!chain.snapshotFor(epochOf(chain.slot)).power.has(op.pubHex), 'not active until the next epoch');
  assert.ok(chain.supply().conserved);

  // Next epoch: the new validator is in the snapshot and leads some slots.
  const nextEpochStart = (epochOf(chain.slot) + 1) * SLOTS_PER_EPOCH;
  const all = [...keys.validators, op.asValidator('agent-node')];
  chain.produceBlock(all, { minSlot: nextEpochStart });
  const snap = chain.snapshotFor(epochOf(chain.slot));
  assert.ok(snap.power.has(op.pubHex));
  let opSlot = null;
  for (let s = chain.slot + 1; s < chain.slot + SLOTS_PER_EPOCH && !opSlot; s++) if (chain.leaderFor(s).pub === op.pubHex) opSlot = s;
  assert.ok(opSlot, 'new validator is scheduled to lead');
  const delBefore = chain.state.account(del.address).balance;
  const opBefore = chain.state.account(op.address).balance;
  const blk = chain.produceBlock(all, { minSlot: opSlot });
  assert.equal(blk.proposer, op.pubHex);
  // Reward split: 20% commission, rest pro rata (delegator holds 20k of 520k bonded).
  const total = BigInt(blk.reward) + BigInt(blk.fees);
  const expectedDel = ((total - (total * 2000n) / 10000n) * 20_000n) / 520_000n;
  assert.equal(chain.state.account(del.address).balance - delBefore, expectedDel);
  assert.equal(chain.state.account(op.address).balance - opBefore, total - expectedDel);

  // Unbonding: funds return after UNBONDING_EPOCHS.
  chain.submitTx(del.unstake({ validator: op.pubHex, amount: 5_000n * UNIT, nonce: nonce(del) }));
  assert.throws(() => chain.submitTx(del.unstake({ validator: op.pubHex, amount: 999_999n * UNIT, nonce: nonce(del) })), /exceeds/);
  chain.produceBlock(all);
  const entry = chain.state.unbonding.find((u) => u.address === del.address);
  assert.equal(entry.releaseEpoch, chain.state.epoch + UNBONDING_EPOCHS);
  const before = chain.state.account(del.address).balance;
  chain.produceBlock(all, { minSlot: entry.releaseEpoch * SLOTS_PER_EPOCH });
  assert.equal(chain.state.unbonding.length, 0);
  assert.ok(chain.state.account(del.address).balance - before >= 5_000n * UNIT);
  assert.ok(chain.supply().conserved);
});

test('phase 5: equivocation evidence slashes once, burns, rewards the reporter and jails', async () => {
  const { keys, chain, fund, nonce } = await setup();
  const reporter = Wallet.generate();
  fund(reporter, 10);
  chain.produceBlock();
  const bad = keys.validators[1]; // borealis
  const vote = (hash) => ({ kind: 'precommit', height: 5, round: 0, blockHash: hash, validator: bad.pubHex, sig: schnorrSign(voteDigest('precommit', 5, 0, hash), bad.secret) });
  const voteA = vote('a'.repeat(64)), voteB = vote('b'.repeat(64));
  const ev = (a, b) => signTx({ type: 'evidence', from: reporter.pubHex, voteA: a, voteB: b, fee: '10000', nonce: nonce(reporter) }, reporter.secret);
  assert.throws(() => chain.submitTx(ev(voteA, voteA)), /do not conflict/);
  assert.throws(() => chain.submitTx(ev(voteA, { ...voteB, sig: voteA.sig })), /validly signed/);
  const bonded = chain.state.validators.get(bad.pubHex).selfStake;
  const repBefore = chain.state.account(reporter.address).balance;
  chain.submitTx(ev(voteA, voteB));
  chain.produceBlock();
  const v = chain.state.validators.get(bad.pubHex);
  const slashed = (bonded * BigInt(SLASH_BPS)) / 10_000n;
  const reward = (slashed * BigInt(REPORTER_REWARD_BPS)) / 10_000n;
  assert.ok(v.jailed);
  assert.equal(v.selfStake, bonded - slashed);
  assert.equal(chain.state.burned, slashed - reward);
  assert.equal(chain.state.account(reporter.address).balance - repBefore, reward - 10_000n);
  assert.ok(chain.supply().conserved, 'issued = circulating + staked + shielded + burned');
  assert.throws(() => chain.submitTx(ev(voteB, voteA)), /already processed/);
  // Jailed validators leave the next epoch's schedule.
  chain.produceBlock(undefined, { minSlot: (epochOf(chain.slot) + 1) * SLOTS_PER_EPOCH });
  assert.ok(!chain.snapshotFor(epochOf(chain.slot)).power.has(bad.pubHex));
});
