// Minimal secp256k1 group arithmetic + Schnorr signatures, pure BigInt (works in Node and browsers).
// UNAUDITED demo cryptography — do not use to protect real value.
import { bigToBytes, bytesToBig, bytesToHex, hexToBytes, concatBytes, randomBytes, utf8 } from './encoding.js';
import { taggedHash } from './sha256.js';

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };

export function invert(a, m = P) {
  a = mod(a, m);
  if (a === 0n) throw new Error('inverse of zero');
  let [x0, x1, r0, r1] = [0n, 1n, m, a];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [x0, x1] = [x1, x0 - q * x1];
  }
  return mod(x0, m);
}

function powMod(b, e, m) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

// Jacobian coordinates; Z === 0n is the point at infinity.
export class Point {
  constructor(X, Y, Z) { this.X = X; this.Y = Y; this.Z = Z; }
  static fromAffine(x, y) { return new Point(x, y, 1n); }
  isZero() { return this.Z === 0n; }

  double() {
    const { X, Y, Z } = this;
    if (Z === 0n || Y === 0n) return ZERO;
    const A = (X * X) % P, B = (Y * Y) % P, C = (B * B) % P;
    const t = X + B;
    const D = mod(2n * (t * t - A - C));
    const E = 3n * A, F = (E * E) % P;
    const X3 = mod(F - 2n * D);
    const Y3 = mod(E * (D - X3) - 8n * C);
    const Z3 = (2n * Y * Z) % P;
    return new Point(X3, Y3, Z3);
  }

  add(Q) {
    if (this.Z === 0n) return Q;
    if (Q.Z === 0n) return this;
    const { X: X1, Y: Y1, Z: Z1 } = this, { X: X2, Y: Y2, Z: Z2 } = Q;
    const Z1Z1 = (Z1 * Z1) % P, Z2Z2 = (Z2 * Z2) % P;
    const U1 = (X1 * Z2Z2) % P, U2 = (X2 * Z1Z1) % P;
    const S1 = (((Y1 * Z2) % P) * Z2Z2) % P, S2 = (((Y2 * Z1) % P) * Z1Z1) % P;
    if (U1 === U2) return S1 === S2 ? this.double() : ZERO;
    const H = mod(U2 - U1), I = (4n * H * H) % P, J = (H * I) % P;
    const r = mod(2n * (S2 - S1)), V = (U1 * I) % P;
    const X3 = mod(r * r - J - 2n * V);
    const Y3 = mod(r * (V - X3) - 2n * S1 * J);
    const zs = Z1 + Z2;
    const Z3 = mod((zs * zs - Z1Z1 - Z2Z2) * H);
    return new Point(X3, Y3, Z3);
  }

  negate() { return new Point(this.X, this.Z === 0n ? this.Y : mod(-this.Y), this.Z); }
  sub(Q) { return this.add(Q.negate()); }

  // 4-bit fixed window, variable base.
  mul(k) {
    k = mod(k, N);
    if (k === 0n || this.Z === 0n) return ZERO;
    const table = [ZERO, this];
    for (let i = 2; i < 16; i++) table.push(table[i - 1].add(this));
    let acc = ZERO;
    const bits = k.toString(2);
    const pad = (4 - (bits.length % 4)) % 4;
    const s = '0'.repeat(pad) + bits;
    for (let i = 0; i < s.length; i += 4) {
      if (!acc.isZero()) acc = acc.double().double().double().double();
      const w = parseInt(s.slice(i, i + 4), 2);
      if (w) acc = acc.add(table[w]);
    }
    return acc;
  }

  toAffine() {
    if (this.Z === 0n) throw new Error('point at infinity');
    const zi = invert(this.Z), zi2 = (zi * zi) % P;
    return { x: (this.X * zi2) % P, y: (((this.Y * zi2) % P) * zi) % P };
  }

  equals(Q) {
    if (this.Z === 0n || Q.Z === 0n) return this.Z === 0n && Q.Z === 0n;
    const Z1Z1 = (this.Z * this.Z) % P, Z2Z2 = (Q.Z * Q.Z) % P;
    if ((this.X * Z2Z2) % P !== (Q.X * Z1Z1) % P) return false;
    return (((this.Y * Q.Z) % P) * Z2Z2) % P === (((Q.Y * this.Z) % P) * Z1Z1) % P;
  }

  toBytes() {
    const { x, y } = this.toAffine();
    return concatBytes(Uint8Array.of(y & 1n ? 3 : 2), bigToBytes(x));
  }
  toHex() { return bytesToHex(this.toBytes()); }

  static fromBytes(b) {
    if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) throw new Error('invalid point encoding');
    const x = bytesToBig(b.subarray(1));
    if (x >= P) throw new Error('invalid point x');
    const y = liftX(x);
    if (y === null) throw new Error('point not on curve');
    const odd = (y & 1n) === 1n;
    return Point.fromAffine(x, odd === (b[0] === 3) ? y : P - y);
  }
  static fromHex(h) { return Point.fromBytes(hexToBytes(h)); }
}

export const ZERO = new Point(0n, 1n, 0n);

function liftX(x) {
  const c = mod(x * x * x + 7n);
  const y = powMod(c, (P + 1n) / 4n, P);
  return (y * y) % P === c ? y : null;
}

// Precomputed fixed-base tables: table[i][j] = j * 16^i * B. Lazily built.
class FixedBase {
  constructor(point) { this.point = point; this.table = null; }
  build() {
    this.table = [];
    let base = this.point;
    for (let i = 0; i < 64; i++) {
      const row = [ZERO, base];
      for (let j = 2; j < 16; j++) row.push(row[j - 1].add(base));
      this.table.push(row);
      base = row[15].add(base); // 16 * base
    }
  }
  mul(k) {
    if (!this.table) this.build();
    k = mod(k, N);
    let acc = ZERO;
    for (let i = 0; k > 0n; i++, k >>= 4n) {
      const w = Number(k & 15n);
      if (w) acc = acc.add(this.table[i][w]);
    }
    return acc;
  }
}

export const G = Point.fromAffine(GX, GY);

// Second generator H for Pedersen commitments: nothing-up-my-sleeve hash-to-curve
// (try-and-increment), so nobody knows log_G(H).
function deriveH() {
  for (let ctr = 0; ; ctr++) {
    const x = mod(bytesToBig(taggedHash('Voxian/Pedersen/H', utf8(String(ctr)))));
    const y = liftX(x);
    if (y !== null) return Point.fromAffine(x, y & 1n ? P - y : y);
  }
}
export const H = deriveH();

const gTable = new FixedBase(G);
const hTable = new FixedBase(H);
export const mulG = (k) => gTable.mul(k);
export const mulH = (k) => hTable.mul(k);

export function hashToScalar(tag, ...parts) {
  const s = mod(bytesToBig(taggedHash(tag, ...parts)), N);
  if (s === 0n) throw new Error('zero scalar');
  return s;
}

export function randomScalar() {
  for (;;) {
    const k = bytesToBig(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
}

export const scalarToBytes = (k) => bigToBytes(mod(k, N));
export const scalarToHex = (k) => bytesToHex(scalarToBytes(k));

export function parseScalarHex(h) {
  if (typeof h !== 'string' || h.length !== 64) throw new Error('invalid scalar');
  const k = bytesToBig(hexToBytes(h));
  if (k >= N) throw new Error('scalar out of range');
  return k;
}

// ---- Schnorr signatures: sig = R (33 bytes) || s (32 bytes), s*G = R + e*P ----
function challenge(R, pub, msg) {
  return mod(bytesToBig(taggedHash('Voxian/schnorr', R.toBytes(), pub.toBytes(), msg)), N);
}

export function schnorrSign(msg, secret, pub = mulG(secret)) {
  const k = hashToScalar('Voxian/nonce', scalarToBytes(secret), msg, randomBytes(32));
  const R = mulG(k);
  const e = challenge(R, pub, msg);
  return bytesToHex(concatBytes(R.toBytes(), scalarToBytes(k + e * secret)));
}

export function schnorrVerify(sigHex, msg, pub) {
  try {
    if (typeof sigHex !== 'string' || sigHex.length !== 130) return false;
    if (pub.isZero()) return false;
    const R = Point.fromHex(sigHex.slice(0, 66));
    const s = parseScalarHex(sigHex.slice(66));
    const e = challenge(R, pub, msg);
    return mulG(s).equals(R.add(pub.mul(e)));
  } catch {
    return false;
  }
}
