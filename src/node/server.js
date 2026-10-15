// Voxian full node: HTTP API + x402 paid services + static web app, with append-only block storage.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNode } from './compose.js';
import { DEFAULT_DEVNET_SECRET } from '../chain/keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT) || 8402;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.VOXIAN_DATA_DIR || path.join(ROOT, 'data'));
const MAX_BODY = 1_000_000;
const MAX_P2P_BODY = 16_000_000; // proposals/commits can carry up to MAX_BLOCK_TXS shielded txs

// Append-only block log. One file per genesis, so a protocol/genesis change never replays stale blocks.
export class FileStorage {
  constructor(dir = DATA_DIR) { this.dir = dir; this.file = null; }
  bind(genesisHash) { this.file = path.join(this.dir, `blocks-${genesisHash.slice(0, 12)}.jsonl`); return this; }
  async load() {
    if (process.env.VOXIAN_RESET === '1') await this.clear();
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
  async append(block) {
    fs.mkdirSync(this.dir, { recursive: true });
    await fs.promises.appendFile(this.file, JSON.stringify(block) + '\n');
  }
  async replaceAll(blocks) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, blocks.map((b) => JSON.stringify(b) + '\n').join(''));
  }
  async clear() { if (this.file) { fs.rmSync(this.file, { force: true }); fs.rmSync(this.metaFile(), { force: true }); } }
  // Small synchronous key/value metadata (the validator signing log must hit disk before votes go out).
  metaFile() { return this.file.replace(/\.jsonl$/, '.meta.json'); }
  readMeta() { try { return JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')); } catch { return {}; } }
  loadMeta(key) { return this.readMeta()[key] ?? null; }
  saveMeta(key, value) {
    fs.mkdirSync(this.dir, { recursive: true });
    const all = this.readMeta();
    all[key] = value;
    const tmp = this.metaFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, this.metaFile());
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

function serveStatic(urlPath, res) {
  // /src/* serves the shared isomorphic modules; everything else comes from web/.
  const [base, rel] = urlPath.startsWith('/src/') ? [path.join(ROOT, 'src'), urlPath.slice(5)] : [path.join(ROOT, 'web'), urlPath === '/' ? 'index.html' : urlPath.slice(1)];
  let file;
  try { file = path.resolve(base, decodeURIComponent(rel)); } catch { res.writeHead(400).end('bad path'); return; }
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-payment',
  'access-control-expose-headers': 'x-payment-response',
};

const envList = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export async function startServer({
  port = PORT, host = HOST, storage, dataDir = process.env.VOXIAN_DATA_DIR ? path.resolve(process.env.VOXIAN_DATA_DIR) : DATA_DIR,
  secret = process.env.VOXIAN_DEVNET_SECRET || DEFAULT_DEVNET_SECRET,
  validators = process.env.VOXIAN_VALIDATORS || 'all', validatorSeed = process.env.VOXIAN_VALIDATOR_SEED, peers = envList(process.env.VOXIAN_PEERS), name = process.env.VOXIAN_NODE_NAME || '', quiet = false,
} = {}) {
  const fileStorage = storage ? null : new FileStorage(dataDir);
  const log = quiet ? () => {} : (m) => console.log(`[${name || 'voxian'}] ${m}`);
  // Bind the file storage to this genesis before the consensus engine reads its signing log.
  if (fileStorage) {
    const { makeGenesis, devnetKeys } = await import('../chain/blockchain.js');
    fileStorage.bind(makeGenesis(devnetKeys(secret)).hash);
  }
  const selfUrl = process.env.VOXIAN_PUBLIC_URL || (peers.length ? `http://127.0.0.1:${port}` : null);
  const node = createNode({ storage: storage ?? fileStorage, secret, validators, validatorSeed, peers, selfUrl, log });
  await node.init();
  node.start();

  // x402 shielded payments carry a ZK proof in the X-PAYMENT header (~30 KB), above Node's 16 KB default.
  const server = http.createServer({ maxHeaderSize: 256 * 1024 }, (req, res) => {
    handleHttp(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    });
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = /^\/(api|x402|paid|p2p)(\/|$)/.test(url.pathname);
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(url.pathname, res);
    }
    let body = null;
    try {
      const raw = req.method === 'POST' ? await readBody(req, url.pathname.startsWith('/p2p/') ? MAX_P2P_BODY : MAX_BODY) : '';
      if (raw) body = JSON.parse(raw);
    } catch (e) {
      res.writeHead(e.status || 400, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify({ error: e.status ? e.message : 'invalid JSON body' }));
      return;
    }
    const out = await node.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    res.writeHead(out.status, { 'content-type': 'application/json', ...CORS, ...out.headers });
    res.end(out.body === null ? undefined : JSON.stringify(out.body));
  }

  await new Promise((r) => server.listen(port, host, r));
  const addr = server.address();
  const c = node.consensus.status();
  if (!quiet) console.log(`⚡ Voxian ${name ? `node "${name}"` : 'devnet node'} running — http://localhost:${addr.port}  (height ${node.chain.height}, ${fileStorage ? `data ${fileStorage.file}` : 'in-memory'})`);
  if (!quiet) console.log(`   consensus: ${c.mode} · validators here: ${c.localValidators.join(', ') || 'none (observer)'}${peers.length ? ` · peers: ${peers.join(' ')}` : ''}`);
  if (!quiet && secret === DEFAULT_DEVNET_SECRET) console.log('   using the public devnet secret (set VOXIAN_DEVNET_SECRET for private validator keys)');
  return { server, node, close: () => { node.stop(); return new Promise((r) => server.close(r)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  const shutdown = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
