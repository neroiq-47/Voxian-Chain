# Voxian ⚡

**Privacy meets the autonomous economy.**

Voxian is a proposed Layer 1 blockchain that combines **zero-knowledge (ZK) privacy** with **x402 payments**, so people, apps and AI agents can pay for digital services privately, securely and automatically.

This repository is a working **devnet MVP**. It has a real chain secured by a **Proof of History** clock and open **Proof of Stake** with BFT finality and slashing, real ZK proofs, real HTTP 402 payments and an autonomous agent. The same code runs as a Node.js full node or entirely inside a browser tab, which is how the GitHub Pages demo works.

| | |
|---|---|
| Token | **VOX** |
| Max supply | **210,000,000 VOX** (hard cap enforced in consensus) |
| Decimals | **8**, smallest unit 0.00000001 VOX |
| Network | `voxian-devnet-1` |

> ⚠️ Devnet demo. Tokens have no value, and the cryptography is hand-written and **unaudited**. As the white paper says, Voxian is a proposed project. Its allocation, issuance and fee rules are not final.

---

## Quick start

```bash
npm start            # standalone full node + web app on http://localhost:8402  (Node ≥ 20, zero dependencies)
npm run cluster      # 4-validator BFT cluster, one process per validator (ports 8402-8405)
npm test             # crypto, PoH, consensus, staking/slashing, ZK and end-to-end x402 tests
npm run agent        # (with the node running) an AI agent funds itself and buys data over x402
npm run agent -- "what is the BTC price?" --scheme zk-shielded
npm run build:pages  # static build in dist/ (the app boots an in-browser node when no backend exists)
```

Environment variables:
- `PORT` (default 8402), `HOST`, `VOXIAN_DATA_DIR` (default `./data`), `VOXIAN_RESET=1` to wipe the chain.
- `VOXIAN_DEVNET_SECRET` derives the validator, faucet and facilitator keys.
- `VOXIAN_VALIDATORS`: `all` (standalone, the default), `none` (observer/RPC node), or names such as `aurora,borealis`.
- `VOXIAN_VALIDATOR_SEED`: a 64-hex wallet seed. The node also runs that key as a validator, so a validator registered on-chain with `validator_register` (for example from the web wallet) can propose and vote. Use *Wallet → Show seed* to get it.
- `VOXIAN_PEERS`: comma-separated peer node URLs.
- `VOXIAN_NODE_NAME`: a log label.

## What's inside

```
src/crypto/     SHA-256, secp256k1 (Jacobian, fixed-base tables), Schnorr signatures (pure JS, isomorphic)
src/zk/         Pedersen commitments, ZK range proofs, stealth addresses, shielded notes
src/chain/      params, tx types, state transition, blocks, mempool, PoH recorder (poh.js), staking & slashing (staking.js), BFT consensus
src/x402/       x402 wire protocol, facilitator (verify/settle), paying client
src/api/        transport-agnostic router + demo paid APIs
src/node/       Node HTTP server, in-browser node, composition
src/wallet/     non-custodial wallet (public + shielded) and API client
src/agent/      autonomous budgeted agent
web/            single-page app: overview, wallet, x402 market, AI agent, staking, explorer
```

### Layer 1
- Blocks are linked by hash, carry a Merkle transaction root (domain-separated, committing to the tx count), and are signed by the proposer (Schnorr over secp256k1).
- Each block also carries a **Proof of History** segment and commits to its `slot`, `pohTicks` and `pohEnd` in the header.
- Blocks come every ~2 s while transactions are waiting, plus a heartbeat block every 10 s when idle.
- Issuance is 50 VOX per block, halving every 2.1M blocks, and is capped at 210M VOX. The devnet genesis allocates 5% to the faucet and stakes 1M VOX across the four genesis validators.
- Consensus checks a supply invariant on every query: `issued = circulating + staked + shielded pool + burned`. Slashed VOX is burned, never re-minted.
- Blocks are stored in an append-only `data/blocks.jsonl` and fully replayed and validated on restart.

The full design and its five phases are in [docs/POH_POS_UPGRADE.md](docs/POH_POS_UPGRADE.md). All parameters below are devnet-sized and **not final**.

### Proof of History clock (slots, epochs, leader schedule)
`src/chain/poh.js` is a sequential SHA-256 hash chain: `next = H("Voxian/poh", prev)`, 200 hashes per tick, one tick every ~100 ms. Every transaction hash is mixed in as `H("Voxian/poh-mix", prev, txHash)`, in block order.

- Validators recompute each block's PoH from the parent's `pohEnd`. A forged, truncated or reordered PoH, or a mix-in that doesn't match the tx list, rejects the block. Each confirmed tx therefore has a verifiable position (`slot`, `pohIndex`), which gives x402 payments and agents a provable ordering.
- **Slots and epochs:** 10 ticks make a 1 s slot, and 120 slots make a 2 min epoch. Time is counted in PoH ticks, not wall clocks: a block that skips slots must carry enough ticks to prove that every skipped slot elapsed (at most 120 slots per block), so a leader can only claim a later slot by doing the hashing.
- **Leader schedule:** fixed per epoch, stake-weighted, built from a validator-set snapshot taken at the epoch boundary and seeded by the anchor block's hash. Each leader holds 2 consecutive slots. Every node computes the same schedule.

### BFT finality (prevote, precommit, locking)
`src/chain/consensus.js` runs Tendermint-style rounds. Round `r` at a height is slot `parentSlot + 1 + r`, led by that slot's scheduled leader.

1. **Propose:** the leader proposes its `validValue` (the newest block that reached a polka) or builds a new block, signs it and gossips it.
2. **Prevote:** each validator re-executes the block (PoH, signatures, ZK proofs, balances) and prevotes for it, unless it is locked on another block. It unlocks only on a later polka.
3. **Precommit:** after prevotes from more than 2/3 of stake (a polka), a validator precommits and locks on that block.
4. **Commit:** precommits from more than 2/3 of stake in one round commit the block. The certificate is stored in the block, and committed blocks are final, so there are no reorgs. Every node, including a syncing one, rejects a block without a valid certificate.
5. **Catch-up:** a restarted or partitioned node fetches committed blocks from peers (`/p2p/blocks`) and verifies each certificate.

Vote power comes from the epoch snapshot for the block's slot. A **persistent signing log** stops a validator from signing two different things for the same (kind, height, round), even across restarts. Re-proposing the `validRound` block lets split votes resolve in later rounds.

With the four genesis validators (30/25/25/20%), any 3 exceed 2/3, so the cluster keeps finalizing with **one validator down**. With two down it **halts safely** (no blocks, no forks) and resumes once a quorum returns. Nodes talk over `POST /p2p/{tx,proposal,vote,commit}`, `GET /p2p/status` and `GET /p2p/blocks`.

`npm start` runs the same engine in standalone mode (all four genesis validator keys on one node). The in-browser node does the same. `npm run cluster` runs one process per validator. To watch fault tolerance, kill one node, then kill a second, then restart them.

### Open Proof of Stake
Anyone with VOX can secure the network:

| Transaction | What it does |
|---|---|
| `validator_register` | registers a validator with a name, a commission (0–50%) and a self-stake of at least **10,000 VOX** |
| `stake` | delegates VOX to a validator |
| `unstake` | starts unbonding; the VOX returns to the delegator after **2 epochs** and earns nothing meanwhile |

- The **active set** is recomputed at every epoch boundary: validators that are not jailed, meet the minimum self-stake, and are in the top **16** by bonded stake (self + delegated). Changes take effect at the next epoch.
- **Rewards:** each block's reward plus fees go to its leader's pool. The validator takes its commission, and the rest is split pro rata between its self-stake and its delegators.
- **Running a validator:** register from the web wallet (*Staking* tab), then either run a node with `VOXIAN_VALIDATOR_SEED=<your wallet seed>`, or, on the in-browser node, click *Run my validator in this browser*.
- **Uptime:** each validator's produced and missed leader slots are tracked and shown on the *Staking* tab.

### Slashing
- Equivocation (two conflicting signed votes for the same kind, height and round) is detected automatically and submitted as an `evidence` transaction.
- **5%** of the offender's bonded stake (self and delegated, pro rata) is taken. **10%** of that goes to the reporter, and the rest is **burned**.
- The offender is **jailed** and leaves the next epoch's schedule. After 2 epochs it may send an `unjail` transaction. Each piece of evidence counts only once.

### Remaining devnet limitations
- The four genesis validator keys, the faucet and the facilitator derive from a shared devnet secret (`VOXIAN_DEVNET_SECRET`).
- The cryptography is hand-written and unaudited.
- The PoH hash rate is devnet-sized (200 hashes per tick, so browsers can verify it). PoH is a verifiable ordering and elapsed-hash proof, not a calibrated wall clock.
- Slashing evidence covers vote equivocation only. Double proposals are not slashed.

### Zero-knowledge privacy (shielded pool)
| Transaction | What it does | What the chain sees |
|---|---|---|
| `shield` | public VOX → confidential note | the amount, plus a proof that the commitment opens to it |
| `shielded` | note(s) → note(s) and/or a public address | one-time keys, commitments and proofs; **no amounts, no recipients** |

- **Pedersen commitments:** `C = v·H + r·G`. `H` is derived by hash-to-curve, so nobody knows `log_G(H)`.
- **Range proofs:** each output proves `0 ≤ v < 2^55` in zero knowledge, using bit decomposition and Cramer–Damgård–Schoenmakers OR-proofs with Fiat–Shamir. This prevents "negative amount" inflation.
- **Balance proof:** a Schnorr signature with key `Σr_in − Σr_out` over the excess point `ΣC_in − ΣC_out − (fee + public)·H`. It proves inputs equal outputs without revealing any amount.
- **Stealth outputs:** `P = Hs(r·A)·G + B`, so each note is unlinkable to the recipient's z-address. Only the view key can find it, and the amount is encrypted to the recipient.
- **Spend authorization:** a signature by the note's one-time key. Spent notes are tracked to prevent double spends.

Known limitation: inputs reference notes by id, so the spend graph is visible (amounts and recipients are not). A production design would use ring signatures or a SNARK membership proof.

### x402 payments
Every paid API answers `402 Payment Required` with two payment options (x402 v1 format: `accepts[]`, then an `X-PAYMENT` header, then `X-PAYMENT-RESPONSE`):

- **`exact`:** the payer signs a transfer *authorization* (`from`, `to`, `value`, validity window, random nonce, `resource`). The facilitator verifies it, relays it as an `auth_transfer` and pays the gas. Authorizations cannot be replayed (the nonce is consumed) or redirected (the signature covers payee and resource).
- **`zk-shielded`:** the payer builds a confidential transaction to the service's z-address with `ref = "x402:<resource>"`, and discloses that output's tx secret **to the facilitator only**. The facilitator checks that the output really pays the required amount to the payee, then settles it. On-chain, nobody learns who paid or how much. The service operator sees its private revenue with its view key.

The facilitator is exposed at `GET /x402/supported`, `POST /x402/verify` and `POST /x402/settle`. Demo services: price oracle, AI sentiment, AI summarizer, chain insights and a randomness beacon. All are local, so the demo works offline.

### AI agent
`VoxAgent` discovers services from `/api/services`, plans from a goal, and pays per call within a budget. It picks private payments automatically when it holds shielded funds. The planner is rule-based so no LLM key is needed; replace `plan()` with an LLM call to make it a full LLM agent.

## API
`GET /api/info` · `/api/stats` · `/api/blocks?limit=` · `/api/blocks/:height|hash` · `/api/tx/:hash` · `/api/accounts/:address` · `/api/mempool` · `/api/notes` · `/api/services` · `/api/services/revenue`
Consensus: `GET /api/consensus` (round, slot, epoch, lock, last commit, peers) · `/api/poh` (live PoH clock, slot/epoch progress, upcoming leaders, recent blocks) · `/api/staking` (bonded, unbonding, burned, active set, validators, slashes, evidence) · `/api/staking/:address` (delegations, unbonding entries, own validator)
`POST /api/tx` (signed transaction) · `POST /api/faucet {address}` (1,000 VOX, 30 s cooldown)
Paid routes: `/paid/oracle/price`, `/paid/ai/sentiment`, `/paid/ai/summarize`, `/paid/data/chain-insights`, `/paid/random`

## Deploying the demo
- **GitHub Pages (no server):** enable *Settings → Pages → Source: GitHub Actions*. Pushing to `main` then runs `.github/workflows/pages.yml`. Every visitor gets their own in-browser devnet, saved in localStorage.
- **Full node:** any Node 20+ host. Run `npm start` and expose the port. The web app detects the backend automatically.

## Roadmap (from the white paper)
1. Finalize the technical design
2. Build a working payment proof of concept ✅ *(this devnet)*
3. Launch a public testnet. Done on the devnet so far: Proof of History, open Proof of Stake, persistent signing log and slashing ([docs/POH_POS_UPGRADE.md](docs/POH_POS_UPGRADE.md)). Still to do: independently generated genesis validator keys and tuned parameters.
4. Complete independent security reviews
5. Only then assess mainnet readiness

## Support Voxian ❤️
Voxian is built in the open and funded through **[GitHub Sponsors](https://github.com/sponsors/neroiq-47)**. The tiers range from budget-friendly to enterprise:

| Tier | Monthly | Highlights |
|---|---:|---|
| ☕ Supporter | $5 | Sponsor badge, thanks in the monthly update |
| 🛠 Builder | $25 | Name in the README, monthly progress update |
| 🤖 Agent Pioneer | $100 | Priority issue triage, early testnet news |
| ⛓️ Validator Partner | $500 | Logo in the README and web app, quarterly roadmap call |
| 🏢 Enterprise | $2,500 | 2 h a month of x402 / shielded-payment integration support |
| 🏛 Enterprise Partner | $10,000 | Top logo placement, 8 h a month of support, named funder of the security review |

One-time gifts of any amount are welcome too. See [docs/SPONSORS.md](docs/SPONSORS.md) for the full tier details.

**Donate with crypto (Solana mainnet only):** `5g4xQALSN81J1EseRkkb4GGWJiLAJCPRnoqUeB5jYWkk`

Funding pays for:
1. Independent security reviews (the white paper's step before any mainnet decision).
2. Testnet infrastructure.
3. Development time.

> Sponsorship is a donation to the project's development. It is not an investment, and it does not buy, reserve or promise any VOX tokens. VOX is a proposed token and the devnet tokens have no value.

## License
MIT
