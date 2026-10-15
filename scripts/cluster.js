#!/usr/bin/env node
// Launch a local 4-validator Voxian cluster: one node process per validator, full-mesh HTTP gossip.
//   npm run cluster                 # ports 8402-8405, data in data/cluster/<name>
//   npm run cluster -- --reset      # start from genesis
//   npm run cluster -- --base 9000  # different ports
// Stop one node (Ctrl-C closes all; or `kill` a single PID shown below) to watch the others keep finalizing.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = Number(args[args.indexOf('--base') + 1]) || 8402;
const reset = args.includes('--reset');
const names = ['aurora', 'borealis', 'cygnus', 'draco'];
const colors = ['\x1b[35m', '\x1b[36m', '\x1b[33m', '\x1b[32m'];
const urls = names.map((_, i) => `http://127.0.0.1:${base + i}`);

const children = names.map((name, i) => {
  const child = spawn(process.execPath, [path.join(root, 'src/node/server.js')], {
    env: {
      ...process.env,
      PORT: String(base + i),
      VOXIAN_NODE_NAME: name,
      VOXIAN_VALIDATORS: name,
      VOXIAN_PEERS: urls.filter((_, j) => j !== i).join(','),
      VOXIAN_DATA_DIR: path.join(root, 'data', 'cluster', name),
      ...(reset ? { VOXIAN_RESET: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `${colors[i]}${name.padEnd(8)}\x1b[0m │ `;
  const pipe = (stream) => stream.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(tag + l)));
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', (code) => console.log(`${tag}exited (${code ?? 'signal'})`));
  return child;
});

console.log(`\n⚡ Voxian validator cluster: ${names.length} nodes, BFT finality at > 2/3 stake, tolerates 1 failure`);
names.forEach((n, i) => console.log(`   ${n.padEnd(9)} pid ${children[i].pid}  ${urls[i]}`));
console.log(`   open any URL for the web app · stop one node with: kill ${children[3].pid}\n`);

const shutdown = () => { children.forEach((c) => c.kill('SIGTERM')); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
