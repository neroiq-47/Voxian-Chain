// Phase 3: PoH-driven BFT cluster (prevote / precommit / locking), fault tolerance, sync, certificates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/compose.js';
import { MemoryStorage } from '../src/chain/blockchain.js';
import { MemoryNetwork } from '../src/chain/consensus.js';
import { voteDigest } from '../src/chain/staking.js';
import { PohRecorder } from '../src/chain/poh.js';
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

function memoryCluster(secret) {
  const net = new MemoryNetwork(NAMES);
  const nodes = NAMES.map((n) => createNode({ storage: new MemoryStorage(), secret, validators: [n], transport: net.transportFor(n) }));
  NAMES.forEach((n, i) => net.add(n, nodes[i].consensus));
  return { net, nodes };
}

function pay(node, to, vox = 1) {
  const f = node.keys.faucet;
  return node.chain.submitTx(signTx({ type: 'transfer', from: f.pubHex, to, amount: (BigInt(vox) * UNIT).toString(), fee: '10000', nonce: node.chain.pending.account(f.address).nonce }, f.secret));
}

test('4-validator PoH/BFT cluster: finality, 1 fault tolerated, halts below quorum, recovers via sync', async (t) => {
  const { net, nodes } = memoryCluster('cluster-test');
  for (const n of nodes) { await n.init(); n.start(); }
  t.after(() => nodes.forEach((n) => n.stop()));
  const [a, b, , d] = nodes;
  const w = Wallet.generate();

  pay(a, w.address, 5);
  await until(() => nodes.every((n) => n.chain.state.account(w.address).balance === 5n * UNIT));
  const h = Math.min(...nodes.map((n) => n.chain.height));
  assert.equal(new Set(nodes.map((n) => n.chain.blocks[h].hash)).size, 1, 'all nodes agree');
  const blk = a.chain.blocks[h];
  const { power, total } = a.chain.commitPower(blk);
  assert.ok(a.chain.hasQuorum(power, total), 'precommit certificate carries > 2/3 stake');
  assert.ok(blk.pohTicks >= 0 && blk.poh.entries.length >= 1, 'block carries PoH');

  // One validator offline: its leader slots are skipped (PoH proves the skip), the rest keep finalizing.
  net.down.add('draco');
  const before = a.chain.height;
  for (let i = 0; i < 3; i++) {
    pay(a, Wallet.generate().address);
    const target = a.chain.height + 1;
    await until(() => a.chain.height >= target);
  }
  assert.ok(a.chain.height >= before + 3);
  assert.equal(d.chain.height, before, 'isolated node did not advance');

  // Two offline: no quorum, the chain halts safely.
  net.down.add('cygnus');
  await sleep(300);
  const halted = a.chain.height;
  pay(a, Wallet.generate().address);
  await sleep(6_000);
  assert.equal(a.chain.height, halted, 'no blocks without 2/3 of stake');
  assert.equal(b.chain.height, halted);

  // Recovery.
  net.down.clear();
  await until(() => a.chain.height > halted);
  await until(() => nodes.every((n) => n.chain.height >= a.chain.height - 1), 25_000);
  const common = Math.min(...nodes.map((n) => n.chain.height));
  assert.equal(new Set(nodes.map((n) => n.chain.blocks[common].hash)).size, 1, 'no fork after recovery');
  assert.ok(d.consensus.stats.synced > 0, 'lagging node caught up through sync');
  assert.ok(nodes.every((n) => n.chain.supply().conserved));
});

test('locking: a block that reached a polka is the one that gets committed after precommits are lost', async (t) => {
  const { net, nodes } = memoryCluster('lock-test');
  for (const n of nodes) { await n.init(); n.start(); }
  t.after(() => nodes.forEach((n) => n.stop()));
  // Drop every precommit and commit message: prevotes form a polka, validators lock, but nothing commits.
  net.filter = ({ type, body }) => !(type === 'commit' || (type === 'vote' && body.kind === 'precommit'));
  const start = nodes[0].chain.height;
  pay(nodes[0], Wallet.generate().address);
  await until(() => nodes.filter((n) => n.consensus.status().locked).length >= 3, 20_000);
  const lockedHash = nodes.find((n) => n.consensus.status().locked).consensus.status().locked.hash;
  await sleep(2_500); // several rounds pass; locked validators must not prevote anything else
  assert.ok(nodes.every((n) => n.chain.height === start), 'nothing commits while precommits are lost');
  assert.ok(nodes.every((n) => !n.consensus.status().locked || n.consensus.status().locked.hash === lockedHash), 'all locks agree');
  net.filter = null;
  await until(() => nodes.every((n) => n.chain.height > start), 25_000);
  assert.equal(nodes[1].chain.blocks[start + 1].hash, lockedHash, 'the locked (polka) block was committed');
  assert.ok(nodes.some((n) => n.consensus.stats.rounds > 0));
});

test('blocks without a valid 2/3 precommit certificate are rejected', async () => {
  const node = createNode({ storage: new MemoryStorage(), secret: 'cert-test', validators: 'all' });
  await node.init();
  const ch = node.chain;
  const leader = ch.leaderFor(ch.slot + 1);
  const key = node.keys.validators.find((v) => v.pubHex === leader.pub);
  const block = ch.buildBlock(ch.slot + 1, key, new PohRecorder(ch.tip.pohEnd));
  const pc = (v, round = 0, hash = block.hash, kind = 'precommit') => ({ validator: v.pubHex, sig: schnorrSign(voteDigest(kind, block.height, round, hash, block.prevHash), v.secret) });
  const vs = node.keys.validators;
  assert.throws(() => ch.applyBlock({ ...block, commit: { round: 0, votes: vs.slice(0, 2).map((v) => pc(v)) } }), /2\/3/, 'two of four is not enough');
  assert.throws(() => ch.applyBlock({ ...block, commit: { round: 0, votes: [pc(vs[0]), pc(vs[0]), pc(vs[1])] } }), /2\/3/, 'duplicates do not add stake');
  assert.throws(() => ch.applyBlock({ ...block, commit: { round: 0, votes: vs.map((v) => pc(v, 0, block.hash, 'prevote')) } }), /2\/3/, 'prevotes are not precommits');
  assert.throws(() => ch.applyBlock({ ...block, commit: { round: 1, votes: vs.map((v) => pc(v, 0)) } }), /2\/3/, 'votes must match the certificate round');
  ch.applyBlock({ ...block, commit: { round: 0, votes: vs.slice(1).map((v) => pc(v)) } });
  assert.equal(ch.height, 1);
});

test('persistent signing log: a restarted validator never signs a conflicting vote', async () => {
  const storage = new MemoryStorage();
  const n1 = createNode({ storage, secret: 'signlog', validators: ['aurora'] });
  await n1.init();
  const v = n1.consensus.local.values().next().value;
  const c = n1.consensus;
  assert.ok(c.signOnce(v, 'prevote', 0, 'a'.repeat(64), voteDigest('prevote', c.h, 0, 'a'.repeat(64), 'p'.repeat(64))));
  const n2 = createNode({ storage, secret: 'signlog', validators: ['aurora'] }); // "restart" on the same storage
  await n2.init();
  const c2 = n2.consensus;
  assert.equal(c2.signOnce(v, 'prevote', 0, 'b'.repeat(64), voteDigest('prevote', c2.h, 0, 'b'.repeat(64), 'p'.repeat(64))), null);
  assert.ok(c2.signOnce(v, 'prevote', 0, 'a'.repeat(64), voteDigest('prevote', c2.h, 0, 'a'.repeat(64), 'p'.repeat(64))), 're-signing the same value is fine');
});

test('equivocating votes seen on the network are auto-reported and slashed', async (t) => {
  const node = createNode({ storage: new MemoryStorage(), secret: 'equiv', validators: 'all' });
  await node.init();
  node.start();
  t.after(() => node.stop());
  await until(() => node.chain.height >= 1, 15_000); // validators earn rewards to pay the evidence fee
  const bad = node.keys.validators[3];
  const h = node.chain.height + 1;
  const parent = node.chain.tip.hash;
  const r = node.consensus.round;
  const vote = (hash) => ({ kind: 'prevote', height: h, round: r, blockHash: hash, parent, validator: bad.pubHex, sig: schnorrSign(voteDigest('prevote', h, r, hash, parent), bad.secret) });
  // Non-validators' votes are not even stored.
  const stranger = Wallet.generate();
  assert.equal(node.consensus.onVote({ ...vote('3'.repeat(64)), validator: stranger.pubHex, sig: schnorrSign(voteDigest('prevote', h, r, '3'.repeat(64), parent), stranger.secret) }).error, 'not a validator at this height');
  node.consensus.onVote(vote('1'.repeat(64)));
  node.consensus.onVote(vote('2'.repeat(64)));
  assert.equal(node.consensus.evidence.length, 1);
  assert.ok(node.consensus.evidence[0].submitted, 'evidence tx submitted');
  await until(() => node.chain.state.validators.get(bad.pubHex).jailed, 15_000);
  assert.ok(node.chain.state.burned > 0n);
  assert.ok(node.chain.supply().conserved);
});

test('HTTP validator cluster gossips over /p2p', async (t) => {
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
  await until(async () => (await (await fetch(`${urls[3]}/api/accounts/${w.address}`)).json()).balance === String(1000n * UNIT));
  const c = await (await fetch(`${urls[2]}/api/consensus`)).json();
  assert.equal(c.mode, 'cluster');
  assert.deepEqual(c.localValidators, ['vox-validator-cygnus']);
  const poh = await (await fetch(`${urls[1]}/api/poh`)).json();
  assert.ok(poh.live.hashRate >= 0 && poh.upcoming.length > 0);
  const st = await (await fetch(`${urls[1]}/api/staking`)).json();
  assert.equal(st.active.length, 4);
});
