import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain, devnetKeys, MemoryStorage } from '../src/chain/blockchain.js';
import { Wallet } from '../src/wallet/wallet.js';
import { signTx } from '../src/chain/tx.js';
import { UNIT, MAX_SUPPLY, blockReward, parseVox, formatVox, HALVING_INTERVAL } from '../src/chain/params.js';

async function setup() {
  const keys = devnetKeys('test-secret');
  const storage = new MemoryStorage();
  const chain = await new Blockchain({ keys, storage }).init();
  const fund = (w, vox) => chain.submitTx(signTx({ type: 'transfer', from: keys.faucet.pubHex, to: w.address, amount: (BigInt(vox) * UNIT).toString(), fee: '10000', nonce: chain.pending.account(keys.faucet.address).nonce }, keys.faucet.secret));
  const notesOf = (w) => w.scanNotes([...chain.pending.notes.values()].map((n) => ({ ...n, spent: chain.pending.spent.has(n.id) })));
  return { keys, storage, chain, fund, notesOf };
}

test('VOX parameters follow the white paper', () => {
  assert.equal(MAX_SUPPLY, 210_000_000n * 100_000_000n);
  assert.equal(parseVox('0.00000001'), 1n);
  assert.equal(formatVox(parseVox('1234.5')), '1,234.5');
  assert.throws(() => parseVox('0.000000001'));
  assert.equal(blockReward(1, 0n), 50n * UNIT);
  assert.equal(blockReward(HALVING_INTERVAL + 1, 0n), 25n * UNIT);
  assert.equal(blockReward(5, MAX_SUPPLY - 3n), 3n, 'issuance never exceeds the cap');
  assert.equal(blockReward(5, MAX_SUPPLY), 0n);
});

test('public transfers, nonces and signatures', async () => {
  const { chain, fund } = await setup();
  const a = Wallet.generate(), b = Wallet.generate();
  fund(a, 100);
  chain.produceBlock();
  assert.equal(chain.state.account(a.address).balance, 100n * UNIT);
  const tx = a.transfer({ to: b.address, amount: 10n * UNIT, nonce: 0 });
  assert.throws(() => chain.submitTx({ ...tx, amount: String(20n * UNIT) }), /signature/);
  assert.throws(() => chain.submitTx(a.transfer({ to: b.address, amount: 10n * UNIT, nonce: 5 })), /nonce/);
  assert.throws(() => chain.submitTx(a.transfer({ to: b.address, amount: 1000n * UNIT, nonce: 0 })), /insufficient/);
  chain.submitTx(tx);
  assert.throws(() => chain.submitTx(tx), /duplicate/);
  chain.produceBlock();
  assert.equal(chain.state.account(b.address).balance, 10n * UNIT);
  assert.ok(chain.supply().conserved);
});

test('shielded pool: shield, private transfer, unshield, double-spend and inflation protection', async () => {
  const { chain, fund, notesOf } = await setup();
  const a = Wallet.generate(), b = Wallet.generate();
  fund(a, 100);
  chain.produceBlock();
  chain.submitTx(a.shield({ amount: 50n * UNIT, nonce: 0 }));
  chain.produceBlock();
  assert.equal(chain.state.pool, 50n * UNIT);

  const owned = notesOf(a);
  assert.equal(owned.length, 1);
  const { tx } = a.buildShielded({ owned, recipients: [{ zaddress: b.zaddress, value: 20n * UNIT }] });
  // Tampering with any output breaks the proofs/signatures.
  const bad = structuredClone(tx);
  bad.outputs[0].C = tx.outputs[1].C;
  assert.throws(() => chain.submitTx(bad));
  chain.submitTx(tx);
  assert.throws(() => chain.submitTx(a.buildShielded({ owned, recipients: [{ zaddress: b.zaddress, value: 1n }] }).tx), /spent/);
  chain.produceBlock();
  assert.equal(notesOf(b)[0].value, 20n * UNIT);

  // Unshield from b to a public address.
  const { tx: un } = b.buildShielded({ owned: notesOf(b), publicOut: { to: b.address, amount: 5n * UNIT } });
  chain.submitTx(un);
  chain.produceBlock();
  assert.equal(chain.state.account(b.address).balance, 5n * UNIT);
  assert.ok(chain.supply().conserved);

  // A shield whose commitment hides more than the public amount must be rejected.
  const cheat = a.shield({ amount: 1n * UNIT, nonce: 1 });
  const big = a.shield({ amount: 40n * UNIT, nonce: 1 });
  cheat.output = big.output;
  assert.throws(() => chain.submitTx(signTx(cheat, a.secret)));
});

test('x402 auth transfers cannot be replayed or redirected', async () => {
  const { chain, fund, keys } = await setup();
  const payer = Wallet.generate(), payee = Wallet.generate();
  fund(payer, 10);
  chain.produceBlock();
  const { authorization, signature } = payer.signAuthorization({ to: payee.address, value: UNIT, resource: '/paid/x' });
  const relay = (auth, nonce) => signTx({ type: 'auth_transfer', relayer: keys.facilitator.pubHex, fee: '10000', nonce, auth, authSig: signature }, keys.facilitator.secret);
  assert.throws(() => chain.submitTx(relay({ ...authorization, to: keys.facilitator.address }, 0)), /authorization signature/);
  chain.submitTx(relay(authorization, 0));
  assert.throws(() => chain.submitTx(relay(authorization, 1)), /already used/);
  chain.produceBlock();
  assert.equal(chain.state.account(payee.address).balance, UNIT);
});

test('blocks are signed, linked and replayable from storage', async () => {
  const { chain, storage, fund, keys } = await setup();
  const a = Wallet.generate();
  fund(a, 5);
  chain.produceBlock();
  chain.produceBlock();
  await new Promise((r) => setTimeout(r, 10));
  const replica = await new Blockchain({ keys, storage }).init();
  assert.equal(replica.height, chain.height);
  assert.equal(replica.tip.hash, chain.tip.hash);
  assert.equal(replica.state.account(a.address).balance, 5n * UNIT);

  const forged = structuredClone(chain.tip);
  const fresh = await new Blockchain({ keys, storage: new MemoryStorage() }).init();
  fresh.applyBlock(structuredClone(chain.blocks[1]), { trusted: false, persist: false });
  forged.reward = String(1000n * UNIT);
  assert.throws(() => fresh.applyBlock(forged, { trusted: false, persist: false }));
});
