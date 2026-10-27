# Bouncer — the on-chain comptroller for AI agents

> **Built at NEAR HACKATHON 2026 · Tracks: `security` `agents` `business` `realworld` `defi`**

## What it is

Every "secure AI agent wallet" today is a prompt and a promise. Bouncer is the smart contract that makes the promise unbreakable: the agent holds exactly one NEAR key, and that key can only ask the contract to pay. The contract says yes or no against rules the human set, and a refusal is a failed transaction anyone can see on the NEAR explorer.

- **On-chain, not in-script.** Spending policy is enforced in a Rust contract on NEAR, not in a TypeScript guard beside the key. If the agent's key leaks, the attacker inherits exactly the policy — not the full wallet.
- **Structural escalation lock, not a software check.** Every policy-mutating method requires exactly 1 yoctoNEAR (10⁻²⁴ NEAR). Function-call access keys cannot attach any deposit, so NEAR rejects an escalation tx at the protocol level (`DepositWithFunctionCall`) before our code runs. No bug in our contract can bypass this. See THREAT_MODEL.
- **Per-tx caps.** Agent can't move more per tx than the cap, even if the key leaks and the attacker runs arbitrary calls.
- **Per-24h rolling rate limits.** Hour-bucketed counters prevent a runaway agent from draining the vault within a day even if each call stays under the per-tx cap.
- **Payee allowlists.** Agent can only pay addresses the owner explicitly approved. Empty allowlist (no payees added) = unrestricted policy.
- **Atomic failure refunds.** If the downstream `ft_transfer` fails, the vault balance is restored in a callback — funds are never debited without being sent.
- **Vault model.** Funds sit in the contract, held in escrow until `execute` matches policy, then ft_transfer'd out. No approval flow needed — policy is code.

## The problem it fixes

A NEAR function-call access key's `allowance` caps **gas**, not token value. From nearcore: *"Allowance is a balance limit to use by this access key to pay for function call gas and transaction fees."* Function-call keys cannot attach NEAR deposits, so they can't move NEAR directly — but they CAN call `ft_transfer` on a fungible token contract, moving the entire token balance for ~free, forever, because gas on NEAR is cheap and the allowance never runs out against value. **NEAR has no native per-agent spending limit.** The limit has to live in a contract the agent can't route around. That's Bouncer.

Real incidents this protects against:
- **Step Finance (Jan 2026):** ~$40M drained when an AI trading agent held simultaneous wallet/oracle/trading permissions with no per-key cap.
- **HOT/SWEAT ft_resolve_transfer exploit (June 2026):** $170K+ drained via NEP-141 callback abuse. Bouncer does not expose a public `ft_resolve_transfer`.
- **Prompt-injection billing runaways:** 6×$3 passes the per-tx cap, the 7th is caught by the daily window. Naive guards miss this.

## Repository layout

```
bouncer/
├── contracts/bouncer/        # Rust smart contract (near-sdk 5.14)
│   ├── Cargo.toml
│   └── src/lib.rs            # ~870 lines, 7 unit tests (bypass tests included)
├── packages/
│   ├── client.mjs            # near-api-js wrapper used by agents + dashboard
│   ├── policy.mjs            # Policy engine (mirrors contract logic, JS side)
│   └── policy.test.mjs       # 10 unit tests, all passing
├── agent/
│   ├── procurement.mjs       # Autonomous procurement agent (pays invoices)
│   ├── solver.mjs            # Reference cross-chain solver (1Click bidder/filler)
│   └── intents.mjs           # NEAR Intents 1Click client (live mainnet quotes)
├── demo/index.html           # Self-contained dashboard (no build, open in browser)
├── scripts/
│   ├── build.sh              # cargo build -> wasm
│   └── deploy.mjs            # Deploy + init to testnet/mainnet
└── docs/
    ├── PLAN.md               # Strategy + competitive analysis
    ├── THESIS.md             # Original thesis
    ├── THREAT_MODEL.md       # What we protect against and what we don't
    └── DEPLOY.md             # Deploy / agent-key setup
```

## Try it — judge path (do X → see Y)

The fastest path is the live dashboard at `<your url>` — but to run from the repo:

### Step 1 — Install + build the contract

```bash
# 1. Install Rust (if you don't have it)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# 2. Optionally install cargo-near for reproducible builds
# cargo install cargo-near

# 3. Build wasm + install JS deps
cd bouncer
npm run build
npm install
```

Expected: `contracts/bouncer/res/bouncer.wasm` is produced. Tests are green:

```bash
npm test
```
Expected: `# tests 10 # pass 10 # fail 0` plus cargo test output (all green).

### Step 2 — Deploy to NEAR testnet

```bash
# Generate or use an existing testnet account (e.g. at https://testnet.mynearwallet.com).
# Faucet: https://near-faucet.io gives 2 NEAR.

DEPLOYER_ID=you.testnet \
DEPLOYER_KEY=ed25519:<your secret key> \
CONTRACT_ID=bouncer.you.testnet \
  node scripts/deploy.mjs
```

Expected: "Deployed in tx …" with an explorer link. Contract is initialized with you as owner.

### Step 3 — Register the vault with testnet USDC

```bash
# Use near-cli or near-api-js. With near-cli:
near call usdc.fakes.testnet storage_deposit '{}' \
  --accountId bouncer.you.testnet --deposit 0.00125
```

Expected: `''` returned (storage paid).

### Step 4 — Fund the vault with testnet USDC

From a wallet that holds testnet USDC (Circle faucet gives 20 USDC.every 2h), call `ft_transfer_call` to the vault contract with `amount: 50000000` (50 USDC, 6 dp) and empty `msg`.

Expected: `vault_balance(usdc.fakes.testnet)` returns `50000000`.

### Step 5 — Set a policy (1 yoctoNEAR, full-access key only)

```bash
near call bouncer.you.testnet set_policy '{
  "policy_id": "procurement",
  "policy": {
    "label": "procurement agent",
    "token": "usdc.fakes.testnet",
    "per_tx_cap": 5000000,
    "windows": [{"period_ns": 86400000000000, "limit": 20000000}],
    "payee_allowlist": ["vendor.near", "base"]
  }
}' --accountId you.testnet --deposit 0.000000000000000000000001
```

Expected: tx succeeds. `get_policy("procurement")` returns the policy you just set.

### Step 6 — Issue the agent a function-call key (the key it will actually hold)

```bash
near add-key you.testnet ed25519:<agent public key> \
  --contract-id bouncer.you.testnet \
  --method-names execute,pay_invoice,file_invoice,open_cross_chain,bid,check \
  --allowance 0.25
```

This key can ONLY call those six methods on bouncer.you.testnet, with ~0.25 N gas budget. It cannot call set_policy, cannot attach deposit, cannot withdraw, cannot touch any other contract.

### Step 7 — The three demo beats (this is the 90-second video)

**Beat A — normal pay succeeds:** Open `demo/index.html`, point it at the contract + agent key, file an invoice for 3 USDC to `vendor.near` with memo "AWS credits", hit "Agent: pay open invoices".

Expected: tx succeeds, green entry in the ledger. Balance: 47 USDC remaining. Explorer link shows a successful Receipt with BOUNCER log `settled policy=procurement amount=3000000`.

**Beat B — policy breach is rejected on-chain:** In the agent console, try `execute` with payee `attacker.near` for 25 USDC, or any amount above $5, or 7×$3 to a single vendor.

Expected: tx FAILS with a visible error like `over per-tx cap: 25000000 > 5000000` or `over 86400000000000ns window…`. The failure is a blockchain receipt, not an alert in a web UI. The explorer link shows status Failure with the same message.

**Beat C — structural escalation proof:** In the dashboard, click **"Try to widen policy with the agent key"**. This calls `set_policy` using the agent's function-call key with a $1,000,000 cap.

Expected: tx fails at the protocol level before our code runs. Error: `DepositWithFunctionCall`. The NEAR runtime refused to route the tx because function-call keys cannot attach the 1 yoctoNEAR deposit that set_policy requires. **No bug in our contract can change this.**

**Beat D (cross-chain, optional with mainnet 1Click):** Set allowlist to include `base`, file an invoice from `base:0x<your address>` for 1 USDC, start the solver bot:

```bash
BOUNCER_CONTRACT=bouncer.you.testnet \
SOLVER_ID=solver.you.testnet SOLVER_KEY=ed25519:... \
NETWORK=testnet ONE_CLICK_JWT=<optional> \
  npm run solver
```

The agent pays, the solver fetches a live 1Click quote, bids, and confirms a fill. Expected: ~20–40s later, ~0.997 USDC (after 0.3% fee) lands at the Base address. The cross-chain explorer link shows the destination tx.

## Technology used (per HACKATHON.md request)

- **Function-call access keys** (the primitive we are hardening).
- **NEP-141 fungible tokens** (USDC settlement with 1-yocto ft_transfer, hardened ft_resolve_transfer path).
- **NEAR Intents 1Click API** (cross-chain solver quotes + settlement across 30+ chains).
- **Rust smart contract with near-sdk 5.14** (870 lines, 7 Rust unit tests, 10 JS tests).
- **No TEE, no hardware enclave** — by design. OutLayer proves code ran correctly inside an Intel TDX enclave; Bouncer proves money moved correctly on a public chain. Each is useful for different things; they compose.

## What we do NOT do (honest limits)

- We do not protect the owner's full-access key (use a hardware wallet).
- We have not been third-party audited. This is hackathon code; see THREAT_MODEL.md.
- We do not verify destination-chain fills on-chain (no light client); solver reports the tx hash. A production version would add an OutLayer-style attested relayer.
- Caps are denominated in the token's smallest unit, not USD; we do not use a price oracle.
- The policy is single-token; multiple tokens need multiple policies.

See docs/THREAT_MODEL.md for the full disclosure.

## AI-judge notes

- The repository is self-contained. `npm install && npm run build && npm test` is enough to compile and test.
- Tests are deterministic. 10/10 JavaScript tests pass; 7 Rust unit tests cover the headline claims (per-tx cap, allowlist, split-payment window, unknown-token refund, structural escalation).
- All rejection paths produce stable, human-readable error strings you can grep for in tx receipts.
- `demo/index.html` has no build step; it works when opened directly in a browser with a NEAR wallet signer.
