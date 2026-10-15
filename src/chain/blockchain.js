// Blocks, mempool, stake-weighted proposer selection, block building/validation and BFT commit certificates.
// A block is final once validators holding > 2/3 of stake have signed it (see consensus.js).
import { canonicalJSON, hexToBytes, bytesToBig, utf8 } from '../crypto/encoding.js';
import { sha256, sha256Hex, taggedHash } from '../crypto/sha256.js';
import { schnorrSign, schnorrVerify } from '../crypto/secp256k1.js';
import { State, applyTx, txAddresses } from './state.js';
import { addressFromPub, parsePub, accountKeyFromSeed, devnetSeed, DEFAULT_DEVNET_SECRET } from './keys.js';
import { txHash, merkleRoot } from './tx.js';
import {
  CHAIN_ID, UNIT, MAX_SUPPLY, GENESIS_TIMESTAMP, MAX_BLOCK_TXS, MAX_MEMPOOL, MAX_PENDING_PER_SENDER, ROUND_TIMEOUT_MS, MAX_CLOCK_DRIFT_MS, blockReward,
} from './params.js';

export const VALIDATOR_NAMES = ['vox-validator-aurora', 'vox-validator-borealis', 'vox-validator-cygnus', 'vox-validator-draco'];
const VALIDATOR_STAKES = [300_000n, 250_000n, 250_000n, 200_000n]; // any 3 of 4 exceed 2/3: tolerates 1 faulty validator

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

// Genesis: 5% of max supply to the devnet faucet, validator stake, and gas money for the facilitator.
export function makeGenesis(keys) {
  const allocations = [
    { address: keys.faucet.address, label: 'Devnet faucet', amount: (10_500_000n * UNIT).toString() },
    { address: keys.facilitator.address, label: 'x402 facilitator (gas)', amount: (10_000n * UNIT).toString() },
  ];
  const validators = keys.validators.map((v, i) => ({ name: v.name, pub: v.pubHex, address: v.address, stake: (VALIDATOR_STAKES[i] * UNIT).toString() }));
  const header = { chainId: CHAIN_ID, height: 0, round: 0, prevHash: '0'.repeat(64), timestamp: GENESIS_TIMESTAMP, proposer: '', txRoot: merkleRoot([]), reward: '0', fees: '0' };
  return { ...header, hash: sha256Hex(canonicalJSON({ header, allocations, validators })), signature: '', txs: [], allocations, validators };
}

export function genesisState(genesis) {
  const s = new State();
  for (const a of genesis.allocations) { s.credit(a.address, BigInt(a.amount)); s.issued += BigInt(a.amount); }
  for (const v of genesis.validators) { s.staked += BigInt(v.stake); s.issued += BigInt(v.stake); }
  if (s.issued > MAX_SUPPLY) throw new Error('genesis exceeds max supply');
  return s;
}

const headerOf = (b) => ({ chainId: CHAIN_ID, height: b.height, round: b.round, prevHash: b.prevHash, timestamp: b.timestamp, proposer: b.proposer, txRoot: b.txRoot, reward: b.reward, fees: b.fees });
export const blockHash = (b) => sha256Hex(canonicalJSON(headerOf(b)));
// Validators sign (height, blockHash). The commit certificate is not part of the block hash.
export const voteDigest = (height, hash) => taggedHash('Voxian/vote', utf8(CHAIN_ID), utf8(`${height}:${hash}`));

// Bounded insertion-ordered set (oldest entries evicted first).
class BoundedSet {
  constructor(max) { this.max = max; this.set = new Set(); }
  has(k) { return this.set.has(k); }
  add(k) { this.set.delete(k); this.set.add(k); if (this.set.size > this.max) this.set.delete(this.set.values().next().value); }
  delete(k) { this.set.delete(k); }
}

export class MemoryStorage {
  constructor() { this.blocks = []; }
  async load() { return this.blocks; }
  async append(block) { this.blocks.push(block); }
  async replaceAll(blocks) { this.blocks = [...blocks]; }
  async clear() { this.blocks = []; }
}

// Who "sends" a tx, for per-sender mempool limits (shielded txs have no public sender).
function senderOf(tx) {
  if (tx.type === 'transfer' || tx.type === 'shield') return tx.from;
  if (tx.type === 'auth_transfer') return tx.relayer;
  return 'shielded';
}

export class Blockchain {
  constructor({ keys = devnetKeys(), storage = new MemoryStorage(), now = () => Date.now() } = {}) {
    this.keys = keys;
    this.genesis = makeGenesis(keys);
    this.storage = storage;
    this.now = now;
    this.validators = this.genesis.validators;
    this.totalStake = this.validators.reduce((n, v) => n + BigInt(v.stake), 0n);
    this.stakeOf = new Map(this.validators.map((v) => [v.pub, BigInt(v.stake)]));
    this.blockListeners = new Set();
    this.txListeners = new Set();
    this.reset();
  }

  reset() {
    this.blocks = [this.genesis];
    this.state = genesisState(this.genesis);
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
  onBlock(fn) { this.blockListeners.add(fn); return () => this.blockListeners.delete(fn); }
  onTx(fn) { this.txListeners.add(fn); return () => this.txListeners.delete(fn); }

  // Stake-weighted, deterministic proposer for (height, round). A new round starts every ROUND_TIMEOUT_MS,
  // so a crashed proposer only delays the chain by one round.
  proposerFor(prevHash, height, round = 0) {
    let r = bytesToBig(sha256(utf8(`${prevHash}:${height}:${round}`))) % this.totalStake;
    for (const v of this.validators) { if (r < BigInt(v.stake)) return v; r -= BigInt(v.stake); }
    return this.validators[0];
  }

  hasQuorum(power) { return power * 3n > this.totalStake * 2n; }

  // Sum of stake behind valid, distinct validator votes for this block.
  commitPower(block, { checkSigs = true } = {}) {
    const votes = block.commit?.votes;
    if (!Array.isArray(votes)) return 0n;
    const digest = voteDigest(block.height, block.hash);
    const seen = new Set();
    let power = 0n;
    for (const v of votes) {
      const stake = v && this.stakeOf.get(v.validator);
      if (!stake || seen.has(v.validator)) continue;
      if (checkSigs && !schnorrVerify(v.sig, digest, parsePub(v.validator))) continue;
      seen.add(v.validator);
      power += stake;
    }
    return power;
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
      applyTx(this.pending, tx, { height: this.height + 1, timestamp: this.now(), skipCrypto: this.verified.has(hash), admission: true });
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
    const keep = [];
    for (const m of this.mempool) {
      try { applyTx(this.pending, m.tx, { height: this.height + 1, timestamp: this.now(), skipCrypto: true }); keep.push(m); }
      catch { this.verified.delete(m.hash); }
    }
    this.mempool = keep;
  }

  // ---- blocks ----
  // Execute txs on a copy of state. dropInvalid=true when building (skip bad txs), false when validating.
  execute(header, txs, { dropInvalid, trusted }) {
    const s = this.state.clone();
    const included = [];
    let fees = 0n;
    for (const tx of txs) {
      const hash = txHash(tx);
      try {
        const r = applyTx(s, tx, { height: header.height, timestamp: header.timestamp, skipCrypto: trusted || this.verified.has(hash) });
        fees += r.fee;
        included.push({ hash, tx });
      } catch (e) {
        if (!dropInvalid) throw new Error(`invalid tx in block ${header.height}: ${e.message}`);
        this.verified.delete(hash);
      }
    }
    const reward = blockReward(header.height, s.issued);
    s.issued += reward;
    s.credit(addressFromPub(header.proposer), reward + fees);
    s.height = header.height;
    return { state: s, included, fees, reward };
  }

  // Build and sign (but do not commit) the next block as `proposer` in `round`.
  buildBlock(round, proposer /* { pubHex, secret } */) {
    const prev = this.tip;
    const height = prev.height + 1;
    const header = { height, round, prevHash: prev.hash, timestamp: Math.max(this.now(), prev.timestamp + 1 + round * ROUND_TIMEOUT_MS), proposer: proposer.pubHex };
    const window = this.mempool.slice(0, MAX_BLOCK_TXS);
    const { included, fees, reward } = this.execute(header, window.map((m) => m.tx), { dropInvalid: true, trusted: false });
    // Txs that no longer apply can't wedge the mempool.
    const keep = new Set(included.map((i) => i.hash));
    const failed = new Set(window.filter((m) => !keep.has(m.hash)).map((m) => m.hash));
    if (failed.size) this.mempool = this.mempool.filter((m) => !failed.has(m.hash));
    const block = { ...header, txRoot: merkleRoot(included.map((i) => i.hash)), reward: reward.toString(), fees: fees.toString(), txs: included.map((i) => i.tx) };
    block.hash = blockHash(block);
    block.signature = schnorrSign(hexToBytes(block.hash), proposer.secret);
    return block;
  }

  // Full validity check of a proposed block against the current tip (everything except the commit certificate).
  validateBlock(block, { trusted = false } = {}) {
    const prev = this.tip;
    if (!block || typeof block !== 'object') throw new Error('bad block');
    if (block.height !== prev.height + 1) throw new Error('wrong height');
    if (block.prevHash !== prev.hash) throw new Error('wrong parent');
    if (!Number.isSafeInteger(block.round) || block.round < 0) throw new Error('bad round');
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp <= prev.timestamp) throw new Error('bad timestamp');
    if (block.timestamp < prev.timestamp + block.round * ROUND_TIMEOUT_MS) throw new Error('round started too early');
    if (!trusted && block.timestamp > this.now() + MAX_CLOCK_DRIFT_MS) throw new Error('block from the future');
    if (block.proposer !== this.proposerFor(prev.hash, block.height, block.round).pub) throw new Error('wrong proposer');
    if (!Array.isArray(block.txs) || block.txs.length > MAX_BLOCK_TXS) throw new Error('bad txs');
    const hashes = block.txs.map(txHash);
    if (new Set(hashes).size !== hashes.length) throw new Error('duplicate tx in block');
    if (block.txRoot !== merkleRoot(hashes)) throw new Error('bad tx root');
    if (block.hash !== blockHash(block)) throw new Error('bad block hash');
    if (!trusted && !schnorrVerify(block.signature, hexToBytes(block.hash), parsePub(block.proposer))) throw new Error('bad block signature');
    const result = this.execute(block, block.txs, { dropInvalid: false, trusted });
    if (result.fees.toString() !== block.fees || result.reward.toString() !== block.reward) throw new Error('bad reward/fees');
    if (!trusted) for (const h of hashes) this.verified.add(h);
    return { ...result, hashes };
  }

  // Commit a block. Untrusted blocks must carry a commit certificate signed by > 2/3 of stake.
  applyBlock(block, { trusted = false, persist = true } = {}) {
    const { state, hashes } = this.validateBlock(block, { trusted });
    if (!trusted && !this.hasQuorum(this.commitPower(block))) throw new Error('missing 2/3 commit certificate');

    this.state = state;
    this.blocks.push(block);
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

  // Standalone helper (all validator keys local): build, sign votes with every local key, commit.
  produceBlock(localValidators = this.keys.validators) {
    const prev = this.tip;
    const proposer = this.proposerFor(prev.hash, prev.height + 1, 0);
    const local = localValidators.find((v) => v.pubHex === proposer.pub);
    if (!local) return null;
    const block = this.buildBlock(0, local);
    const digest = voteDigest(block.height, block.hash);
    block.commit = { votes: localValidators.map((v) => ({ validator: v.pubHex, sig: schnorrSign(digest, v.secret) })) };
    return this.applyBlock(block);
  }

  // ---- queries ----
  getTx(hash) {
    const loc = this.txIndex.get(hash);
    if (loc) {
      const block = this.blocks[loc.height];
      return { status: 'confirmed', height: loc.height, blockHash: block.hash, timestamp: block.timestamp, tx: block.txs[loc.index] };
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
      // Invariant: every unit ever minted is in an account, in stake, or in the shielded pool.
      conserved: s.circulating() + s.staked + s.pool === s.issued,
      nextReward: blockReward(this.height + 1, s.issued).toString(),
    };
  }
}
