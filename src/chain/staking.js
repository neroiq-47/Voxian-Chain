// Open Proof of Stake (phases 4-5): validator registration, delegation, unbonding, epoch transitions,
// reward distribution and equivocation slashing. All functions validate before mutating state.
import { schnorrVerify } from '../crypto/secp256k1.js';
import { taggedHash } from '../crypto/sha256.js';
import { utf8 } from '../crypto/encoding.js';
import { addressFromPub, parsePub } from './keys.js';
import {
  CHAIN_ID, MIN_VALIDATOR_STAKE, MIN_DELEGATION, MAX_VALIDATORS, MAX_COMMISSION_BPS, UNBONDING_EPOCHS, SLASH_BPS, REPORTER_REWARD_BPS, parseUnits,
  MAX_DELEGATORS_PER_VALIDATOR, JAIL_EPOCHS,
} from './params.js';

export const VOTE_KINDS = ['prevote', 'precommit'];
const HEX64 = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// What a validator signs for a consensus vote. Binding the parent block hash ties a vote to one chain
// history, so votes from another chain instance (e.g. a wiped devnet) can't be replayed as evidence.
export const voteDigest = (kind, height, round, blockHash, parent) => taggedHash('Voxian/vote', utf8(CHAIN_ID), utf8(`${kind}:${height}:${round}:${blockHash}:${parent}`));

export function checkVote(v) {
  if (!v || typeof v !== 'object') return false;
  if (!VOTE_KINDS.includes(v.kind) || !Number.isSafeInteger(v.height) || v.height < 1 || !Number.isSafeInteger(v.round) || v.round < 0) return false;
  if (typeof v.blockHash !== 'string' || !HEX64.test(v.blockHash) || typeof v.parent !== 'string' || !HEX64.test(v.parent)) return false;
  try { return schnorrVerify(v.sig, voteDigest(v.kind, v.height, v.round, v.blockHash, v.parent), parsePub(v.validator)); } catch { return false; }
}

const fail = (msg) => { throw new Error(msg); };
const bondedOf = (v) => v.selfStake + v.delegated;

// Active validator set for an epoch: not jailed, self-stake >= minimum, top MAX_VALIDATORS by bonded stake.
export function activeSet(state) {
  return [...state.validators.values()]
    .filter((v) => !v.jailed && v.selfStake >= MIN_VALIDATOR_STAKE)
    .sort((a, b) => (bondedOf(b) > bondedOf(a) ? 1 : bondedOf(b) < bondedOf(a) ? -1 : a.pub < b.pub ? -1 : 1))
    .slice(0, MAX_VALIDATORS)
    .map((v) => ({ pub: v.pub, name: v.name, address: v.owner, stake: bondedOf(v) }));
}

// Release matured unbonding entries when the chain enters `epoch`.
export function enterEpoch(state, epoch) {
  if (epoch <= state.epoch) return;
  state.epoch = epoch;
  const keep = [];
  for (const u of state.unbonding) {
    if (u.releaseEpoch <= epoch) { state.credit(u.address, u.amount); state.staked -= u.amount; }
    else keep.push(u);
  }
  state.unbonding = keep;
}

// Block reward + fees go to the leader's stake pool: commission to the operator, the rest pro rata.
export function distributeReward(state, pub, amount) {
  const v = state.validators.get(pub);
  if (amount <= 0n) return;
  if (!v) { state.credit(addressFromPub(pub), amount); return; }
  const total = bondedOf(v);
  const commission = (amount * BigInt(v.commissionBps)) / 10_000n;
  const rest = amount - commission;
  let paid = 0n;
  const dels = state.delegations.get(pub);
  if (dels && total > 0n) {
    for (const [addr, d] of dels) {
      const share = (rest * d) / total;
      if (share > 0n) { state.credit(addr, share); paid += share; }
    }
  }
  state.credit(v.owner, amount - paid); // commission + self-stake share + rounding dust
  v.rewards += amount;
}

function delegationsOf(state, pub) {
  if (!state.delegations.has(pub)) state.delegations.set(pub, new Map());
  return state.delegations.get(pub);
}

// Apply a staking tx (signature already verified by the caller). Returns nothing; throws on invalid.
export function applyStakingTx(state, tx, fee, ctx) {
  const from = addressFromPub(tx.from);
  const acct = state.account(from);
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce !== acct.nonce) fail(`bad nonce: expected ${acct.nonce}`);

  switch (tx.type) {
    case 'validator_register': {
      if (typeof tx.name !== 'string' || !NAME_RE.test(tx.name)) fail('validator name: 2-32 chars of a-z, 0-9, -');
      if ([...state.validators.values()].some((v) => v.name === tx.name)) fail('validator name taken');
      if (state.validators.has(tx.from)) fail('already a validator');
      if (!Number.isSafeInteger(tx.commissionBps) || tx.commissionBps < 0 || tx.commissionBps > MAX_COMMISSION_BPS) fail(`commission must be 0-${MAX_COMMISSION_BPS} bps`);
      const amount = parseUnits(tx.amount);
      if (amount < MIN_VALIDATOR_STAKE) fail('self-stake below validator minimum');
      if (acct.balance < amount + fee) fail('insufficient balance');
      state.accounts.set(from, { balance: acct.balance - amount - fee, nonce: acct.nonce + 1 });
      state.validators.set(tx.from, newValidator(tx.from, tx.name, tx.commissionBps, amount, state.epoch));
      state.staked += amount;
      return;
    }

    case 'stake': {
      const v = state.validators.get(tx.validator);
      if (!v) fail('unknown validator');
      if (v.jailed) fail('validator is jailed');
      const amount = parseUnits(tx.amount);
      if (amount < MIN_DELEGATION) fail('below minimum delegation');
      const existing = state.delegations.get(tx.validator);
      if (tx.validator !== tx.from && !existing?.has(from) && (existing?.size ?? 0) >= MAX_DELEGATORS_PER_VALIDATOR) fail('validator has the maximum number of delegators');
      if (acct.balance < amount + fee) fail('insufficient balance');
      state.accounts.set(from, { balance: acct.balance - amount - fee, nonce: acct.nonce + 1 });
      if (tx.validator === tx.from) v.selfStake += amount;
      else { const d = delegationsOf(state, tx.validator); d.set(from, (d.get(from) ?? 0n) + amount); v.delegated += amount; }
      state.staked += amount;
      return;
    }

    case 'unstake': {
      const v = state.validators.get(tx.validator);
      if (!v) fail('unknown validator');
      const amount = parseUnits(tx.amount);
      const self = tx.validator === tx.from;
      const have = self ? v.selfStake : (state.delegations.get(tx.validator)?.get(from) ?? 0n);
      if (amount > have) fail('unstake exceeds bonded amount');
      if (acct.balance < fee) fail('insufficient balance for fee');
      state.accounts.set(from, { balance: acct.balance - fee, nonce: acct.nonce + 1 });
      if (self) v.selfStake -= amount;
      else {
        const d = delegationsOf(state, tx.validator);
        const left = have - amount;
        if (left === 0n) d.delete(from); else d.set(from, left);
        v.delegated -= amount;
      }
      state.unbonding.push({ address: from, validator: tx.validator, amount, releaseEpoch: state.epoch + UNBONDING_EPOCHS, height: ctx.height, epoch: state.epoch });
      return; // still counted in state.staked until released
    }

    case 'unjail': {
      const v = state.validators.get(tx.from);
      if (!v) fail('not a validator');
      if (!v.jailed) fail('validator is not jailed');
      if (state.epoch < v.jailedUntilEpoch) fail(`jailed until epoch ${v.jailedUntilEpoch}`);
      if (v.selfStake < MIN_VALIDATOR_STAKE) fail('self-stake below validator minimum: stake more first');
      if (acct.balance < fee) fail('insufficient balance for fee');
      state.accounts.set(from, { balance: acct.balance - fee, nonce: acct.nonce + 1 });
      v.jailed = false;
      return;
    }

    case 'evidence': {
      const { voteA: a, voteB: b } = tx;
      if (!checkVote(a) || !checkVote(b)) fail('evidence votes must be validly signed');
      if (a.validator !== b.validator || a.kind !== b.kind || a.height !== b.height || a.round !== b.round || a.parent !== b.parent) fail('votes are not for the same slot');
      if (a.blockHash === b.blockHash) fail('votes do not conflict');
      if (a.height > ctx.height) fail('evidence for a future height');
      if (!ctx.parentHashAt || ctx.parentHashAt(a.height) !== a.parent) fail('evidence votes are not from this chain');
      const key = `${a.validator}:${a.kind}:${a.height}:${a.round}`;
      if (state.evidence.has(key)) fail('evidence already processed');
      const v = state.validators.get(a.validator);
      if (!v) fail('unknown validator');
      if (acct.balance < fee) fail('insufficient balance for fee');
      state.accounts.set(from, { balance: acct.balance - fee, nonce: acct.nonce + 1 });
      // Slash bonded stake pro rata (self + delegators).
      const cut = (x) => (x * BigInt(SLASH_BPS)) / 10_000n;
      let slashed = cut(v.selfStake);
      v.selfStake -= slashed;
      const dels = state.delegations.get(v.pub);
      if (dels) for (const [addr, d] of dels) { const c = cut(d); dels.set(addr, d - c); slashed += c; v.delegated -= c; }
      // Stake counted in the offence's voting-weight epoch is still on the hook, including stake that began unbonding
      // during that epoch (weights only drop at the next boundary, so unstaking early must not escape the slash).
      const offenceEpoch = ctx.epochAt?.(a.height) ?? state.epoch;
      for (const u of state.unbonding) if (u.validator === v.pub && u.epoch >= offenceEpoch) { const c = cut(u.amount); u.amount -= c; slashed += c; }
      state.unbonding = state.unbonding.filter((u) => u.amount > 0n);
      state.staked -= slashed;
      // The reporter earns a share, unless the offender reports itself (that share is burned too).
      const reward = from === v.owner ? 0n : (slashed * BigInt(REPORTER_REWARD_BPS)) / 10_000n;
      state.credit(from, reward);
      state.burned += slashed - reward;
      v.jailed = true;
      v.jailedUntilEpoch = state.epoch + JAIL_EPOCHS;
      v.slashed += slashed;
      state.evidence.add(key);
      state.slashes.push({ validator: v.pub, name: v.name, kind: a.kind, height: a.height, round: a.round, amount: slashed.toString(), burned: (slashed - reward).toString(), reporter: from, atHeight: ctx.height });
      return;
    }
  }
}

export function newValidator(pub, name, commissionBps, selfStake, epoch) {
  return { pub, name, owner: addressFromPub(pub), commissionBps, selfStake, delegated: 0n, jailed: false, jailedUntilEpoch: 0, slashed: 0n, rewards: 0n, joinedEpoch: epoch, produced: 0, missed: 0 };
}

export const STAKING_TYPES = new Set(['validator_register', 'stake', 'unstake', 'evidence', 'unjail']);
