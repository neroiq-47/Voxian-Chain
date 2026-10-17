// Shielded ("z") addresses and confidential notes.
//  - Stealth outputs: each note gets a fresh one-time key P = Hs(r*A)*G + B, so observers can't link
//    notes to a z-address. Only the holder of view key a can recognise them (Hs(a*R) == Hs(r*A)).
//  - Amounts are hidden in Pedersen commitments C = v*H + blind*G with a ZK range proof.
//  - The amount is encrypted to the recipient; the blinding factor is derived from the shared secret.
// UNAUDITED demo cryptography.
import { N, ZERO, mod, mulG, mulH, Point, randomScalar, hashToScalar, scalarToBytes } from '../crypto/secp256k1.js';
import { taggedHash } from '../crypto/sha256.js';
import { bigToHex, bytesToBig, hexToBig } from '../crypto/encoding.js';
import { commit, proveRange, verifyRange } from './rangeproof.js';

export const ZADDR_PREFIX = 'voxz';
const MASK64 = (1n << 64n) - 1n;

export function deriveShieldedKeys(seed /* Uint8Array */) {
  const viewSecret = hashToScalar('Voxian/view-key', seed);
  const spendSecret = hashToScalar('Voxian/spend-key', seed);
  const A = mulG(viewSecret), B = mulG(spendSecret);
  return { viewSecret, spendSecret, A, B, zaddress: ZADDR_PREFIX + A.toHex() + B.toHex() };
}

export function parseZAddress(z) {
  if (typeof z !== 'string' || !/^voxz[0-9a-f]{132}$/.test(z)) throw new Error('invalid z-address');
  return { A: Point.fromHex(z.slice(4, 70)), B: Point.fromHex(z.slice(70, 136)) };
}

export const isZAddress = (z) => { try { parseZAddress(z); return true; } catch { return false; } };

function sharedFrom(point) {
  return hashToScalar('Voxian/stealth', point.toBytes());
}
const blindFrom = (shared) => hashToScalar('Voxian/blind', scalarToBytes(shared));
const maskFrom = (shared) => bytesToBig(taggedHash('Voxian/amount', scalarToBytes(shared)).subarray(0, 8));

// Create a confidential output paying `value` (bigint, base units) to a z-address.
export function createOutput(zaddress, value, { withRangeProof = true } = {}) {
  const txSecret = randomScalar();
  const { A, B } = parseZAddress(zaddress);
  const R = mulG(txSecret);
  const shared = sharedFrom(A.mul(txSecret));
  const P = mulG(shared).add(B);
  const blind = blindFrom(shared);
  const C = commit(value, blind);
  const output = {
    P: P.toHex(),
    R: R.toHex(),
    C: C.toHex(),
    enc: bigToHex((value ^ maskFrom(shared)) & MASK64, 8),
  };
  if (withRangeProof) output.rp = proveRange(value, blind, C);
  return { output, value, blind, txSecret };
}

// Recipient-side scan. Returns null if the note isn't ours.
export function scanOutput(keys, out) {
  try {
    const R = Point.fromHex(out.R);
    const shared = sharedFrom(R.mul(keys.viewSecret));
    const P = Point.fromHex(out.P);
    if (!mulG(shared).add(keys.B).equals(P)) return null;
    const value = (hexToBig(out.enc) ^ maskFrom(shared)) & MASK64;
    const blind = blindFrom(shared);
    if (!commit(value, blind).equals(Point.fromHex(out.C))) return null;
    return { value, blind, oneTimeSecret: mod(shared + keys.spendSecret, N) };
  } catch {
    return null;
  }
}

// Payment disclosure (used by x402 "zk-shielded"): the payer reveals the per-output tx secret r to the
// payee's facilitator only, proving "output i pays v to z-address" without revealing who paid.
export function verifyDisclosure(zaddress, out, txSecretHex) {
  const { A, B } = parseZAddress(zaddress);
  const r = hexToBig(txSecretHex);
  if (r <= 0n || r >= N) throw new Error('bad tx secret');
  if (!mulG(r).equals(Point.fromHex(out.R))) throw new Error('tx secret does not match R');
  const shared = sharedFrom(A.mul(r));
  if (!mulG(shared).add(B).equals(Point.fromHex(out.P))) throw new Error('output not addressed to payee');
  const value = (hexToBig(out.enc) ^ maskFrom(shared)) & MASK64;
  if (!commit(value, blindFrom(shared)).equals(Point.fromHex(out.C))) throw new Error('amount does not open commitment');
  return value;
}

export const verifyOutputRange = (out) => verifyRange(Point.fromHex(out.C), out.rp);

// Excess point for the balance proof: sum(C_in) - sum(C_out) - publicValue*H must equal z*G.
export function balanceExcess(inputCommitments, outputCommitments, publicValue) {
  let X = ZERO;
  for (const c of inputCommitments) X = X.add(Point.fromHex(c));
  for (const c of outputCommitments) X = X.sub(Point.fromHex(c));
  return X.sub(mulH(publicValue));
}

