# Bouncer — payments firewall for autonomous agents on NEAR

Bouncer aims to let an AI agent buy several resources — such as compute,
storage, and API credits — using different NEAR fungible tokens, subject to
owner-defined spending policies. The current prototype implements the vault and
policy checks. A plan-driven runner has passed a three-token testnet payment
check; the quote-to-delivery integration is being validated separately. This is
unaudited testnet software, not suitable for real funds.

## Target tracks

The planned multi-resource agent targets Autonomous Business, AI Security &
Defense, and Agent Economy first. Real-World Money, Unstoppable DeFi and
AI Swarms are potential extensions, not completed integrations.

## Contract capabilities in this branch

- NEP-141 deposits; token-specific vault balances and per-policy caps.
- A direct `execute` call must come from the owner account, with **zero**
  attached deposit and a signing public key explicitly granted to that policy.
  The owner separately creates a NEAR function-call key limited to `execute`.
  Each signed request includes the expected token, checked on chain against the
  policy to prevent a token substitution between preview and execution.
- Per-transaction caps, a conservative rolling daily budget and fail-closed
  payee allowlists. The daily budget sums the current hour and 24 previous
  hourly buckets: spending less than 24 hours old cannot expire early, but may
  remain counted for up to one extra hour. Revoking the final payee blocks all
  payments on that policy. `daily_spent` reports the current budget usage.
- Policy changes, agent-key grants/revocations, payee changes and withdrawals
  require the owner and exactly **1 yoctoNEAR**.
- A transfer failure callback attempts to refund the vault and the original
  spend bucket. A failed callback can still leave a debit unresolved.

The updated check is designed to use a real restricted key to pay wNEAR, deny
other callers and policies, revoke a payee and a key, and test both layers of
the 1-yocto guard with a separate deliberately limited probe key. A zero-deposit
policy mutation should fail in the contract; a one-yocto attempt should fail at
the NEAR protocol layer. Results must be verified by the live testnet run;
offline mocks are not proof of on-chain behavior.

### Important prototype limitations

- These changes only apply to **newly deployed contracts**. Earlier deployments,
  including `bouncer-a958bd.testnet`, still have the older unauthenticated
  `execute` and a different state layout. The v4 rolling-budget bucket semantics
  also differ from v3. Do not upgrade older deployments without a migration or
  use them for valuable funds. The script creates a fresh account.
- The security check uses **one token (wNEAR)**. The separate multi-token check
  creates two synthetic testnet credit FTs and sends payments to three vendor
  accounts. It is not a USDC/stablecoin demonstration.
- A self-hosted development provider can verify a payment and perform a small
  compute job, store a local file, or serve a text-statistics API. It is not a
  commercial provider. The agent fetches fixed quotes from this provider and
  validates owner-pinned constraints, but is not an AI or a marketplace.
  Independent vendors, invoices, stablecoin flows and NEAR Intents remain
  unfinished.
- Token trust is not enforced; configure policies only for trusted FTs. Key
  grants do not themselves create or restrict NEAR access keys. The owner must
  create correctly scoped function-call keys and keep full-access keys private.
- This code has not been audited. Contract callback failure, token behavior,
  owner-key compromise and gas/balance exhaustion remain risks.

## Run the wNEAR testnet check

Requires Node.js 22, npm, network access to NEAR testnet and its account helper,
and the `bouncer.wasm` included in the repository. No wallet or external faucet
website is needed. Each run creates and funds a **new testnet** account; keys
are saved in `~/.near-credentials/testnet/` (keep these files private), and the
latest contract ID is written to `~/.bouncer_id`.

In a Codespaces terminal:

```sh
cd /workspaces/Bouncer
git pull --ff-only
npm install --prefix bouncer
node bouncer/demo-all.mjs
```

The script creates a contract, a depositor and a vendor, wraps 2 NEAR into
wNEAR, funds the vault with 1.5 wNEAR, and tries one allowed payment plus
several disallowed operations using a restricted key. It checks expected rejection
reasons, exercises a failed FT transfer and refund callback, checks the restored
vault and daily budget, examines receipts, and verifies exact on-chain balances:

```
user:   0.5 wNEAR
vendor: 0.1 wNEAR
vault:  1.4 wNEAR (matches token contract)
✅ All checks passed. One token; payment signed by a restricted agent key.
```

Every successful operation prints a transaction link. The script exits with a
nonzero status on unexpected rejection, unexpected success, failed downstream
receipt, or a balance mismatch. Testnet RPC/helper outages or faucet limits can
also stop a run; their errors are printed rather than hidden. Set
`NEAR_TESTNET_RPC` to override the default FastNEAR testnet RPC. Daily budget
tracking uses conservative hourly buckets rather than resetting at midnight.

GitHub Actions also has an opt-in testnet smoke job, triggered manually or by a
push whose commit message contains `[testnet-smoke]`. It creates real testnet
accounts with ephemeral keys on the runner; it does not upload those keys.
Ordinary CI runs do not create testnet accounts.

## Multi-token procurement check (testnet only)

After CI has attached the matching `bouncer.wasm`, this optional script creates
new testnet accounts, wNEAR plus **two synthetic testnet credit tokens**, three
vendor accounts, policies and an execute-only key. It fetches quotes, makes
payments and verifies each token's recorded vault, actual vault and vendor
balances. A local development provider then verifies each on-chain transaction
and fulfills a small SHA-256 compute job, stores and retrieves a local file, and
serves a text-statistics API. These are real operations on the machine running
the demo, **not commercial cloud resources**.

```sh
node bouncer/demo-multi-resource.mjs
```

This requires the NEAR testnet token factory and creates real testnet
transactions. It stores a reusable plan, journal, provider redemption state and
local objects under `~/.bouncer/testnet/`; private keys are stored separately
under `~/.near-credentials/testnet/`. The testnet credits have no monetary value.
A [live testnet CI run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40555110181)
passed the restricted-key security and three-token payment checks. A
[separate run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40556175783)
passed the complete quote → payment → local delivery check using the self-hosted
provider. These runs used the prior v3 contract; the rolling-budget v4 contract
requires a fresh deployment and its own live verification. Neither run
demonstrates a commercial resource purchase.

### Run the resource agent again

The multi-token script also writes `<account>.provider.json` and
`<account>.goals.json` alongside its plan and journal. The goals file points to
the **same journal** used for the original payments; retaining it is essential
to avoid paying twice. It also contains the resource inputs, so treat it as
private. To start the local development provider and preview those goals after
running the demo locally:

```sh
cd /workspaces/Bouncer
ID=$(cat "$HOME/.bouncer_id")
node bouncer/agent/resource-agent.mjs --goals "$HOME/.bouncer/testnet/$ID.goals.json" --key "$HOME/.near-credentials/testnet/$ID.agent.json" --local-provider "$HOME/.bouncer/testnet/$ID.provider.json"
```

The agent defaults to a dry run. Add `--execute` only after reviewing the
quotes; completed orders in the configured journal are skipped and the
provider returns their existing results. Using a different or deleted journal
can cause repeat payments. `--local-provider` starts the loopback-only development
provider for this command and shuts it down afterwards. Both programs support
`--help`.

### Run a supplied procurement plan

The runner defaults to a read-only preview. `--execute` explicitly submits
real testnet transactions; it rejects full-access or over-broad keys. Request
amounts are **strings in the token's smallest units**, not USD or floats.

```json
{
  "contract_id": "bouncer-example.testnet",
  "owner_account_id": "bouncer-example.testnet",
  "requests": [{
    "id": "compute-1", "resource": "compute", "policy_id": "compute-wnear",
    "token": "wrap.testnet", "payee": "vendor.bouncer-example.testnet",
    "amount": "100000000000000000000000", "memo": "compute:1h"
  }]
}
```

```sh
node bouncer/agent/procurement.mjs --plan /path/to/plan.json --key /path/to/agent-key.json
# Only after reviewing the plan and dry-run output:
node bouncer/agent/procurement.mjs --plan /path/to/plan.json --key /path/to/agent-key.json --execute
```

The journal is local, not a distributed exactly-once mechanism. Before sending,
requests are marked pending; if confirmation is uncertain the runner refuses to
retry automatically. Inspect the chain and reconcile the journal manually. Do
not delete or change journals to bypass this safety check. Keys must be kept
private, and different journal paths cannot prevent duplicate payments.

The development provider trusts its configured RPC, Bouncer account/code, and
FT contracts; it is not a trustless payment proof. Its local redemption state
is single-process only. It has no authentication, TLS, privacy or multi-host
replay protection and must not be exposed publicly or used with real money.
Order data is sent to the provider, and its hash is public in the payment memo.

## Local tests

```sh
npm install --prefix bouncer
npm test --prefix bouncer
```

The JavaScript policy simulation uses exact rolling windows and is not identical
to the contract's conservative hourly buckets. Offline demo tests use a mocked
NEAR transport; neither proves live blockchain behavior. CI also runs native Rust
contract tests, and the opt-in Actions job or Codespaces command above exercises
real testnet transactions. To build locally with Rust and the wasm target, run
`bash bouncer/scripts/build.sh`; CI additionally uses `wasm-opt -O1`.

## Main files

- `bouncer/contracts/bouncer/src/lib.rs` — current vault and policy contract.
- `bouncer/demo-all.mjs` — fresh-deployment restricted-key security check.
- `bouncer/demo-multi-resource.mjs` — testnet wNEAR plus synthetic FT check.
- `bouncer/agent/procurement.mjs` — plan-driven, testnet-only procurement runner.
- `bouncer/agent/resource-agent.mjs` — quote, guarded payment, fulfillment orchestration.
- `bouncer/services/resource-provider.mjs` — self-hosted test-only resource provider.
- `bouncer/tests/` — offline regression tests for the demo script.
- `bouncer/packages/policy/` — independent JavaScript policy simulation.
- `.github/workflows/ci.yml` — JavaScript tests, contract build, and optional
  manual live testnet smoke job.

All earlier deployments, including `bouncer-2dcd4e.testnet` and
`bouncer-a958bd.testnet`, use older state layouts. Do not upgrade them to this
contract without an explicit migration. The demo deploys a fresh contract.

## Roadmap

1. Validate the new restricted-key and policy isolation flow on testnet,
   including the 1-yocto protection with real restricted keys.
2. Validate the quote-to-delivery testnet flow end to end; integrate independent
   resource vendors and independently verifiable fulfillment.
3. Add verifiable receipts/invoices, stablecoin flows and real, explicitly
   verified NEAR Intents settlement. Strengthen failure/recovery tests.
4. Record the submission demo only after the complete flow works end to end.

MIT license.
