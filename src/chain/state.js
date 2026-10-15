// Ledger state and the state-transition function for every transaction type.
// applyTx validates fully before mutating anything, so a throw leaves the state untouched.
import { mulH, Point, schnorrVerify } from '../crypto/secp256k1.js';
import { addressFromPub, isAddress, parsePub } from './keys.js';
import { txSighash, txHash, txSize, noteId, authDigest } from './tx.js';
import { MIN_FEE, MAX_TX_BYTES, MAX_SHIELDED_INPUTS, MAX_SHIELDED_OUTPUTS, MAX_MEMO, MAX_REF, parseUnits } from './params.js';
import { verifyOutputRange, balanceExcess } from '../zk/shielded.js';

export class State {
  constructor() {
    this.accounts = new Map(); // address -> { balance: bigint, nonce: number }
    this.notes = new Map(); // id -> note (immutable objects)
    this.spent = new Set(); // spent note ids (nullifiers)
    this.authNonces = new Set(); // used x402 authorization nonces
    this.issued = 0n; // total VOX ever minted
    this.staked = 0n; // locked validator stake
    this.pool = 0n; // total value inside the shielded pool
    this.height = 0;
    this.stats = { txCount: 0, transfers: 0, shieldedTxs: 0, x402Payments: 0, x402PublicVolume: 0n, x402PrivatePayments: 0 };
  }

  clone() {
    const s = new State();
    for (const [k, v] of this.accounts) s.accounts.set(k, { ...v });
    s.notes = new Map(this.notes);
    s.spent = new Set(this.spent);
    s.authNonces = new Set(this.authNonces);
    s.issued = this.issued; s.staked = this.staked; s.pool = this.pool; s.height = this.height;
    s.stats = { ...this.stats };
    return s;
  }

  account(address) {
    return this.accounts.get(address) ?? { balance: 0n, nonce: 0 };
  }

  credit(address, amount) {
    const a = this.account(address);
    this.accounts.set(address, { balance: a.balance + amount, nonce: a.nonce });
  }

  circulating() {
    let total = 0n;
    for (const a of this.accounts.values()) total += a.balance;
    return total;
  }
}

const fail = (msg) => { throw new Error(msg); };

function checkFee(tx) {
  const fee = parseUnits(tx.fee, { allowZero: true });
  if (fee < MIN_FEE[tx.type]) fail(`fee below minimum ${MIN_FEE[tx.type]} units`);
  return fee;
}

function checkNonce(acct, nonce) {
  if (!Number.isSafeInteger(nonce) || nonce !== acct.nonce) fail(`bad nonce: expected ${acct.nonce}`);
}

function checkOutputShape(o, needRangeProof) {
  if (!o || typeof o !== 'object') fail('bad output');
  for (const k of ['P', 'R', 'C']) Point.fromHex(o[k]);
  if (typeof o.enc !== 'string' || !/^[0-9a-f]{16}$/.test(o.enc)) fail('bad encrypted amount');
  if (needRangeProof && typeof o.rp !== 'string') fail('missing range proof');
}

const storedNote = (o, hash, index, height) => ({ id: noteId(hash, index), P: o.P, R: o.R, C: o.C, enc: o.enc, txHash: hash, height });

const TYPE_KEYS = {
  transfer: ['type', 'from', 'to', 'amount', 'fee', 'nonce', 'memo', 'sig'],
  shield: ['type', 'from', 'amount', 'fee', 'nonce', 'output', 'openingProof', 'sig'],
  shielded: ['type', 'inputs', 'outputs', 'publicOut', 'fee', 'ref', 'sigs'],
  auth_transfer: ['type', 'relayer', 'fee', 'nonce', 'auth', 'authSig', 'sig'],
};

/**
 * Validate and apply `tx` to `state`. ctx = { height, timestamp (ms), skipCrypto }.
 * Returns { hash, fee }.
 */
export function applyTx(state, tx, ctx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) fail('tx must be an object');
  const allowed = TYPE_KEYS[tx.type];
  if (!allowed) fail('unknown tx type');
  for (const k of Object.keys(tx)) if (!allowed.includes(k)) fail(`unexpected field "${k}"`);
  if (txSize(tx) > MAX_TX_BYTES) fail('tx too large');
  const hash = txHash(tx);
  const verify = !ctx.skipCrypto;
  const fee = checkFee(tx);
  const sighash = txSighash(tx);

  switch (tx.type) {
    case 'transfer': {
      const pub = parsePub(tx.from);
      const from = addressFromPub(tx.from);
      if (!isAddress(tx.to)) fail('invalid recipient address');
      const amount = parseUnits(tx.amount);
      if (tx.memo !== undefined && (typeof tx.memo !== 'string' || tx.memo.length > MAX_MEMO)) fail('bad memo');
      const acct = state.account(from);
      checkNonce(acct, tx.nonce);
      if (acct.balance < amount + fee) fail('insufficient balance');
      if (verify && !schnorrVerify(tx.sig, sighash, pub)) fail('invalid signature');
      state.accounts.set(from, { balance: acct.balance - amount - fee, nonce: acct.nonce + 1 });
      state.credit(tx.to, amount);
      state.stats.transfers++;
      break;
    }

    case 'shield': {
      const pub = parsePub(tx.from);
      const from = addressFromPub(tx.from);
      const amount = parseUnits(tx.amount);
      checkOutputShape(tx.output, false);
      if (tx.output.rp !== undefined) fail('shield outputs carry no range proof');
      const acct = state.account(from);
      checkNonce(acct, tx.nonce);
      if (acct.balance < amount + fee) fail('insufficient balance');
      if (verify) {
        if (!schnorrVerify(tx.sig, sighash, pub)) fail('invalid signature');
        // Prove C - amount*H = blind*G: the commitment really holds exactly `amount`.
        const opening = Point.fromHex(tx.output.C).sub(mulH(amount));
        if (!schnorrVerify(tx.openingProof, sighash, opening)) fail('invalid commitment opening proof');
      }
      const note = storedNote(tx.output, hash, 0, ctx.height);
      if (state.notes.has(note.id)) fail('duplicate note');
      state.accounts.set(from, { balance: acct.balance - amount - fee, nonce: acct.nonce + 1 });
      state.pool += amount;
      state.notes.set(note.id, note);
      break;
    }

    case 'shielded': {
      const { inputs, outputs, publicOut } = tx;
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_SHIELDED_INPUTS) fail('bad inputs');
      if (!Array.isArray(outputs) || outputs.length > MAX_SHIELDED_OUTPUTS) fail('bad outputs');
      if (new Set(inputs).size !== inputs.length) fail('duplicate input');
      const notes = inputs.map((id) => {
        const n = typeof id === 'string' && state.notes.get(id);
        if (!n) fail('unknown note ' + id);
        if (state.spent.has(id)) fail('note already spent');
        return n;
      });
      outputs.forEach((o) => checkOutputShape(o, true));
      let pubAmount = 0n;
      if (publicOut !== null && publicOut !== undefined) {
        if (typeof publicOut !== 'object' || !isAddress(publicOut.to)) fail('bad publicOut');
        if (Object.keys(publicOut).some((k) => k !== 'to' && k !== 'amount')) fail('bad publicOut');
        pubAmount = parseUnits(publicOut.amount);
      }
      if (outputs.length === 0 && pubAmount === 0n) fail('tx has no outputs');
      if (tx.ref !== undefined && (typeof tx.ref !== 'string' || tx.ref.length > MAX_REF)) fail('bad ref');
      if (state.pool < pubAmount + fee) fail('shielded pool underflow');
      if (!tx.sigs || !Array.isArray(tx.sigs.inputs) || tx.sigs.inputs.length !== inputs.length) fail('bad sigs');
      if (verify) {
        notes.forEach((n, i) => {
          if (!schnorrVerify(tx.sigs.inputs[i], sighash, Point.fromHex(n.P))) fail('invalid input signature');
        });
        for (const o of outputs) if (!verifyOutputRange(o)) fail('invalid range proof');
        const excess = balanceExcess(notes.map((n) => n.C), outputs.map((o) => o.C), fee + pubAmount);
        if (excess.isZero() || !schnorrVerify(tx.sigs.balance, sighash, excess)) fail('invalid balance proof');
      }
      for (const id of inputs) state.spent.add(id);
      outputs.forEach((o, i) => { const n = storedNote(o, hash, i, ctx.height); state.notes.set(n.id, n); });
      state.pool -= pubAmount + fee;
      if (pubAmount > 0n) state.credit(publicOut.to, pubAmount);
      state.stats.shieldedTxs++;
      if (typeof tx.ref === 'string' && tx.ref.startsWith('x402:')) { state.stats.x402Payments++; state.stats.x402PrivatePayments++; }
      break;
    }

    case 'auth_transfer': {
      const relayerPub = parsePub(tx.relayer);
      const relayer = addressFromPub(tx.relayer);
      const a = tx.auth;
      if (!a || typeof a !== 'object') fail('missing authorization');
      const keys = Object.keys(a).sort().join(',');
      if (keys !== 'from,nonce,resource,to,validAfter,validBefore,value') fail('bad authorization fields');
      const payerPub = parsePub(a.from);
      const payer = addressFromPub(a.from);
      if (!isAddress(a.to)) fail('bad payee');
      const value = parseUnits(a.value);
      if (typeof a.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(a.nonce)) fail('bad authorization nonce');
      if (typeof a.resource !== 'string' || a.resource.length > MAX_REF) fail('bad resource');
      if (!Number.isSafeInteger(a.validAfter) || !Number.isSafeInteger(a.validBefore)) fail('bad validity window');
      const nowSec = Math.floor(ctx.timestamp / 1000);
      if (nowSec < a.validAfter || nowSec >= a.validBefore) fail('authorization expired or not yet valid');
      if (state.authNonces.has(a.nonce)) fail('authorization already used');
      const rAcct = state.account(relayer);
      checkNonce(rAcct, tx.nonce);
      const pAcct = state.account(payer);
      const sameAccount = payer === relayer;
      if (sameAccount ? pAcct.balance < value + fee : pAcct.balance < value) fail('payer has insufficient balance');
      if (!sameAccount && rAcct.balance < fee) fail('relayer cannot pay fee');
      if (verify) {
        if (!schnorrVerify(tx.authSig, authDigest(a), payerPub)) fail('invalid authorization signature');
        if (!schnorrVerify(tx.sig, sighash, relayerPub)) fail('invalid relayer signature');
      }
      const r = state.account(relayer);
      state.accounts.set(relayer, { balance: r.balance - fee, nonce: r.nonce + 1 });
      const p = state.account(payer);
      state.accounts.set(payer, { balance: p.balance - value, nonce: p.nonce });
      state.credit(a.to, value);
      state.authNonces.add(a.nonce);
      state.stats.x402Payments++;
      state.stats.x402PublicVolume += value;
      break;
    }
  }
  state.stats.txCount++;
  return { hash, fee };
}

// Addresses a tx touches (for the explorer's per-address history).
export function txAddresses(tx) {
  const out = new Set();
  try {
    if (tx.type === 'transfer') { out.add(addressFromPub(tx.from)); out.add(tx.to); }
    if (tx.type === 'shield') out.add(addressFromPub(tx.from));
    if (tx.type === 'shielded' && tx.publicOut) out.add(tx.publicOut.to);
    if (tx.type === 'auth_transfer') { out.add(addressFromPub(tx.relayer)); out.add(addressFromPub(tx.auth.from)); out.add(tx.auth.to); }
  } catch { /* malformed txs never reach the chain */ }
  return [...out];
}
