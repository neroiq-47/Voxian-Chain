// Demo paid APIs sold over x402. All logic is local and deterministic-ish (no external calls), so the
// demo works offline and on static hosting.
import { sha256Hex } from '../crypto/sha256.js';
import { randomBytes, bytesToHex } from '../crypto/encoding.js';
import { formatVox, UNIT } from '../chain/params.js';

const POS = ['good', 'great', 'excellent', 'bullish', 'fast', 'secure', 'private', 'love', 'growth', 'win', 'strong', 'innovative', 'efficient', 'safe', 'gain', 'up', 'success', 'happy', 'easy', 'trust'];
const NEG = ['bad', 'poor', 'bearish', 'slow', 'hack', 'exploit', 'scam', 'hate', 'loss', 'weak', 'risk', 'fail', 'down', 'expensive', 'broken', 'fear', 'leak', 'crash', 'angry', 'fraud'];

function sentiment(text) {
  const words = String(text).toLowerCase().match(/[a-z']+/g) ?? [];
  let pos = 0, neg = 0;
  const hits = [];
  words.forEach((w, i) => {
    const negated = ['not', "don't", 'never', 'no'].includes(words[i - 1]);
    if (POS.includes(w)) { negated ? neg++ : pos++; hits.push((negated ? '¬' : '+') + w); }
    if (NEG.includes(w)) { negated ? pos++ : neg++; hits.push((negated ? '¬' : '-') + w); }
  });
  const score = words.length ? (pos - neg) / Math.max(1, pos + neg) : 0;
  return { label: score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral', score: Number(score.toFixed(3)), positive: pos, negative: neg, signals: hits.slice(0, 12), words: words.length };
}

function summarize(text, n = 2) {
  const sentences = String(text).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length <= n) return { summary: sentences.join(' '), sentences: sentences.length, kept: sentences.length };
  const freq = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z]{4,}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const ws = s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    return { i, s, score: ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(ws.length + 1) + (i === 0 ? 1 : 0) };
  });
  const keep = scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i);
  return { summary: keep.map((k) => k.s).join(' '), sentences: sentences.length, kept: keep.length };
}

// Simulated price: smooth random walk derived from the chain tip, so every node agrees.
function price(pair, chain) {
  const base = { 'VOX-USD': 0.42, 'BTC-USD': 112_000, 'ETH-USD': 4_200, 'SOL-USD': 210 }[pair];
  if (base === undefined) throw Object.assign(new Error('unknown pair (try VOX-USD, BTC-USD, ETH-USD, SOL-USD)'), { status: 400 });
  const h = parseInt(sha256Hex(`${pair}:${Math.floor(chain.height / 5)}`).slice(0, 8), 16) / 0xffffffff;
  const drift = Math.sin(chain.height / 40) * 0.03 + (h - 0.5) * 0.02;
  const p = base * (1 + drift);
  return { pair, price: Number(p.toPrecision(6)), change24h: Number((drift * 100).toFixed(2)), source: 'voxian-sim-oracle', height: chain.height, observedAt: new Date().toISOString() };
}

const json = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

export function createServices(chain) {
  const u = (vox) => (BigInt(Math.round(vox * 1e8)) * UNIT / 100_000_000n).toString();
  return [
    {
      id: 'oracle-price', name: 'Price Oracle', category: 'Data', method: 'GET', path: '/paid/oracle/price', price: u(0.01),
      description: 'Signed market price feed for VOX and majors (simulated).', example: '?pair=VOX-USD',
      handler: (req) => price(req.query.pair || 'VOX-USD', chain),
    },
    {
      id: 'ai-sentiment', name: 'AI Sentiment', category: 'AI', method: 'POST', path: '/paid/ai/sentiment', price: u(0.02),
      description: 'Lexicon-based sentiment scoring for text an agent is reading.', example: { text: 'Voxian payments are fast and private. Not a scam.' },
      handler: (req) => {
        const text = String(json(req).text ?? '').slice(0, 10_000);
        if (!text) throw Object.assign(new Error('body.text required'), { status: 400 });
        return sentiment(text);
      },
    },
    {
      id: 'ai-summarize', name: 'AI Summarizer', category: 'AI', method: 'POST', path: '/paid/ai/summarize', price: u(0.05),
      description: 'Extractive summarization: keeps the most informative sentences.', example: { text: 'Paste a long article here.', sentences: 2 },
      handler: (req) => {
        const b = json(req);
        const text = String(b.text ?? '').slice(0, 20_000);
        if (!text) throw Object.assign(new Error('body.text required'), { status: 400 });
        return summarize(text, Math.min(5, Math.max(1, Number(b.sentences) || 2)));
      },
    },
    {
      id: 'chain-insights', name: 'Chain Insights', category: 'Data', method: 'GET', path: '/paid/data/chain-insights', price: u(0.01),
      description: 'Network analytics: throughput, issuance, shielded pool and x402 activity.',
      handler: () => {
        const recent = chain.blocks.slice(-50);
        const txs = recent.reduce((n, b) => n + b.txs.length, 0);
        const span = (recent.at(-1).timestamp - recent[0].timestamp) / 1000 || 1;
        const s = chain.state;
        return {
          height: chain.height, txsLast50Blocks: txs, tps: Number((txs / span).toFixed(3)),
          issuedVOX: formatVox(s.issued), shieldedPoolVOX: formatVox(s.pool), x402Payments: s.stats.x402Payments,
          x402PrivatePayments: s.stats.x402PrivatePayments, shieldedTxs: s.stats.shieldedTxs, mempool: chain.mempool.length,
        };
      },
    },
    {
      id: 'randomness', name: 'Randomness Beacon', category: 'Utility', method: 'GET', path: '/paid/random', price: u(0.005),
      description: 'Random 256-bit value bound to the latest block signature.',
      handler: () => {
        const salt = bytesToHex(randomBytes(16));
        return { value: sha256Hex(`${chain.tip.hash}:${chain.tip.signature}:${salt}`), salt, blockHash: chain.tip.hash, height: chain.height, recipe: 'sha256(blockHash:blockSignature:salt)' };
      },
    },
  ];
}
