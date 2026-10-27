# Bouncer — payments firewall for autonomous agents on NEAR

Bouncer aims to let an AI agent buy several resources — such as compute,
storage, and API credits — using different NEAR fungible tokens, subject to
owner-defined spending policies. The current prototype implements the vault and
policy checks. The v4 prototype has passed a three-token testnet quote → payment
→ self-hosted delivery check and a separate restricted-key security/refund check.
An optional model adapter now translates natural-language objectives into tasks
within an owner-controlled catalog; see [AI agent setup and limits](bouncer/docs/AI_AGENT.md).
No model or inference service is bundled. This is unaudited testnet software,
not suitable for real funds.

## Website preview (read-only)

**[Open Bouncer](https://www.madethis.website/s/nrqegcc3/)** — a public,
temporary preview hosted by madethis.website, expiring **3 November 2026 at
19:27 UTC**. Anyone with the link can view it. It is a snapshot, not a
production deployment, and the private repository remains private.

`bouncer/web/` explains the prototype's request → quote → guarded payment →
fulfillment flow with a newcomer tour and an interactive walkthrough of three
real, **recorded** testnet requests and results. It links to the payment transactions
and separate refund test, and distinguishes the recorded deterministic flow from the then-planned AI
planner and commercial integrations. This snapshot predates the new model adapter.
The two credit tokens are synthetic and fulfillment was self-hosted. The site
is not a live agent dashboard or commercial marketplace. It includes an
optional, identity-only testnet wallet connection on an isolated top-level
origin; **wallet connection is disabled on the shared-origin guest preview**.
The connector has been exercised with a mock and a real Meteor UI opened and
cancelled, but not with a real wallet sign-in. Connecting does not create a
vault, grant spending access, or sign transactions. The site can try an
optional public-RPC read of the recorded contract’s current vault balances; if
that fails it keeps the recorded snapshot.

To view it locally from the repository root (Node is not required):

```sh
python3 -m http.server 4173 --bind 0.0.0.0 --directory bouncer/web
```

GitHub Pages is not configured for this private repository. The explicitly
opt-in `[publish-web-preview]` workflow publishes **only the seven whitelisted
static web files** to a public third-party guest host for a time-limited preview;
it does not publish the repository, credentials or journals. The host controls
availability and expiry. It is not a durable production deployment, and normal
pushes do not trigger it. See [website and wallet notes](bouncer/docs/WEB.md).

## AI assistant access (MCP)

The [MCP server](bouncer/docs/MCP.md) exposes policy inspection and configured
quote/preflight tools over local stdio or authenticated loopback HTTP. These
are read-only testnet tools: no private keys, policy changes, payments or deliveries.
Gemini CLI and Claude Code have passed local stdio connection checks without a
model conversation; project configuration is included. ChatGPT web and other
remote clients need a separately hosted HTTPS endpoint and compatible
authentication; an OAuth deployment is not supplied or verified. MCP connects
tools—it does not itself provide a model or access to the new planning/execution path.

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
policy mutation fails in the contract; a one-yocto attempt fails at the NEAR
protocol layer. Both were verified in the [v4 live testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40558301848).
Offline mocks are not proof of on-chain behavior.

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
  compute job, store a local file, count text or fetch public GitHub repository
  metadata. GitHub data is live, unauthenticated third-party data; availability
  is not guaranteed. The provider is not commercial. The agent fetches fixed quotes and
  validates owner-pinned constraints. An optional model adapter proposes tasks;
  it requires a separately supplied model and is not a marketplace. Independent
  vendors, invoices, stablecoin flows and NEAR Intents remain unfinished.
- Token trust is not enforced; configure policies only for trusted FTs. Changing
  a policy's token retains its numeric spend history even if the new token has
  different units; create a new policy for a different token instead. Key
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
The [v4 live testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40558301848)
passed both the restricted-key security/refund check and the full quote →
payment → local delivery check. The three payment transactions are
[compute/wNEAR](https://testnet.nearblocks.io/txns/6VELBm5bCbTF2jv88q2R4omrSJkvj8Ytr4aqa1FCtdTv),
[storage credits](https://testnet.nearblocks.io/txns/2oCD4escgD2JEnYRbTAKCRS3zNB13iafqsRPuEsqTQVB), and
[API credits](https://testnet.nearblocks.io/txns/4HL53bUj6G8u1ZEKy8Wuj52sC5h2kzYAgzaREHL5M4sd).
The separately tested [failed-transfer refund](https://testnet.nearblocks.io/txns/GkQL6ZNHC7gGmRmCHc9uFv7fSsNdeJkTZaHtNPcxfhtw)
restored the recorded vault balance and daily budget. These are testnet results,
not commercial resource purchases.

### Natural-language planning

The optional [AI agent](bouncer/docs/AI_AGENT.md) accepts an objective and a
trusted owner catalog, then can preview or explicitly execute the resulting
resource tasks through the same guarded runner. The model cannot set payment
addresses, policy, token or budget. AI output can still be wrong; review it
before spending. A local model server or another explicitly configured
OpenAI-compatible endpoint is required. In the [AI-planned testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40579499294),
a local Qwen2.5 1.5B model generated the three synthetic tasks; Bouncer checked
them, paid three testnet FTs and verified the local deliveries. The model's
inputs were checked against the requested literals before any accounts were
created. The original v4 run linked above used deterministic inputs. Both use
self-hosted development services, not commercial vendors.

### Run the resource agent again

The multi-token script also writes `<account>.provider.json`,
`<account>.owner.json` and `<account>.goals.json` alongside its plan and journal. The goals file points to
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
- `bouncer/agent/goal-planner.mjs`, `autonomous.mjs` — model proposals constrained by the owner catalog.
- `bouncer/services/resource-provider.mjs` — self-hosted test-only resource provider.
- `bouncer/demo/index.html` — clearly labelled offline simulation only; it sends
  no transactions and does not exactly match contract behavior.
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
