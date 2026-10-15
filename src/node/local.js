// In-browser Voxian node: the full chain, facilitator and paid APIs running inside the page.
// Used automatically when the web app is served statically (e.g. GitHub Pages) with no backend.
import { createNode } from './compose.js';

const KEY = 'voxian.devnet.blocks.v1';

class LocalStorageStorage {
  constructor() { this.blocks = []; this.warned = false; }
  async load() {
    try { this.blocks = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { this.blocks = []; }
    return this.blocks;
  }
  async append(block) {
    this.blocks.push(block);
    try { localStorage.setItem(KEY, JSON.stringify(this.blocks)); }
    catch { if (!this.warned) { this.warned = true; console.warn('[voxian] browser storage full; chain continues in memory only'); } }
  }
  async clear() { this.blocks = []; try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
}

export async function createLocalNode() {
  const storage = new LocalStorageStorage();
  const node = createNode({ storage });
  await node.init();
  node.start();

  async function localFetch(input, init = {}) {
    const url = new URL(String(input), 'http://voxian.local/');
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    let body = null;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 }); }
    }
    const out = await node.handle({ method: (init.method || 'GET').toUpperCase(), path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
    return new Response(out.body === null ? null : JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', ...out.headers } });
  }

  return { node, fetch: localFetch, reset: async () => { await storage.clear(); location.reload(); } };
}
