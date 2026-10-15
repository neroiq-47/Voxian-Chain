# Voxian PoH + PoS upgrade: 5-phase plan

**Goal:** give Voxian a verifiable clock (**Proof of History**) and real, open **Proof of Stake** (validator registration, delegation, rewards and slashing), on top of the existing BFT validator cluster. The upgrade must not compromise the parts of the project that matter most: private ZK payments, x402 machine payments and AI agents.

## Scope guardrails (from the white paper)

| Guardrail | How the upgrade respects it |
|---|---|
| VOX: 210,000,000 max supply, 8 decimals | Issuance is unchanged: 50 VOX per block, halving, hard cap. Slashed VOX is **burned**, never re-minted. The supply invariant becomes `issued = circulating + staked + shielded + burned`. |
| "VOX supports network fees, staking if required by the final consensus design" | Staking is the only new token use. Fees and rewards go to validators and the people who stake with them. No new token or inflation. |
| Privacy-conscious (ZK) | Staking is a public action, as it must be for accountability, but shielded notes are never touched. PoH orders shielded txs without revealing anything about them. |
| Built for AI agents and x402 | The PoH clock gives agents verifiable ordering of their paid calls: each tx is mixed into the hash chain. Agents and services can query slot, epoch and leader schedule. The x402 flows are unchanged. |
| Independent Layer 1 | Our own consensus: PoH clock, stake-weighted leader schedule, Tendermint-style BFT finality, slashing. |
| Proposed project; devnet first | Every parameter is devnet-sized and documented as not final. Unaudited crypto stays flagged. |

## Phase 1: Proof of History clock
*A verifiable, sequential SHA-256 hash chain that proves time passed and fixes the order of transactions.*
- `src/chain/poh.js`: `PohRecorder` (tick, mix-in, snapshot) and `verifyPoh()`.
  - `next = H("Voxian/poh", prev)`, repeated `HASHES_PER_TICK` times per tick.
  - Transaction hashes are mixed in as `H("Voxian/poh-mix", prev, txHash)`.
- Every block carries `poh = { ticks, end, entries[] }`, continuing from the parent's `pohEnd`. The header commits to `slot`, `pohTicks` and `pohEnd`.
- Validators recompute the whole chain. The mixed-in tx hashes must equal the block's tx list in order. This gives a verifiable ordering proof for every payment, including x402.
- **Done when:** a block with a forged, truncated or reordered PoH, or a tampered mix-in, is rejected.

## Phase 2: Slots, epochs and a PoH-driven leader schedule
*Time is measured in PoH ticks, not wall clocks.*
- `TICKS_PER_SLOT` ticks make a slot; `SLOTS_PER_EPOCH` slots make an epoch.
- Each block has a `slot` greater than its parent's and may skip at most `MAX_SLOT_GAP` (120) slots. Its PoH must prove that every skipped slot really elapsed: `ticks ≥ (slot − parentSlot − 1) × TICKS_PER_SLOT`, with no cap. During a longer stall, the round-to-slot mapping wraps so blocks always stay provable.
- The leader schedule is fixed per epoch. It is stake-weighted, uses a snapshot of the validator set taken at the epoch boundary, and is seeded by the anchor block's hash. Leaders hold `LEADER_SLOTS` consecutive slots.
- This replaces the old wall-clock round timer: a leader can only claim a later slot by doing the sequential hashing.
- **Done when:** blocks from the wrong leader for a slot, or with too few ticks for the slots they skip, are rejected, and the schedule is identical on every node.

## Phase 3: BFT finality v2 (prevote, precommit, locking)
*Fixes the gaps listed in the cluster release: liveness under vote splits, and double-voting after a restart.*
- Tendermint-style two-phase votes per (height, round), where round r is slot `parentSlot + 1 + r`:
  - **Prevote** for a valid proposal unless locked on another block (unlock only on a later polka).
  - **Precommit** after more than 2/3 prevotes (a polka), and lock on that block.
  - **Commit** after more than 2/3 precommits in one round. The certificate is stored in the block.
- Leaders re-propose the newest block that reached a polka (`validRound`), so split votes resolve in later rounds.
- A persistent signing log makes a validator refuse to sign two different things for the same (kind, height, round), even across restarts.
- Vote power comes from the epoch snapshot of the block's slot.
- **Done when:** the cluster tolerates one of four validators down, halts safely below quorum, recovers, and resolves a forced vote split.

## Phase 4: Open Proof of Stake (registration, delegation, rewards, unbonding)
*Anyone with VOX can secure the network: validators are no longer limited to the devnet keys.*
- New transactions:
  - `validator_register`: self-stake at least `MIN_VALIDATOR_STAKE`, with a name and a commission.
  - `stake`: delegate to a validator.
  - `unstake`: start unbonding; funds return after `UNBONDING_EPOCHS`.
- The active set is recomputed each epoch: validators that aren't jailed, have at least the minimum self-stake, and are in the top `MAX_VALIDATORS` by bonded stake. Changes take effect at the next epoch boundary.
- Each block's reward plus fees go to its leader's stake pool. The validator takes its commission, and the rest is split pro rata between its self-stake and its delegators.
- A node can run a validator from its own key (`VOXIAN_VALIDATOR_SEED`). The in-browser node can promote the browser wallet to a live validator.
- **Done when:** a newly registered validator enters the schedule in the next epoch, rewards reach delegators, unbonded VOX is released on time, and supply stays conserved.

## Phase 5: Slashing and accountability
- Equivocation (two conflicting signed votes for the same kind, height and round) is detected automatically and submitted as an `evidence` transaction.
  - `SLASH_BPS` of the offender's bonded stake (self and delegated, pro rata) is taken: 10% goes to the reporter and the rest is **burned**.
  - Stake that started unbonding at or after the offence is slashed too.
  - The offender is **jailed** for `JAIL_EPOCHS` (2), then may `unjail`. Each piece of evidence counts only once.
  - Votes name their parent block, so votes from another chain instance can't be replayed as evidence.
- Uptime accounting: each validator's produced and missed leader slots, shown in the explorer.
- **Done when:** a forged double-vote is slashed exactly once, burned VOX shows in the supply, and a jailed validator receives no slots.

## Audit outcome (fixed before shipping)
Two independent reviews (consensus, and staking economics) ran against the finished code. Every confirmed finding was fixed and has a regression test (`test/audit.test.js`):

| Finding | Severity | Fix |
|---|---|---|
| Two blocks at one height could each reach 2/3 of a *different* epoch's validator set | Critical | All votes at a height are weighted by a single snapshot (`weightSnapshot`) |
| A leader could claim far-future slots cheaply (capped PoH) and drag peers' rounds forward | High | Full PoH for every skipped slot, at most 120 skipped; rounds advance only by local clock or > 1/3 of stake (f+1 rule); proposals more than one round ahead are rejected |
| CPU amplification: many signed junk proposals, and certificate-less commits verified in full | High | One proposal per round is validated; the commit certificate is checked before PoH and proofs; PoH hashing is about 7.6× faster (SHA-256 midstate) |
| Unstaking right before evidence escaped the slash | High | Unbonding stake from the offence height onward is slashed |
| Jailing everyone halted the chain permanently; old votes from a wiped devnet could serve as evidence | High | Timed jail plus `unjail`; the active set never goes empty; votes are bound to the parent hash |
| Leader-schedule seed could be ground through the anchor block's hash | Medium | Seeds chain epoch to epoch and only mix in height and slot |
| Signing log and lock not durable across a crash or restart | Medium | fsync'd writes; the lock and valid-block state are persisted |
| Votes from non-validators stored without limit; unauthenticated peer announcements | Medium | Votes are only accepted from the height's validator set; hellos must be signed by an active validator; failing dynamic peers are evicted; sync falls back to the next peer |
| Delegation spam slowed every block; self-reporting cut the penalty; released stake wasn't spendable until the next block; misleading uptime | Low | Max 1,000 delegators per validator and a 10 VOX minimum; self-reports earn no reward; pending state enters the epoch; missed slots are only counted once a heartbeat was due |

## Delivery
All five phases ship together on the devnet branch. Validation:
- Unit, cluster and end-to-end tests: x402, ZK and agent flows must still pass.
- A live multi-process cluster run.
- Browser checks in full-node and in-browser modes.
- An independent audit pass, with fixes.

Devnet parameters (tick 100 ms, 200 hashes per tick, 1 s slots, 2 min epochs) are for demonstration and are **not final**.
