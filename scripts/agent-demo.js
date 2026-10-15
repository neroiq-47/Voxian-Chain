#!/usr/bin/env node
// CLI demo: an autonomous agent funds itself from the faucet, shields some VOX, then buys data over x402.
// Usage: npm start (in another terminal), then: npm run agent -- "your goal" [--node http://localhost:8402] [--scheme auto|exact|zk-shielded]
import { ChainClient } from '../src/wallet/client.js';
import { Wallet } from '../src/wallet/wallet.js';
import { VoxAgent } from '../src/agent/agent.js';
import { UNIT, formatVox } from '../src/chain/params.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
const node = opt('node', process.env.VOXIAN_NODE || 'http://localhost:8402');
const scheme = opt('scheme', 'auto');
const goal = args.join(' ') || 'Full research report on VOX price, network activity and sentiment';

const f = (u, i) => fetch(new URL(u, node.endsWith('/') ? node : node + '/'), i);
const api = new ChainClient(f);
const wallet = Wallet.generate();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { kind: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

console.log(`${C.warn}⚡ Voxian agent${C.off} → ${node}\n${C.dim}address ${wallet.address}${C.off}`);
await api.faucet(wallet.address);
process.stdout.write('waiting for faucet funds');
while ((await api.account(wallet.address)).balance === '0') { process.stdout.write('.'); await sleep(500); }
console.log(` ${C.ok}funded${C.off}`);

if (scheme !== 'exact') {
  const a = await api.account(wallet.address);
  await api.submit(wallet.shield({ amount: 5n * UNIT, nonce: a.pendingNonce }));
  console.log(`${C.dim}shielded 5 VOX into a confidential note${C.off}`);
}

const agent = new VoxAgent({
  fetch: f, api, wallet, budget: UNIT, scheme,
  log: (e) => {
    const col = ['settled', 'result', 'done'].includes(e.kind) ? C.ok : ['error', 'skip'].includes(e.kind) ? C.err : ['402', 'sign'].includes(e.kind) ? C.warn : C.kind;
    console.log(`${col}${e.kind.padEnd(9)}${C.off} ${e.message}`);
  },
});
const r = await agent.run(goal);
console.log(`\n${r.report}\n\n${C.ok}spent ${formatVox(r.spent)} VOX in ${r.receipts.length} x402 payments${C.off}`);
