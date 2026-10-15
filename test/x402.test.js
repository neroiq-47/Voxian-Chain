import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/node/server.js';
import { MemoryStorage } from '../src/chain/blockchain.js';
import { ChainClient } from '../src/wallet/client.js';
import { Wallet } from '../src/wallet/wallet.js';
import { VoxAgent } from '../src/agent/agent.js';
import { x402Fetch } from '../src/x402/client.js';
import { decodeHeader, encodeHeader } from '../src/x402/protocol.js';
import { UNIT } from '../src/chain/params.js';

const until = async (cond) => { for (let i = 0; i < 80; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

test('x402 end to end over HTTP: 402 challenge, exact + zk-shielded payments, agent', async (t) => {
  const s = await startServer({ port: 0, host: '127.0.0.1', storage: new MemoryStorage(), secret: 'x402-test', quiet: true });
  t.after(() => s.close());
  const base = `http://127.0.0.1:${s.server.address().port}/`;
  const f = (u, i) => fetch(new URL(u, base), i);
  const api = new ChainClient(f);
  const w = Wallet.generate();

  // Unpaid request -> 402 with both schemes
  const r = await f('paid/random');
  assert.equal(r.status, 402);
  const body = await r.json();
  assert.equal(body.x402Version, 1);
  assert.deepEqual(body.accepts.map((a) => a.scheme), ['exact', 'zk-shielded']);

  // Malformed paths don't crash the node; the facilitator refuses requirements it didn't issue.
  assert.equal((await f('%')).status, 400);
  const forged = { ...body.accepts[0], payTo: w.address, maxAmountRequired: '1' };
  const settle = await (await f('x402/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paymentPayload: {}, paymentRequirements: forged }) })).json();
  assert.equal(settle.success, false);
  assert.match(settle.errorReason, /unknown paymentRequirements/);

  // Garbage / unfunded payments are refused
  assert.equal((await f('paid/random', { headers: { 'x-payment': 'not-base64!!' } })).status, 402);
  await assert.rejects(x402Fetch(f, 'paid/random', {}, { wallet: w, api, scheme: 'exact' }), /payment rejected/);

  await api.faucet(w.address);
  await until(async () => (await api.account(w.address)).balance !== '0');

  // exact
  const ex = await x402Fetch(f, 'paid/oracle/price?pair=BTC-USD', {}, { wallet: w, api, scheme: 'exact' });
  assert.equal(ex.data.pair, 'BTC-USD');
  assert.ok(ex.receipt.success);

  // Replaying the same X-PAYMENT header must fail
  const auth = w.signAuthorization({ to: body.accepts[0].payTo, value: 500000n, resource: '/paid/random' });
  const hdr = encodeHeader({ x402Version: 1, scheme: 'exact', network: 'voxian-devnet', payload: auth });
  assert.equal((await f('paid/random', { headers: { 'x-payment': hdr } })).status, 200);
  assert.equal((await f('paid/random', { headers: { 'x-payment': hdr } })).status, 402);

  // Price limit is enforced client-side
  await assert.rejects(x402Fetch(f, 'paid/ai/summarize', { method: 'POST', body: '{"text":"a. b."}', headers: { 'content-type': 'application/json' } }, { wallet: w, api, scheme: 'exact', maxAmount: 1n }), /exceeds limit/);

  // zk-shielded
  const acct = await api.account(w.address);
  await api.submit(w.shield({ amount: 2n * UNIT, nonce: acct.pendingNonce }));
  const zk = await x402Fetch(f, 'paid/ai/sentiment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'fast and secure' }) }, { wallet: w, api, scheme: 'zk-shielded' });
  assert.equal(zk.data.label, 'positive');
  const tx = await api.tx(zk.receipt.transaction);
  assert.equal(tx.summary.amount, null, 'amount hidden on-chain');
  assert.equal(tx.summary.from, 'shielded');

  // Agent spends within budget
  const agent = new VoxAgent({ fetch: f, api, wallet: w, budget: UNIT / 10n, scheme: 'auto' });
  const run = await agent.run('full report');
  assert.ok(run.receipts.length >= 3);
  assert.ok(run.spent <= UNIT / 10n);

  await until(async () => (await api.mempool()).txs.length === 0);
  const stats = await api.stats();
  assert.ok(stats.supply.conserved);
  assert.ok(stats.x402PrivatePayments >= 1);
  const rev = await api.revenue();
  assert.ok(BigInt(rev.shieldedRevenue) > 0n, 'operator sees private revenue with its view key');
  assert.ok(decodeHeader(encodeHeader({ a: 1 })).a === 1);
});
