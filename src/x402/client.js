// x402 client: fetch a resource, and if it answers 402, pay with a Voxian wallet and retry.
import { encodeHeader, decodeHeader, SCHEME_EXACT, SCHEME_ZK, PAYMENT_HEADER, RESPONSE_HEADER, X402_VERSION } from './protocol.js';
import { formatVox } from '../chain/params.js';

/**
 * opts: { wallet, api (ChainClient), scheme: 'exact' | 'zk-shielded' | 'auto', maxAmount (bigint units), onStep(evt) }
 * Returns { status, data, receipt, requirement, scheme, price }.
 */
export async function x402Fetch(fetchFn, url, init = {}, opts) {
  const { wallet, api, scheme = 'auto', maxAmount, onStep = () => {} } = opts;
  const first = await fetchFn(url, init);
  if (first.status !== 402) {
    const data = await first.json().catch(() => ({}));
    if (!first.ok) throw new Error(data.error || `HTTP ${first.status}`);
    return { status: first.status, data, price: 0n };
  }

  const challenge = await first.json();
  if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) throw new Error('402 response without payment options');
  onStep({ kind: '402', message: `402 Payment Required — ${challenge.accepts.length} payment option(s)`, challenge });

  let pick = scheme;
  if (scheme === 'auto') {
    const owned = wallet.scanNotes(await api.notes()).filter((n) => !n.spent);
    const price = BigInt(challenge.accepts[0].maxAmountRequired);
    const shieldedBal = owned.reduce((s, n) => s + n.value, 0n);
    pick = shieldedBal >= price + BigInt(challenge.accepts.find((a) => a.scheme === SCHEME_ZK)?.extra?.minFee ?? 0) ? SCHEME_ZK : SCHEME_EXACT;
  }
  const req = challenge.accepts.find((a) => a.scheme === pick);
  if (!req) throw new Error(`server does not accept scheme ${pick}`);
  const price = BigInt(req.maxAmountRequired);
  if (maxAmount !== undefined && price > maxAmount) throw new Error(`price ${formatVox(price)} VOX exceeds limit ${formatVox(maxAmount)} VOX`);

  let payload;
  if (pick === SCHEME_EXACT) {
    payload = wallet.signAuthorization({ to: req.payTo, value: price, resource: req.resource, validSeconds: req.maxTimeoutSeconds });
    onStep({ kind: 'sign', message: `Signed transfer authorization for ${formatVox(price)} VOX (facilitator pays gas)` });
  } else {
    const owned = wallet.scanNotes(await api.notes());
    onStep({ kind: 'prove', message: 'Building shielded payment: stealth output + Pedersen commitment + ZK range proofs…' });
    const { tx, disclosures } = wallet.buildShielded({ owned, recipients: [{ zaddress: req.payTo, value: price }], ref: req.extra.ref, fee: BigInt(req.extra.minFee) });
    payload = { transaction: tx, disclosure: disclosures[0] };
    onStep({ kind: 'sign', message: `Shielded tx ready (${tx.inputs.length} note in, ${tx.outputs.length} out). Amount & recipient hidden on-chain.` });
  }

  const header = encodeHeader({ x402Version: X402_VERSION, scheme: pick, network: req.network, payload });
  const second = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), [PAYMENT_HEADER]: header } });
  const data = await second.json().catch(() => ({ error: `HTTP ${second.status}` }));
  const rh = second.headers.get(RESPONSE_HEADER);
  const receipt = rh ? decodeHeader(rh) : null;
  if (second.status !== 200) throw new Error(`payment rejected: ${data.error || second.status}`);
  onStep({ kind: 'settled', message: `Settled on-chain · tx ${receipt?.transaction?.slice(0, 16)}…`, receipt });
  return { status: second.status, data, receipt, requirement: req, scheme: pick, price };
}
