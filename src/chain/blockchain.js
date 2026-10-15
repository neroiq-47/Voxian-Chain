// Blocks, mempool, stake-weighted proposer selection and block production/validation.
import { canonicalJSON, hexToBytes, bytesToBig, utf8 } from '../crypto/encoding.js';
import { sha256, sha256Hex } from '../crypto/sha256.js';
import { schnorrSign, schnorrVerify, mulH } from '../crypto/secp256k1.js';
import { State, applyTx, txAddresses } from './state.js';
import { addressFromPub, parsePub, accountKeyFromSeed, devnetSeed, DEFAULT_DEVNET_SECRET } from './keys.js';
import { txHash, merkleRoot } from './tx.js';
import {
  CHAIN_ID, UNIT, MAX_SUPPLY, GENESIS_TIMESTAMP, MAX_BLOCK_TXS, MAX_MEMPOOL, BLOCK_INTERVAL_MS, EMPTY_BLOCK_MS, blockReward,
} from './params.js';

export const VALIDATOR_NAMES = ['vox-validator-aurora', 'vox-validator-borealis', 'vox-validator-cygnus'];

// Devnet roles derived from the node secret.
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
  const stakes = [400_000n, 350_000n, 250_000n];
  const validators = keys.validators.map((v, i) => ({ name: v.name, pub: v.pubHex, address: v.address, stake: (stakes[i] * UNIT).toString() }));
  const header = { chainId: CHAIN_ID, height: 0, prevHash: '0'.repeat(64), timestamp: GENESIS_TIMESTAMP, proposer: '', txRoot: merkleRoot([]), reward: '0', fees: '0' };
  return { ...header, hash: sha256Hex(canonicalJSON({ header, allocations, validators })), signature: '', txs: [], allocations, validators };
}

export function genesisState(genesis) {
  const s = new State();
  for (const a of genesis.allocations) { s.credit(a.address, BigInt(a.amount)); s.issued += BigInt(a.amount); }
  for (const v of genesis.validators) { s.staked += BigInt(v.stake); s.issued += BigInt(v.stake); }
  if (s.issued > MAX_SUPPLY) throw new Error('genesis exceeds max supply');
  return s;
}

const headerOf = (b) => ({ chainId: CHAIN_ID, height: b.height, prevHash: b.prevHash, timestamp: b.timestamp, proposer: b.proposer, txRoot: b.txRoot, reward: b.reward, fees: b.fees });
export const blockHash = (b) => sha256Hex(canonicalJSON(headerOf(b)));

export class MemoryStorage {
  constructor() { this.blocks = []; }
  async load() { return this.blocks; }
  async append(block) { this.blocks.push(block); }
  async clear() { this.blocks = []; }
}

export class Blockchain {
  constructor({ keys = devnetKeys(), storage = new MemoryStorage(), now = () => Date.now() } = {}) {
    this.keys = keys;
    this.genesis = makeGenesis(keys);
    this.storage = storage;
    this.now = now;
    this.validatorSecrets = new Map(keys.validators.map((v) => [v.pubHex, v.secret]));
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.blocks = [this.genesis];
    this.state = genesisState(this.genesis);
    this.txIndex = new Map(); // hash -> { height, index }
    this.addrIndex = new Map(); // address -> [hash] (newest last, capped)
    this.verified = new Set(); // tx hashes whose signatures/proofs were already checked
    this.mempool = [];
    this.pending = this.state.clone();
    this.lastBlockAt = 0;
  }

  async init() {
    const stored = await this.storage.load();
    for (const b of stored) {
      try { this.applyBlock(b, { trusted: true, persist: false }); }
      catch (e) { console.warn(`[voxian] stopped replay at height ${b.height}: ${e.message}`); break; }
    }
    this.lastBlockAt = this.now();
    return this;
  }

  get tip() { return this.blocks[this.blocks.length - 1]; }
  get height() { return this.tip.height; }
  onBlock(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Stake-weighted, deterministic proposer for the next block.
  proposerFor(prevHash, height) {
    const vs = this.genesis.validators;
    const total = vs.reduce((n, v) => n + BigInt(v.stake), 0n);
    let r = bytesToBig(sha256(utf8(`${prevHash}:${height}`))) % total;
    for (const v of vs) { if (r < BigInt(v.stake)) return v; r -= BigInt(v.stake); }
    return vs[0];
  }

  // ---- mempool ----
  submitTx(tx) {
    const hash = txHash(tx);
    if (this.txIndex.has(hash) || this.mempool.some((m) => m.hash === hash)) throw new Error('duplicate transaction');
    if (this.mempool.length >= MAX_MEMPOOL) throw new Error('mempool full');
    applyTx(this.pending, tx, { height: this.height + 1, timestamp: this.now(), skipCrypto: this.verified.has(hash) });
    this.verified.add(hash);
    this.mempool.push({ hash, tx, receivedAt: this.now() });
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
  // Execute txs on a copy of state. dropInvalid=true when producing (skip bad txs), false when validating.
  execute(header, txs, { dropInvalid, trusted }) {
    const s = this.state.clone();
    const included = [];
    let fees = 0n;
    for (const tx of txs) {
      try {
        const hash = txHash(tx);
        const r = applyTx(s, tx, { height: header.height, timestamp: header.timestamp, skipCrypto: trusted || this.verified.has(hash) });
        fees += r.fee;
        included.push({ hash, tx });
      } catch (e) {
        if (!dropInvalid) throw new Error(`invalid tx in block ${header.height}: ${e.message}`);
      }
    }
    const reward = blockReward(header.height, s.issued);
    s.issued += reward;
    s.credit(addressFromPub(header.proposer), reward + fees);
    s.height = header.height;
    return { state: s, included, fees, reward };
  }

  produceBlock() {
    const prev = this.tip;
    const height = prev.height + 1;
    const proposer = this.proposerFor(prev.hash, height);
    const secret = this.validatorSecrets.get(proposer.pub);
    if (!secret) return null; // not our turn on a multi-node network
    const header = { height, prevHash: prev.hash, timestamp: Math.max(this.now(), prev.timestamp + 1), proposer: proposer.pub };
    const candidates = this.mempool.slice(0, MAX_BLOCK_TXS).map((m) => m.tx);
    const { included, fees, reward } = this.execute(header, candidates, { dropInvalid: true, trusted: false });
    const block = { ...header, txRoot: merkleRoot(included.map((i) => i.hash)), reward: reward.toString(), fees: fees.toString(), txs: included.map((i) => i.tx) };
    block.hash = blockHash(block);
    block.signature = schnorrSign(hexToBytes(block.hash), secret);
    // Drop candidates that failed so they can't wedge the mempool.
    const includedSet = new Set(included.map((i) => i.hash));
    const failed = new Set(this.mempool.slice(0, MAX_BLOCK_TXS).filter((m) => !includedSet.has(m.hash)).map((m) => m.hash));
    this.mempool = this.mempool.filter((m) => !failed.has(m.hash));
    this.applyBlock(block, { trusted: false, persist: true });
    return block;
  }

  applyBlock(block, { trusted, persist }) {
    const prev = this.tip;
    if (block.height !== prev.height + 1) throw new Error('wrong height');
    if (block.prevHash !== prev.hash) throw new Error('wrong parent');
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp <= prev.timestamp) throw new Error('bad timestamp');
    if (block.timestamp > this.now() + 15_000) throw new Error('block from the future');
    const expected = this.proposerFor(prev.hash, block.height);
    if (block.proposer !== expected.pub) throw new Error('wrong proposer');
    if (!Array.isArray(block.txs)) throw new Error('bad txs');
    const hashes = block.txs.map(txHash);
    if (block.txRoot !== merkleRoot(hashes)) throw new Error('bad tx root');
    if (block.hash !== blockHash(block)) throw new Error('bad block hash');
    if (!trusted && !schnorrVerify(block.signature, hexToBytes(block.hash), parsePub(block.proposer))) throw new Error('bad block signature');
    const { state, fees, reward } = this.execute(block, block.txs, { dropInvalid: false, trusted });
    if (fees.toString() !== block.fees || reward.toString() !== block.reward) throw new Error('bad reward/fees');

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
    this.lastBlockAt = this.now();
    if (persist) Promise.resolve(this.storage.append(block)).catch((e) => console.warn('[voxian] persist failed:', e.message));
    for (const fn of this.listeners) { try { fn(block); } catch { /* listener errors are not consensus errors */ } }
    return block;
  }

  // Called on a timer: fast blocks while txs wait, heartbeat blocks when idle.
  tick() {
    const since = this.now() - this.lastBlockAt;
    if ((this.mempool.length > 0 && since >= BLOCK_INTERVAL_MS) || since >= EMPTY_BLOCK_MS) return this.produceBlock();
    return null;
  }

  start(intervalMs = 250) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[voxian] block production error', e); } }, intervalMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

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

  // Pedersen generator exposed for clients/explorers.
  static get pedersenH() { return mulH(1n).toHex(); }
}
