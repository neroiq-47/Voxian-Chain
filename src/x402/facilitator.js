// x402 facilitator for Voxian: verifies payment payloads against requirements and settles them on-chain.
import { applyTx } from '../chain/state.js';
import { signTx, txHash } from '../chain/tx.js';
import { MIN_FEE, NETWORK } from '../chain/params.js';
import { addressFromPub } from '../chain/keys.js';
import { verifyDisclosure } from '../zk/shielded.js';
import { X402_VERSION, SCHEME_EXACT, SCHEME_ZK, zkRef } from './protocol.js';

export class Facilitator {
  constructor(chain, key) {
    this.chain = chain;
    this.key = key; // facilitator account: relays "exact" payments and pays their gas
  }

  supported() {
    return { kinds: [{ x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: NETWORK }, { x402Version: X402_VERSION, scheme: SCHEME_ZK, network: NETWORK }] };
  }

  // Build the on-chain tx that settles this payment (exact: relayer-signed; zk: the payer's own tx).
  buildTx(payment) {
    if (payment.scheme === SCHEME_EXACT) {
      const { authorization, signature } = payment.payload ?? {};
      const nonce = this.chain.pending.account(this.key.address).nonce;
      return signTx({ type: 'auth_transfer', relayer: this.key.pubHex, fee: MIN_FEE.auth_transfer.toString(), nonce, auth: authorization, authSig: signature }, this.key.secret);
    }
    return payment.payload?.transaction;
  }

  verify(payment, req) {
    try {
      if (!payment || payment.x402Version !== X402_VERSION) throw new Error('unsupported x402Version');
      if (payment.scheme !== req.scheme || payment.network !== req.network) throw new Error('scheme/network mismatch');
      const required = BigInt(req.maxAmountRequired);
      let payer;
      if (payment.scheme === SCHEME_EXACT) {
        const a = payment.payload?.authorization;
        if (!a || typeof a !== 'object') throw new Error('missing authorization');
        if (a.to !== req.payTo) throw new Error('authorization pays the wrong address');
        if (a.resource !== req.resource) throw new Error('authorization is for a different resource');
        if (typeof a.value !== 'string' || !/^\d{1,17}$/.test(a.value) || BigInt(a.value) < required) throw new Error('insufficient amount');
        if (a.validBefore - Math.floor(Date.now() / 1000) > req.maxTimeoutSeconds + 60) throw new Error('authorization window too long');
        payer = addressFromPub(a.from);
      } else if (payment.scheme === SCHEME_ZK) {
        const tx = payment.payload?.transaction;
        const d = payment.payload?.disclosure;
        if (!tx || tx.type !== 'shielded') throw new Error('expected a shielded transaction');
        if (tx.ref !== zkRef(req.resource)) throw new Error('payment ref does not match resource');
        const out = Array.isArray(tx.outputs) && tx.outputs[d?.outputIndex];
        if (!out) throw new Error('disclosed output not found');
        const value = verifyDisclosure(req.payTo, out, d.txSecret);
        if (value < required) throw new Error('insufficient amount');
        payer = 'shielded';
      } else {
        throw new Error('unsupported scheme');
      }
      // Dry-run the settlement tx against the pending state (signatures, proofs, balances, replay).
      const tx = this.buildTx(payment);
      const hash = txHash(tx);
      applyTx(this.chain.pending.clone(), tx, { height: this.chain.height + 1, timestamp: Date.now(), skipCrypto: this.chain.verified.has(hash) });
      this.chain.verified.add(hash); // signatures/proofs checked once; settle() reuses the result
      return { isValid: true, payer };
    } catch (e) {
      return { isValid: false, invalidReason: e.message };
    }
  }

  settle(payment, req) {
    const v = this.verify(payment, req);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, network: NETWORK, transaction: '' };
    try {
      const hash = this.chain.submitTx(this.buildTx(payment));
      return { success: true, transaction: hash, network: NETWORK, payer: v.payer };
    } catch (e) {
      return { success: false, errorReason: e.message, network: NETWORK, transaction: '' };
    }
  }
}
