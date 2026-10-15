// x402 (HTTP 402 Payment Required) wire format, following the x402 v1 spec:
//   402 body:            { x402Version, error, accepts: PaymentRequirements[] }
//   request header:      X-PAYMENT: base64(JSON PaymentPayload)
//   response header:     X-PAYMENT-RESPONSE: base64(JSON SettlementResponse)
// Voxian defines two schemes on network "voxian-devnet":
//   exact        – payer signs a transfer authorization; the facilitator relays it and pays gas.
//   zk-shielded  – payer sends a confidential shielded tx to the payee's z-address and discloses
//                  the output's tx secret to the facilitator only. Observers learn nothing.
import { base64Encode, base64Decode } from '../crypto/encoding.js';
import { NETWORK, TICKER, DECIMALS, MIN_FEE } from '../chain/params.js';

export const X402_VERSION = 1;
export const SCHEME_EXACT = 'exact';
export const SCHEME_ZK = 'zk-shielded';
export const PAYMENT_HEADER = 'x-payment';
export const RESPONSE_HEADER = 'x-payment-response';

export const encodeHeader = (obj) => base64Encode(JSON.stringify(obj));

export function decodeHeader(value) {
  if (typeof value !== 'string' || value.length > 400_000) throw new Error('invalid payment header');
  const obj = JSON.parse(base64Decode(value));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('invalid payment header');
  return obj;
}

export const zkRef = (resource) => `x402:${resource}`;

export function paymentRequirements(service, payee) {
  const common = {
    network: NETWORK,
    maxAmountRequired: service.price,
    resource: service.path,
    description: service.description,
    mimeType: 'application/json',
    maxTimeoutSeconds: 300,
    asset: TICKER,
  };
  return [
    { scheme: SCHEME_EXACT, ...common, payTo: payee.address, extra: { name: 'Voxian', decimals: DECIMALS } },
    { scheme: SCHEME_ZK, ...common, payTo: payee.zaddress, extra: { name: 'Voxian', decimals: DECIMALS, ref: zkRef(service.path), minFee: MIN_FEE.shielded.toString() } },
  ];
}
