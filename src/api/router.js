// Transport-agnostic HTTP router. The Node server and the in-browser node both call handle().
import { isAddress } from '../chain/keys.js';
import { signTx, txHash } from '../chain/tx.js';
import {
  formatVox, parseVox, CHAIN_ID, NETWORK, TICKER, DECIMALS, MAX_SUPPLY, MIN_FEE, BLOCK_INTERVAL_MS, INITIAL_REWARD, HALVING_INTERVAL,
  TICK_MS, HASHES_PER_TICK, TICKS_PER_SLOT, SLOTS_PER_EPOCH, LEADER_SLOTS, MIN_VALIDATOR_STAKE, MIN_DELEGATION, MAX_VALIDATORS, MAX_COMMISSION_BPS,
  UNBONDING_EPOCHS, SLASH_BPS, REPORTER_REWARD_BPS,
} from '../chain/params.js';
import { epochOf } from '../chain/blockchain.js';
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

// Operator access to shielded totals: a bearer token from VOXIAN_OPERATOR_TOKEN. Unset means no shielded view at all.
function operatorAuthorized(req) {
  const want = process.env.VOXIAN_OPERATOR_TOKEN;
  const got = String(req.headers?.authorization ?? '').replace(/^Bearer /, '');
  if (!want || got.length !== want.length) return false;
  let diff = 0; // constant-time comparison; the router also runs in the browser, so no node:crypto here
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

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
  if (tx.type === 'validator_register') Object.assign(s, { from: addressFromPub(tx.from), to: 'stake (self-bond)', amount: tx.amount, validatorName: tx.name, commissionBps: tx.commissionBps });
  if (tx.type === 'stake') Object.assign(s, { from: addressFromPub(tx.from), to: addressFromPub(tx.validator), amount: tx.amount, validator: tx.validator });
  if (tx.type === 'unstake') Object.assign(s, { from: addressFromPub(tx.validator), to: addressFromPub(tx.from), amount: tx.amount, validator: tx.validator, unbonding: true });
  if (tx.type === 'unjail') Object.assign(s, { from: addressFromPub(tx.from), to: addressFromPub(tx.from), amount: null, validator: tx.from });
  if (tx.type === 'evidence') Object.assign(s, { from: addressFromPub(tx.from), to: addressFromPub(tx.voteA.validator), amount: null, offender: tx.voteA.validator, voteKind: tx.voteA.kind, slashing: true });
  return s;
}

const blockSummary = (b) => ({ height: b.height, slot: b.slot, hash: b.hash, timestamp: b.timestamp, proposer: b.proposer, txCount: b.txs.length, reward: b.reward, fees: b.fees, pohTicks: b.pohTicks, round: b.commit?.round ?? 0, signers: b.commit?.votes.length ?? 0 });
const bpsPct = (x, total) => (total > 0n ? Number((x * 10000n) / total) / 100 : 0);

export function createRouter({ chain, consensus, facilitator, services, payee, keys }) {
  const faucetLast = new Map();
  let faucetWindow = [];
  // The public facilitator endpoints only settle payments for this node's own services (otherwise anyone
  // could make the facilitator relay, and pay gas for, arbitrary self-payments).
  const knownRequirements = new Set(services.flatMap((s) => paymentRequirements(s, payee).map((r) => canonicalJSON(r))));
  const isKnownRequirement = (r) => { try { return knownRequirements.has(canonicalJSON(r)); } catch { return false; } };
  const nameOf = (pub) => chain.state.validators.get(pub)?.name ?? (pub ? pub.slice(0, 10) + '…' : 'genesis');
  // Active set for the next slot's epoch (what the leader schedule and vote weights use).
  const activeValidators = () => {
    const snap = chain.snapshotFor(epochOf(chain.slot + 1));
    return snap.validators.map((v) => ({ name: v.name, pub: v.pub, address: v.address, stake: v.stake.toString(), weightPct: bpsPct(v.stake, snap.total) }));
  };
  const validatorView = (v) => {
    const bonded = v.selfStake + v.delegated;
    return {
      name: v.name, pub: v.pub, owner: v.owner, selfStake: v.selfStake.toString(), delegated: v.delegated.toString(), bonded: bonded.toString(),
      commissionBps: v.commissionBps, jailed: v.jailed, jailedUntilEpoch: v.jailedUntilEpoch, slashed: v.slashed.toString(), rewards: v.rewards.toString(), joinedEpoch: v.joinedEpoch,
      produced: v.produced, missed: v.missed, uptimePct: v.produced + v.missed ? Math.round((v.produced / (v.produced + v.missed)) * 1000) / 10 : null,
      delegators: chain.state.delegations.get(v.pub)?.size ?? 0,
    };
  };

  const routes = [
    ['GET', /^\/api\/info$/, () => ok({
      chainId: CHAIN_ID, network: NETWORK, ticker: TICKER, decimals: DECIMALS, maxSupply: MAX_SUPPLY.toString(),
      height: chain.height, tipHash: chain.tip.hash, genesisHash: chain.genesis.hash, blockIntervalMs: BLOCK_INTERVAL_MS,
      initialReward: INITIAL_REWARD.toString(), halvingInterval: HALVING_INTERVAL,
      minFees: Object.fromEntries(Object.entries(MIN_FEE).map(([k, v]) => [k, v.toString()])),
      validators: activeValidators(), faucet: keys.faucet.address, facilitator: keys.facilitator.address,
      poh: { tickMs: TICK_MS, hashesPerTick: HASHES_PER_TICK, ticksPerSlot: TICKS_PER_SLOT, slotsPerEpoch: SLOTS_PER_EPOCH, leaderSlots: LEADER_SLOTS },
      staking: { minValidatorStake: MIN_VALIDATOR_STAKE.toString(), minDelegation: MIN_DELEGATION.toString(), maxValidators: MAX_VALIDATORS, maxCommissionBps: MAX_COMMISSION_BPS, unbondingEpochs: UNBONDING_EPOCHS, slashBps: SLASH_BPS, reporterRewardBps: REPORTER_REWARD_BPS },
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
      return ok({ blocks: chain.blocks.slice(-limit).reverse().map((b) => ({ ...blockSummary(b), proposerName: b.height ? nameOf(b.proposer) : 'genesis' })) });
    }],

    ['GET', /^\/api\/blocks\/([0-9a-f]+)$/, (req, [id]) => {
      const b = id.length === 64 ? chain.blocks.find((x) => x.hash === id) : chain.blocks[Number(id)];
      if (!b) return err(404, 'block not found');
      const { allocations, validators: vs, ...rest } = b;
      let commit = null;
      if (b.commit) {
        let stakePct = null;
        try { const { power, total } = chain.commitPower(b, { checkSigs: false }); stakePct = bpsPct(power, total); } catch { /* snapshot pruned for old epochs */ }
        commit = { round: b.commit.round, signers: b.commit.votes.map((v) => nameOf(v.validator)), stakePct };
      }
      return ok({ ...rest, epoch: epochOf(b.slot), commit, proposerName: b.height ? nameOf(b.proposer) : 'genesis', allocations, validators: vs, txs: b.txs.map((t) => ({ ...summarizeTx(t, txHash(t)), raw: displayTx(t) })) });
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

    // The service operator's view: public revenue is visible to all; shielded revenue only with the operator token.
    ['GET', /^\/api\/services\/revenue$/, (req) => {
      const publicRevenue = chain.state.account(payee.address).balance.toString();
      if (!operatorAuthorized(req)) return ok({ publicRevenue, shieldedRevenue: null, shieldedPayments: null });
      let priv = 0n, count = 0;
      for (const n of chain.state.notes.values()) {
        const r = scanOutput(payee.shielded, n);
        if (r) { priv += r.value; count++; }
      }
      return ok({ publicRevenue, shieldedRevenue: priv.toString(), shieldedPayments: count });
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

    // ---- Proof of History & Proof of Stake ----
    ['GET', /^\/api\/poh$/, () => {
      const c = consensus.status();
      const tip = chain.tip;
      const slot = c.slot;
      return ok({
        tip: { height: tip.height, slot: tip.slot, pohEnd: tip.pohEnd, pohTicks: tip.pohTicks },
        live: { ...c.poh, round: c.round, slot, epoch: c.epoch, slotInEpoch: slot % SLOTS_PER_EPOCH, slotsPerEpoch: SLOTS_PER_EPOCH },
        upcoming: c.upcoming,
        recentBlocks: chain.blocks.slice(-12).filter((b) => b.height > 0).reverse().map((b) => ({ height: b.height, slot: b.slot, pohTicks: b.pohTicks, pohEnd: b.pohEnd, txs: b.txs.length, leader: nameOf(b.proposer) })),
      });
    }],
    ['GET', /^\/api\/staking$/, () => {
      const s = chain.state;
      const bonded = [...s.validators.values()].reduce((n, v) => n + v.selfStake + v.delegated, 0n);
      return ok({
        epoch: s.epoch, nextEpochSlot: (epochOf(chain.slot) + 1) * SLOTS_PER_EPOCH, slot: chain.slot,
        bonded: bonded.toString(), unbonding: s.unbonding.reduce((n, u) => n + u.amount, 0n).toString(), burned: s.burned.toString(),
        active: activeValidators(),
        validators: [...s.validators.values()].map(validatorView).sort((a, b) => { const x = BigInt(a.bonded), y = BigInt(b.bonded); return x === y ? (a.pub < b.pub ? -1 : 1) : y > x ? 1 : -1; }),
        slashes: s.slashes.slice(-20).reverse(),
        evidence: consensus.status().evidence,
      });
    }],
    ['GET', /^\/api\/staking\/(vox1[0-9a-f]{40})$/, (req, [address]) => {
      const s = chain.state;
      const delegations = [];
      for (const [pub, m] of s.delegations) if (m.has(address)) delegations.push({ validator: pub, name: nameOf(pub), amount: m.get(address).toString() });
      for (const v of s.validators.values()) if (v.owner === address) delegations.push({ validator: v.pub, name: v.name, amount: v.selfStake.toString(), self: true });
      return ok({
        address, delegations,
        unbonding: s.unbonding.filter((u) => u.address === address).map((u) => ({ ...u, amount: u.amount.toString(), name: nameOf(u.validator) })),
        validator: [...s.validators.values()].filter((v) => v.owner === address).map(validatorView)[0] ?? null,
      });
    }],
    ['GET', /^\/p2p\/status$/, () => ok(consensus.status())],
    ['GET', /^\/p2p\/blocks$/, (req) => ok({ blocks: blocksFrom(chain, Number(req.query.from), Number(req.query.limit) || 50) })],
    ['POST', /^\/p2p\/tx$/, (req) => ok(consensus.onTx(req.body))],
    ['POST', /^\/p2p\/hello$/, (req) => ok(consensus.onHello(req.body))],
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
