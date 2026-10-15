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
const BLOCKS_FILE = path.join(DATA_DIR, 'blocks.jsonl');
const MAX_BODY = 1_000_000;

class FileStorage {
  async load() {
    if (process.env.VOXIAN_RESET === '1') await this.clear();
    if (!fs.existsSync(BLOCKS_FILE)) return [];
    return fs.readFileSync(BLOCKS_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
  async append(block) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await fs.promises.appendFile(BLOCKS_FILE, JSON.stringify(block) + '\n');
  }
  async clear() { fs.rmSync(BLOCKS_FILE, { force: true }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

function serveStatic(urlPath, res) {
  // /src/* serves the shared isomorphic modules; everything else comes from web/.
  const [base, rel] = urlPath.startsWith('/src/') ? [path.join(ROOT, 'src'), urlPath.slice(5)] : [path.join(ROOT, 'web'), urlPath === '/' ? 'index.html' : urlPath.slice(1)];
  const file = path.resolve(base, decodeURIComponent(rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
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

export async function startServer({ port = PORT, host = HOST, storage = new FileStorage(), secret = process.env.VOXIAN_DEVNET_SECRET || DEFAULT_DEVNET_SECRET } = {}) {
  const node = createNode({ storage, secret });
  await node.init();
  node.start();

  // x402 shielded payments carry a ZK proof in the X-PAYMENT header (~30 KB), above Node's 16 KB default.
  const server = http.createServer({ maxHeaderSize: 256 * 1024 }, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isApi = /^\/(api|x402|paid)(\/|$)/.test(url.pathname);
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(url.pathname, res);
    }
    let body = null;
    try {
      const raw = req.method === 'POST' ? await readBody(req) : '';
      if (raw) body = JSON.parse(raw);
    } catch (e) {
      res.writeHead(e.status || 400, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify({ error: e.status ? e.message : 'invalid JSON body' }));
      return;
    }
    const out = await node.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    res.writeHead(out.status, { 'content-type': 'application/json', ...CORS, ...out.headers });
    res.end(out.body === null ? undefined : JSON.stringify(out.body));
  });

  await new Promise((r) => server.listen(port, host, r));
  const addr = server.address();
  console.log(`⚡ Voxian devnet node running — http://localhost:${addr.port}  (height ${node.chain.height}${storage instanceof FileStorage ? `, data ${BLOCKS_FILE}` : ', in-memory'})`);
  if (secret === DEFAULT_DEVNET_SECRET) console.log('   using the public devnet secret (set VOXIAN_DEVNET_SECRET for private validator keys)');
  return { server, node, close: () => { node.stop(); return new Promise((r) => server.close(r)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  const shutdown = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
