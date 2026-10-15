import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createECDH } from 'node:crypto';
import { sha256Hex } from '../src/crypto/sha256.js';
import { G, H, N, mulG, mulH, Point, randomScalar, schnorrSign, schnorrVerify } from '../src/crypto/secp256k1.js';
import { utf8, canonicalJSON, base64Encode, base64Decode } from '../src/crypto/encoding.js';
import { commit, proveRange, verifyRange, RANGE_BITS } from '../src/zk/rangeproof.js';
import { deriveShieldedKeys, createOutput, scanOutput, verifyDisclosure } from '../src/zk/shielded.js';
import { scalarToHex } from '../src/crypto/secp256k1.js';

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ü'.repeat(300)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
});

test('secp256k1 matches node:crypto public keys', () => {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  const sk = BigInt('0x' + ecdh.getPrivateKey('hex'));
  assert.equal(mulG(sk).toHex(), ecdh.getPublicKey('hex', 'compressed'));
  assert.equal(G.mul(sk).toHex(), ecdh.getPublicKey('hex', 'compressed'));
  assert.ok(G.mul(N - 1n).add(G).isZero());
  assert.ok(Point.fromHex(H.toHex()).equals(H));
  assert.ok(mulH(7n).equals(H.mul(7n)));
});

test('schnorr signatures', () => {
  const sk = randomScalar();
  const m = utf8('voxian');
  const sig = schnorrSign(m, sk);
  assert.ok(schnorrVerify(sig, m, mulG(sk)));
  assert.ok(!schnorrVerify(sig, utf8('voxiam'), mulG(sk)));
  assert.ok(!schnorrVerify(sig, m, mulG(sk + 1n)));
  assert.ok(!schnorrVerify(sig.slice(0, -2) + '00', m, mulG(sk)));
  assert.ok(!schnorrVerify('zz', m, mulG(sk)));
});

test('range proofs: completeness and soundness checks', () => {
  const b = randomScalar();
  for (const v of [0n, 1n, 123456789n, (1n << BigInt(RANGE_BITS)) - 1n]) {
    assert.ok(verifyRange(commit(v, b), proveRange(v, b)), `value ${v}`);
  }
  const p = proveRange(42n, b);
  assert.ok(!verifyRange(commit(43n, b), p), 'proof bound to its commitment');
  const tampered = p.slice(0, 100) + (p[100] === 'a' ? 'b' : 'a') + p.slice(101);
  assert.ok(!verifyRange(commit(42n, b), tampered));
  assert.throws(() => proveRange(-1n, b));
  assert.throws(() => proveRange(1n << BigInt(RANGE_BITS), b));
});

test('stealth outputs are only visible to the recipient', () => {
  const alice = deriveShieldedKeys(utf8('alice')), bob = deriveShieldedKeys(utf8('bob'));
  const o = createOutput(bob.zaddress, 777n);
  assert.equal(scanOutput(bob, o.output).value, 777n);
  assert.equal(scanOutput(alice, o.output), null);
  assert.equal(verifyDisclosure(bob.zaddress, o.output, scalarToHex(o.txSecret)), 777n);
  assert.throws(() => verifyDisclosure(alice.zaddress, o.output, scalarToHex(o.txSecret)));
  const o2 = createOutput(bob.zaddress, 777n);
  assert.notEqual(o.output.P, o2.output.P, 'one-time keys are unlinkable');
});

test('encoding helpers', () => {
  assert.equal(canonicalJSON({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(base64Decode(base64Encode('héllo ⚡')), 'héllo ⚡');
  assert.throws(() => canonicalJSON({ a: 1n }));
});
