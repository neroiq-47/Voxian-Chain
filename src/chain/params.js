// Protocol parameters. VOX figures follow the Voxian short white paper; everything else is a devnet choice
// (the white paper notes allocation, issuance and fee rules are not final).

export const CHAIN_ID = 'voxian-devnet-1';
export const NETWORK = 'voxian-devnet';
export const TICKER = 'VOX';
export const DECIMALS = 8;
export const UNIT = 10n ** BigInt(DECIMALS);
export const MAX_SUPPLY = 210_000_000n * UNIT; // 210,000,000 VOX, smallest unit 0.00000001 VOX

// Issuance: 50 VOX per block, halving every 2.1M blocks, hard-capped at MAX_SUPPLY.
export const INITIAL_REWARD = 50n * UNIT;
export const HALVING_INTERVAL = 2_100_000;

export const MIN_FEE = {
  transfer: 10_000n, // 0.0001 VOX
  auth_transfer: 10_000n, // x402 "exact" settlement, paid by the facilitator
  shield: 50_000n, // 0.0005 VOX
  shielded: 100_000n, // 0.001 VOX (range proofs are expensive to verify)
};

export const BLOCK_INTERVAL_MS = 2_000; // produce a block this often while txs are waiting
export const EMPTY_BLOCK_MS = 10_000; // heartbeat block when idle
export const MAX_BLOCK_TXS = 200;
export const MAX_MEMPOOL = 1_000;
export const MAX_TX_BYTES = 200_000;
export const MAX_SHIELDED_INPUTS = 8;
export const MAX_SHIELDED_OUTPUTS = 4;
export const MAX_MEMO = 140;
export const MAX_REF = 200;
export const GENESIS_TIMESTAMP = Date.UTC(2026, 9, 1); // 2026-10-01

export function blockReward(height, issued) {
  if (height <= 0) return 0n;
  const halvings = Math.floor((height - 1) / HALVING_INTERVAL);
  const reward = halvings >= 64 ? 0n : INITIAL_REWARD >> BigInt(halvings);
  const room = MAX_SUPPLY - issued;
  return room <= 0n ? 0n : reward < room ? reward : room;
}

export function parseVox(str) {
  const s = String(str).trim();
  if (!/^\d{1,9}(\.\d{1,8})?$/.test(s)) throw new Error(`invalid VOX amount "${str}" (max 8 decimals)`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(DECIMALS, '0'));
}

export function formatVox(units, { trim = true } = {}) {
  const u = BigInt(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = (a / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (a % UNIT).toString().padStart(DECIMALS, '0');
  if (trim) frac = frac.replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

// Amounts travel as decimal strings of base units (JSON has no 64-bit ints).
export function parseUnits(s, { allowZero = false } = {}) {
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,16})$/.test(s)) throw new Error('amount must be a base-unit integer string');
  const v = BigInt(s);
  if (!allowZero && v === 0n) throw new Error('amount must be positive');
  if (v > MAX_SUPPLY) throw new Error('amount exceeds max supply');
  return v;
}
