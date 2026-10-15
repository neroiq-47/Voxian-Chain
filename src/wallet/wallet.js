// Non-custodial wallet: builds and signs every transaction type client-side (Node or browser).
import { bytesToHex, hexToBytes, randomBytes } from '../crypto/encoding.js';
import { N, mod, mulH, Point, schnorrSign, scalarToHex } from '../crypto/secp256k1.js';
import { accountKeyFromSeed } from '../chain/keys.js';
import { txSighash, signTx, authDigest } from '../chain/tx.js';
import { deriveShieldedKeys, createOutput, scanOutput } from '../zk/shielded.js';
import { MIN_FEE } from '../chain/params.js';

export class Wallet {
  constructor(seedHex) {
    if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('wallet seed must be 32 bytes hex');
    this.seedHex = seedHex;
    const seed = hexToBytes(seedHex);
    Object.assign(this, accountKeyFromSeed(seed)); // secret, pub, pubHex, address
    this.shielded = deriveShieldedKeys(seed);
    this.zaddress = this.shielded.zaddress;
  }

  static generate() { return new Wallet(bytesToHex(randomBytes(32))); }

  transfer({ to, amount, nonce, fee = MIN_FEE.transfer, memo }) {
    const tx = { type: 'transfer', from: this.pubHex, to, amount: String(amount), fee: String(fee), nonce };
    if (memo) tx.memo = memo;
    return signTx(tx, this.secret);
  }

  // Public VOX -> private note owned by this wallet's z-address.
  shield({ amount, nonce, fee = MIN_FEE.shield }) {
    const value = BigInt(amount);
    const { output, blind } = createOutput(this.zaddress, value, { withRangeProof: false });
    const tx = { type: 'shield', from: this.pubHex, amount: value.toString(), fee: String(fee), nonce, output };
    const h = txSighash(tx);
    tx.openingProof = schnorrSign(h, blind, Point.fromHex(output.C).sub(mulH(value)));
    tx.sig = schnorrSign(h, this.secret, this.pub);
    return tx;
  }

  // Trial-decrypt chain notes; returns the ones we own (with their secrets).
  scanNotes(notes) {
    const owned = [];
    for (const n of notes) {
      const r = scanOutput(this.shielded, n);
      if (r) owned.push({ id: n.id, value: r.value, blind: r.blind, oneTimeSecret: r.oneTimeSecret, spent: !!n.spent, confirmed: n.confirmed !== false, height: n.height });
    }
    return owned;
  }

  /**
   * Private transfer / unshield. recipients: [{ zaddress, value: bigint }]; publicOut: { to, amount: bigint } | null.
   * Change returns to our own z-address. Returns { tx, disclosures } where disclosures[i] proves recipient i's payment.
   */
  buildShielded({ owned, recipients = [], publicOut = null, fee = MIN_FEE.shielded, ref }) {
    const pubAmount = publicOut ? BigInt(publicOut.amount) : 0n;
    const need = recipients.reduce((s, r) => s + BigInt(r.value), 0n) + pubAmount + BigInt(fee);
    const spendable = owned.filter((n) => !n.spent).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    const inputs = [];
    let total = 0n;
    for (const n of spendable) { if (total >= need) break; inputs.push(n); total += n.value; }
    if (total < need) throw new Error('insufficient shielded balance');
    if (inputs.length > 8) throw new Error('too many notes needed; consolidate first');

    const created = recipients.map((r, i) => ({ ...createOutput(r.zaddress, BigInt(r.value)), recipient: i }));
    const change = total - need;
    if (change > 0n) created.push(createOutput(this.zaddress, change));
    // Shuffle so output position doesn't reveal which output is the payment and which is change.
    for (let i = created.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [created[i], created[j]] = [created[j], created[i]]; }

    const tx = {
      type: 'shielded',
      inputs: inputs.map((n) => n.id),
      outputs: created.map((c) => c.output),
      publicOut: publicOut ? { to: publicOut.to, amount: pubAmount.toString() } : null,
      fee: String(fee),
    };
    if (ref) tx.ref = ref;
    const h = txSighash(tx);
    const z = mod(inputs.reduce((s, n) => s + n.blind, 0n) - created.reduce((s, c) => s + c.blind, 0n), N);
    tx.sigs = { inputs: inputs.map((n) => schnorrSign(h, n.oneTimeSecret)), balance: schnorrSign(h, z) };
    const disclosures = recipients.map((_, i) => { const k = created.findIndex((c) => c.recipient === i); return { outputIndex: k, txSecret: scalarToHex(created[k].txSecret) }; });
    return { tx, disclosures, spentIds: inputs.map((n) => n.id) };
  }

  // x402 "exact" scheme: sign an authorization a facilitator can settle (payer pays no gas).
  signAuthorization({ to, value, resource, validSeconds = 300, now = Date.now() }) {
    const t = Math.floor(now / 1000);
    const authorization = { from: this.pubHex, to, value: String(value), validAfter: t - 30, validBefore: t + validSeconds, nonce: bytesToHex(randomBytes(32)), resource };
    return { authorization, signature: schnorrSign(authDigest(authorization), this.secret, this.pub) };
  }
}
