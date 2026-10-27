# Bouncer — On-Chain Payments Firewall for Autonomous AI Agents

> A smart contract + agent runtime that lets AI agents spend money safely on NEAR.
> Per-tx caps, payee allowlists, daily limits, and a structural **1-yoctoNEAR escalation guard** that makes
> policy immutable to stolen function-call keys. Failed transfers auto-refund.

**Live on NEAR testnet:** [`bouncer-2dcd4e.testnet`](https://testnet.nearblocks.io/address/bouncer-2dcd4e.testnet?tab=receipts)
**Pull Request:** [#3](https://github.com/abdullahimujeeb05-stack/Bouncer/pull/3)

---

## The problem

When you give an AI agent a wallet so it can buy compute, storage, API credits, and data on your behalf,
you hand it the ability to empty your account. Existing wallets are all-or-nothing: a key that can sign
a $0.01 API call can also drain the vault to an attacker.

Function-call keys on NEAR can restrict *which contract* an agent can call — but they can't cap how much
it spends per transaction, limit payees, or prevent the agent from calling an "approve infinite allowance"
method by accident. A compromised agent (prompt injection, vendor supply-chain, or stolen key) is game over.

## How Bouncer solves it

The agent never holds value. Value sits behind a Bouncer smart contract whose policy is set once by the
owner with a **full-access key**, and every mutation of that policy requires exactly **1 yoctoNEAR** of
attached deposit — an operation that is *protocol-level impossible* from a function-call access key
(NEAR rejects `DepositWithFunctionCall` before any contract code runs).

Every agent-side spend goes through `execute(policy_id, payee, amount, memo)` and must clear:

1. **Per-tx cap** — amount ≤ policy cap, else `"BLOCKED: amount exceeds per-tx cap"`
2. **Payee allowlist** — payee must be on the policy's allowlist (if allowlist non-empty)
3. **Vault balance** — vault must hold enough of the policy's FT
4. **Refund callback** — if the downstream `ft_transfer` fails, the vault balance is restored automatically

The happy path: a compliant payment under cap to an approved payee with a funded vault goes through
in a single cross-contract call, the vendor receives FTs, and an on-chain receipt is logged.

## Tracks (NEAR Hackathon — $250k prize pool)

Bouncer is built for **Autonomous Business**, **AI Security & Defense**, and **Agent Economy** as the
three primary tracks. The multi-resource architecture extends naturally into **Real-World Money**,
**Unstoppable DeFi** (NEAR Intents solver picks the cheapest vendor), and **AI Swarms** (multiple
agents sharing a vault with per-agent sub-policies).

- 🔒 **Autonomous Business** — AI manages procurement and treasury within human-set constraints
- 🔒 **AI Security & Defense** — spending limits + wallet safeguards + escalation-proof policy
- 🔒 **Agent Economy** — agents earn, spend, negotiate, and pay vendors autonomously
- 🟡 **Real-World Money** — invoices, receipts, stablecoin policies (USDC)
- 🟡 **Unstoppable DeFi** — NEAR Intents integration for best-price vendor routing
- 🟡 **AI Swarms** — per-agent sub-policies over shared vault
- 🔵 **Privacy & Private AI** (stretch) — TEE-based signing via NEAR AI Cloud

## NEAR primitives used

| Primitive | Where | Why |
|---|---|---|
| **Function-call access keys** | Agent key has `ft_transfer_call`/`execute` allowance only | Limits what the agent can do at the protocol layer |
| **1-yocto deposit guard** | `set_policy`, `allow_payee`, `withdraw`, `execute` | Converts "owner-only" into a protocol invariant (FC keys can't attach NEAR) |
| **NEP-141 Fungible Tokens** | Vault holds wNEAR + USDC (and arbitrary FTs) | Multi-resource payments; real value, not a toy |
| **Promise + cross-contract callbacks** | `execute → ft_transfer → after_execute` | Auto-refund the vault on transfer failure |
| **NEP-141 `ft_on_transfer`** | Vault funding | Users/agents fund the vault via a normal `ft_transfer_call` |
| **Sub-accounts** | Per-test vendor accounts (e.g. `vendor-xxx.testnet`) | Real vendor identities for multi-resource demo |
| **near-api-js** | Deploy/fund/pay scripts | One-command Codespaces flow — no wallet login, no faucet site |

The contract source is 182 lines of Rust in `bouncer/contracts/bouncer/src/lib.rs`. No complex frameworks.
The direct `panic_utf8` host import guarantees readable on-chain error strings (near-sdk 5.x's default
panic machinery strips them to "unreachable" traps under LTO).

## Quickstart — reproduce from Codespaces (5 minutes, no wallet, no faucet site)

You need: GitHub Codespaces (free), a browser. No Rust toolchain needed — CI builds the wasm.

```sh
# 1. Open this repo in Codespaces from github.com/abdullahimujeeb05-stack/Bouncer
#    (Code → Codespaces → Create codespace on main)
#
# 2. Inside the Codespaces terminal:
cd /workspaces/Bouncer/bouncer && npm install near-api-js && cd ..
node bouncer/deploy.mjs
```

**What happens:** `deploy.mjs` calls the NEAR testnet helper server-side to create a funded subaccount
(named `bouncer-XXXXXX.testnet`), saves the key to `~/.near-credentials/testnet/`, deploys `bouncer.wasm`,
and calls `new({owner: ...})`.

**Expected output (15s):**
```
==> Creating funded testnet account: bouncer-a1b2c3.testnet
    helper ok: tx ...
==> Deploying bouncer.wasm (188661 bytes)...
    deploy tx: ...
==> Initializing ...
    init tx: ...
=== CONTRACT DEPLOYED ===
Account:   bouncer-a1b2c3.testnet
Explorer:  https://testnet.nearblocks.io/address/bouncer-a1b2c3.testnet
```

## Step-by-step demo ("do X, see Y")

All scripts work with the repo as-cloned. Run them in order from the repo root.

### Step 1 — Set policy + allowlist, run policy checks (read-only views)
```sh
NODE_OPTIONS="--require=./bouncer/quiet.cjs" node bouncer/redeploy.mjs
```
**See:**
- ✅ Banner: *"BOUNCER — on-chain AI-agent payments firewall (testnet)"*
- ✅ Two on-chain setup txs (set_policy + allowlist), each signed with 1 yocto
- ❌ `insufficient vault balance (have 0, need 3000000)` — view correctly reports empty vault
- ❌ `BLOCKED: amount 10000000 exceeds per-tx cap 5000000` — per-tx cap enforced
- ❌ `BLOCKED: payee attacker.testnet not in allowlist` — allowlist enforced
- ❌ `ESCALATION BLOCKED: requires exactly 1 yoctoNEAR (owner-only guard)` — 0-deposit rejection
- ❌ `ESCALATION BLOCKED: caller is not owner` — non-owner rejection
- ❌ `REJECTED ON-CHAIN (expected): Smart contract panicked: ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR` — real tx, blockchain rejects

### Step 2 — End-to-end happy path (fund vault with wNEAR, pay vendor)
```sh
NODE_OPTIONS="--require=./bouncer/quiet.cjs" node bouncer/fund-and-pay.mjs
```
**See:**
- ✅ Vendor sub-account created under your bouncer contract
- ✅ Storage deposit on `wrap.testnet` (NEP-141 registration for vendor)
- ✅ 1 NEAR wrapped into wNEAR via `wrap.testnet.near_deposit()`
- ✅ wNEAR policy set (2 NEAR/tx cap), vendor allowlisted
- ✅ 1 wNEAR sent into vault via `ft_transfer_call` (triggers `ft_on_transfer`)
- 🎯 **0.1 wNEAR payment executed to vendor** via `execute()` (the money actually moves)
- ✅ Final balances: vendor = 0.1 wNEAR, vault = 0.9 wNEAR
- ✅ Explorer link to the paid transaction

### Step 3 — Click into any tx URL
**Do:** Open the `paid` tx hash on testnet.nearblocks.io
**See:** Receipt showing `ft_transfer` from Bouncer to vendor, with memo `compute:1h`.
The vendor's `ft_balance_of` view returns 0.1 wNEAR.

The payment path is real on-chain value transfer, not a mock.

## Architecture

```
            ┌────────────────────────────────────────────┐
            │   AI agent (runs anywhere: TEE, server,    │
            │   browser extension, mobile)               │
            │   signs execute(policy, payee, amount)     │
            │   with a FUNCTION-CALL KEY that can ONLY:  │
            │     • call bouncer.execute()              │
            │     • attach ≤ 1 yoctoNEAR                │
            └─────────────┬──────────────────────────────┘
                          │ function call
                          ▼
            ┌────────────────────────────────────────────┐
            │            BOUNCER (on-chain)              │
            │  ┌─ set_policy / allow_payee   ◄── owner   │  ◄─ requires 1 yocto
            │  │  (full-access key only)                 │     (FC keys cannot)
            │  ├─ execute(policy,payee,amount):          │
            │  │   1. per-tx cap check                   │
            │  │   2. payee allowlist check              │
            │  │   3. vault balance check                │
            │  │   4. debit vault                        │
            │  │   5. ft_transfer → payee                │
            │  │   6. after_execute → refund on failure  │
            │  └─ withdraw (owner only, 1-yocto guard)   │
            └─────────────┬──────────────────────────────┘
                          │ ft_transfer
                          ▼
            ┌────────────────────────────────────────────┐
            │  wNEAR / USDC / any NEP-141 token          │
            │  → vendor sub-account or external address  │
            └────────────────────────────────────────────┘
```

The 1-yocto guard is the security primitive, not just a check: because function-call keys physically cannot
attach any deposit (nearcore rejects the action at the protocol layer), an agent cannot call `set_policy`
to raise its own cap or add a new payee — even if you give the agent a key it cannot use to escalate.

## Files

```
bouncer/
├── contracts/bouncer/src/lib.rs   # 182-line contract (caps + allowlist + refunds + 1-yocto guard)
├── contracts/bouncer/Cargo.toml   # near-sdk 5.14, opt-level=s, lto=false (preserves panic strings)
├── deploy.mjs                     # Creates funded testnet account via helper, deploys, inits
├── redeploy.mjs                   # Upgrades code + runs setup + 5 view checks + on-chain escalation
├── fund-and-pay.mjs               # Happy path: wrap NEAR → fund vault → pay vendor end-to-end
├── quiet.cjs                      # NODE_OPTIONS preload to silence near-api-js deprecation noise
└── packages/                      # (future) policy engine, agent runtime, intents solver
bouncer.wasm                       # CI-built contract artifact (wasm-opt -O1, panic strings intact)
.github/workflows/ci.yml           # JS tests + wasm build + shrink + bot-commit bouncer.wasm (green)
```

## Running the tests

```sh
cd bouncer && npm install && npm test
```

Tests cover policy key composition, cap math, and the allowlist logic in `packages/policy/`.

## What's next before submission deadline (Nov 13)

- [ ] Daily rate limits (24-hour bucketed, same 1-yocto-guarded setter)
- [ ] Invoices / receipt NEP-171 NFT per successful payment
- [ ] NEAR Intents solver: agent gets quotes from ≥3 mock vendors, Bouncer pays the cheapest
- [ ] USDC.fakes.testnet policy alongside wNEAR for multi-resource demo
- [ ] Per-agent sub-policies (swarm use case)
- [ ] TEE-based agent signer (NEAR AI Cloud) — stretch

## License

MIT. Built solo for the NEAR Hackathon 2026.
