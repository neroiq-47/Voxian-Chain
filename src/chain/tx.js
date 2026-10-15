// Transaction encoding, hashing and signing.
import { canonicalJSON, utf8, concatBytes } from '../crypto/encoding.js';
import { sha256, sha256Hex, taggedHash } from '../crypto/sha256.js';
import { schnorrSign } from '../crypto/secp256k1.js';
import { CHAIN_ID } from './params.js';

export const TX_TYPES = ['transfer', 'shield', 'shielded', 'auth_transfer'];
const SIG_FIELDS = new Set(['sig', 'sigs', 'openingProof']);

function stripSigs(tx) {
  const out = {};
  for (const k of Object.keys(tx)) if (!SIG_FIELDS.has(k)) out[k] = tx[k];
  return out;
}

// What signers commit to: chain id + every non-signature field.
export const txSighash = (tx) => taggedHash('Voxian/tx', utf8(CHAIN_ID), utf8(canonicalJSON(stripSigs(tx))));
export const txHash = (tx) => sha256Hex(canonicalJSON(tx));
export const txSize = (tx) => canonicalJSON(tx).length;
export const noteId = (hash, index) => sha256Hex(`${hash}:${index}`);

export function signTx(tx, secret) {
  tx.sig = schnorrSign(txSighash(tx), secret);
  return tx;
}

// x402 "exact" authorization (EIP-3009 style): the payer signs a transfer that a facilitator relays.
export const authDigest = (auth) => taggedHash('Voxian/x402/auth', utf8(CHAIN_ID), utf8(canonicalJSON(auth)));

export function merkleRoot(hashes) {
  if (hashes.length === 0) return sha256Hex('');
  let level = hashes.map((h) => sha256(utf8(h)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(concatBytes(level[i], level[i + 1] ?? level[i])));
    level = next;
  }
  return Array.from(level[0], (b) => b.toString(16).padStart(2, '0')).join('');
}
