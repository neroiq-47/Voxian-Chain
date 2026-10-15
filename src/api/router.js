// Transport-agnostic HTTP router. The Node server and the in-browser node both call handle().
import { isAddress } from '../chain/keys.js';
import { signTx, txHash } from '../chain/tx.js';
import { formatVox, parseVox, CHAIN_ID, NETWORK, TICKER, DECIMALS, MAX_SUPPLY, MIN_FEE, BLOCK_INTERVAL_MS, INITIAL_REWARD, HALVING_INTERVAL } from '../chain/params.js';
import { addressFromPub } from '../chain/keys.js';
import { txAddresses } from '../chain/state.js';
import { H } from '../crypto/secp256k1.js';
import { RANGE_BITS } from '../zk/rangeproof.js';
import { scanOutput } from '../zk/shielded.js';
import { paymentRequirements, decodeHeader, encodeHeader, PAYMENT_HEADER, X402_VERSION } from '../x402/protocol.js';
import { blocksFrom } from '../chain/consensus.js';
import { canonicalJSON } from '../crypto/encoding.js';

const FAUCET_AMOUNT = parseVox('1000');
const FAUCET_COOLDOWN_MS = 30_000;
const FAUCET_GLOBAL_PER_MIN = 20; // new addresses are free, so also cap total faucet throughput

const ok = (body, headers = {}) => ({ status: 200, headers, body });
const err = (status, message, extra = {}) => ({ status, headers: {}, body: { error: message, ...extra } });

// Hide bulky range proofs in explorer views.
function displayTx(tx) {
  if (tx.type !== 'shielded') return tx;
  return { ...tx, outputs: tx.outputs.map(({ rp, ...o }) => ({ ...o, rangeProofBytes: rp.length / 2 })) };
}

function summarizeTx(tx, hash, extra = {}) {
  const s = { hash, type: tx.type, fee: tx.fee, ...extra };
  if (tx.type === 'transfer') Object.assign(s, { from: addressFromPub(tx.from), to: tx.to, amount: tx.amount, memo: tx.memo });
  if (tx.type === 'shield') Object.assign(s, { from: addressFromPub(tx.from), to: 'shielded pool', amount: tx.amount });
  if (tx.type === 'shielded') Object.assign(s, { from: 'shielded', to: tx.publicOut ? tx.publicOut.to : 'shielded', amount: tx.publicOut ? tx.publicOut.amount : null, private: true, ref: tx.ref, notesIn: tx.inputs.length, notesOut: tx.outputs.length });
  if (tx.type === 'auth_transfer') Object.assign(s, { from: addressFromPub(tx.auth.from), to: tx.auth.to, amount: tx.auth.value, resource: tx.auth.resource, x402: true });
  return s;
}

const blockSummary = (b) => ({ height: b.height, hash: b.hash, timestamp: b.timestamp, proposer: b.proposer, txCount: b.txs.length, reward: b.reward, fees: b.fees });

export function createRouter({ chain, consensus, facilitator, services, payee, keys }) {
  const faucetLast = new Map();
  let faucetWindow = [];
  // The public facilitator endpoints only settle payments for this node's own services (otherwise anyone
  // could make the facilitator relay, and pay gas for, arbitrary self-payments).
  const knownRequirements = new Set(services.flatMap((s) => paymentRequirements(s, payee).map((r) => canonicalJSON(r))));
  const isKnownRequirement = (r) => { try { return knownRequirements.has(canonicalJSON(r)); } catch { return false; } };
  const validators = chain.genesis.validators;
  const validatorName = new Map(validators.map((v) => [v.pub, v.name]));

  const routes = [
    ['GET', /^\/api\/info$/, () => ok({
      chainId: CHAIN_ID, network: NETWORK, ticker: TICKER, decimals: DECIMALS, maxSupply: MAX_SUPPLY.toString(),
      height: chain.height, tipHash: chain.tip.hash, genesisHash: chain.genesis.hash, blockIntervalMs: BLOCK_INTERVAL_MS,
      initialReward: INITIAL_REWARD.toString(), halvingInterval: HALVING_INTERVAL,
      minFees: Object.fromEntries(Object.entries(MIN_FEE).map(([k, v]) => [k, v.toString()])),
      validators, faucet: keys.faucet.address, facilitator: keys.facilitator.address,
      zk: { commitment: 'Pedersen (secp256k1)', H: H.toHex(), rangeProofBits: RANGE_BITS, rangeProof: 'bit-decomposition CDS OR-proofs (Fiat–Shamir)', stealth: 'one-time keys P = Hs(rA)G + B' },
      x402: { version: X402_VERSION, schemes: facilitator.supported().kinds.map((k) => k.scheme) },
    })],

    ['GET', /^\/api\/stats$/, () => {
      const recent = chain.blocks.slice(-30).filter((b) => b.height > 0);
      const span = recent.length > 1 ? (recent.at(-1).timestamp - recent[0].timestamp) / (recent.length - 1) : 0;
      const s = chain.state.stats;
      return ok({
        height: chain.height, tipHash: chain.tip.hash, tipTime: chain.tip.timestamp, mempool: chain.mempool.length,
        avgBlockMs: Math.round(span), supply: chain.supply(), accounts: chain.state.accounts.size, notes: chain.state.notes.size,
        spentNotes: chain.state.spent.size, consensus: { mode: consensus.mode, lastCommit: consensus.lastCommit, peersOnline: consensus.status().peers.filter((p) => p.ok).length, peers: consensus.peers.size }, ...s, x402PublicVolume: s.x402PublicVolume.toString(),
      });
    }],

    ['GET', /^\/api\/blocks$/, (req) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      return ok({ blocks: chain.blocks.slice(-limit).reverse().map((b) => ({ ...blockSummary(b), round: b.round, signers: b.commit?.votes.length ?? 0, proposerName: validatorName.get(b.proposer) ?? 'genesis' })) });
    }],

    ['GET', /^\/api\/blocks\/([0-9a-f]+)$/, (req, [id]) => {
      const b = id.length === 64 ? chain.blocks.find((x) => x.hash === id) : chain.blocks[Number(id)];
      if (!b) return err(404, 'block not found');
      const { allocations, validators: vs, ...rest } = b;
      const commit = b.commit ? { signers: b.commit.votes.map((v) => validatorName.get(v.validator) ?? v.validator), stakePct: Number((chain.commitPower(b, { checkSigs: false }) * 10000n) / chain.totalStake) / 100 } : null;
      return ok({ ...rest, commit, proposerName: validatorName.get(b.proposer) ?? 'genesis', allocations, validators: vs, txs: b.txs.map((t) => ({ ...summarizeTx(t, txHash(t)), raw: displayTx(t) })) });
    }],

    ['GET', /^\/api\/tx\/([0-9a-f]{64})$/, (req, [hash]) => {
      const r = chain.getTx(hash);
      if (!r) return err(404, 'transaction not found');
      return ok({ ...r, summary: summarizeTx(r.tx, hash), tx: displayTx(r.tx) });
    }],

    ['GET', /^\/api\/accounts\/(vox1[0-9a-f]{40})$/, (req, [address]) => {
      const a = chain.state.account(address), p = chain.pending.account(address);
      const hashes = (chain.addrIndex.get(address) ?? []).slice(-25).reverse();
      const txs = hashes.map((h) => { const r = chain.getTx(h); return summarizeTx(r.tx, h, { height: r.height, timestamp: r.timestamp }); });
      const pendingTxs = chain.mempool.filter((m) => txAddresses(m.tx).includes(address))
        .map((m) => summarizeTx(m.tx, m.hash, { pending: true }));
      return ok({ address, balance: a.balance.toString(), nonce: a.nonce, pendingBalance: p.balance.toString(), pendingNonce: p.nonce, txs: [...pendingTxs, ...txs] });
    }],

    ['GET', /^\/api\/mempool$/, () => ok({ txs: chain.mempool.map((m) => summarizeTx(m.tx, m.hash, { receivedAt: m.receivedAt })) })],

    ['GET', /^\/api\/notes$/, () => ok({
      notes: [...chain.pending.notes.values()].map((n) => ({ ...n, spent: chain.pending.spent.has(n.id), confirmed: chain.state.notes.has(n.id) })),
    })],

    ['POST', /^\/api\/tx$/, (req) => {
      try { return ok({ hash: chain.submitTx(req.body) }); } catch (e) { return err(400, e.message); }
    }],

    ['POST', /^\/api\/faucet$/, (req) => {
      const address = req.body?.address;
      if (!isAddress(address)) return err(400, 'valid vox1… address required');
      const now = Date.now();
      faucetWindow = faucetWindow.filter((t) => now - t < 60_000);
      if (faucetWindow.length >= FAUCET_GLOBAL_PER_MIN) return err(429, 'faucet is busy: global rate limit reached, try again in a minute');
      for (const [a, t] of faucetLast) if (now - t >= FAUCET_COOLDOWN_MS) faucetLast.delete(a);
      const last = faucetLast.get(address) ?? 0;
      if (Date.now() - last < FAUCET_COOLDOWN_MS) return err(429, `faucet cooldown: try again in ${Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - last)) / 1000)}s`);
      const f = keys.faucet;
      const tx = signTx({ type: 'transfer', from: f.pubHex, to: address, amount: FAUCET_AMOUNT.toString(), fee: MIN_FEE.transfer.toString(), nonce: chain.pending.account(f.address).nonce, memo: 'Voxian devnet faucet' }, f.secret);
      try {
        const hash = chain.submitTx(tx);
        faucetLast.set(address, Date.now());
        faucetWindow.push(Date.now());
        return ok({ hash, amount: FAUCET_AMOUNT.toString(), formatted: formatVox(FAUCET_AMOUNT) });
      } catch (e) { return err(503, 'faucet unavailable: ' + e.message); }
    }],

    ['GET', /^\/api\/services$/, () => ok({
      payee: { address: payee.address, zaddress: payee.zaddress },
      services: services.map(({ handler, ...s }) => ({ ...s, priceFormatted: formatVox(BigInt(s.price)), accepts: paymentRequirements(s, payee) })),
    })],

    // The service operator's view: public revenue is visible to all; shielded revenue only via its view key.
    ['GET', /^\/api\/services\/revenue$/, () => {
      let priv = 0n, count = 0;
      for (const n of chain.state.notes.values()) {
        const r = scanOutput(payee.shielded, n);
        if (r) { priv += r.value; count++; }
      }
      return ok({ publicRevenue: chain.state.account(payee.address).balance.toString(), shieldedRevenue: priv.toString(), shieldedPayments: count });
    }],

    ['GET', /^\/x402\/supported$/, () => ok(facilitator.supported())],
    ['POST', /^\/x402\/verify$/, (req) => (isKnownRequirement(req.body?.paymentRequirements)
      ? ok(facilitator.verify(req.body?.paymentPayload, req.body.paymentRequirements))
      : ok({ isValid: false, invalidReason: 'unknown paymentRequirements: this facilitator only settles payments for its listed services' }))],
    ['POST', /^\/x402\/settle$/, (req) => (isKnownRequirement(req.body?.paymentRequirements)
      ? ok(facilitator.settle(req.body?.paymentPayload, req.body.paymentRequirements))
      : ok({ success: false, errorReason: 'unknown paymentRequirements', network: NETWORK, transaction: '' }))],

    // ---- validator cluster ----
    ['GET', /^\/api\/consensus$/, () => ok(consensus.status())],
    ['GET', /^\/p2p\/status$/, () => ok(consensus.status())],
    ['GET', /^\/p2p\/blocks$/, (req) => ok({ blocks: blocksFrom(chain, Number(req.query.from), Number(req.query.limit) || 50) })],
    ['POST', /^\/p2p\/tx$/, (req) => ok(consensus.onTx(req.body))],
    ['POST', /^\/p2p\/proposal$/, (req) => ok(consensus.onProposal(req.body))],
    ['POST', /^\/p2p\/vote$/, (req) => ok(consensus.onVote(req.body))],
    ['POST', /^\/p2p\/commit$/, (req) => ok(consensus.onCommit(req.body))],
  ];

  async function paid(req, service) {
    const accepts = paymentRequirements(service, payee);
    const header = req.headers[PAYMENT_HEADER];
    const challenge = (error) => ({ status: 402, headers: {}, body: { x402Version: X402_VERSION, error, accepts } });
    if (!header) return challenge('X-PAYMENT header is required');
    let payment;
    try { payment = decodeHeader(header); } catch { return challenge('malformed X-PAYMENT header'); }
    const requirement = accepts.find((a) => a.scheme === payment.scheme && a.network === payment.network);
    if (!requirement) return challenge('unsupported scheme or network');
    const v = facilitator.verify(payment, requirement);
    if (!v.isValid) return challenge(v.invalidReason);
    let result;
    try { result = await service.handler(req); } catch (e) { return err(e.status ?? 500, e.message); } // not charged on failure
    const s = facilitator.settle(payment, requirement);
    if (!s.success) return challenge(s.errorReason);
    return ok({ ...result, _x402: { paid: formatVox(BigInt(requirement.maxAmountRequired)) + ' VOX', scheme: requirement.scheme, transaction: s.transaction } }, { 'X-PAYMENT-RESPONSE': encodeHeader(s) });
  }

  return async function handle(req) {
    try {
      if (req.method === 'OPTIONS') return { status: 204, headers: {}, body: null };
      const service = services.find((s) => s.path === req.path);
      if (service) {
        if (req.method !== service.method) return err(405, `use ${service.method}`);
        return await paid(req, service);
      }
      for (const [method, re, fn] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(req.path);
        if (m) return await fn(req, m.slice(1));
      }
      return err(404, 'not found');
    } catch (e) {
      return err(500, e.message);
    }
  };
}
