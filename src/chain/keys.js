// Account keys and addresses.
import { mulG, hashToScalar, Point } from '../crypto/secp256k1.js';
import { sha256Hex } from '../crypto/sha256.js';
import { hexToBytes, utf8 } from '../crypto/encoding.js';

export const ADDRESS_RE = /^vox1[0-9a-f]{40}$/;
export const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

export const addressFromPub = (pubHex) => 'vox1' + sha256Hex(hexToBytes(pubHex)).slice(0, 40);
export const isAddress = (a) => typeof a === 'string' && ADDRESS_RE.test(a);

export function parsePub(pubHex) {
  if (typeof pubHex !== 'string' || !PUBKEY_RE.test(pubHex)) throw new Error('invalid public key');
  return Point.fromHex(pubHex);
}

export function accountKeyFromSeed(seed /* Uint8Array */) {
  const secret = hashToScalar('Voxian/account-key', seed);
  const pub = mulG(secret);
  const pubHex = pub.toHex();
  return { secret, pub, pubHex, address: addressFromPub(pubHex) };
}

// Well-known devnet roles. Keys derive from a node secret (VOXIAN_DEVNET_SECRET); the default is public,
// which is fine for a demo network and NOT for anything holding value.
export const DEFAULT_DEVNET_SECRET = 'voxian-public-devnet';
export function devnetSeed(secret, role) {
  return utf8(`${secret}/${role}`);
}
