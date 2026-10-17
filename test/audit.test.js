// Regression tests for the PoH/PoS audit findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain, devnetKeys, MemoryStorage, epochOf } from '../src/chain/blockchain.js';
import { createNode } from '../src/node/compose.js';
import { helloDigest } from '../src/chain/consensus.js';
import { PohRecorder } from '../src/chain/poh.js';
import { voteDigest } from '../src/chain/staking.js';
import { signTx } from '../src/chain/tx.js';
import { schnorrSign } from '../src/crypto/secp256k1.js';
import { Wallet } from '../src/wallet/wallet.js';
import { UNIT, SLOTS_PER_EPOCH, TICKS_PER_SLOT, JAIL_EPOCHS, SLASH_BPS } from '../src/chain/params.js';

async function setup(secret = 'audit') {
  const keys = devnetKeys(secret);
  const chain = await new Blockchain({ keys, storage: new MemoryStorage() }).init();
  const fund = (w, vox) => chain.submitTx(signTx({ type: 'transfer', from: keys.faucet.pubHex, to: w.address, amount: (BigInt(vox) * UNIT).toString(), fee: '10000', nonce: chain.pending.account(keys.faucet.address).nonce }, keys.faucet.secret));
  const nonce = (w) => chain.pending.account(w.address).nonce;
  const byName = (n) => keys.validators.find((v) => v.name.endsWith(n));
  return { keys, chain, fund, nonce, byName };
}
const evidenceTx = (from, nonce, a, b) => signTx({ type: 'evidence', from: from.pubHex, voteA: a, voteB: b, fee: '10000', nonce }, from.secret);
function doubleVote(chain, v, h = chain.height) {
  const parent = chain.blocks[h - 1].hash;
  const mk = (hash) => ({ kind: 'precommit', height: h, round: 0, blockHash: hash, parent, validator: v.pubHex, sig: schnorrSign(voteDigest('precommit', h, 0, hash, parent), v.secret) });
  return [mk('a'.repeat(64)), mk('b'.repeat(64))];
}

test('no cross-epoch fork: every vote at a height is weighted by one validator-set snapshot', async () => {
  const { keys, chain, fund, nonce, byName } = await setup();
  // A delegator moves 700k VOX onto cygnus during epoch 0, so the epoch-1 set differs from epoch 0's.
  const d = Wallet.generate();
  fund(d, 710_000);
  chain.produceBlock();
  chain.submitTx(d.stake({ validator: byName('cygnus').pubHex, amount: 700_000n * UNIT, nonce: nonce(d) }));
  chain.produceBlock();
  // A candidate block for a slot in epoch 1, certified only by cygnus + draco: that's 67.6% of the
  // epoch-1 set but 45% of the stake that weighs this height. It must not commit.
  let slot = SLOTS_PER_EPOCH;
  while (![byName('cygnus').pubHex, byName('draco').pubHex].includes(chain.leaderFor(slot).pub)) slot++;
  assert.ok(slot - chain.slot <= 120);
  const leader = keys.validators.find((v) => v.pubHex === chain.leaderFor(slot).pub);
  const rec = new PohRecorder(chain.tip.pohEnd);
  rec.tick((slot - chain.slot - 1) * TICKS_PER_SLOT);
  const y = chain.buildBlock(slot, leader, rec);
  const pc = (v) => ({ validator: v.pubHex, sig: schnorrSign(voteDigest('precommit', y.height, 0, y.hash, y.prevHash), v.secret) });
  assert.throws(() => chain.applyBlock({ ...y, commit: { round: 0, votes: [pc(byName('cygnus')), pc(byName('draco'))] } }), /2\/3/);
});

test('slashing reaches stake that is already unbonding (no unstake-then-equivocate escape)', async () => {
  const { chain, fund, nonce } = await setup();
  const op = Wallet.generate(), reporter = Wallet.generate();
  fund(op, 20_000); fund(reporter, 10);
  chain.produceBlock();
  chain.submitTx(op.registerValidator({ name: 'escapee', amount: 15_000n * UNIT, nonce: nonce(op) }));
  chain.produceBlock();
  const [a, b] = doubleVote(chain, op.asValidator('escapee'));
  chain.submitTx(op.unstake({ validator: op.pubHex, amount: 15_000n * UNIT, nonce: nonce(op) })); // run for the exit…
  chain.submitTx(evidenceTx(reporter, nonce(reporter), a, b)); // …evidence lands in the same block
  chain.produceBlock();
  const u = chain.state.unbonding.find((x) => x.address === op.address);
  assert.equal(u.amount, 15_000n * UNIT - (15_000n * UNIT * BigInt(SLASH_BPS)) / 10_000n);
  assert.ok(chain.state.validators.get(op.pubHex).jailed);
  assert.ok(chain.supply().conserved);
});

test('jail is temporary (unjail after JAIL_EPOCHS) and the active set never goes empty', async () => {
  const { keys, chain, fund, nonce } = await setup();
  const rep = Wallet.generate();
  fund(rep, 10);
  chain.produceBlock();
  for (const v of keys.validators) chain.submitTx(evidenceTx(rep, nonce(rep), ...doubleVote(chain, v)));
  chain.produceBlock();
  assert.ok([...chain.state.validators.values()].every((v) => v.jailed));
  // Next epoch: no unjailed validator exists, yet the schedule still works (previous set carries on).
  const next = (epochOf(chain.slot) + 1) * SLOTS_PER_EPOCH;
  while (chain.slot < next) chain.produceBlock(undefined, { minSlot: Math.min(chain.slot + 100, next) });
  assert.equal(chain.snapshotFor(epochOf(chain.slot)).validators.length, 4);
  // A validator can unjail itself once JAIL_EPOCHS have passed.
  const aurora = keys.validators[0];
  const unjail = () => signTx({ type: 'unjail', from: aurora.pubHex, fee: '10000', nonce: chain.pending.account(aurora.address).nonce }, aurora.secret);
  assert.throws(() => chain.submitTx(unjail()), /jailed until/);
  const until = chain.state.validators.get(aurora.pubHex).jailedUntilEpoch * SLOTS_PER_EPOCH;
  while (chain.slot < until) chain.produceBlock(undefined, { minSlot: Math.min(chain.slot + 100, until) });
  chain.submitTx(unjail());
  chain.produceBlock();
  assert.equal(chain.state.validators.get(aurora.pubHex).jailed, false);
});

test('consensus input hardening: far-future proposals, one proposal per round, signed hello only', async () => {
  const node = createNode({ storage: new MemoryStorage(), secret: 'harden', validators: 'all' });
  await node.init();
  const c = node.consensus;
  const ch = node.chain;
  // A leader can't drag peers to a far round by itself.
  const r = c.round + 5;
  const leader = node.keys.validators.find((v) => v.pubHex === ch.leaderFor(c.slotOf(r)).pub);
  const blk = ch.buildBlock(c.slotOf(r), leader, new PohRecorder(ch.tip.pohEnd));
  assert.match(c.onProposal({ height: c.h, round: r, validRound: -1, blockHash: blk.hash, proposer: leader.pubHex, sig: 'x', block: blk }).error, /future round/);
  // Blocks must prove every skipped slot with PoH (no cap), and may skip at most MAX_SLOT_GAP slots.
  assert.throws(() => ch.validateBlock(ch.buildBlock(ch.slot + 200, leader, new PohRecorder(ch.tip.pohEnd))), /skips more than|wrong leader/);
  // Peer announcements must be signed by an active validator.
  assert.equal(c.onHello({ url: 'http://evil.example', validator: leader.pubHex, sig: '00'.repeat(65) }).added, false);
  const stranger = Wallet.generate();
  assert.match(c.onHello({ url: 'http://x.example', validator: stranger.pubHex, sig: schnorrSign(helloDigest('http://x.example'), stranger.secret) }).error, /not an active validator/);
});

test('unstaking in an earlier block than the offence, same epoch, is still slashed', async () => {
  const { chain, fund, nonce } = await setup('audit-early-unstake');
  const op = Wallet.generate(), reporter = Wallet.generate();
  fund(op, 20_000); fund(reporter, 10);
  chain.produceBlock();
  chain.submitTx(op.registerValidator({ name: 'early', amount: 15_000n * UNIT, nonce: nonce(op) }));
  chain.produceBlock();
  chain.submitTx(op.unstake({ validator: op.pubHex, amount: 15_000n * UNIT, nonce: nonce(op) }));
  chain.produceBlock(); // the unstake is committed first; its weight still counts until the epoch ends
  const [a, b] = doubleVote(chain, op.asValidator('early'), chain.height + 1); // equivocation at a later height
  chain.submitTx(evidenceTx(reporter, nonce(reporter), a, b));
  chain.produceBlock();
  const u = chain.state.unbonding.find((x) => x.address === op.address);
  assert.equal(u.amount, 15_000n * UNIT - (15_000n * UNIT * BigInt(SLASH_BPS)) / 10_000n);
  assert.ok(chain.supply().conserved);
});
