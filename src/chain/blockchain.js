// Blocks, mempool, Proof-of-History slots/epochs, stake-weighted leader schedule, block building/validation
// and BFT commit certificates (> 2/3 of the epoch's bonded stake precommitting the block).
import { canonicalJSON, hexToBytes, bytesToBig, utf8 } from '../crypto/encoding.js';
import { sha256, sha256Hex } from '../crypto/sha256.js';
import { schnorrSign, schnorrVerify } from '../crypto/secp256k1.js';
import { State, applyTx, txAddresses } from './state.js';
import { addressFromPub, parsePub, accountKeyFromSeed, devnetSeed, DEFAULT_DEVNET_SECRET } from './keys.js';
import { txHash, merkleRoot } from './tx.js';
import { PohRecorder, verifyPoh, pohSeed } from './poh.js';
import { activeSet, enterEpoch, distributeReward, newValidator, voteDigest } from './staking.js';

export { voteDigest };
import {
  CHAIN_ID, UNIT, MAX_SUPPLY, GENESIS_TIMESTAMP, MAX_BLOCK_TXS, MAX_MEMPOOL, MAX_PENDING_PER_SENDER, MAX_CLOCK_DRIFT_MS, blockReward,
  TICK_MS, TICKS_PER_SLOT, SLOTS_PER_EPOCH, LEADER_SLOTS, MAX_BLOCK_TICKS, MAX_SLOT_GAP, HEARTBEAT_SLOTS,
} from './params.js';

export const VALIDATOR_NAMES = ['vox-validator-aurora', 'vox-validator-borealis', 'vox-validator-cygnus', 'vox-validator-draco'];
const VALIDATOR_STAKES = [300_000n, 250_000n, 250_000n, 200_000n]; // any 3 of 4 exceed 2/3: tolerates 1 faulty validator
const GENESIS_COMMISSION_BPS = 1_000;

export const epochOf = (slot) => Math.floor(slot / SLOTS_PER_EPOCH);

// Devnet roles derived from the network secret.
export function devnetKeys(secret = DEFAULT_DEVNET_SECRET) {
  const k = (role) => accountKeyFromSeed(devnetSeed(secret, role));
  return {
    validators: VALIDATOR_NAMES.map((name) => ({ name, ...k(name) })),
    faucet: k('faucet'),
    facilitator: k('x402-facilitator'),
    service: k('x402-services'),
    serviceSeed: devnetSeed(secret, 'x402-services-shielded'),
  };
}

// Genesis: 5% of max supply to the devnet faucet, validator self-stake, gas money for the facilitator.
export function makeGenesis(keys) {
  const allocations = [
    { address: keys.faucet.address, label: 'Devnet faucet', amount: (10_500_000n * UNIT).toString() },
    { address: keys.facilitator.address, label: 'x402 facilitator (gas)', amount: (10_000n * UNIT).toString() },
  ];
  const validators = keys.validators.map((v, i) => ({ name: v.name, pub: v.pubHex, address: v.address, stake: (VALIDATOR_STAKES[i] * UNIT).toString() }));
  const pohEnd = pohSeed(sha256Hex(canonicalJSON({ allocations, validators })));
  const header = { chainId: CHAIN_ID, height: 0, slot: 0, prevHash: '0'.repeat(64), timestamp: GENESIS_TIMESTAMP, proposer: '', txRoot: merkleRoot([]), reward: '0', fees: '0', pohTicks: 0, pohEnd };
  return { ...header, hash: sha256Hex(canonicalJSON({ header, allocations, validators })), signature: '', poh: { entries: [] }, txs: [], allocations, validators };
}

export function genesisState(genesis) {
  const s = new State();
  for (const a of genesis.allocations) { s.credit(a.address, BigInt(a.amount)); s.issued += BigInt(a.amount); }
  for (const v of genesis.validators) {
    s.validators.set(v.pub, newValidator(v.pub, v.name.replace('vox-validator-', ''), GENESIS_COMMISSION_BPS, BigInt(v.stake), 0));
    s.staked += BigInt(v.stake);
    s.issued += BigInt(v.stake);
  }
  if (s.issued > MAX_SUPPLY) throw new Error('genesis exceeds max supply');
  return s;
}

const headerOf = (b) => ({
  chainId: CHAIN_ID, height: b.height, slot: b.slot, prevHash: b.prevHash, timestamp: b.timestamp, proposer: b.proposer,
  txRoot: b.txRoot, reward: b.reward, fees: b.fees, pohTicks: b.pohTicks, pohEnd: b.pohEnd,
});
export const blockHash = (b) => sha256Hex(canonicalJSON(headerOf(b)));

// Bounded insertion-ordered set (oldest entries evicted first).
class BoundedSet {
  constructor(max) { this.max = max; this.set = new Set(); }
  has(k) { return this.set.has(k); }
  add(k) { this.set.delete(k); this.set.add(k); if (this.set.size > this.max) this.set.delete(this.set.values().next().value); }
  delete(k) { this.set.delete(k); }
}

export class MemoryStorage {
  constructor() { this.blocks = []; this.meta = {}; }
  async load() { return this.blocks; }
  async append(block) { this.blocks.push(block); }
  async replaceAll(blocks) { this.blocks = [...blocks]; }
  async clear() { this.blocks = []; this.meta = {}; }
  loadMeta(key) { return this.meta[key] ?? null; }
  saveMeta(key, value) { this.meta[key] = structuredClone(value); }
}

// Who "sends" a tx, for per-sender mempool limits (shielded txs have no public sender).
function senderOf(tx) {
  if (tx.type === 'auth_transfer') return tx.relayer;
  if (tx.type === 'shielded') return 'shielded';
  return tx.from;
}

export class Blockchain {
  constructor({ keys = devnetKeys(), storage = new MemoryStorage(), now = () => Date.now() } = {}) {
    this.keys = keys;
    this.genesis = makeGenesis(keys);
    this.storage = storage;
    this.now = now;
    this.blockListeners = new Set();
    this.txListeners = new Set();
    this.parentHashAt = (h) => this.blocks[h - 1]?.hash; // for evidence: votes at height h name block h-1
    this.epochAt = (h) => (this.blocks[h] ? epochOf(this.blocks[h].slot) : null); // for evidence: the epoch whose weights covered height h
    this.reset();
  }

  reset() {
    this.blocks = [this.genesis];
    this.state = genesisState(this.genesis);
    this.snapshots = new Map(); // epoch -> validator-set snapshot fixed at the epoch boundary
    this.snapshots.set(0, this.makeSnapshot(0));
    this.futureSnapshots = new Map(); // memo for epochs after the tip's (valid until the tip changes)
    this.txIndex = new Map(); // hash -> { height, index }
    this.addrIndex = new Map(); // address -> [hash] (newest last, capped)
    this.verified = new BoundedSet(5_000); // tx hashes whose signatures/proofs already passed
    this.rejected = new BoundedSet(5_000); // tx hashes that failed crypto checks (cheap re-rejection)
    this.mempool = [];
    this.pending = this.state.clone();
  }

  async init() {
    const stored = await this.storage.load();
    let ok = 0;
    for (const b of stored) {
      try { this.applyBlock(b, { trusted: true, persist: false }); ok++; }
      catch (e) { console.warn(`[voxian] stopped replay at height ${b.height}: ${e.message}`); break; }
    }
    // Drop anything after the first unreplayable block so new blocks never get appended behind it.
    if (ok < stored.length && this.storage.replaceAll) await this.storage.replaceAll(this.blocks.slice(1));
    return this;
  }

  get tip() { return this.blocks[this.blocks.length - 1]; }
  get height() { return this.tip.height; }
  get slot() { return this.tip.slot; }
  onBlock(fn) { this.blockListeners.add(fn); return () => this.blockListeners.delete(fn); }
  onTx(fn) { this.txListeners.add(fn); return () => this.txListeners.delete(fn); }

  // ---- epochs & leader schedule (phase 2) ----
  // The schedule seed chains epoch to epoch and only mixes in the anchor's height and slot, which the
  // anchor's proposer can't grind (unlike its hash: timestamp, tx choice, PoH ticks). Its only influence is
  // whether/in which of its slots to produce. If every validator were jailed, the previous set carries on.
  makeSnapshot(epoch) {
    const tip = this.blocks.at(-1);
    const prev = epoch === 0 ? null : this.snapshots.get(epochOf(tip.slot));
    let validators = activeSet(this.state);
    if (validators.length === 0 && prev) validators = prev.validators;
    const seed = prev ? sha256Hex(`Voxian/schedule:${prev.seed}:${tip.height}:${tip.slot}:${epoch}`) : this.genesis.hash;
    return { epoch, anchor: tip.hash, seed, validators, total: validators.reduce((n, v) => n + v.stake, 0n), power: new Map(validators.map((v) => [v.pub, v.stake])) };
  }

  // The validator set for `epoch` is fixed by the last block before the epoch starts.
  // For epochs after the tip's, that block is (or will be) the current tip, so the snapshot is derived from it.
  snapshotFor(epoch) {
    const known = this.snapshots.get(epoch);
    if (known) return known;
    const tipEpoch = epochOf(this.tip.slot);
    if (epoch <= tipEpoch) throw new Error(`no validator snapshot for past epoch ${epoch}`);
    let s = this.futureSnapshots.get(epoch);
    if (!s) { s = this.makeSnapshot(epoch); this.futureSnapshots.set(epoch, s); }
    return s;
  }

  leaderFor(slot) {
    const snap = this.snapshotFor(epochOf(slot));
    if (snap.total === 0n) throw new Error('no active validators');
    let r = bytesToBig(sha256(utf8(`${snap.seed}:${Math.floor(slot / LEADER_SLOTS)}`))) % snap.total;
    for (const v of snap.validators) { if (r < v.stake) return v; r -= v.stake; }
    return snap.validators[0];
  }

  hasQuorum(power, total) { return total > 0n && power * 3n > total * 2n; }

  // Voting weights for height h come from ONE snapshot: the epoch of the first slot after block h-1.
  // (Weighting candidate blocks by their own slots' epochs would let two blocks at one height each reach
  // 2/3 of a different validator set: a fork.)
  weightSnapshot(height) {
    const parent = this.blocks[height - 1];
    if (!parent) throw new Error('unknown parent height');
    return this.snapshotFor(epochOf(parent.slot + 1));
  }

  // Stake behind valid, distinct precommits for this block.
  commitPower(block, { checkSigs = true } = {}) {
    const cert = block.commit;
    const snap = this.weightSnapshot(block.height);
    if (!cert || !Number.isSafeInteger(cert.round) || cert.round < 0 || !Array.isArray(cert.votes)) return { power: 0n, total: snap.total };
    const digest = voteDigest('precommit', block.height, cert.round, block.hash, block.prevHash);
    const seen = new Set();
    let power = 0n;
    for (const v of cert.votes) {
      const stake = v && snap.power.get(v.validator);
      if (!stake || seen.has(v.validator)) continue;
      if (checkSigs && !schnorrVerify(v.sig, digest, parsePub(v.validator))) continue;
      seen.add(v.validator);
      power += stake;
    }
    return { power, total: snap.total };
  }

  // ---- mempool ----
  submitTx(tx, { origin = 'local' } = {}) {
    const hash = txHash(tx);
    if (this.txIndex.has(hash) || this.mempool.some((m) => m.hash === hash)) throw new Error('duplicate transaction');
    if (this.rejected.has(hash)) throw new Error('transaction previously rejected');
    if (this.mempool.length >= MAX_MEMPOOL) throw new Error('mempool full');
    const sender = senderOf(tx);
    if (this.mempool.filter((m) => m.sender === sender).length >= MAX_PENDING_PER_SENDER) throw new Error('too many pending transactions from this sender');
    try {
      applyTx(this.pending, tx, { height: this.height + 1, timestamp: this.now(), skipCrypto: this.verified.has(hash), admission: true, parentHashAt: this.parentHashAt, epochAt: this.epochAt });
    } catch (e) {
      if (e.crypto) this.rejected.add(hash);
      throw e;
    }
    this.verified.add(hash);
    this.mempool.push({ hash, tx, sender, receivedAt: this.now() });
    for (const fn of this.txListeners) { try { fn(tx, { hash, origin }); } catch { /* gossip errors never fail a submit */ } }
    return hash;
  }

  rebuildPending() {
    this.pending = this.state.clone();
    enterEpoch(this.pending, epochOf(this.tip.slot + 1)); // stake released at the boundary is spendable now
    const keep = [];
    for (const m of this.mempool) {
      try { applyTx(this.pending, m.tx, { height: this.height + 1, timestamp: this.now(), skipCrypto: true, parentHashAt: this.parentHashAt, epochAt: this.epochAt }); keep.push(m); }
      catch { this.verified.delete(m.hash); }
    }
    this.mempool = keep;
  }

  // ---- blocks ----
  // Execute a block's txs on a copy of state: epoch transition, txs, then reward to the leader's stake pool.
  execute(header, txs, { dropInvalid, trusted }) {
    const s = this.state.clone();
    enterEpoch(s, epochOf(header.slot));
    const included = [];
    let fees = 0n;
    for (const tx of txs) {
      const hash = txHash(tx);
      try {
        const r = applyTx(s, tx, { height: header.height, timestamp: header.timestamp, skipCrypto: trusted || this.verified.has(hash), parentHashAt: this.parentHashAt, epochAt: this.epochAt });
        fees += r.fee;
        included.push({ hash, tx });
      } catch (e) {
        if (!dropInvalid) throw new Error(`invalid tx in block ${header.height}: ${e.message}`);
        this.verified.delete(hash);
      }
    }
    const reward = blockReward(header.height, s.issued);
    s.issued += reward;
    distributeReward(s, header.proposer, reward + fees);
    // Uptime: the leader produced; leaders of skipped slots that were due a heartbeat missed theirs.
    const prevSlot = this.tip.slot;
    const prod = s.validators.get(header.proposer);
    if (prod) prod.produced++;
    for (let sl = prevSlot + HEARTBEAT_SLOTS; sl < header.slot && sl - prevSlot <= SLOTS_PER_EPOCH; sl++) {
      const v = s.validators.get(this.leaderFor(sl).pub);
      if (v) v.missed++;
    }
    s.height = header.height;
    return { state: s, included, fees, reward };
  }

  // Build and sign (but do not commit) the next block as the leader of `slot`, using the local PoH recorder.
  buildBlock(slot, proposer /* { pubHex, secret } */, recorder) {
    const prev = this.tip;
    const height = prev.height + 1;
    const header = { height, slot, prevHash: prev.hash, timestamp: Math.max(this.now(), prev.timestamp + 1), proposer: proposer.pubHex };
    const window = this.mempool.slice(0, MAX_BLOCK_TXS);
    const { included, fees, reward } = this.execute(header, window.map((m) => m.tx), { dropInvalid: true, trusted: false });
    const keep = new Set(included.map((i) => i.hash));
    const failed = new Set(window.filter((m) => !keep.has(m.hash)).map((m) => m.hash));
    if (failed.size) this.mempool = this.mempool.filter((m) => !failed.has(m.hash));
    const hashes = included.map((i) => i.hash);
    const poh = recorder.segment(hashes); // ticks since the parent, then the txs mixed in order
    const block = {
      ...header, txRoot: merkleRoot(hashes), reward: reward.toString(), fees: fees.toString(),
      pohTicks: poh.ticks, pohEnd: poh.end, poh: { entries: poh.entries }, txs: included.map((i) => i.tx),
    };
    block.hash = blockHash(block);
    block.signature = schnorrSign(hexToBytes(block.hash), proposer.secret);
    return block;
  }

  // Full validity check against the current tip (everything except the commit certificate).
  validateBlock(block, { trusted = false } = {}) {
    const prev = this.tip;
    if (!block || typeof block !== 'object') throw new Error('bad block');
    if (block.height !== prev.height + 1) throw new Error('wrong height');
    if (block.prevHash !== prev.hash) throw new Error('wrong parent');
    if (!Number.isSafeInteger(block.slot) || block.slot <= prev.slot) throw new Error('slot must increase');
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp <= prev.timestamp) throw new Error('bad timestamp');
    if (!trusted && block.timestamp > this.now() + MAX_CLOCK_DRIFT_MS) throw new Error('block from the future');
    if (block.proposer !== this.leaderFor(block.slot).pub) throw new Error('wrong leader for slot');
    if (!Array.isArray(block.txs) || block.txs.length > MAX_BLOCK_TXS) throw new Error('bad txs');
    const hashes = block.txs.map(txHash);
    if (new Set(hashes).size !== hashes.length) throw new Error('duplicate tx in block');
    if (block.txRoot !== merkleRoot(hashes)) throw new Error('bad tx root');
    if (block.hash !== blockHash(block)) throw new Error('bad block hash');

    // Proof of History: the segment must continue from the parent, prove the skipped slots elapsed,
    // and contain exactly this block's txs, in order.
    const gap = block.slot - prev.slot;
    if (gap > MAX_SLOT_GAP) throw new Error(`slot skips more than ${MAX_SLOT_GAP} slots`);
    const minTicks = (gap - 1) * TICKS_PER_SLOT;
    if (!Number.isSafeInteger(block.pohTicks) || block.pohTicks < minTicks || block.pohTicks > MAX_BLOCK_TICKS) throw new Error(`PoH must prove ${minTicks}-${MAX_BLOCK_TICKS} ticks for this slot`);
    // Hashing is fast, so PoH alone does not prove time passed: the skipped slots must also span real time (minus drift).
    if (!trusted && block.timestamp - prev.timestamp < (gap - 1) * TICKS_PER_SLOT * TICK_MS - MAX_CLOCK_DRIFT_MS) throw new Error('block is too close to its parent for the slots it skips');
    if (!trusted) {
      if (!schnorrVerify(block.signature, hexToBytes(block.hash), parsePub(block.proposer))) throw new Error('bad block signature');
      const poh = verifyPoh(prev.pohEnd, block.poh?.entries, { maxTicks: MAX_BLOCK_TICKS, maxEntries: MAX_BLOCK_TXS + 64 });
      if (poh.end !== block.pohEnd || poh.ticks !== block.pohTicks) throw new Error('PoH does not match header');
      if (poh.mixins.length !== hashes.length || poh.mixins.some((m, i) => m !== hashes[i])) throw new Error('PoH tx order does not match block');
    }

    const result = this.execute(block, block.txs, { dropInvalid: false, trusted });
    if (result.fees.toString() !== block.fees || result.reward.toString() !== block.reward) throw new Error('bad reward/fees');
    if (!trusted) for (const h of hashes) this.verified.add(h);
    return { ...result, hashes };
  }

  // Commit a block. Untrusted blocks must carry a precommit certificate from > 2/3 of the epoch's stake.
  applyBlock(block, { trusted = false, persist = true } = {}) {
    if (!trusted) {
      // Cheap checks and the certificate first: never spend PoH/proof verification on an uncertified block.
      if (!block || block.height !== this.height + 1 || block.prevHash !== this.tip.hash) throw new Error('block does not extend the tip');
      if (block.hash !== blockHash(block)) throw new Error('bad block hash');
      const { power, total } = this.commitPower(block);
      if (!this.hasQuorum(power, total)) throw new Error('missing 2/3 commit certificate');
    }
    const { state, hashes } = this.validateBlock(block, { trusted });
    const epoch = epochOf(block.slot);
    if (!this.snapshots.has(epoch)) this.snapshots.set(epoch, this.snapshotFor(epoch)); // freeze at the boundary
    for (const e of this.snapshots.keys()) if (e < epoch - 2) this.snapshots.delete(e);

    this.state = state;
    this.blocks.push(block);
    this.futureSnapshots.clear();
    hashes.forEach((h, i) => {
      this.txIndex.set(h, { height: block.height, index: i });
      this.verified.delete(h);
      for (const a of txAddresses(block.txs[i])) {
        const list = this.addrIndex.get(a) ?? [];
        list.push(h);
        if (list.length > 200) list.shift();
        this.addrIndex.set(a, list);
      }
    });
    const inBlock = new Set(hashes);
    this.mempool = this.mempool.filter((m) => !inBlock.has(m.hash));
    this.rebuildPending();
    if (persist) Promise.resolve(this.storage.append(block)).catch((e) => console.warn('[voxian] persist failed:', e.message));
    for (const fn of this.blockListeners) { try { fn(block); } catch { /* listener errors are not consensus errors */ } }
    return block;
  }

  // Standalone/test helper: the first upcoming slot (>= minSlot) led by a local key gets a block,
  // precommitted by all local keys.
  produceBlock(localValidators = this.keys.validators, { minSlot = 0 } = {}) {
    const prev = this.tip;
    const start = Math.max(1, minSlot - prev.slot);
    for (let gap = start; gap < start + 64; gap++) {
      const leader = this.leaderFor(prev.slot + gap);
      const local = localValidators.find((v) => v.pubHex === leader.pub);
      if (!local) continue;
      if (gap > MAX_SLOT_GAP) return null;
      const rec = new PohRecorder(prev.pohEnd);
      if (gap > 1) rec.tick((gap - 1) * TICKS_PER_SLOT);
      const block = this.buildBlock(prev.slot + gap, local, rec);
      const digest = voteDigest('precommit', block.height, 0, block.hash, block.prevHash);
      block.commit = { round: 0, votes: localValidators.map((v) => ({ validator: v.pubHex, sig: schnorrSign(digest, v.secret) })) };
      // Self-produced test driver: the blocks are signed by this process, and its fast-forwarded slots are not wall time.
      return this.applyBlock(block, { trusted: true });
    }
    return null;
  }

  // ---- queries ----
  getTx(hash) {
    const loc = this.txIndex.get(hash);
    if (loc) {
      const block = this.blocks[loc.height];
      return { status: 'confirmed', height: loc.height, slot: block.slot, pohIndex: loc.index, blockHash: block.hash, timestamp: block.timestamp, tx: block.txs[loc.index] };
    }
    const m = this.mempool.find((x) => x.hash === hash);
    return m ? { status: 'pending', tx: m.tx, receivedAt: m.receivedAt } : null;
  }

  supply() {
    const s = this.state;
    return {
      maxSupply: MAX_SUPPLY.toString(),
      issued: s.issued.toString(),
      circulating: s.circulating().toString(),
      staked: s.staked.toString(),
      shieldedPool: s.pool.toString(),
      burned: s.burned.toString(),
      // Invariant: every unit ever minted is in an account, staked/unbonding, in the shielded pool, or burned.
      conserved: s.circulating() + s.staked + s.pool + s.burned === s.issued,
      nextReward: blockReward(this.height + 1, s.issued).toString(),
    };
  }
}
