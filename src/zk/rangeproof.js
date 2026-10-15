// Zero-knowledge range proof that a Pedersen commitment C = v*H + r*G hides 0 <= v < 2^RANGE_BITS.
// Construction: bit decomposition C = sum 2^i * C_i, and for each C_i a Cramer–Damgård–Schoenmakers
// OR-proof that C_i commits to 0 or 1 (Fiat–Shamir, 128-bit challenges). Reveals nothing about v.
// UNAUDITED demo cryptography.
import { H, N, mod, mulG, mulH, Point, randomScalar, invert, ZERO, scalarToHex, parseScalarHex } from '../crypto/secp256k1.js';
import { taggedHash } from '../crypto/sha256.js';
import { bytesToBig, bigToHex, hexToBig, randomBytes } from '../crypto/encoding.js';

export const RANGE_BITS = 55; // 2^55 > 210,000,000 VOX * 10^8, so every valid amount fits.
const C128 = 1n << 128n;

const challenge = (C, Ci, R0, R1, i) =>
  bytesToBig(taggedHash('Voxian/range', C.toBytes(), Ci.toBytes(), R0.toBytes(), R1.toBytes(), new Uint8Array([i]))) % C128;

export function commit(value, blind) {
  return mulH(value).add(mulG(blind));
}

// Per-bit encoding (hex): C_i (66) | e0 (32) | e1 (32) | s0 (64) | s1 (64)
const BIT_HEX = 66 + 32 + 32 + 64 + 64;
export const RANGE_PROOF_HEX_LEN = BIT_HEX * RANGE_BITS;

export function proveRange(value, blind, C = commit(value, blind)) {
  if (value < 0n || value >= 1n << BigInt(RANGE_BITS)) throw new Error('value out of range');
  // Bit blinds must satisfy sum 2^i r_i = blind (mod N).
  const blinds = [];
  let acc = 0n;
  for (let i = 0; i < RANGE_BITS - 1; i++) {
    const r = randomScalar();
    blinds.push(r);
    acc = mod(acc + (r << BigInt(i)), N);
  }
  blinds.push(mod((blind - acc) * invert(1n << BigInt(RANGE_BITS - 1), N), N));

  let out = '';
  for (let i = 0; i < RANGE_BITS; i++) {
    const b = Number((value >> BigInt(i)) & 1n);
    const r = blinds[i];
    const Ci = b ? H.add(mulG(r)) : mulG(r);
    const targets = [Ci, Ci.sub(H)]; // log_G(targets[b]) = r
    const sim = 1 - b;
    const k = randomScalar();
    const e = [0n, 0n], s = [0n, 0n], R = [null, null];
    e[sim] = bytesToBig(randomBytes(16));
    s[sim] = randomScalar();
    R[sim] = mulG(s[sim]).sub(targets[sim].mul(e[sim]));
    R[b] = mulG(k);
    const ch = challenge(C, Ci, R[0], R[1], i);
    e[b] = mod(ch - e[sim], C128);
    s[b] = mod(k + e[b] * r, N);
    out += Ci.toHex() + bigToHex(e[0], 16) + bigToHex(e[1], 16) + scalarToHex(s[0]) + scalarToHex(s[1]);
  }
  return out;
}

export function verifyRange(C, proofHex) {
  try {
    if (typeof proofHex !== 'string' || proofHex.length !== RANGE_PROOF_HEX_LEN) return false;
    let sum = ZERO;
    // Iterate from the most significant bit so the aggregate is built with Horner's rule.
    for (let i = RANGE_BITS - 1; i >= 0; i--) {
      const chunk = proofHex.slice(i * BIT_HEX, (i + 1) * BIT_HEX);
      const Ci = Point.fromHex(chunk.slice(0, 66));
      const e0 = hexToBig(chunk.slice(66, 98));
      const e1 = hexToBig(chunk.slice(98, 130));
      const s0 = parseScalarHex(chunk.slice(130, 194));
      const s1 = parseScalarHex(chunk.slice(194, 258));
      const R0 = mulG(s0).sub(Ci.mul(e0));
      const R1 = mulG(s1).sub(Ci.sub(H).mul(e1));
      if (R0.isZero() || R1.isZero()) return false;
      if ((e0 + e1) % C128 !== challenge(C, Ci, R0, R1, i)) return false;
      sum = sum.double().add(Ci);
    }
    return sum.equals(C);
  } catch {
    return false;
  }
}
