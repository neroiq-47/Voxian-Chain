// Thin JSON client for the Voxian node API. `fetchFn` is window.fetch, Node's fetch, or the in-browser node.
export class ChainClient {
  constructor(fetchFn, base = '') {
    this.fetch = fetchFn;
    this.base = base;
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  info() { return this.request('api/info'); }
  stats() { return this.request('api/stats'); }
  blocks(limit = 20) { return this.request(`api/blocks?limit=${limit}`); }
  block(id) { return this.request(`api/blocks/${encodeURIComponent(id)}`); }
  tx(hash) { return this.request(`api/tx/${encodeURIComponent(hash)}`); }
  account(address) { return this.request(`api/accounts/${encodeURIComponent(address)}`); }
  mempool() { return this.request('api/mempool'); }
  async notes() { return (await this.request('api/notes')).notes; }
  submit(tx) { return this.request('api/tx', { method: 'POST', body: tx }); }
  faucet(address) { return this.request('api/faucet', { method: 'POST', body: { address } }); }
  services() { return this.request('api/services'); }
  revenue() { return this.request('api/services/revenue'); }
}
