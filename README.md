# Voxian ⚡

**Privacy meets the autonomous economy.**

Voxian is a proposed Layer 1 blockchain that combines **zero-knowledge (ZK) privacy** with **x402 payments**, so people, apps and AI agents can pay for digital services privately, securely and automatically.

This repository is a working **devnet MVP**. It has a real chain, real ZK proofs, real HTTP 402 payments and an autonomous agent. The same code runs as a Node.js full node or entirely inside a browser tab, which is how the GitHub Pages demo works.

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
npm start            # full node + web app on http://localhost:8402  (Node ≥ 20, zero dependencies)
npm test             # crypto, consensus, ZK and end-to-end x402 tests
npm run agent        # (with the node running) an AI agent funds itself and buys data over x402
npm run agent -- "what is the BTC price?" --scheme zk-shielded
npm run build:pages  # static build in dist/ (the app boots an in-browser node when no backend exists)
```

Environment variables: `PORT` (8402), `HOST`, `VOXIAN_DATA_DIR` (`./data`), `VOXIAN_DEVNET_SECRET` (derives the validator, faucet and facilitator keys), and `VOXIAN_RESET=1` to wipe the chain.

## What's inside

```
src/crypto/     SHA-256, secp256k1 (Jacobian, fixed-base tables), Schnorr signatures (pure JS, isomorphic)
src/zk/         Pedersen commitments, ZK range proofs, stealth addresses, shielded notes
src/chain/      params, tx types, state transition, blocks, mempool, stake-weighted PoS proposer
src/x402/       x402 wire protocol, facilitator (verify/settle), paying client
src/api/        transport-agnostic router + demo paid APIs
src/node/       Node HTTP server, in-browser node, composition
src/wallet/     non-custodial wallet (public + shielded) and API client
src/agent/      autonomous budgeted agent
web/            single-page app: overview, wallet, x402 market, AI agent, explorer
```

### Layer 1
- Blocks are linked by hash, carry a Merkle transaction root, and are signed by the proposer (Schnorr over secp256k1).
- A stake-weighted, deterministic proposer is chosen from 3 devnet validators.
- Blocks come every ~2 s while transactions are waiting, plus a heartbeat block every 10 s.
- Issuance is 50 VOX per block, halving every 2.1M blocks, and is capped at 210M VOX. The devnet genesis allocates 5% to the faucet and stakes 1M VOX across the validators.
- Consensus checks a supply invariant on every query: `issued = circulating + staked + shielded pool`.
- Blocks are stored in an append-only `data/blocks.jsonl` and fully replayed and validated on restart.

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
`POST /api/tx` (signed transaction) · `POST /api/faucet {address}` (1,000 VOX, 30 s cooldown)
Paid routes: `/paid/oracle/price`, `/paid/ai/sentiment`, `/paid/ai/summarize`, `/paid/data/chain-insights`, `/paid/random`

## Deploying the demo
- **GitHub Pages (no server):** enable *Settings → Pages → Source: GitHub Actions*. Pushing to `main` then runs `.github/workflows/pages.yml`. Every visitor gets their own in-browser devnet, saved in localStorage.
- **Full node:** any Node 20+ host. Run `npm start` and expose the port. The web app detects the backend automatically.

## Roadmap (from the white paper)
1. Finalize the technical design
2. Build a working payment proof of concept ✅ *(this devnet)*
3. Launch a testnet (multi-node P2P networking, real validator set)
4. Complete independent security reviews
5. Only then assess mainnet readiness

## License
MIT
