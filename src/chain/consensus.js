// Voxian consensus: Proof-of-History clock + stake-weighted leader schedule + Tendermint-style BFT finality.
//
//  PoH (phase 1-2): every node runs a PoH recorder from the tip's pohEnd. Rounds are PoH slots:
//    round r at height h is slot tip.slot + 1 + r, led by the epoch schedule's leader for that slot.
//    A leader can only claim a later slot by carrying the sequential hashes proving the skipped slots.
//  BFT (phase 3), per (height, round):
//    PROPOSAL  – the slot leader proposes its validValue (newest block with a polka) or builds a new block.
//    PREVOTE   – validators prevote the proposal unless locked on another block (unlock only on a newer polka).
//    PRECOMMIT – after > 2/3 prevotes (a polka) in the current round: lock on the block and precommit it.
//    COMMIT    – > 2/3 precommits in one round: the block is final (certificate stored in the block).
//  Safety (phase 3/5): a persistent signing log stops a validator ever signing two different values for the
//    same (kind, height, round), even across restarts. Conflicting votes seen from others become evidence
//    transactions that slash and jail the offender.
//  Safe while < 1/3 of stake is Byzantine; live once a round has an honest leader and timely messages.
import { schnorrSign, schnorrVerify } from '../crypto/secp256k1.js';
import { taggedHash } from '../crypto/sha256.js';
import { utf8 } from '../crypto/encoding.js';
import { parsePub } from './keys.js';
import { signTx } from './tx.js';
import { epochOf } from './blockchain.js';
import { PohRecorder } from './poh.js';
import { voteDigest, checkVote } from './staking.js';
import { BLOCK_INTERVAL_MS, HEARTBEAT_SLOTS, TICK_MS, TICKS_PER_SLOT, HASHES_PER_TICK, MAX_BLOCK_TICKS, MAX_SLOT_GAP, ROUND_LOOKAHEAD, MIN_FEE, CHAIN_ID } from './params.js';

const SYNC_BATCH = 50;
const MAX_PEERS = 32;
const MAX_EVIDENCE = 100;
const PEER_EVICT_FAILURES = 5;
export const helloDigest = (url) => taggedHash('Voxian/hello', utf8(CHAIN_ID), utf8(url));
export const proposalDigest = (height, round, validRound, blockHash) => taggedHash('Voxian/proposal', utf8(CHAIN_ID), utf8(`${height}:${round}:${validRound}:${blockHash}`));

export class Consensus {
  /**
   * chain: Blockchain; localValidators: [{ name, pubHex, secret }];
   * transport: { peers, broadcast(type, body), get(peer, path) } or null (standalone); storage: for the signing log.
   */
  constructor({ chain, localValidators = [], transport = null, storage = chain.storage, log = () => {} }) {
    this.chain = chain;
    this.local = new Map(localValidators.map((v) => [v.pubHex, v]));
    this.transport = transport;
    this.storage = storage;
    this.log = log;
    this.peers = new Map((transport?.peers ?? []).map((url) => [url, { url, ok: false, height: null, lastSeen: 0, latencyMs: null, failures: 0, dynamic: false }]));
    this.syncing = false;
    this.lastCommit = null;
    this.evidence = []; // detected equivocations { voteA, voteB, submitted }
    this.stats = { proposals: 0, prevotes: 0, precommits: 0, votesReceived: 0, commits: 0, rounds: 0, synced: 0, evidence: 0 };
    this.signLog = new Map(Object.entries(storage?.loadMeta?.('signlog') ?? {}));
    this.hashRate = 0;
    this.resetHeight();
    chain.onTx((tx, { origin }) => { if (origin !== 'peer') this.broadcast('tx', tx); });
    chain.onBlock(() => this.resetHeight());
  }

  get mode() { return this.transport && this.peers.size ? 'cluster' : 'standalone'; }

  resetHeight() {
    const tip = this.chain.tip;
    this.h = tip.height + 1;
    this.recorder = new PohRecorder(tip.pohEnd); // PoH continues from the committed tip
    this.clockTicks = 0;
    this.roundFloor = 0;
    this.lastRound = -1;
    this.proposals = new Map(); // round -> { hash, validRound, msg }
    this.blocks = new Map(); // hash -> validated block (no certificate)
    this.invalid = new Set();
    this.votes = { prevote: new Map(), precommit: new Map() }; // round -> Map(validator -> { hash, sig })
    this.maxRoundSeen = new Map(); // validator -> highest round it has voted in (for f+1 round catch-up)
    this.seenProposalRounds = new Set(); // one signed proposal per round is all we'll ever validate
    this.weights = this.chain.weightSnapshot(this.h); // ONE validator set weighs every vote at this height
    this.lockedHash = null; this.lockedRound = -1;
    this.validHash = null; this.validRound = -1;
    this.proposed = new Set(); this.prevoted = new Set(); this.precommitted = new Set();
    // Restore a lock taken before a restart (losing it could let us prevote a conflicting block).
    const saved = this.storage?.loadMeta?.('lock');
    if (saved && saved.h === this.h) Object.assign(this, { lockedHash: saved.lockedHash, lockedRound: saved.lockedRound, validHash: saved.validHash, validRound: saved.validRound, roundFloor: Math.max(saved.lockedRound, saved.validRound, 0) });
  }

  saveLock() {
    try { this.storage?.saveMeta?.('lock', { h: this.h, lockedHash: this.lockedHash, lockedRound: this.lockedRound, validHash: this.validHash, validRound: this.validRound }); } catch { /* best effort */ }
  }

  ensureHeight() { if (this.h !== this.chain.height + 1) this.resetHeight(); }
  broadcast(type, body) { if (this.transport) this.transport.broadcast(type, body); }
  // Round r leads slot tip.slot + 1 + r. After MAX_SLOT_GAP rounds without a commit the mapping wraps,
  // so a long stall never produces slots too far ahead to be provable with PoH.
  slotOf(round) { return this.chain.tip.slot + 1 + (round % MAX_SLOT_GAP); }
  get round() { return Math.max(Math.floor(this.clockTicks / TICKS_PER_SLOT), this.roundFloor); }

  // ---- signing with a persistent equivocation guard ----
  signOnce(v, kind, round, hash, digest) {
    const key = `${v.pubHex}:${kind}:${this.h}:${round}`;
    const prior = this.signLog.get(key);
    if (prior && prior.hash !== hash) return null; // never sign two values for one slot
    if (prior) return prior.sig;
    const sig = schnorrSign(digest, v.secret);
    this.signLog.set(key, { hash, sig });
    for (const k of this.signLog.keys()) if (Number(k.split(':')[2]) < this.h - 5) this.signLog.delete(k);
    try { this.storage?.saveMeta?.('signlog', Object.fromEntries(this.signLog)); } catch { /* best effort */ }
    return sig;
  }

  // ---- PoH clock ----
  tick() {
    this.ensureHeight();
    const t0 = Date.now();
    this.clockTicks++;
    if (this.recorder.ticks < MAX_BLOCK_TICKS) {
      this.recorder.tick();
      const ms = Date.now() - t0;
      if (ms > 0) this.hashRate = Math.round(this.hashRate * 0.9 + (HASHES_PER_TICK / ms) * 1000 * 0.1);
    }
    const r = this.round;
    if (r !== this.lastRound) {
      if (this.lastRound >= 0) this.stats.rounds++;
      this.lastRound = r;
      this.rebroadcast();
      this.tryPrevote(r);
    }
    this.maybePropose(r);
  }

  // Re-send our latest votes and the best proposal each round (covers lost messages and restarted peers).
  rebroadcast() {
    for (const kind of ['prevote', 'precommit']) {
      const rounds = [...this.votes[kind].keys()].sort((a, b) => b - a).slice(0, 2);
      for (const r of rounds) for (const [validator, v] of this.votes[kind].get(r)) {
        if (this.local.has(validator)) this.broadcast('vote', { kind, height: this.h, round: r, blockHash: v.hash, parent: this.chain.tip.hash, validator, sig: v.sig });
      }
    }
    const best = [...this.proposals.entries()].sort((a, b) => b[0] - a[0])[0];
    if (best) this.broadcast('proposal', best[1].msg);
  }

  maybePropose(r) {
    if (this.proposed.has(r) || this.local.size === 0) return;
    const leader = this.chain.leaderFor(this.slotOf(r));
    const me = this.local.get(leader.pub);
    if (!me) return;
    const since = this.chain.now() - this.chain.tip.timestamp;
    const due = this.validHash || (this.chain.mempool.length > 0 && since >= BLOCK_INTERVAL_MS) || r >= HEARTBEAT_SLOTS - 1;
    if (!due) return;
    // A fresh block must carry PoH proving every slot it skips.
    if (!this.validHash && this.recorder.ticks < (this.slotOf(r) - this.chain.tip.slot - 1) * TICKS_PER_SLOT) return;
    let block, validRound;
    if (this.validHash) { block = this.blocks.get(this.validHash); validRound = this.validRound; }
    else { block = this.chain.buildBlock(this.slotOf(r), me, this.recorder); validRound = -1; }
    if (!block) return;
    const sig = this.signOnce(me, 'proposal', r, block.hash, proposalDigest(this.h, r, validRound, block.hash));
    if (!sig) return;
    this.proposed.add(r);
    if (validRound < 0) this.stats.proposals++;
    this.log(`proposed #${block.height} slot ${block.slot} round ${r}${validRound >= 0 ? ` (re-proposal, polka r${validRound})` : ''} · ${block.txs.length} txs · ${block.pohTicks} PoH ticks`);
    const msg = { height: this.h, round: r, validRound, blockHash: block.hash, proposer: me.pubHex, sig, block };
    this.broadcast('proposal', msg);
    this.onProposal(msg);
  }

  // ---- messages ----
  onProposal(msg) {
    this.ensureHeight();
    if (!msg || typeof msg !== 'object' || !msg.block || typeof msg.blockHash !== 'string') return { ok: false, error: 'bad proposal' };
    if (msg.height < this.h) return { ok: true, stale: true };
    if (msg.height > this.h) { this.requestSync(); return { ok: true, behind: true }; }
    if (!Number.isSafeInteger(msg.round) || msg.round < 0 || !Number.isSafeInteger(msg.validRound) || msg.validRound < -1 || msg.validRound >= msg.round) return { ok: false, error: 'bad round' };
    // Rounds only advance by our clock or by > 1/3 of stake voting ahead, never by a lone leader's claim.
    if (msg.round > this.round + 1) return { ok: false, error: 'proposal for a future round' };
    if (this.seenProposalRounds.has(msg.round)) return { ok: true, duplicate: true };
    let leader;
    try { leader = this.chain.leaderFor(this.slotOf(msg.round)); } catch (e) { return { ok: false, error: e.message }; }
    if (msg.proposer !== leader.pub) return { ok: false, error: 'not the leader for this round' };
    if (!schnorrVerify(msg.sig, proposalDigest(msg.height, msg.round, msg.validRound, msg.blockHash), parsePub(msg.proposer))) return { ok: false, error: 'bad proposal signature' };
    this.seenProposalRounds.add(msg.round); // only the first signed proposal per round is ever validated
    const hash = msg.blockHash;
    if (msg.block.hash !== hash || this.invalid.has(hash)) return { ok: false, error: 'invalid block' };
    if (!this.blocks.has(hash)) {
      try { this.chain.validateBlock(msg.block); }
      catch (e) { this.invalid.add(hash); this.log(`rejected proposal #${msg.height} r${msg.round}: ${e.message}`); return { ok: false, error: e.message }; }
      const { commit, ...clean } = msg.block;
      this.blocks.set(hash, clean);
    }
    this.proposals.set(msg.round, { hash, validRound: msg.validRound, msg });
    this.tryPrevote(this.round);
    this.tallyAll();
    return { ok: true };
  }

  hasPolka(round, hash) {
    const votes = this.votes.prevote.get(round);
    return !!votes && this.quorum(votes, hash);
  }

  tryPrevote(r) {
    if (this.prevoted.has(r) || this.local.size === 0) return;
    const p = this.proposals.get(r);
    if (!p) return;
    const accept = this.lockedRound === -1 || this.lockedHash === p.hash || (p.validRound > this.lockedRound && this.hasPolka(p.validRound, p.hash));
    if (!accept) return; // locked on a different block
    this.prevoted.add(r);
    this.castVotes('prevote', r, p.hash);
  }

  castVotes(kind, round, hash) {
    for (const v of this.local.values()) {
      const parent = this.chain.tip.hash;
      const sig = this.signOnce(v, kind, round, hash, voteDigest(kind, this.h, round, hash, parent));
      if (!sig) continue;
      this.stats[kind === 'prevote' ? 'prevotes' : 'precommits']++;
      const vote = { kind, height: this.h, round, blockHash: hash, parent, validator: v.pubHex, sig };
      this.broadcast('vote', vote);
      this.recordVote(vote);
    }
    this.tally(kind, round);
  }

  onVote(vote) {
    this.ensureHeight();
    if (!vote || typeof vote !== 'object') return { ok: false, error: 'bad vote' };
    if (vote.height < this.h) return { ok: true, stale: true };
    if (vote.height > this.h) { this.requestSync(); return { ok: true, behind: true }; }
    if (!Number.isSafeInteger(vote.round) || vote.round < 0) return { ok: false, error: 'bad round' };
    if (!this.weights.power.has(vote.validator)) return { ok: false, error: 'not a validator at this height' };
    if (vote.parent !== this.chain.tip.hash) return { ok: true, stale: true };
    if (vote.round < this.round - 5) return { ok: true, stale: true };
    if (!checkVote(vote)) return { ok: false, error: 'bad vote signature' };
    this.stats.votesReceived++;
    this.noteRound(vote.validator, vote.round);
    if (vote.round > this.round + ROUND_LOOKAHEAD) return { ok: true, ahead: true }; // counted for catch-up only
    this.recordVote(vote);
    this.tally(vote.kind, vote.round);
    return { ok: true };
  }

  // Tendermint's f+1 rule: if validators with > 1/3 of stake are in round >= R, we're behind; jump to R.
  noteRound(validator, round) {
    if ((this.maxRoundSeen.get(validator) ?? -1) >= round) return;
    this.maxRoundSeen.set(validator, round);
    if (round <= this.round) return;
    const sorted = [...this.maxRoundSeen].sort((a, b) => b[1] - a[1]);
    let power = 0n;
    for (const [v, r] of sorted) {
      power += this.weights.power.get(v) ?? 0n;
      if (power * 3n > this.weights.total) {
        if (r > this.round) { this.roundFloor = r; this.tryPrevote(r); }
        return;
      }
    }
  }

  recordVote(vote) {
    const byRound = this.votes[vote.kind];
    if (!byRound.has(vote.round)) byRound.set(vote.round, new Map());
    const m = byRound.get(vote.round);
    const prior = m.get(vote.validator);
    if (prior && prior.hash !== vote.blockHash) { this.reportEquivocation(vote, prior); return; }
    if (!prior) m.set(vote.validator, { hash: vote.blockHash, sig: vote.sig });
  }

  // Phase 5: two conflicting signed votes -> evidence tx (slashes + jails the offender on-chain).
  reportEquivocation(vote, prior) {
    const voteA = { kind: vote.kind, height: vote.height, round: vote.round, blockHash: prior.hash, parent: vote.parent, validator: vote.validator, sig: prior.sig };
    if (this.evidence.length >= MAX_EVIDENCE) return;
    if (this.evidence.some((e) => e.voteA.validator === vote.validator && e.voteA.kind === vote.kind && e.voteA.height === vote.height && e.voteA.round === vote.round)) return;
    const ev = { voteA, voteB: vote, submitted: null };
    this.evidence.push(ev);
    this.stats.evidence++;
    this.log(`equivocation detected: ${vote.validator.slice(0, 12)}… ${vote.kind} h${vote.height} r${vote.round}`);
    this.submitEvidence(ev);
  }

  submitEvidence(ev) {
    for (const v of this.local.values()) {
      if (v.pubHex === ev.voteA.validator) continue;
      const addr = this.chain.pending.account(v.address);
      if (addr.balance < MIN_FEE.evidence) continue;
      try {
        const tx = signTx({ type: 'evidence', from: v.pubHex, voteA: ev.voteA, voteB: ev.voteB, fee: MIN_FEE.evidence.toString(), nonce: addr.nonce }, v.secret);
        ev.submitted = this.chain.submitTx(tx);
        return;
      } catch (e) { this.log(`evidence submission failed: ${e.message}`); }
    }
  }

  // Stake behind `hash` among these votes, weighted by this height's single snapshot. We only act on
  // quorums for blocks we have validated ourselves.
  quorum(votes, hash) {
    if (!this.blocks.has(hash)) return false;
    let power = 0n;
    for (const [validator, v] of votes) if (v.hash === hash) power += this.weights.power.get(validator) ?? 0n;
    return this.chain.hasQuorum(power, this.weights.total);
  }

  tallyAll() {
    for (const kind of ['prevote', 'precommit']) for (const r of [...this.votes[kind].keys()]) this.tally(kind, r);
  }

  tally(kind, round) {
    const votes = this.votes[kind].get(round);
    if (!votes || this.h !== this.chain.height + 1) return;
    for (const hash of new Set([...votes.values()].map((v) => v.hash))) {
      if (!this.quorum(votes, hash)) continue;
      if (kind === 'prevote') {
        if (round > this.validRound) { this.validHash = hash; this.validRound = round; this.saveLock(); }
        if (round > this.roundFloor) this.roundFloor = round;
        if (round === this.round && !this.precommitted.has(round) && this.local.size) {
          this.precommitted.add(round);
          this.lockedHash = hash; this.lockedRound = round;
          this.saveLock(); // persist the lock before the precommit leaves this node
          this.castVotes('precommit', round, hash);
        }
      } else {
        this.commit(hash, round);
        return;
      }
    }
  }

  commit(hash, round) {
    const block = this.blocks.get(hash);
    if (!block) return false;
    const votes = [...this.votes.precommit.get(round)].filter(([, v]) => v.hash === hash).map(([validator, v]) => ({ validator, sig: v.sig }));
    const committed = { ...block, commit: { round, votes } };
    try { this.chain.applyBlock(committed); } // resets height state via onBlock
    catch (e) { this.log(`commit of #${block.height} failed: ${e.message}`); return false; }
    this.recordCommit(committed);
    this.broadcast('commit', committed);
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
    return { ok: true };
  }

  onTx(tx) {
    try { return { ok: true, hash: this.chain.submitTx(tx, { origin: 'peer' }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  recordCommit(block) {
    this.stats.commits++;
    const names = new Map(this.chain.state.validators.size ? [...this.chain.state.validators.values()].map((v) => [v.pub, v.name]) : []);
    const { power, total } = this.chain.commitPower(block, { checkSigs: false });
    this.lastCommit = {
      height: block.height, slot: block.slot, round: block.commit.round, hash: block.hash, pohTicks: block.pohTicks,
      signers: block.commit.votes.map((v) => names.get(v.validator) ?? v.validator.slice(0, 12)),
      stakePct: total > 0n ? Number((power * 10000n) / total) / 100 : 0,
    };
  }

  // ---- catch-up sync ----
  requestSync() { if (!this.syncing) this.sync().catch(() => {}); }

  async sync() {
    if (!this.transport || this.syncing) return;
    this.syncing = true;
    try {
      const statuses = await Promise.all([...this.peers.keys()].map(async (url) => {
        const t0 = Date.now();
        const p = this.peers.get(url);
        try {
          const s = await this.transport.get(url, 'p2p/status');
          if (!Number.isSafeInteger(s?.height)) throw new Error('bad status');
          Object.assign(p, { ok: true, height: s.height, lastSeen: Date.now(), latencyMs: Date.now() - t0, validators: s.localValidators, failures: 0 });
          return { url, height: s.height };
        } catch {
          Object.assign(p, { ok: false, failures: (p.failures ?? 0) + 1 });
          if (p.dynamic && p.failures >= PEER_EVICT_FAILURES) this.removePeer(url);
          return null;
        }
      }));
      // Try candidates from highest claimed height down; a peer that can't back its claim is skipped
      // (and evicted if it joined dynamically), so one lying peer can't block catch-up.
      const candidates = statuses.filter((s) => s && s.height > this.chain.height).sort((a, b) => b.height - a.height);
      for (const best of candidates) {
        const start = this.chain.height;
        try {
          while (this.chain.height < best.height) {
            const { blocks } = await this.transport.get(best.url, `p2p/blocks?from=${this.chain.height + 1}&limit=${SYNC_BATCH}`);
            if (!Array.isArray(blocks) || !blocks.length) throw new Error('peer served no blocks');
            for (const b of blocks.slice(0, SYNC_BATCH)) {
              this.chain.applyBlock(b); // checks the 2/3 certificate first, then PoH, leader and txs
              this.recordCommit(b);
              this.stats.synced++;
            }
          }
          this.log(`synced to #${this.chain.height} from ${best.url}`);
          return;
        } catch (e) {
          this.log(`sync from ${best.url} failed at #${this.chain.height + 1}: ${e.message}`);
          const p = this.peers.get(best.url);
          if (p && this.chain.height === start) { p.failures = (p.failures ?? 0) + 1; if (p.dynamic && p.failures >= PEER_EVICT_FAILURES) this.removePeer(best.url); }
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  // Phase 4: run an additional validator key on this node (e.g. a newly registered wallet validator).
  addLocalValidator(v) { this.local.set(v.pubHex, v); }

  // Dynamic membership: a validator node announces its URL, signed by its (registered, unjailed)
  // validator key; we add it to our gossip set. Unsigned or non-validator announcements are ignored, so
  // strangers can't fill the peer table or point our gossip at arbitrary URLs.
  onHello(msg) {
    if (!msg || typeof msg.url !== 'string' || msg.url.length > 200 || typeof msg.validator !== 'string') return { added: false, error: 'bad hello' };
    const v = this.chain.state.validators.get(msg.validator);
    if (!v || v.jailed) return { added: false, error: 'not an active validator' };
    let pub;
    try { pub = parsePub(msg.validator); } catch { return { added: false, error: 'bad validator key' }; }
    if (!schnorrVerify(msg.sig, helloDigest(msg.url), pub)) return { added: false, error: 'bad signature' };
    return { added: this.addPeer(msg.url) };
  }

  addPeer(url) {
    if (!this.transport?.addPeer || this.peers.size >= MAX_PEERS) return false;
    const clean = this.transport.addPeer(url);
    if (!clean || this.peers.has(clean)) return false;
    this.peers.set(clean, { url: clean, ok: false, height: null, lastSeen: 0, latencyMs: null, failures: 0, dynamic: true });
    this.log(`peer joined: ${clean}`);
    return true;
  }

  removePeer(url) {
    this.peers.delete(url);
    this.transport?.removePeer?.(url);
    this.log(`peer evicted: ${url}`);
  }

  announce() {
    const self = this.transport?.self;
    const v = this.local.values().next().value;
    if (!self || !v) return; // observers don't need to be pushed to: they sync by pulling
    this.transport.announce({ url: self, validator: v.pubHex, sig: schnorrSign(helloDigest(self), v.secret) });
  }

  status() {
    const r = this.round;
    const tip = this.chain.tip;
    const upcoming = [];
    for (let i = 0; i < 8; i++) {
      const slot = this.slotOf(r) + i;
      try { const l = this.chain.leaderFor(slot); upcoming.push({ slot, leader: l.name, local: this.local.has(l.pub) }); } catch { break; }
    }
    const voteCount = (kind) => [...(this.votes[kind].get(r)?.values() ?? [])].length;
    return {
      mode: this.mode,
      height: this.chain.height,
      tipHash: tip.hash,
      nextHeight: this.h,
      round: r,
      slot: this.slotOf(r),
      epoch: epochOf(this.slotOf(r)),
      quorum: '> 2/3 of the height\'s stake snapshot',
      locked: this.lockedHash ? { hash: this.lockedHash, round: this.lockedRound } : null,
      valid: this.validHash ? { hash: this.validHash, round: this.validRound } : null,
      prevotesThisRound: voteCount('prevote'),
      precommitsThisRound: voteCount('precommit'),
      poh: { ticks: this.recorder.ticks, clockTicks: this.clockTicks, hash: this.recorder.end, hashesPerTick: HASHES_PER_TICK, ticksPerSlot: TICKS_PER_SLOT, tickMs: TICK_MS, hashRate: this.hashRate },
      upcoming,
      localValidators: [...this.local.values()].map((v) => v.name),
      lastCommit: this.lastCommit,
      evidence: this.evidence.map((e) => ({ validator: e.voteA.validator, kind: e.voteA.kind, height: e.voteA.height, round: e.voteA.round, submitted: e.submitted })),
      peers: [...this.peers.values()],
      stats: this.stats,
    };
  }

  start(intervalMs = TICK_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log(`consensus tick error: ${e.message}`); } }, intervalMs);
    if (this.transport) {
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), 30_000); // re-announce after peer restarts
      this.requestSync();
      this.syncTimer = setInterval(() => this.requestSync(), 2_000);
    }
  }

  stop() { clearInterval(this.timer); clearInterval(this.syncTimer); clearInterval(this.announceTimer); this.timer = this.syncTimer = this.announceTimer = null; }
}

// HTTP gossip between cluster nodes (full mesh, fire-and-forget POSTs to /p2p/<type>).
export class HttpTransport {
  constructor(peers, { timeoutMs = 5_000, self = null } = {}) {
    this.peers = peers.map((p) => p.replace(/\/+$/, ''));
    this.timeoutMs = timeoutMs;
    this.self = self;
  }
  addPeer(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
    const clean = u.origin;
    if (clean === this.self || this.peers.includes(clean)) return false;
    this.peers.push(clean);
    return clean;
  }
  removePeer(url) { this.peers = this.peers.filter((p) => p !== url); }
  // Tell every peer how to reach us (they add us to their gossip set).
  announce(hello) {
    for (const peer of this.peers) fetch(`${peer}/p2p/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello), signal: AbortSignal.timeout(this.timeoutMs) }).catch(() => {});
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
          if (net.filter && !net.filter({ from: id, to: peer, type, body })) continue; // simulated message loss
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

