// Byte/hex/JSON helpers shared by Node and the browser (no dependencies).

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (b) => td.decode(b);

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts) {
  const arrs = parts.map((p) => (typeof p === 'string' ? utf8(p) : p));
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

export function bigToBytes(n, len = 32) {
  if (n < 0n) throw new Error('negative bigint');
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  if (n !== 0n) throw new Error('bigint too large');
  return out;
}

export function bytesToBig(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export const bigToHex = (n, len = 32) => bytesToHex(bigToBytes(n, len));
export const hexToBig = (hex) => bytesToBig(hexToBytes(hex));

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}


// Deterministic JSON: sorted keys, no undefined, no non-finite numbers.
export function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') throw new Error('bigint must be encoded as string');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new Error('unsupported type ' + typeof value);
}

export function base64Encode(str) {
  const bytes = utf8(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return fromUtf8(bytes);
}
