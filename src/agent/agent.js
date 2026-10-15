// Autonomous agent that discovers paid APIs and pays for them over x402 within a budget.
// The "planner" is rule-based so the demo needs no LLM key; swap plan() for an LLM call in production.
import { x402Fetch } from '../x402/client.js';
import { formatVox } from '../chain/params.js';

const DEFAULT_TEXT = 'Voxian is a proposed Layer 1 blockchain for private, verifiable payments. AI agents can pay for APIs with x402 and keep sensitive details private with zero-knowledge proofs. Payments are fast and programmable. Developers get simple, secure tools. Some people fear crypto is risky, but strong privacy and good engineering build trust.';

export class VoxAgent {
  constructor({ fetch, api, wallet, budget, scheme = 'auto', log = () => {} }) {
    Object.assign(this, { fetch, api, wallet, budget: BigInt(budget), scheme, log });
    this.spent = 0n;
    this.receipts = [];
  }

  get remaining() { return this.budget - this.spent; }

  plan(goal, catalog) {
    const g = goal.toLowerCase();
    const want = [];
    const add = (id, input) => { const s = catalog.find((x) => x.id === id); if (s && !want.some((w) => w.service.id === id)) want.push({ service: s, input }); };
    const pair = (g.match(/\b(btc|eth|sol|vox)\b/)?.[1] ?? 'vox').toUpperCase() + '-USD';
    if (/price|market|quote|worth|btc|eth|sol\b/.test(g)) add('oracle-price', { query: `?pair=${pair}` });
    if (/network|chain|stats|activity|health|insight/.test(g)) add('chain-insights', {});
    if (/sentiment|feel|mood|opinion|tone/.test(g)) add('ai-sentiment', { body: { text: DEFAULT_TEXT } });
    if (/summar|tl;?dr|brief|digest/.test(g)) add('ai-summarize', { body: { text: DEFAULT_TEXT, sentences: 2 } });
    if (/random|lottery|dice|coin|pick/.test(g)) add('randomness', {});
    if (want.length === 0 || /report|research|everything|full/.test(g)) {
      add('oracle-price', { query: `?pair=${pair}` });
      add('chain-insights', {});
      add('ai-sentiment', { body: { text: DEFAULT_TEXT } });
      add('ai-summarize', { body: { text: DEFAULT_TEXT, sentences: 2 } });
    }
    return want;
  }

  async run(goal) {
    this.log({ kind: 'think', message: `Goal: "${goal}" · budget ${formatVox(this.budget)} VOX · scheme ${this.scheme}` });
    const { services } = await this.api.services();
    this.log({ kind: 'discover', message: `Discovered ${services.length} paid APIs via /api/services` });
    const steps = this.plan(goal, services);
    const total = steps.reduce((s, x) => s + BigInt(x.service.price), 0n);
    this.log({ kind: 'plan', message: `Plan: ${steps.map((s) => s.service.name).join(' → ')} (≈${formatVox(total)} VOX + fees)` });

    const results = [];
    for (const { service, input } of steps) {
      const price = BigInt(service.price);
      if (price > this.remaining) { this.log({ kind: 'skip', message: `Skipping ${service.name}: price ${formatVox(price)} > remaining budget ${formatVox(this.remaining)}` }); continue; }
      this.log({ kind: 'call', message: `${service.method} ${service.path}${input.query ?? ''}` });
      try {
        const init = service.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body) } : { method: 'GET' };
        const r = await x402Fetch(this.fetch, service.path.slice(1) + (input.query ?? ''), init, { wallet: this.wallet, api: this.api, scheme: this.scheme, maxAmount: this.remaining, onStep: this.log });
        this.spent += r.price;
        this.receipts.push({ service: service.name, scheme: r.scheme, price: r.price, tx: r.receipt?.transaction });
        results.push({ service, data: r.data });
        this.log({ kind: 'result', message: `${service.name}: ${brief(service.id, r.data)}`, data: r.data });
      } catch (e) {
        this.log({ kind: 'error', message: `${service.name} failed: ${e.message}` });
      }
    }
    const report = compose(goal, results);
    this.log({ kind: 'done', message: `Done. Spent ${formatVox(this.spent)} VOX across ${this.receipts.length} x402 payments.`, report });
    return { report, spent: this.spent, receipts: this.receipts, results };
  }
}

function brief(id, d) {
  if (id === 'oracle-price') return `${d.pair} = $${d.price} (${d.change24h >= 0 ? '+' : ''}${d.change24h}%)`;
  if (id === 'chain-insights') return `height ${d.height}, ${d.x402Payments} x402 payments, shielded pool ${d.shieldedPoolVOX} VOX`;
  if (id === 'ai-sentiment') return `${d.label} (score ${d.score})`;
  if (id === 'ai-summarize') return `"${d.summary}"`;
  if (id === 'randomness') return d.value.slice(0, 24) + '…';
  return JSON.stringify(d).slice(0, 80);
}

function compose(goal, results) {
  if (!results.length) return 'No data purchased.';
  return [`Report for: ${goal}`, ...results.map((r) => `• ${r.service.name}: ${brief(r.service.id, r.data)}`)].join('\n');
}
