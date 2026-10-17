// Voxian web app: explorer, non-custodial wallet (public + shielded), x402 marketplace and AI agent console.
// Talks to a full node over HTTP, or boots a complete in-browser node when served statically.
import { ChainClient } from './src/wallet/client.js';
import { Wallet } from './src/wallet/wallet.js';
import { VoxAgent } from './src/agent/agent.js';
import { x402Fetch } from './src/x402/client.js';
import { decodeHeader, PAYMENT_HEADER, RESPONSE_HEADER } from './src/x402/protocol.js';
import { formatVox, parseVox, MIN_FEE } from './src/chain/params.js';
import { isAddress } from './src/chain/keys.js';
import { isZAddress } from './src/zk/shielded.js';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h, a = 10, b = 6) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h ?? '');
const vox = (u) => (u === null || u === undefined ? '—' : `${formatVox(BigInt(u))} VOX`);
const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
const nextFrame = () => new Promise((r) => setTimeout(r, 30)); // let the UI paint before heavy proving

function toast(msg, kind = '') {
  const t = $('#toast');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

// One wallet operation at a time: concurrent builds would reuse the same nonce or the same notes.
let walletBusy = false;
async function busy(btn, label, fn) {
  if (walletBusy) { toast('Another transaction is still being built. One moment…', 'error'); return; }
  walletBusy = true;
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { await nextFrame(); return await fn(); }
  catch (e) { toast(e.message, 'error'); }
  finally { walletBusy = false; if (btn) { btn.disabled = false; btn.textContent = old; } }
}

const TX_LABELS = { transfer: 'transfer', shield: 'shield', auth_transfer: 'x402 · exact', validator_register: 'validator', stake: 'stake', unstake: 'unstake', evidence: 'slashing evidence', unjail: 'unjail' };
const typeTag = (t) => `<span class="tag ${esc(t.type)}">${esc(t.type === 'shielded' ? (t.ref?.startsWith('x402:') ? 'x402 · private' : 'private') : TX_LABELS[t.type] ?? t.type)}</span>${t.pending ? ' <span class="tag pending">pending</span>' : ''}`;
const shortName = (n) => String(n ?? '').replace('vox-validator-', '');
const pct = (x) => (x === null || x === undefined ? '—' : `${x}%`);
const addrLink = (a) => (isAddress(a) ? `<a href="#explorer/${esc(a)}" class="mono">${esc(short(a, 10, 4))}</a>` : `<span class="muted">${esc(a ?? '—')}</span>`);

// ---------- state ----------
let fetchFn, api, mode, localNode, info, wallet;
const noteCache = new Map(); // note id -> scan result (or null if not ours)
let myNotes = [];
let currentView = '';

const SEED_KEY = `voxian.wallet.seed:${location.pathname}`; // per path: GitHub Pages sites share an origin
function saveSeed(w) {
  try { localStorage.setItem(SEED_KEY, w.seedHex); }
  catch { toast('Could not save your wallet seed in this browser. Use "Show seed" to back it up.', 'error'); }
}

function loadWallet() {
  let seed = null;
  try { seed = localStorage.getItem(SEED_KEY); } catch { /* storage unavailable */ }
  const w = seed ? new Wallet(seed) : Wallet.generate();
  saveSeed(w);
  return w;
}

function setWallet(w) {
  wallet = w;
  noteCache.clear();
  myNotes = [];
  saveSeed(w);
}

async function scanMyNotes() {
  const notes = await api.notes();
  for (const n of notes) {
    if (!noteCache.has(n.id)) noteCache.set(n.id, wallet.scanNotes([n])[0] ?? null);
  }
  myNotes = notes.filter((n) => noteCache.get(n.id)).map((n) => ({ ...noteCache.get(n.id), spent: n.spent, confirmed: n.confirmed, height: n.height }));
  return myNotes;
}
const shieldedBalance = () => myNotes.filter((n) => !n.spent).reduce((s, n) => s + n.value, 0n);

// ---------- views ----------
const views = {};

views.overview = {
  render: () => `
    <section class="hero">
      <div class="eyebrow">Live devnet · ${mode === 'browser' ? 'running in your browser' : 'full node'}</div>
      <h1>Privacy meets the <span>autonomous economy.</span></h1>
      <p>Voxian is a Layer 1 blockchain combining zero-knowledge technology with x402 payments, so people, apps and AI agents can pay for
      digital services privately, securely and automatically. This is a live devnet. Every block, proof and payment below is real and runs ${mode === 'browser' ? 'in your browser' : 'on this node'}.</p>
      <div class="pills"><span class="pill">🌐 Built for AI agents, APIs &amp; services</span><span class="pill">🔐 ZK confidential notes</span><span class="pill">⚡ x402 programmable payments</span><span class="pill">⛓️ Independent Layer 1</span></div>
      <div class="row" style="margin-top:14px"><a class="btn" href="#wallet">Open wallet →</a><a class="btn ghost" href="#agent">Run an AI agent</a></div>
    </section>
    <div class="grid g4 section" id="stats"></div>
    <div class="grid g3 section">
      <div class="card span2"><div class="row between"><h3>Latest blocks</h3><a href="#explorer" class="small">Explorer →</a></div><div class="table-wrap" id="blocks"></div></div>
      <div class="card"><h3>Supply</h3><div id="supply"></div></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><div class="row between"><h3>Validator cluster · PoH + BFT finality</h3><span class="small muted" id="cluster-mode"></span></div><div id="validators"></div><p class="small muted" id="cluster-note" style="margin-bottom:0"></p></div>
      <div class="card"><h3>VOX token</h3><div class="kv">
        <div>Ticker</div><div><b>VOX</b></div>
        <div>Max supply</div><div>210,000,000 VOX (hard cap)</div>
        <div>Decimals</div><div>8 · smallest unit 0.00000001 VOX</div>
        <div>Issuance</div><div>${vox(info.initialReward)} / block, halving every ${info.halvingInterval.toLocaleString()} blocks</div>
        <div>Uses</div><div>Network fees, validator staking, x402 payments</div>
        <div>Network</div><div>${esc(info.chainId)}</div>
      </div></div>
    </div>`,
  async update() {
    const [s, { blocks }, c, i] = await Promise.all([api.stats(), api.blocks(8), api.consensus(), api.info()]);
    info = i; // the active validator set changes at epoch boundaries
    $('#stats').innerHTML = [
      ['Block height', `#${s.height.toLocaleString()}`, `avg block ${(s.avgBlockMs / 1000).toFixed(1)}s · mempool ${s.mempool}`],
      ['Transactions', s.txCount.toLocaleString(), `${s.transfers} transfers · ${s.shieldedTxs} shielded`],
      ['x402 payments', s.x402Payments.toLocaleString(), `${s.x402PrivatePayments} private · ${vox(s.x402PublicVolume)} public volume`],
      ['Shielded pool', vox(s.supply.shieldedPool), `${s.notes} notes · ${s.spentNotes} spent`],
    ].map(([l, v, sub]) => `<div class="card stat"><div class="label">${l}</div><div class="value">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    $('#blocks').innerHTML = blockTable(blocks);
    const pct = Number((BigInt(s.supply.issued) * 10000n) / BigInt(s.supply.maxSupply)) / 100;
    $('#supply').innerHTML = `<div class="kv">
      <div>Issued</div><div>${vox(s.supply.issued)}</div>
      <div>Max</div><div>${vox(s.supply.maxSupply)}</div></div>
      <div class="bar" style="margin:12px 0"><div style="width:${Math.max(pct, 0.5)}%"></div></div>
      <div class="kv"><div>Circulating</div><div>${vox(s.supply.circulating)}</div>
      <div>Staked</div><div>${vox(s.supply.staked)}</div>
      <div>Shielded</div><div>${vox(s.supply.shieldedPool)}</div>
      <div>Burned</div><div>${vox(s.supply.burned ?? 0)}</div>
      <div>Next reward</div><div>${vox(s.supply.nextReward)}</div>
      <div>Conservation</div><div class="${s.supply.conserved ? 'ok' : 'bad'}">${s.supply.conserved ? '✓ issued = circulating + staked + shielded + burned' : '✗ mismatch'}</div></div>`;
    const signed = new Set(c.lastCommit?.signers ?? []);
    const local = new Set((c.localValidators ?? []).map(shortName));
    const peers = c.peers ?? [];
    $('#cluster-mode').textContent = `slot ${c.slot} · epoch ${c.epoch} · ${c.mode === 'cluster' ? `${peers.filter((p) => p.ok).length}/${peers.length} peers online` : 'standalone'}`;
    $('#validators').innerHTML = `<div class="table-wrap"><table><tr><th>Validator</th><th>Stake</th><th>Weight</th><th>Last block</th></tr>${info.validators.map((v) => `
      <tr><td>${esc(shortName(v.name))}${local.has(shortName(v.name)) ? ' <span class="tag">this node</span>' : ''}<div class="small">${addrLink(v.address)}</div></td><td>${vox(v.stake)}</td>
      <td>${esc(Number(v.weightPct ?? 0).toFixed(1))}%</td><td>${signed.has(v.name) ? '<span class="ok">✓ signed</span>' : c.lastCommit ? '<span class="muted">—</span>' : ''}</td></tr>`).join('')}</table></div>`;
    const lc = c.lastCommit;
    $('#cluster-note').innerHTML = lc
      ? `Block #${esc(lc.height)} (slot ${esc(lc.slot)}, ${esc(lc.pohTicks)} PoH ticks) finalized in round ${esc(lc.round)} by ${esc(lc.signers.length)} validators with <b>${esc(lc.stakePct ?? '—')}%</b> of stake (needs &gt; 66.67%). Now at slot ${esc(c.slot)} · epoch ${esc(c.epoch)} · round ${esc(c.round)}. <a href="#staking">Staking →</a>`
      : 'Waiting for the first commit…';
  },
};

function blockTable(blocks) {
  return `<table><tr><th>Height</th><th>Slot</th><th>Hash</th><th>Proposer</th><th>Txs</th><th>Finality</th><th>Age</th></tr>${blocks.map((b) => `
    <tr class="click" data-go="#explorer/${esc(b.height)}"><td><b>#${esc(b.height)}</b></td><td class="mono" title="${esc(b.pohTicks ?? 0)} PoH ticks in this block">${esc(b.slot ?? '—')}</td><td class="mono">${esc(short(b.hash, 8, 4))}</td><td>${esc(shortName(b.proposerName))}${b.round ? ` <span class="tag" title="committed in BFT round ${esc(b.round)} (earlier rounds timed out or split)">r${esc(b.round)}</span>` : ''}</td><td>${b.txCount}</td><td>${b.height === 0 ? '—' : `<span class="ok" title="validator signatures in the commit certificate">✓ ${b.signers}/${info.validators.length}</span>`}</td><td class="muted">${b.height === 0 ? 'genesis' : ago(b.timestamp)}</td></tr>`).join('')}</table>`;
}

views.wallet = {
  render: () => `
    <div class="row between"><h2>Wallet</h2><span class="muted small">Keys never leave this browser. Transactions are built &amp; proven client-side.</span></div>
    <div class="grid g3 section">
      <div class="card stat glow"><div class="label">Public balance</div><div class="value" id="w-pub">—</div><div class="sub" id="w-pub-sub"></div></div>
      <div class="card stat glow"><div class="label">🔐 Shielded balance</div><div class="value" id="w-shielded">—</div><div class="sub" id="w-shielded-sub">scanning notes with your view key…</div></div>
      <div class="card"><h3>Devnet faucet</h3><p class="small muted">Get 1,000 test VOX (30s cooldown).</p><button id="btn-faucet" class="volt">⚡ Request 1,000 VOX</button></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h3>Public address</h3><div class="addr copy" data-copy="${esc(wallet.address)}" title="click to copy">${esc(wallet.address)}</div>
        <h3 style="margin-top:14px">Shielded z-address</h3><div class="addr copy small" data-copy="${esc(wallet.zaddress)}" title="click to copy">${esc(wallet.zaddress)}</div>
        <div class="row" style="margin-top:12px"><button class="ghost small" id="btn-new">New wallet</button><button class="ghost small" id="btn-export">Show seed</button><button class="ghost small" id="btn-import">Import seed</button></div>
        <div id="seed-box"></div></div>
      <div class="card"><h3>Send VOX (public)</h3>
        <form id="f-send"><label>Recipient (vox1…)</label><input name="to" placeholder="vox1…" required />
          <div class="row"><div><label>Amount (VOX)</label><input name="amount" placeholder="10" required /></div><div><label>Memo (optional, public)</label><input name="memo" maxlength="140" /></div></div>
          <div class="row" style="margin-top:12px"><button>Send</button><span class="small muted">fee ${vox(MIN_FEE.transfer)}</span></div></form></div>
    </div>
    <div class="grid g3 section">
      <div class="card"><h3>1 · Shield</h3><p class="small muted">Move public VOX into a confidential note. The amount is hidden in a Pedersen commitment and the note gets a one-time stealth key.</p>
        <form id="f-shield"><label>Amount (VOX)</label><input name="amount" placeholder="100" required /><div class="row" style="margin-top:12px"><button>Shield</button><span class="small muted">fee ${vox(MIN_FEE.shield)}</span></div></form></div>
      <div class="card"><h3>2 · Private send</h3><p class="small muted">Pay any z-address. Sender, receiver and amount stay hidden. Validators check ZK range proofs and a balance proof instead.</p>
        <form id="f-zsend"><label>Recipient z-address</label><input name="to" placeholder="voxz…" required /><div class="row small" style="margin-top:6px"><a href="#" data-fill="self">use my own</a><a href="#" data-fill="service">x402 service</a></div>
          <label>Amount (VOX)</label><input name="amount" placeholder="5" required /><div class="row" style="margin-top:12px"><button>Send privately</button><span class="small muted">fee ${vox(MIN_FEE.shielded)}</span></div></form></div>
      <div class="card"><h3>3 · Unshield</h3><p class="small muted">Withdraw from your notes to a public address. Only the withdrawn amount becomes public.</p>
        <form id="f-unshield"><label>To (vox1…)</label><input name="to" value="${esc(wallet.address)}" required /><label>Amount (VOX)</label><input name="amount" placeholder="1" required /><div class="row" style="margin-top:12px"><button>Unshield</button><span class="small muted">fee ${vox(MIN_FEE.shielded)}</span></div></form></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h3>Activity</h3><div class="table-wrap" id="w-activity"></div></div>
      <div class="card"><h3>My confidential notes</h3><p class="small muted">Only your view key can find these. On-chain they are unlinkable commitments.</p><div class="table-wrap" id="w-notes"></div></div>
    </div>`,
  async update() {
    const [a] = await Promise.all([api.account(wallet.address), scanMyNotes()]);
    $('#w-pub').textContent = vox(a.pendingBalance);
    $('#w-pub-sub').textContent = a.pendingBalance !== a.balance ? `confirmed ${vox(a.balance)} · pending changes` : `nonce ${a.nonce}`;
    $('#w-shielded').textContent = vox(shieldedBalance());
    const unspent = myNotes.filter((n) => !n.spent);
    $('#w-shielded-sub').textContent = `${unspent.length} unspent note${unspent.length === 1 ? '' : 's'}`;
    $('#w-activity').innerHTML = a.txs.length ? `<table><tr><th>Type</th><th>Amount</th><th>Counterparty</th><th></th></tr>${a.txs.map((t) => {
      const out = t.from === wallet.address;
      return `<tr class="click" data-go="#explorer/${t.hash}"><td>${typeTag(t)}</td><td class="${out ? 'bad' : 'ok'}">${out ? '−' : '+'}${vox(t.amount)}</td><td>${addrLink(out ? t.to : t.from)}</td><td class="muted small">${t.pending ? '' : '#' + t.height}</td></tr>`;
    }).join('')}</table>` : '<p class="muted small">No activity yet. Request VOX from the faucet to start.</p>';
    $('#w-notes').innerHTML = myNotes.length ? `<table><tr><th>Note</th><th>Value</th><th>Status</th></tr>${[...myNotes].reverse().map((n) => `
      <tr><td class="mono">${esc(short(n.id, 10, 4))}</td><td>${vox(n.value)}</td><td>${n.spent ? '<span class="muted">spent</span>' : n.confirmed ? '<span class="ok">unspent</span>' : '<span class="tag pending">pending</span>'}</td></tr>`).join('')}</table>` : '<p class="muted small">No notes yet. Shield some VOX.</p>';
  },
  bind() {
    $('#btn-faucet').onclick = (e) => busy(e.target, 'Requesting…', async () => { const r = await api.faucet(wallet.address); toast(`Faucet sent ${r.formatted} VOX · tx ${short(r.hash)}`, 'success'); refresh(); });
    $('#btn-new').onclick = () => { if (confirm('Create a new wallet? Save your current seed first if you want to keep it.')) { setWallet(Wallet.generate()); route(true); } };
    $('#btn-export').onclick = () => { $('#seed-box').innerHTML = `<label>Seed (keep secret, devnet only)</label><div class="addr copy" data-copy="${esc(wallet.seedHex)}">${esc(wallet.seedHex)}</div>`; };
    $('#btn-import').onclick = () => {
      const s = prompt('Paste a 64-hex-character wallet seed:');
      if (!s) return;
      try { setWallet(new Wallet(s.trim().toLowerCase())); route(true); toast('Wallet imported', 'success'); } catch (e) { toast(e.message, 'error'); }
    };
    document.querySelectorAll('[data-fill]').forEach((a) => (a.onclick = async (e) => {
      e.preventDefault();
      $('#f-zsend').to.value = a.dataset.fill === 'self' ? wallet.zaddress : (await api.services()).payee.zaddress;
    }));
    formHandler('#f-send', 'Signing…', async (f) => {
      if (!isAddress(f.to.value.trim())) throw new Error('invalid vox1 address');
      const a = await api.account(wallet.address);
      const tx = wallet.transfer({ to: f.to.value.trim(), amount: parseVox(f.amount.value), nonce: a.pendingNonce, memo: f.memo.value.trim() || undefined });
      return api.submit(tx);
    });
    formHandler('#f-shield', 'Shielding…', async (f) => {
      const a = await api.account(wallet.address);
      return api.submit(wallet.shield({ amount: parseVox(f.amount.value), nonce: a.pendingNonce }));
    });
    formHandler('#f-zsend', 'Proving…', async (f) => {
      if (!isZAddress(f.to.value.trim())) throw new Error('invalid z-address');
      const owned = await scanMyNotes();
      const { tx } = wallet.buildShielded({ owned, recipients: [{ zaddress: f.to.value.trim(), value: parseVox(f.amount.value) }] });
      return api.submit(tx);
    });
    formHandler('#f-unshield', 'Proving…', async (f) => {
      if (!isAddress(f.to.value.trim())) throw new Error('invalid vox1 address');
      const owned = await scanMyNotes();
      const { tx } = wallet.buildShielded({ owned, publicOut: { to: f.to.value.trim(), amount: parseVox(f.amount.value) } });
      return api.submit(tx);
    });
  },
};

function formHandler(sel, label, fn) {
  const form = $(sel);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), label, async () => {
      const r = await fn(form);
      toast(`Submitted · tx ${short(r.hash)} · included in the next block`, 'success');
      form.querySelectorAll('input[name=amount],input[name=memo]').forEach((i) => (i.value = ''));
      refresh();
    });
  };
}

// ---------- x402 marketplace ----------
let catalog = null;
views.market = {
  render: () => `
    <div class="row between"><h2>x402 Marketplace</h2><span class="muted small">HTTP 402 Payment Required → pay → retry with <code>X-PAYMENT</code> → content + <code>X-PAYMENT-RESPONSE</code></span></div>
    <p class="muted">Each API below answers <code>402</code> with two payment options: <b>exact</b> (signed authorization, gasless for the payer, public) and
      <b>zk-shielded</b> (a confidential note payment: the chain never sees who paid or how much). Fund your wallet and shield a little VOX to try private payments.</p>
    <div class="grid g3 section" id="m-services"><div class="card muted">Loading catalog…</div></div>
    <div class="grid g2 section">
      <div class="card"><h3>Protocol trace</h3><div id="m-trace" class="trace"><p class="muted small">Call a service to see the full x402 exchange.</p></div></div>
      <div class="card"><h3>Service operator view</h3><p class="small muted">Public revenue is visible to everyone. Shielded revenue is visible only to the operator, who scans with its view key.</p><div id="m-revenue"></div>
        <h3 style="margin-top:16px">Your wallet</h3><div id="m-wallet" class="kv"></div></div>
    </div>`,
  async update() {
    const [rev, a] = await Promise.all([api.revenue(), api.account(wallet.address), scanMyNotes()]);
    $('#m-revenue').innerHTML = `<div class="kv"><div>Public (exact)</div><div>${vox(rev.publicRevenue)}</div><div>🔐 Shielded</div><div>${vox(rev.shieldedRevenue)} · ${rev.shieldedPayments} payments</div></div>`;
    $('#m-wallet').innerHTML = `<div>Public</div><div>${vox(a.pendingBalance)}</div><div>Shielded</div><div>${vox(shieldedBalance())}</div>`;
    if (!catalog) {
      catalog = await api.services();
      $('#m-services').innerHTML = catalog.services.map((s) => `
        <div class="card service" data-id="${esc(s.id)}">
          <div class="row between"><b>${esc(s.name)}</b><span class="tag">${esc(s.category)}</span></div>
          <div class="price volt">${esc(s.priceFormatted)} VOX <span class="small muted">/ call</span></div>
          <div class="small muted">${esc(s.description)}</div>
          <code class="small">${esc(s.method)} ${esc(s.path)}</code>
          ${s.method === 'POST' ? `<textarea>${esc(JSON.stringify(s.example, null, 1))}</textarea>` : `<input value="${esc(s.example ?? '')}" placeholder="query string" />`}
          <div class="row"><button class="small" data-pay="exact">Pay · exact</button><button class="small ghost" data-pay="zk-shielded">🔐 Pay · private</button></div>
        </div>`).join('');
      document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => callService(b)));
    }
  },
};

async function callService(btn) {
  const card = btn.closest('.service');
  const s = catalog.services.find((x) => x.id === card.dataset.id);
  const scheme = btn.dataset.pay;
  const trace = $('#m-trace');
  trace.innerHTML = '';
  const add = (cls, title, body) => { trace.insertAdjacentHTML('beforeend', `<div class="step ${cls}"><b>${esc(title)}</b>${body ? `<pre>${esc(body)}</pre>` : ''}</div>`); };
  const tracedFetch = async (url, init = {}) => {
    const pay = init.headers?.[PAYMENT_HEADER];
    if (pay) {
      const d = decodeHeader(pay);
      const shown = JSON.parse(JSON.stringify(d), (k, v) => (k === 'rp' ? `<${v.length / 2} byte ZK range proof>` : v));
      add('', `→ ${init.method || 'GET'} /${url} with X-PAYMENT (${(pay.length / 1024).toFixed(1)} KB)`, JSON.stringify(shown, null, 2));
    } else add('', `→ ${init.method || 'GET'} /${url}`, init.body || '');
    const res = await fetchFn(url, init);
    const body = await res.clone().json().catch(() => null);
    const rh = res.headers.get(RESPONSE_HEADER);
    add(res.status === 402 ? 's402' : res.ok ? 's200' : 'serr', `← ${res.status}${res.status === 402 ? ' Payment Required' : ''}`,
      (rh ? `X-PAYMENT-RESPONSE: ${JSON.stringify(decodeHeader(rh), null, 2)}\n\n` : '') + JSON.stringify(body, null, 2));
    return res;
  };
  await busy(btn, scheme === 'exact' ? 'Signing…' : 'Proving…', async () => {
    const input = card.querySelector('textarea, input');
    const init = s.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(JSON.parse(input.value || '{}')) } : { method: 'GET' };
    const url = s.path.slice(1) + (s.method === 'GET' && input.value ? (input.value.startsWith('?') ? input.value : '?' + input.value) : '');
    const r = await x402Fetch(tracedFetch, url, init, { wallet, api, scheme, ownedNotes: scanMyNotes, onStep: (e) => (e.kind === 'prove' || e.kind === 'sign') && add('', e.message) });
    toast(`Paid ${vox(r.price)}${r.cost > r.price ? ` + ${vox(r.cost - r.price)} fee` : ''} via ${r.scheme} · tx ${short(r.receipt?.transaction)}`, 'success');
    refresh();
  });
}

// ---------- AI agent ----------
views.agent = {
  render: () => `
    <div class="row between"><h2>Autonomous AI Agent</h2><span class="muted small">Discovers paid APIs, plans, and pays per call over x402. No human in the loop.</span></div>
    <div class="grid g3 section">
      <div class="card span2">
        <form id="f-agent">
          <label>Goal</label><input name="goal" value="Full research report on VOX price, network activity and market sentiment" />
          <div class="chips" style="margin-top:8px">${['What is the BTC price?', 'Summarize the Voxian pitch', 'How healthy is the network?', 'Pick a random lottery number', 'Market sentiment on Voxian'].map((g) => `<span class="chip" data-goal="${esc(g)}">${esc(g)}</span>`).join('')}</div>
          <div class="row"><div><label>Budget (VOX)</label><input name="budget" value="0.5" /></div>
            <div><label>Payment mode</label><select name="scheme"><option value="auto">auto (private if shielded funds)</option><option value="zk-shielded">always private (zk-shielded)</option><option value="exact">always public (exact)</option></select></div></div>
          <div class="row" style="margin-top:14px"><button>▶ Run agent</button><span class="small muted" id="a-funds"></span></div>
        </form>
      </div>
      <div class="card"><h3>Agent wallet</h3><p class="small muted">The agent spends from your browser wallet, capped by its budget.</p><div id="a-wallet" class="kv"></div></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h3>Agent log</h3><div class="log" id="a-log"><span class="muted">Idle.</span></div></div>
      <div class="card"><h3>Report</h3><pre id="a-report">—</pre><h3 style="margin-top:14px">x402 receipts</h3><div id="a-receipts" class="table-wrap"></div></div>
    </div>`,
  async update() {
    const [a] = await Promise.all([api.account(wallet.address), scanMyNotes()]);
    $('#a-wallet').innerHTML = `<div>Public</div><div>${vox(a.pendingBalance)}</div><div>Shielded</div><div>${vox(shieldedBalance())}</div>`;
    $('#a-funds').textContent = BigInt(a.pendingBalance) === 0n && shieldedBalance() === 0n ? '⚠ Wallet empty: use the faucet on the Wallet tab first.' : '';
  },
  bind() {
    document.querySelectorAll('[data-goal]').forEach((c) => (c.onclick = () => { $('#f-agent').goal.value = c.dataset.goal; }));
    const form = $('#f-agent');
    form.onsubmit = (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), 'Agent running…', async () => {
        const log = $('#a-log');
        log.innerHTML = '';
        $('#a-report').textContent = '…';
        $('#a-receipts').innerHTML = '';
        const agent = new VoxAgent({
          fetch: fetchFn, api, wallet, budget: parseVox(form.budget.value), scheme: form.scheme.value, ownedNotes: scanMyNotes,
          log: (ev) => { log.insertAdjacentHTML('beforeend', `<div class="ln"><span class="k ${esc(ev.kind)}">${esc(ev.kind)}</span><span>${esc(ev.message)}</span></div>`); log.scrollTop = log.scrollHeight; },
        });
        const r = await agent.run(form.goal.value);
        $('#a-report').textContent = r.report;
        $('#a-receipts').innerHTML = r.receipts.length ? `<table><tr><th>Service</th><th>Scheme</th><th>Cost</th><th>Tx</th></tr>${r.receipts.map((x) => `<tr><td>${esc(x.service)}</td><td><span class="tag ${x.scheme === 'exact' ? 'x402' : 'shielded'}">${esc(x.scheme)}</span></td><td>${vox(x.cost)}</td><td>${x.tx ? `<a class="mono" href="#explorer/${esc(x.tx)}">${esc(short(x.tx, 8, 4))}</a>` : ''}</td></tr>`).join('')}</table>` : '';
        refresh();
      });
    };
  },
};

// ---------- staking (Proof of History + Proof of Stake) ----------
const VALIDATOR_KEY = `voxian.validator:${location.pathname}`; // in-browser node: remembers to re-run the wallet's validator
let stakingValKey = '';
const bpsToPct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;

function runLocalValidator(name) {
  localNode.node.consensus.addLocalValidator(wallet.asValidator(name));
  try { localStorage.setItem(VALIDATOR_KEY, JSON.stringify({ address: wallet.address, name })); } catch { /* storage unavailable */ }
}

views.staking = {
  render: () => {
    stakingValKey = '';
    const st = info.staking ?? {};
    return `
    <div class="row between"><h2>Staking</h2><span class="muted small">Proof of History clock · open Proof of Stake · slashing</span></div>
    <div class="grid g3 section">
      <div class="card span2"><div class="row between"><h3>Proof of History clock</h3><span class="small muted" id="s-poh-mode"></span></div><div id="s-poh"><p class="muted small">Loading…</p></div></div>
      <div class="card"><h3>Upcoming leaders</h3><div id="s-leaders"></div></div>
    </div>
    <div class="grid g4 section" id="s-stats"></div>
    <div class="card section"><div class="row between"><h3>Validators</h3><span class="small muted">up to ${esc(st.maxValidators ?? 16)} active · set recomputed each epoch</span></div><div class="table-wrap" id="s-validators"></div></div>
    <div class="grid g3 section">
      <div class="card"><h3>Delegate</h3><p class="small muted">Bond VOX to a validator. You earn a share of its block rewards and fees after its commission. Min ${vox(st.minDelegation)}.</p>
        <form id="f-delegate"><label>Validator</label><select name="validator" required></select>
          <label>Amount (VOX)</label><input name="amount" placeholder="100" required />
          <div class="row" style="margin-top:12px"><button>Delegate</button><span class="small muted">fee ${vox(MIN_FEE.stake)}</span></div></form></div>
      <div class="card"><h3>Undelegate</h3><p class="small muted">Start unbonding. The VOX returns to your balance after ${esc(st.unbondingEpochs ?? 2)} epochs and earns nothing meanwhile.</p>
        <form id="f-undelegate"><label>Validator</label><select name="validator" required></select>
          <label>Amount (VOX)</label><input name="amount" placeholder="50" required />
          <div class="row" style="margin-top:12px"><button>Undelegate</button><span class="small muted">fee ${vox(MIN_FEE.unstake)}</span></div></form></div>
      <div class="card"><h3>Become a validator</h3>
        <form id="f-register"><div class="row"><div><label>Name (a-z, 0-9, -)</label><input name="name" placeholder="my-validator" pattern="[a-z0-9\\-]{2,32}" maxlength="32" required /></div>
          <div><label>Commission (%)</label><input name="commission" value="10" inputmode="decimal" required /></div></div>
          <label>Self-stake (VOX)</label><input name="amount" placeholder="${esc(formatVox(BigInt(st.minValidatorStake ?? 0)))}" required />
          <p class="small muted" style="margin:8px 0 0">Needs at least ${vox(st.minValidatorStake)} of your own VOX plus the ${vox(MIN_FEE.validator_register)} fee. The faucet gives 1,000 VOX every 30s, so request it about ${esc(Math.ceil(Number(BigInt(st.minValidatorStake ?? 0) / 100000000000n)) + 1)} times first. Commission is 0–${esc((st.maxCommissionBps ?? 5000) / 100)}%. You join the leader schedule at the next epoch boundary.</p>
          <div class="row" style="margin-top:12px"><button>Register validator</button><span class="small muted">fee ${vox(MIN_FEE.validator_register)}</span></div></form>
        <div id="s-run" style="margin-top:12px"></div></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h3>My stake</h3><div id="s-mine"></div></div>
      <div class="card"><h3>Slashing log</h3><p class="small muted">Double-signing (two conflicting votes for the same height and round) costs ${esc(bpsToPct(st.slashBps ?? 500))} of bonded stake: ${esc(bpsToPct(st.reporterRewardBps ?? 1000))} of it goes to the reporter, the rest is burned, and the validator is jailed for 2 epochs (then it may unjail).</p><div class="table-wrap" id="s-slashes"></div></div>
    </div>`;
  },
  async update() {
    const [p, s, mine, c] = await Promise.all([api.poh(), api.staking(), api.stakingOf(wallet.address), api.consensus()]);
    const L = p.live;
    const slotPct = L.slotsPerEpoch ? (L.slotInEpoch / L.slotsPerEpoch) * 100 : 0;
    $('#s-poh-mode').textContent = `${c.mode} · round ${L.round}`;
    $('#s-poh').innerHTML = `
      <div class="poh-head"><div><div class="label">Slot</div><div class="value">${esc(L.slot.toLocaleString())}</div></div><div><div class="label">Epoch</div><div class="value">${esc(L.epoch)}</div></div><div><div class="label">PoH ticks</div><div class="value">${esc(L.ticks.toLocaleString())}</div></div></div>
      <div class="row between small" style="margin-top:10px"><span class="muted">Slot in epoch</span><span>${esc(L.slotInEpoch)} / ${esc(L.slotsPerEpoch)}</span></div>
      <div class="bar" style="margin:6px 0 12px"><div style="width:${Math.max(slotPct, 0.5).toFixed(2)}%"></div></div>
      <div class="kv">
        <div>Current PoH hash</div><div class="mono" title="${esc(L.hash)}">${esc(short(L.hash, 16, 8))}</div>
        <div>Hash rate</div><div>${esc(Math.round(L.hashRate ?? 0).toLocaleString())} hashes/s</div>
        <div>Clock</div><div>${esc(L.hashesPerTick)} hashes/tick · ${esc(L.ticksPerSlot)} ticks/slot · ${esc(L.tickMs)} ms/tick</div>
        <div>Tip block</div><div><a href="#explorer/${esc(p.tip.height)}">#${esc(p.tip.height)}</a> · slot ${esc(p.tip.slot)} · ${esc(p.tip.pohTicks)} ticks · <span class="mono" title="${esc(p.tip.pohEnd)}">${esc(short(p.tip.pohEnd, 8, 4))}</span></div>
      </div>
      <p class="small muted" style="margin-bottom:0">Every transaction hash is mixed into this SHA-256 chain, so its position is a verifiable ordering proof. A leader can only claim a later slot by doing the sequential hashing.</p>`;
    $('#s-leaders').innerHTML = p.upcoming.length ? `<table><tr><th>Slot</th><th>Leader</th></tr>${p.upcoming.map((u) => `
      <tr><td class="mono">${esc(u.slot)}${u.slot === L.slot ? ' <span class="tag x402">now</span>' : ''}</td><td>${esc(shortName(u.leader))}${u.local ? ' <span class="tag">this node</span>' : ''}</td></tr>`).join('')}</table>` : '<p class="muted small">Schedule not available yet.</p>';

    $('#s-stats').innerHTML = [
      ['Epoch', `${s.epoch}`, `next epoch at slot ${s.nextEpochSlot.toLocaleString()} · in ${Math.max(0, s.nextEpochSlot - L.slot)} slots`],
      ['Total bonded', vox(s.bonded), `${s.active.length} active of ${s.validators.length} validators`],
      ['Unbonding', vox(s.unbonding), `released after ${info.staking?.unbondingEpochs ?? 2} epochs`],
      ['Burned (slashed)', vox(s.burned), `${s.slashes.length} slashing event${s.slashes.length === 1 ? '' : 's'}`],
    ].map(([l, v, sub]) => `<div class="card stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');

    const active = new Set(s.active.map((v) => v.pub));
    const status = (v) => (v.jailed ? '<span class="tag evidence">jailed</span>' : active.has(v.pub) ? '<span class="tag ok-tag">active</span>' : '<span class="tag pending" title="not in the active set (below the minimum self-stake, outside the top validators, or waiting for the next epoch)">inactive</span>');
    $('#s-validators').innerHTML = s.validators.length ? `<table><tr><th>Validator</th><th>Bonded</th><th>Commission</th><th>Delegators</th><th>Uptime</th><th>Rewards</th><th>Status</th><th></th></tr>${s.validators.map((v) => `
      <tr><td><b>${esc(v.name)}</b>${v.owner === wallet.address ? ' <span class="tag">you</span>' : ''}<div class="small">${addrLink(v.owner)}</div></td>
        <td class="nowrap">${vox(v.bonded)}<div class="small muted">self ${esc(formatVox(BigInt(v.selfStake)))} + delegated ${esc(formatVox(BigInt(v.delegated)))}</div></td>
        <td>${esc(bpsToPct(v.commissionBps))}</td><td>${esc(v.delegators)}</td>
        <td>${esc(pct(v.uptimePct))}<div class="small muted">${esc(v.produced)} produced · ${esc(v.missed)} missed</div></td>
        <td>${vox(v.rewards)}${BigInt(v.slashed) > 0n ? `<div class="small bad">slashed ${esc(formatVox(BigInt(v.slashed)))}</div>` : ''}</td>
        <td>${status(v)}</td><td><button class="small ghost" data-delegate="${esc(v.pub)}"${v.jailed ? ' disabled title="jailed"' : ''}>Delegate</button></td></tr>`).join('')}</table>` : '<p class="muted small">No validators.</p>';

    // Validator selects: rebuild only when the set changes, so a choice in progress is kept.
    const key = s.validators.map((v) => `${v.pub}:${v.name}:${v.jailed}`).join('|');
    if (key !== stakingValKey) {
      stakingValKey = key;
      const opts = s.validators.map((v) => `<option value="${esc(v.pub)}">${esc(v.name)}${v.jailed ? ' (jailed)' : ''} · ${esc(bpsToPct(v.commissionBps))} commission</option>`).join('');
      document.querySelectorAll('#f-delegate select[name=validator], #f-undelegate select[name=validator]').forEach((sel) => { const old = sel.value; sel.innerHTML = opts; if (old && s.validators.some((v) => v.pub === old)) sel.value = old; });
      const mineFirst = mine.delegations.find((d) => !d.self)?.validator;
      if (mineFirst && !$('#f-undelegate').dataset.touched) $('#f-undelegate').validator.value = mineFirst;
    }

    $('#s-mine').innerHTML = `${mine.delegations.length ? `<table><tr><th>Validator</th><th>Amount</th><th>Kind</th></tr>${mine.delegations.map((d) => `
      <tr><td>${esc(d.name)}</td><td>${vox(d.amount)}</td><td>${d.self ? '<span class="tag validator_register">self-bond</span>' : '<span class="tag stake">delegation</span>'}</td></tr>`).join('')}</table>` : '<p class="muted small">No stake yet. Get VOX from the faucet on the Wallet tab, then delegate.</p>'}
      <h3 style="margin-top:14px">Unbonding</h3>${mine.unbonding.length ? `<table><tr><th>Validator</th><th>Amount</th><th>Released</th></tr>${mine.unbonding.map((u) => `
      <tr><td>${esc(u.name)}</td><td>${vox(u.amount)}</td><td>epoch ${esc(u.releaseEpoch)} <span class="small muted">(${u.releaseEpoch > s.epoch ? `in ${esc(u.releaseEpoch - s.epoch)} epoch${u.releaseEpoch - s.epoch === 1 ? '' : 's'}` : 'next block'})</span></td></tr>`).join('')}</table>` : '<p class="muted small">Nothing unbonding.</p>'}`;

    const myVal = s.validators.find((v) => v.owner === wallet.address);
    const localNames = new Set((c.localValidators ?? []).map(shortName));
    let run = '';
    if (myVal) {
      run = `<p class="notice" style="margin:0 0 8px">You registered <b>${esc(myVal.name)}</b> (${myVal.jailed ? 'jailed' : active.has(myVal.pub) ? 'active' : 'joins the active set at the next epoch boundary'}).</p>`;
      if (myVal.jailed && typeof wallet.unjail === 'function') run += '<p class="small muted" style="margin:0 0 8px">A jailed validator can rejoin after the jail period: <button class="small ghost" data-unjail="1">Unjail</button></p>';
      if (mode === 'browser') {
        run += localNames.has(myVal.name)
          ? '<p class="small ok" style="margin:0">✓ Your validator is running in this browser: it proposes and votes with your wallet key.</p>'
          : `<button class="small" data-run-validator="${esc(myVal.name)}">Run my validator in this browser</button>`;
      } else {
        run += `<p class="small muted" style="margin:0">To sign blocks, run a node with your key: <code>VOXIAN_VALIDATOR_SEED=&lt;your wallet seed&gt; npm start</code> (Wallet → Show seed).${localNames.has(myVal.name) ? ' <span class="ok">✓ this node is running it.</span>' : ''}</p>`;
      }
    }
    $('#s-run').innerHTML = run;

    const nameOf = (pub) => s.validators.find((v) => v.pub === pub)?.name ?? short(pub, 8, 4);
    $('#s-slashes').innerHTML = `${s.slashes.length ? `<table><tr><th>Validator</th><th>Offence</th><th>Height · round</th><th>Slashed</th><th>Burned</th></tr>${s.slashes.map((x) => `
      <tr><td>${esc(x.name)}</td><td>double ${esc(x.kind)}</td><td>#${esc(x.height)} · r${esc(x.round)}</td><td class="bad">${vox(x.amount)}</td><td>${vox(x.burned)}</td></tr>`).join('')}</table>` : '<p class="muted small">No slashing yet. Every validator has behaved.</p>'}
      ${s.evidence.length ? `<h3 style="margin-top:14px">Detected evidence</h3><table><tr><th>Validator</th><th>Votes</th><th>Height · round</th><th>Submitted</th></tr>${s.evidence.map((e) => `
      <tr><td>${esc(nameOf(e.validator))}</td><td>${esc(e.kind)}</td><td>#${esc(e.height)} · r${esc(e.round)}</td><td>${e.submitted ? '<span class="ok">✓</span>' : '<span class="muted">pending</span>'}</td></tr>`).join('')}</table>` : ''}`;
  },
  bind() {
    const st = info.staking ?? {};
    $('#f-undelegate').validator.onchange = () => { $('#f-undelegate').dataset.touched = '1'; };
    $('#s-validators').onclick = (e) => {
      const b = e.target.closest('[data-delegate]');
      if (!b) return;
      const f = $('#f-delegate');
      f.validator.value = b.dataset.delegate;
      f.scrollIntoView({ behavior: 'smooth', block: 'center' });
      f.amount.focus({ preventScroll: true });
    };
    $('#s-run').onclick = (e) => {
      const u = e.target.closest('[data-unjail]');
      if (u) {
        busy(u, 'Signing…', async () => {
          const a = await api.account(wallet.address);
          const r = await api.submit(wallet.unjail({ nonce: a.pendingNonce }));
          toast(`Submitted · tx ${short(r.hash)} · included in the next block`, 'success');
          refresh();
        });
        return;
      }
      const b = e.target.closest('[data-run-validator]');
      if (!b || mode !== 'browser') return;
      try { runLocalValidator(b.dataset.runValidator); toast(`Validator ${b.dataset.runValidator} now runs in this browser`, 'success'); refresh(); } catch (err) { toast(err.message, 'error'); }
    };
    formHandler('#f-delegate', 'Signing…', async (f) => {
      if (!f.validator.value) throw new Error('choose a validator');
      const amount = parseVox(f.amount.value);
      if (st.minDelegation && amount < BigInt(st.minDelegation)) throw new Error(`minimum delegation is ${vox(st.minDelegation)}`);
      const a = await api.account(wallet.address);
      return api.submit(wallet.stake({ validator: f.validator.value, amount, nonce: a.pendingNonce }));
    });
    formHandler('#f-undelegate', 'Signing…', async (f) => {
      if (!f.validator.value) throw new Error('choose a validator');
      const a = await api.account(wallet.address);
      return api.submit(wallet.unstake({ validator: f.validator.value, amount: parseVox(f.amount.value), nonce: a.pendingNonce }));
    });
    formHandler('#f-register', 'Registering…', async (f) => {
      const name = f.name.value.trim();
      if (!/^[a-z0-9-]{2,32}$/.test(name)) throw new Error('name: 2-32 characters, a-z, 0-9 and -');
      const pctVal = Number(f.commission.value);
      const maxPct = (st.maxCommissionBps ?? 5000) / 100;
      if (!Number.isFinite(pctVal) || pctVal < 0 || pctVal > maxPct) throw new Error(`commission must be between 0 and ${maxPct}%`);
      const amount = parseVox(f.amount.value);
      if (st.minValidatorStake && amount < BigInt(st.minValidatorStake)) throw new Error(`self-stake must be at least ${vox(st.minValidatorStake)}`);
      const a = await api.account(wallet.address);
      return api.submit(wallet.registerValidator({ name, commissionBps: Math.round(pctVal * 100), amount, nonce: a.pendingNonce }));
    });
  },
};

// ---------- explorer ----------
views.explorer = {
  render: (arg) => `
    <div class="row between"><h2>Explorer</h2></div>
    <form id="f-search" class="row" style="margin-top:8px"><input name="q" placeholder="Block height, block hash, tx hash or vox1 address" value="${esc(arg ?? '')}" /><button style="flex:0 0 auto">Search</button></form>
    <div id="x-result" class="section"></div>
    <div class="grid g2 section"><div class="card"><h3>Recent blocks</h3><div class="table-wrap" id="x-blocks"></div></div><div class="card"><h3>Mempool</h3><div class="table-wrap" id="x-mempool"></div></div></div>`,
  async update() {
    const [{ blocks }, { txs }] = await Promise.all([api.blocks(15), api.mempool()]);
    $('#x-blocks').innerHTML = blockTable(blocks);
    $('#x-mempool').innerHTML = txs.length ? txTable(txs) : '<p class="muted small">Empty. All transactions are confirmed.</p>';
  },
  bind(arg) {
    $('#f-search').onsubmit = (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) location.hash = `#explorer/${encodeURIComponent(q)}`; };
    if (arg) showExplorerItem(arg);
  },
};

const txTable = (txs) => `<table><tr><th>Tx</th><th>Type</th><th>From → To</th><th>Amount</th></tr>${txs.map((t) => `
  <tr class="click" data-go="#explorer/${t.hash}"><td class="mono">${esc(short(t.hash, 8, 4))}</td><td>${typeTag(t)}</td><td class="small">${addrLink(t.from)} → ${addrLink(t.to)}</td><td>${t.amount ? vox(t.amount) : t.private ? '<span class="violet">hidden</span>' : '<span class="muted">—</span>'}</td></tr>`).join('')}</table>`;

async function showExplorerItem(q) {
  const box = $('#x-result');
  box.innerHTML = '<div class="card muted">Searching…</div>';
  try {
    if (/^\d+$/.test(q) || (/^[0-9a-f]{64}$/.test(q) && !(await api.tx(q).catch(() => null)))) {
      const b = await api.block(q);
      box.innerHTML = `<div class="card"><h3>Block #${b.height}</h3><div class="kv">
        <div>Hash</div><div class="mono break">${esc(b.hash)}</div><div>Parent</div><div class="mono break">${b.height ? `<a href="#explorer/${b.height - 1}">${esc(b.prevHash)}</a>` : esc(b.prevHash)}</div>
        <div>Time</div><div>${new Date(b.timestamp).toLocaleString()}</div><div>Proposer</div><div>${esc(b.proposerName)}</div>
        <div>Reward + fees</div><div>${vox(b.reward)} + ${vox(b.fees)}</div><div>Tx root</div><div class="mono break">${esc(b.txRoot)}</div>
        <div>Signature</div><div class="mono break small">${esc(b.signature || '—')}</div>
        <div>Slot · epoch</div><div>slot ${esc(b.slot ?? '—')} · epoch ${esc(b.epoch ?? '—')}</div>
        <div>PoH ticks</div><div>${esc(b.pohTicks ?? 0)} ticks${b.poh?.entries ? ` · ${esc(b.poh.entries.length)} entries` : ''}</div>
        <div>PoH end hash</div><div class="mono break small">${esc(b.pohEnd || '—')}</div>
        <div>Commit round</div><div>${b.commit ? esc(b.commit.round) : '—'}</div>
        <div>Finality</div><div>${b.commit ? `<span class="ok">✓ final</span>, signed by ${esc(b.commit.signers.length)} validators (${b.commit.signers.map((n) => esc(shortName(n))).join(', ')}) with ${b.commit.stakePct === null || b.commit.stakePct === undefined ? '<span class="muted">stake share unavailable (epoch snapshot pruned)</span>' : `${esc(b.commit.stakePct)}% of stake`}` : 'genesis'}</div></div>
        ${b.allocations ? `<h3 style="margin-top:14px">Genesis allocations</h3><table>${b.allocations.map((a) => `<tr><td>${esc(a.label)}</td><td>${addrLink(a.address)}</td><td>${vox(a.amount)}</td></tr>`).join('')}</table>` : ''}
        <h3 style="margin-top:14px">Transactions (${b.txs.length})</h3>${b.txs.length ? txTable(b.txs) : '<p class="muted small">No transactions.</p>'}</div>`;
    } else if (/^[0-9a-f]{64}$/.test(q)) {
      const t = await api.tx(q);
      const s = t.summary;
      box.innerHTML = `<div class="card"><h3>Transaction</h3><div class="kv">
        <div>Hash</div><div class="mono break">${esc(q)}</div><div>Status</div><div>${t.status === 'confirmed' ? `<span class="ok">confirmed</span> in <a href="#explorer/${esc(t.height)}">block #${esc(t.height)}</a>` : '<span class="tag pending">pending</span>'}</div>
        ${t.status === 'confirmed' && t.slot !== undefined ? `<div>PoH position</div><div>slot ${esc(t.slot)}, mix-in #${esc(t.pohIndex)} <span class="muted small">(verifiable ordering)</span></div>` : ''}
        <div>Type</div><div>${typeTag(s)}</div><div>From</div><div>${addrLink(s.from)}</div><div>To</div><div>${addrLink(s.to)}</div>
        <div>Amount</div><div>${s.amount ? vox(s.amount) : s.private ? '<span class="violet">🔐 hidden (Pedersen commitment)</span>' : '—'}</div><div>Fee</div><div>${vox(s.fee)}</div>
        ${s.validatorName ? `<div>Validator name</div><div>${esc(s.validatorName)} · commission ${esc(Number(s.commissionBps ?? 0) / 100)}%</div>` : ''}
        ${s.validator ? `<div>Validator key</div><div class="mono break small">${esc(s.validator)}</div>` : ''}
        ${s.offender ? `<div>Offender</div><div class="mono break small">${esc(s.offender)}</div><div>Equivocation</div><div>two conflicting ${esc(s.voteKind)} votes</div>` : ''}
        ${s.resource ? `<div>x402 resource</div><div class="mono">${esc(s.resource)}</div>` : ''}${s.ref ? `<div>Reference</div><div class="mono">${esc(s.ref)}</div>` : ''}${s.memo ? `<div>Memo</div><div>${esc(s.memo)}</div>` : ''}
        </div>${s.private ? '<p class="notice" style="margin-top:12px">This is a confidential transaction. Observers see only one-time keys, commitments and proofs. Inputs are authorised by one-time-key signatures; a balance proof shows inputs = outputs + fee without revealing any amount; each output carries a 55-bit ZK range proof.</p>' : ''}${s.unbonding ? `<p class="notice" style="margin-top:12px">Unstaked VOX unbonds for ${esc(info.staking?.unbondingEpochs ?? 2)} epochs before it returns to the delegator's balance.</p>` : ''}${s.slashing ? '<p class="notice" style="margin-top:12px">Slashing evidence: two conflicting signed votes for the same (kind, height, round). The offender loses part of its bonded stake (10% of it to the reporter, the rest burned) and is jailed.</p>' : ''}
        <h3 style="margin-top:14px">Raw</h3><pre>${esc(JSON.stringify(t.tx, null, 2))}</pre></div>`;
    } else if (isAddress(q)) {
      const a = await api.account(q);
      box.innerHTML = `<div class="card"><h3>Account</h3><div class="kv"><div>Address</div><div class="mono break">${esc(q)}</div><div>Balance</div><div>${vox(a.balance)}</div><div>Nonce</div><div>${a.nonce}</div></div>
        <h3 style="margin-top:14px">Transactions</h3>${a.txs.length ? txTable(a.txs) : '<p class="muted small">None.</p>'}</div>`;
    } else throw new Error('Not found. Enter a block height, 64-char hash, or vox1 address.');
  } catch (e) {
    box.innerHTML = `<div class="card bad">${esc(e.message)}</div>`;
  }
}

// ---------- about ----------
// ---------- donate ----------
const SPONSORS_URL = 'https://github.com/sponsors/neroiq-47';
const SOLANA_ADDRESS = '5g4xQALSN81J1EseRkkb4GGWJiLAJCPRnoqUeB5jYWkk';
const TIERS = [
  ['☕', 'Supporter', '$5', 'Sponsor badge, thanks in the monthly update'],
  ['🛠', 'Builder', '$25', 'Name in the README, monthly progress update'],
  ['🤖', 'Agent Pioneer', '$100', 'Priority issue triage, early testnet news'],
  ['⛓️', 'Validator Partner', '$500', 'Logo in the README and web app, quarterly roadmap call'],
  ['🏢', 'Enterprise', '$2,500', '2 h/month of x402 & shielded-payment integration support'],
  ['🏛', 'Enterprise Partner', '$10,000', 'Top logo placement, 8 h/month of support, named funder of the security review'],
];
views.donate = {
  render: () => `
    <section class="hero" style="text-align:center"><button type="button" class="bull-link" data-scroll="donate-options" aria-label="Show donation options"><img class="bull-big" src="assets/donate-bull-lg.png" alt="" width="168" height="168" /></button>
      <h1>Support <span>Voxian</span></h1>
      <p style="margin:0 auto">Voxian is built in the open. Donations fund independent security reviews (the white paper's step before any mainnet decision), public testnet infrastructure and development time.</p></section>
    <div class="grid g2 section" id="donate-options">
      <div class="card glow"><h3>GitHub Sponsors</h3>
        <p class="small muted">Monthly or one-time, any amount. GitHub takes no fees on personal accounts, so it all reaches the project.</p>
        <a class="btn" href="${SPONSORS_URL}" target="_blank" rel="noopener">❤️ Sponsor on GitHub ↗</a></div>
      <div class="card glow"><h3>Donate with crypto (Solana)</h3>
        <p class="small muted">SOL or SPL tokens such as USDC. <b class="volt">Solana mainnet only.</b> Funds sent from another chain are lost, and transfers can't be reversed.</p>
        <div class="addr copy" id="sol-address" data-copy="${SOLANA_ADDRESS}" tabindex="0" role="button" aria-label="Solana donation address, press Enter to copy" title="click to copy">${SOLANA_ADDRESS}</div>
        <div class="row" style="margin-top:12px"><button type="button" class="ghost small" data-copy="${SOLANA_ADDRESS}" data-select="sol-address">Copy address</button><a class="btn ghost small" href="solana:${SOLANA_ADDRESS}">Open in wallet</a></div></div>
    </div>
    <div class="card section"><h3>Sponsor tiers</h3><div class="table-wrap"><table><tr><th>Tier</th><th>Monthly</th><th>Benefits</th></tr>
      ${TIERS.map(([icon, name, price, perks]) => `<tr><td>${icon} <b>${name}</b></td><td class="tier-price volt">${price}</td><td class="small">${perks}</td></tr>`).join('')}
    </table></div><p class="small muted">Organisations can sponsor from a GitHub organisation account. Full details are in <a href="https://github.com/neroiq-47/Voxian-Chain/blob/main/docs/SPONSORS.md" target="_blank" rel="noopener">docs/SPONSORS.md</a>.</p></div>
    <div class="card section notice">Donations are gifts to open-source development. They are not an investment, equity or a token sale, and they do not buy, reserve or promise any VOX. VOX is a proposed token and devnet tokens have no value.</div>`,
};

views.about = {
  render: () => `
    <section class="hero"><h1>About <span>Voxian</span></h1><p>Voxian is a proposed Layer 1 blockchain designed for private, verifiable digital payments in an increasingly automated world.</p></section>
    <div class="grid g2 section">
      <div class="card"><h3>What this MVP implements</h3><ul class="small">
        <li><b>Layer 1 chain:</b> blocks, mempool, Merkle tx roots, Schnorr-signed blocks, halving issuance hard-capped at 210M VOX.</li>
        <li><b>Proof of History clock:</b> a sequential SHA-256 hash chain proves time passed between blocks and fixes the order of every transaction, including x402 payments. Time is measured in PoH slots and epochs, and a stake-weighted leader schedule is fixed per epoch.</li>
        <li><b>BFT finality:</b> Tendermint-style prevote / precommit rounds with locking, &gt; 2/3-stake commit certificates and catch-up sync. A persistent signing log prevents double-voting after a restart. Survives one of four validators going down.</li>
        <li><b>Open Proof of Stake:</b> anyone can register a validator (10,000 VOX self-stake) or delegate. Rewards and fees are split by commission, unstaked VOX unbonds over 2 epochs, and the active set (up to 16) is recomputed every epoch.</li>
        <li><b>Slashing:</b> double-signing is detected automatically and submitted as evidence. 5% of the offender's bonded stake is taken (10% of it to the reporter, the rest burned) and the validator is jailed.</li>
        <li><b>ZK privacy:</b> confidential notes with Pedersen commitments, 55-bit zero-knowledge range proofs (CDS OR-proofs), balance proofs, stealth one-time addresses and encrypted amounts.</li>
        <li><b>x402 payments:</b> HTTP 402 challenges, an <code>exact</code> scheme (gasless signed authorizations relayed by a facilitator) and a <code>zk-shielded</code> scheme (private note payments with selective disclosure to the payee).</li>
        <li><b>AI agents:</b> an autonomous agent discovers paid APIs, plans, and pays per request within a budget.</li>
        <li><b>Runs anywhere:</b> as a Node.js full node, or entirely in your browser (GitHub Pages) with the same code.</li></ul></div>
      <div class="card"><h3>Roadmap (from the white paper)</h3><ol class="small"><li>Finalize the technical design</li><li>Build a working payment proof of concept ✓ <span class="muted">(this devnet)</span></li><li>Launch a public testnet</li><li>Complete independent security reviews</li><li>Only then assess mainnet readiness</li></ol>
        <p class="small muted">Consensus upgrade on this devnet: Proof of History + open Proof of Stake with slashing. All parameters (100 ms ticks, 1 s slots, 2 min epochs) are devnet-sized and not final.</p>
        <h3>Node mode</h3><p class="small">${mode === 'browser' ? 'You are running an <b>in-browser node</b>. The whole chain lives in this tab and in localStorage.' : 'You are connected to a <b>Voxian full node</b> over HTTP.'}</p>
        ${mode === 'browser' ? '<button class="ghost small" id="btn-reset">Reset local chain</button>' : ''}</div>
    </div>
    <div class="card section notice">Voxian is a proposed project concept. The network, token and technical features described here are not represented as live or completed. Supply and ticker are proposed and subject to final validation. This devnet uses unaudited cryptography and test tokens with no value.</div>`,
  bind() { $('#btn-reset')?.addEventListener('click', () => { if (confirm('Erase the local devnet chain?')) localNode.reset(); }); },
};

// ---------- router & refresh loop ----------
async function route(force = false) {
  const [rawName, ...rest] = (location.hash.slice(1) || 'overview').split('/');
  const name = Object.hasOwn(views, rawName) ? rawName : 'overview';
  let arg;
  try { arg = rest.join('/') ? decodeURIComponent(rest.join('/')) : undefined; } catch { arg = rest.join('/'); }
  const view = views[name];
  const key = `${name}/${arg ?? ''}`;
  if (key === currentView && !force) return;
  currentView = key;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  if (name === 'market') catalog = null;
  $('#view').innerHTML = view.render(arg);
  view.bind?.(arg);
  await refresh();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await api.stats();
    $('#height-badge').textContent = `#${s.height.toLocaleString()}`;
    const name = currentView.split('/')[0];
    await views[name]?.update?.();
  } catch (e) {
    console.warn(e);
  } finally {
    refreshing = false;
  }
}

// Copy with fallbacks: async clipboard, then execCommand, then select the text for a manual copy.
function selectText(el) {
  if (!el) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
async function copyText(text, el) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast('Copied', 'success');
  } catch {
    selectText(el);
    let ok = false;
    try { ok = el ? document.execCommand('copy') : false; } catch { /* unsupported */ }
    toast(ok ? 'Copied' : 'Address selected: press Ctrl+C (⌘C on Mac) to copy', ok ? 'success' : '');
  }
}
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.addr[data-copy]')) { e.preventDefault(); copyText(e.target.dataset.copy, e.target); }
});

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a')) location.hash = go.dataset.go;
  const c = e.target.closest('[data-copy]');
  if (c) copyText(c.dataset.copy, document.getElementById(c.dataset.select) || (c.classList.contains('addr') ? c : null));
  const sc = e.target.closest('[data-scroll]');
  if (sc) document.getElementById(sc.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

async function boot() {
  try {
    const r = await fetch('api/info', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('no node');
    fetchFn = (u, i) => fetch(u, i);
    mode = 'server';
  } catch {
    const { createLocalNode } = await import('./src/node/local.js');
    localNode = await createLocalNode();
    fetchFn = localNode.fetch;
    mode = 'browser';
  }
  api = new ChainClient(fetchFn);
  info = await api.info();
  wallet = loadWallet();
  if (mode === 'browser') {
    // Re-run the wallet's validator if the user promoted it before (it is lost on reload otherwise).
    try {
      const v = JSON.parse(localStorage.getItem(VALIDATOR_KEY) || 'null');
      if (v?.address === wallet.address && v.name) localNode.node.consensus.addLocalValidator(wallet.asValidator(v.name));
    } catch { /* storage unavailable */ }
  }
  $('#mode-badge').textContent = mode === 'browser' ? '🧠 in-browser node' : '🛰 full node';
  $('#mode-badge').title = mode === 'browser' ? 'No backend found: the full Voxian node runs inside this page' : 'Connected to a Voxian node over HTTP';
  window.addEventListener('hashchange', () => route());
  await route(true);
  setInterval(refresh, 2500);
}

boot().catch((e) => { $('#view').innerHTML = `<div class="card bad">Failed to start: ${esc(e.message)}</div>`; console.error(e); });
