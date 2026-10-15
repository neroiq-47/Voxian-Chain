import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/compose.js';
import { MemoryStorage, voteDigest } from '../src/chain/blockchain.js';
import { MemoryNetwork } from '../src/chain/consensus.js';
import { signTx } from '../src/chain/tx.js';
import { schnorrSign } from '../src/crypto/secp256k1.js';
import { Wallet } from '../src/wallet/wallet.js';
import { UNIT } from '../src/chain/params.js';
import { startServer } from '../src/node/server.js';

const NAMES = ['aurora', 'borealis', 'cygnus', 'draco'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(100); }
  throw new Error('timeout');
}

function memoryCluster() {
  const net = new MemoryNetwork(NAMES);
  const nodes = NAMES.map((n) => createNode({ storage: new MemoryStorage(), secret: 'cluster-test', validators: [n], transport: net.transportFor(n) }));
  NAMES.forEach((n, i) => net.add(n, nodes[i].consensus));
  return { net, nodes };
}

// Faucet payment submitted on one node (gossiped to the rest).
function pay(node, to, vox = 1) {
  const f = node.keys.faucet;
  return node.chain.submitTx(signTx({ type: 'transfer', from: f.pubHex, to, amount: (BigInt(vox) * UNIT).toString(), fee: '10000', nonce: node.chain.pending.account(f.address).nonce }, f.secret));
}

test('4-validator cluster: gossip, BFT finality, fault tolerance, halting below quorum, catch-up sync', async (t) => {
  const { net, nodes } = memoryCluster();
  for (const n of nodes) { await n.init(); n.start(); }
  t.after(() => nodes.forEach((n) => n.stop()));
  const [a, b, c, d] = nodes;
  const w = Wallet.generate();

  // A tx submitted to one node is gossiped, proposed, voted and committed on every node.
  pay(a, w.address, 5);
  await until(() => nodes.every((n) => n.chain.state.account(w.address).balance === 5n * UNIT));
  const h = Math.min(...nodes.map((n) => n.chain.height));
  const tips = new Set(nodes.map((n) => n.chain.blocks[h].hash));
  assert.equal(tips.size, 1, 'all nodes agree on the same block');
  const blk = a.chain.blocks[h];
  assert.ok(a.chain.hasQuorum(a.chain.commitPower(blk)), 'commit certificate carries > 2/3 stake');
  assert.ok(blk.commit.votes.length >= 3);

  // One validator offline: the other three (> 2/3 stake) keep finalizing; its proposer turns time out.
  net.down.add('draco');
  const before = a.chain.height;
  for (let i = 0; i < 3; i++) {
    pay(a, Wallet.generate().address);
    const target = a.chain.height + 1;
    await until(() => a.chain.height >= target);
  }
  assert.ok(a.chain.height >= before + 3);
  assert.equal(d.chain.height, before, 'isolated node did not advance');

  // Two validators offline: no quorum, the chain halts safely (no fork, no finality without 2/3).
  net.down.add('cygnus');
  await sleep(300);
  const halted = a.chain.height;
  pay(a, Wallet.generate().address);
  await sleep(7_000);
  assert.equal(a.chain.height, halted, 'no blocks without 2/3 of stake');
  assert.equal(b.chain.height, halted);

  // Recovery: both come back, catch up via sync, and the cluster finalizes again.
  net.down.clear();
  await until(() => a.chain.height > halted);
  await until(() => nodes.every((n) => n.chain.height >= a.chain.height - 1), 20_000);
  const common = Math.min(...nodes.map((n) => n.chain.height));
  assert.equal(new Set(nodes.map((n) => n.chain.blocks[common].hash)).size, 1, 'no fork after recovery');
  assert.ok(d.consensus.stats.synced > 0, 'lagging node caught up through sync');
  assert.ok(nodes.every((n) => n.chain.supply().conserved));
});

test('blocks without a 2/3 commit certificate are rejected', async () => {
  const node = createNode({ storage: new MemoryStorage(), secret: 'cert-test', validators: 'all' });
  await node.init();
  const ch = node.chain;
  const prev = ch.tip;
  const proposer = ch.proposerFor(prev.hash, 1, 0);
  const key = node.keys.validators.find((v) => v.pubHex === proposer.pub);
  const block = ch.buildBlock(0, key);
  const digest = voteDigest(block.height, block.hash);
  const vote = (v) => ({ validator: v.pubHex, sig: schnorrSign(digest, v.secret) });
  // Two validators (at most 55% of stake): not enough.
  const two = node.keys.validators.slice(0, 2);
  assert.throws(() => ch.applyBlock({ ...block, commit: { votes: two.map(vote) } }), /2\/3/);
  // Duplicated votes from the same validator don't add stake.
  assert.throws(() => ch.applyBlock({ ...block, commit: { votes: [vote(two[0]), vote(two[0]), vote(two[1])] } }), /2\/3/);
  // Votes for a different block don't count.
  const wrong = node.keys.validators.map((v) => ({ validator: v.pubHex, sig: schnorrSign(voteDigest(1, 'f'.repeat(64)), v.secret) }));
  assert.throws(() => ch.applyBlock({ ...block, commit: { votes: wrong } }), /2\/3/);
  // Wrong proposer for the round is rejected even with a full certificate.
  const other = node.keys.validators.find((v) => v.pubHex !== proposer.pub);
  const imposter = ch.buildBlock(0, other);
  const d2 = voteDigest(imposter.height, imposter.hash);
  assert.throws(() => ch.applyBlock({ ...imposter, commit: { votes: node.keys.validators.map((v) => ({ validator: v.pubHex, sig: schnorrSign(d2, v.secret) })) } }), /proposer/);
  // Three of four validators: final.
  ch.applyBlock({ ...block, commit: { votes: node.keys.validators.slice(1).map(vote) } });
  assert.equal(ch.height, 1);
});

test('HTTP validator cluster: four node processes-worth of servers gossip over /p2p', async (t) => {
  const ports = [18402, 18403, 18404, 18405];
  const urls = ports.map((p) => `http://127.0.0.1:${p}`);
  const servers = [];
  for (let i = 0; i < 4; i++) {
    servers.push(await startServer({ port: ports[i], host: '127.0.0.1', storage: new MemoryStorage(), secret: 'http-cluster', validators: [NAMES[i]], peers: urls.filter((_, j) => j !== i), name: NAMES[i], quiet: true }));
  }
  t.after(() => Promise.all(servers.map((s) => s.close())));
  const w = Wallet.generate();
  const r = await fetch(`${urls[0]}/api/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: w.address }) });
  assert.equal(r.status, 200);
  // Read the result from a different validator's node.
  await until(async () => (await (await fetch(`${urls[3]}/api/accounts/${w.address}`)).json()).balance === String(1000n * UNIT));
  const c = await (await fetch(`${urls[2]}/api/consensus`)).json();
  assert.equal(c.mode, 'cluster');
  assert.deepEqual(c.localValidators, ['vox-validator-cygnus']);
  await until(async () => (await (await fetch(`${urls[2]}/api/consensus`)).json()).peers.every((p) => p.ok));
  const heights = await Promise.all(urls.map(async (u) => (await (await fetch(`${u}/api/stats`)).json()).height));
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1);
});
