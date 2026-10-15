// Validator cluster consensus: a simplified Tendermint-style BFT with instant finality.
//
//   1. For each (height, round) a stake-weighted proposer builds and signs a block and gossips a PROPOSAL.
//   2. Every validator re-executes the proposal and, if valid, signs a VOTE for (height, blockHash).
//      A validator votes for at most one block per height (it re-proposes that block if it becomes proposer).
//   3. When votes from > 2/3 of stake are collected, any node assembles the COMMIT certificate,
//      commits the block and gossips it. Committed blocks are final: there are no reorgs.
//   4. If a proposer is down, the next round opens after ROUND_TIMEOUT_MS with a different proposer.
//   5. Nodes that fall behind (restart, partition) catch up by fetching committed blocks from peers.
//
// Safety holds while < 1/3 of stake is Byzantine; with the devnet's 4 validators any 1 may fail.
// The same engine runs standalone (all validator keys local, no peers) where it commits instantly.
import { schnorrSign, schnorrVerify } from '../crypto/secp256k1.js';
import { parsePub } from './keys.js';
import { voteDigest } from './blockchain.js';
import { BLOCK_INTERVAL_MS, EMPTY_BLOCK_MS, ROUND_TIMEOUT_MS } from './params.js';

const SYNC_BATCH = 50;

export class Consensus {
  /**
   * chain: Blockchain; localValidators: [{ name, pubHex, secret }] this node signs for;
   * transport: { peers: string[], broadcast(type, body), get(peer, path) } or null (standalone).
   */
  constructor({ chain, localValidators = [], transport = null, log = () => {} }) {
    this.chain = chain;
    this.local = new Map(localValidators.map((v) => [v.pubHex, v]));
    this.transport = transport;
    this.log = log;
    this.peers = new Map((transport?.peers ?? []).map((url) => [url, { url, ok: false, height: null, lastSeen: 0, latencyMs: null }]));
    this.syncing = false;
    this.lastCommit = null;
    this.stats = { proposals: 0, votesSent: 0, votesReceived: 0, commits: 0, roundChanges: 0, synced: 0 };
    this.resetHeight();
    // Gossip locally-originated txs to the cluster.
    chain.onTx((tx, { origin }) => { if (origin !== 'peer') this.broadcast('tx', tx); });
  }

  get mode() { return this.transport && this.peers.size ? 'cluster' : 'standalone'; }

  resetHeight() {
    this.h = this.chain.height + 1;
    this.proposals = new Map(); // blockHash -> block
    this.votes = new Map(); // blockHash -> Map(validatorPub -> sig)
    this.myVotes = new Map(); // local validatorPub -> blockHash (one vote per height)
    this.proposedRounds = new Set();
    this.lastRebroadcast = -1;
    this.highestRound = 0;
  }

  ensureHeight() { if (this.h !== this.chain.height + 1) this.resetHeight(); }

  broadcast(type, body) { if (this.transport) this.transport.broadcast(type, body); }

  currentRound(now = this.chain.now()) {
    return Math.max(0, Math.floor((now - this.chain.tip.timestamp) / ROUND_TIMEOUT_MS));
  }

  // ---- timer ----
  tick() {
    this.ensureHeight();
    const now = this.chain.now();
    const since = now - this.chain.tip.timestamp;
    const due = (this.chain.mempool.length > 0 && since >= BLOCK_INTERVAL_MS) || since >= EMPTY_BLOCK_MS || this.proposals.size > 0;
    if (!due) return;
    const round = this.currentRound(now);
    if (round > this.highestRound) { if (this.highestRound > 0 || this.proposals.size) this.stats.roundChanges++; this.highestRound = round; }

    // Each new round: re-gossip our votes and the block we voted for (covers lost messages / restarted peers).
    if (round > this.lastRebroadcast) {
      this.lastRebroadcast = round;
      for (const [pub, hash] of this.myVotes) {
        const block = this.proposals.get(hash);
        if (block) this.broadcast('proposal', block);
        this.broadcast('vote', { height: this.h, blockHash: hash, validator: pub, sig: this.votes.get(hash)?.get(pub) });
      }
    }

    if (this.proposedRounds.has(round)) return;
    const proposer = this.chain.proposerFor(this.chain.tip.hash, this.h, round);
    const me = this.local.get(proposer.pub);
    if (!me) return;
    this.proposedRounds.add(round);

    // Locked: if we already voted at this height, push that block again instead of a competing one.
    const lockedHash = [...this.myVotes.values()][0];
    const block = lockedHash ? this.proposals.get(lockedHash) : this.chain.buildBlock(round, me);
    if (!block) return;
    if (!lockedHash) { this.stats.proposals++; this.log(`proposed #${block.height} round ${round} (${block.txs.length} txs)`); }
    this.broadcast('proposal', block);
    this.onProposal(block);
  }

  // ---- messages ----
  onProposal(block) {
    this.ensureHeight();
    if (!block || typeof block !== 'object') return { ok: false, error: 'bad proposal' };
    if (block.height <= this.chain.height) return { ok: true, stale: true };
    if (block.height > this.h) { this.requestSync(); return { ok: true, behind: true }; }
    const hash = block.hash;
    if (!this.proposals.has(hash)) {
      try { this.chain.validateBlock(block); }
      catch (e) { this.log(`rejected proposal #${block.height} r${block.round}: ${e.message}`); return { ok: false, error: e.message }; }
      const { commit, ...clean } = block;
      this.proposals.set(hash, clean);
    }
    const digest = voteDigest(this.h, hash);
    for (const [pub, v] of this.local) {
      if (this.myVotes.has(pub)) continue;
      const vote = { height: this.h, blockHash: hash, validator: pub, sig: schnorrSign(digest, v.secret) };
      this.myVotes.set(pub, hash);
      this.stats.votesSent++;
      this.broadcast('vote', vote);
      this.recordVote(vote);
    }
    this.tryCommit(hash);
    return { ok: true };
  }

  onVote(vote) {
    this.ensureHeight();
    if (!vote || typeof vote !== 'object' || typeof vote.blockHash !== 'string') return { ok: false, error: 'bad vote' };
    if (vote.height <= this.chain.height) return { ok: true, stale: true };
    if (vote.height > this.h) { this.requestSync(); return { ok: true, behind: true }; }
    if (!this.chain.stakeOf.has(vote.validator)) return { ok: false, error: 'unknown validator' };
    if (!schnorrVerify(vote.sig, voteDigest(vote.height, vote.blockHash), parsePub(vote.validator))) return { ok: false, error: 'bad vote signature' };
    this.stats.votesReceived++;
    this.recordVote(vote);
    this.tryCommit(vote.blockHash);
    return { ok: true };
  }

  recordVote(vote) {
    // Count one vote per validator per height (an equivocating validator's later votes are ignored).
    for (const m of this.votes.values()) if (m.has(vote.validator)) return;
    if (!this.votes.has(vote.blockHash)) this.votes.set(vote.blockHash, new Map());
    this.votes.get(vote.blockHash).set(vote.validator, vote.sig);
  }

  tryCommit(hash) {
    const block = this.proposals.get(hash);
    const votes = this.votes.get(hash);
    if (!block || !votes) return false;
    let power = 0n;
    for (const pub of votes.keys()) power += this.chain.stakeOf.get(pub) ?? 0n;
    if (!this.chain.hasQuorum(power)) return false;
    const committed = { ...block, commit: { votes: [...votes].map(([validator, sig]) => ({ validator, sig })) } };
    try {
      this.chain.applyBlock(committed);
    } catch (e) {
      this.log(`commit of #${block.height} failed: ${e.message}`);
      return false;
    }
    this.recordCommit(committed);
    this.broadcast('commit', committed);
    this.resetHeight();
    return true;
  }

  onCommit(block) {
    this.ensureHeight();
    if (!block || typeof block !== 'object') return { ok: false, error: 'bad block' };
    if (block.height <= this.chain.height) return { ok: true, stale: true };
    if (block.height > this.h) { this.requestSync(); return { ok: true, behind: true }; }
    try { this.chain.applyBlock(block); }
    catch (e) { return { ok: false, error: e.message }; }
    this.recordCommit(block);
    this.resetHeight();
    return { ok: true };
  }

  onTx(tx) {
    try { return { ok: true, hash: this.chain.submitTx(tx, { origin: 'peer' }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  recordCommit(block) {
    this.stats.commits++;
    const signers = block.commit.votes.map((v) => this.chain.validators.find((x) => x.pub === v.validator)?.name ?? v.validator);
    const power = this.chain.commitPower(block, { checkSigs: false });
    this.lastCommit = { height: block.height, round: block.round, hash: block.hash, signers, stakePct: Number((power * 10000n) / this.chain.totalStake) / 100 };
  }

  // ---- catch-up sync ----
  requestSync() { if (!this.syncing) this.sync().catch(() => {}); }

  async sync() {
    if (!this.transport || this.syncing) return;
    this.syncing = true;
    try {
      const statuses = await Promise.all([...this.peers.keys()].map(async (url) => {
        const t0 = Date.now();
        try {
          const s = await this.transport.get(url, 'p2p/status');
          Object.assign(this.peers.get(url), { ok: true, height: s.height, lastSeen: Date.now(), latencyMs: Date.now() - t0, validators: s.localValidators });
          return { url, height: s.height };
        } catch {
          Object.assign(this.peers.get(url), { ok: false });
          return null;
        }
      }));
      const best = statuses.filter(Boolean).sort((a, b) => b.height - a.height)[0];
      if (!best || best.height <= this.chain.height) return;
      while (this.chain.height < best.height) {
        const { blocks } = await this.transport.get(best.url, `p2p/blocks?from=${this.chain.height + 1}&limit=${SYNC_BATCH}`);
        if (!blocks?.length) break;
        for (const b of blocks) {
          this.chain.applyBlock(b); // verifies everything, including the 2/3 commit certificate
          this.recordCommit(b);
          this.stats.synced++;
        }
        this.resetHeight();
      }
      this.log(`synced to #${this.chain.height} from ${best.url}`);
    } catch (e) {
      this.log(`sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  status() {
    return {
      mode: this.mode,
      height: this.chain.height,
      tipHash: this.chain.tip.hash,
      nextHeight: this.h,
      round: this.currentRound(),
      roundTimeoutMs: ROUND_TIMEOUT_MS,
      quorum: '> 2/3 of stake',
      localValidators: [...this.local.values()].map((v) => v.name),
      validators: this.chain.validators.map((v) => ({ name: v.name, pub: v.pub, stake: v.stake, local: this.local.has(v.pub) })),
      pendingProposals: this.proposals.size,
      votesThisHeight: [...this.votes.values()].reduce((n, m) => n + m.size, 0),
      lastCommit: this.lastCommit,
      peers: [...this.peers.values()],
      stats: this.stats,
    };
  }

  start(intervalMs = 250) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log(`consensus tick error: ${e.message}`); } }, intervalMs);
    if (this.transport) {
      this.requestSync();
      this.syncTimer = setInterval(() => this.requestSync(), 2_000);
    }
  }

  stop() { clearInterval(this.timer); clearInterval(this.syncTimer); this.timer = this.syncTimer = null; }
}

// HTTP gossip between cluster nodes (full mesh, fire-and-forget POSTs to /p2p/<type>).
export class HttpTransport {
  constructor(peers, { timeoutMs = 5_000 } = {}) {
    this.peers = peers.map((p) => p.replace(/\/+$/, ''));
    this.timeoutMs = timeoutMs;
  }
  broadcast(type, body) {
    const payload = JSON.stringify(body);
    for (const peer of this.peers) {
      fetch(`${peer}/p2p/${type}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(this.timeoutMs) }).catch(() => {});
    }
  }
  async get(peer, path) {
    const res = await fetch(`${peer}/${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

// In-process transport for tests and simulations; supports taking nodes offline.
export class MemoryNetwork {
  constructor(ids) { this.ids = ids; this.nodes = new Map(); this.down = new Set(); }
  transportFor(id) {
    const net = this;
    return {
      peers: this.ids.filter((k) => k !== id),
      broadcast(type, body) {
        if (net.down.has(id)) return;
        for (const [peer, c] of net.nodes) {
          if (peer === id || net.down.has(peer)) continue;
          const copy = structuredClone(body);
          setTimeout(() => { try { c[{ tx: 'onTx', proposal: 'onProposal', vote: 'onVote', commit: 'onCommit' }[type]](copy); } catch { /* peer error */ } }, 1);
        }
      },
      async get(peer, path) {
        if (net.down.has(id) || net.down.has(peer)) throw new Error('unreachable');
        const c = net.nodes.get(peer);
        const url = new URL(path, 'http://x/');
        if (url.pathname === '/p2p/status') return c.status();
        if (url.pathname === '/p2p/blocks') return { blocks: structuredClone(blocksFrom(c.chain, Number(url.searchParams.get('from')), Number(url.searchParams.get('limit')))) };
        throw new Error('not found');
      },
    };
  }
  add(id, consensus) { this.nodes.set(id, consensus); }
}

export function blocksFrom(chain, from, limit = SYNC_BATCH) {
  const start = Math.max(1, from | 0);
  return chain.blocks.slice(start, start + Math.min(SYNC_BATCH, Math.max(1, limit | 0)));
}
