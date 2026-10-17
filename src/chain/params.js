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
  validator_register: 100_000n,
  stake: 10_000n,
  unstake: 10_000n,
  evidence: 10_000n,
  unjail: 10_000n,
};

export const BLOCK_INTERVAL_MS = 2_000; // produce a block this often while txs are waiting
export const EMPTY_BLOCK_MS = 10_000; // heartbeat block when idle
export const MAX_BLOCK_TXS = 200;
export const MAX_MEMPOOL = 1_000;
export const MAX_PENDING_PER_SENDER = 64; // per public key ('shielded' counts as one sender)
export const MIN_AUTH_VALIDITY_S = 30; // x402 authorizations must stay valid this long after admission
export const MAX_CLOCK_DRIFT_MS = 15_000;

// ---- Proof of History (phase 1-2) ----
export const TICK_MS = 100; // target wall time per PoH tick (the recorder ticks on this timer)
export const HASHES_PER_TICK = 200; // sequential SHA-256 per tick (devnet-sized so browsers can verify)
export const TICKS_PER_SLOT = 10; // 1 s slots; a BFT round lasts one slot
export const SLOTS_PER_EPOCH = 120; // 2 min epochs: validator set & leader schedule change at boundaries
export const LEADER_SLOTS = 2; // consecutive slots per scheduled leader
// An idle chain still produces a heartbeat block this many slots after the last one; a leader is only
// charged with a missed slot for skipped slots at or beyond this point (earlier slots had nothing due).
export const HEARTBEAT_SLOTS = Math.ceil(EMPTY_BLOCK_MS / (TICK_MS * TICKS_PER_SLOT));
export const MAX_BLOCK_TICKS = 1_200; // verification bound per block (~0.3 s of hashing)
// A block may skip at most this many slots, and must carry PoH for every skipped slot (no cap), so a
// leader can't jump ahead cheaply. During a longer stall, round -> slot mapping wraps (see consensus).
export const MAX_SLOT_GAP = MAX_BLOCK_TICKS / TICKS_PER_SLOT;
export const ROUND_LOOKAHEAD = 10; // votes/proposals more than this many rounds ahead are not stored

// ---- Proof of Stake (phase 4-5) ----
export const MIN_VALIDATOR_STAKE = 10_000n * UNIT;
export const MIN_DELEGATION = 10n * UNIT;
export const MAX_DELEGATORS_PER_VALIDATOR = 1_000; // bounds per-block reward distribution work
export const JAIL_EPOCHS = 2; // after this many epochs a jailed validator may send `unjail`
export const MAX_VALIDATORS = 16;
export const MAX_COMMISSION_BPS = 5_000;
export const UNBONDING_EPOCHS = 2;
export const SLASH_BPS = 500; // 5% of bonded stake for equivocation
export const REPORTER_REWARD_BPS = 1_000; // 10% of the slashed amount; the rest is burned
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
  const units = BigInt(whole) * UNIT + BigInt(frac.padEnd(DECIMALS, '0'));
  if (units > MAX_SUPPLY) throw new Error(`VOX amount "${str}" exceeds the max supply`);
  return units;
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
