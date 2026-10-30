# Bouncer — autonomous multi-resource procurement on NEAR

Bouncer aims to let an AI agent buy compute, storage and API/data resources
with owner-defined spending policies across NEAR assets. Its testnet prototype
has paid three fungible tokens and Circle's canonical **testnet USDC** for
self-hosted development services. Testnet USDC has no real-world value. It has
also paid independently operated OutLayer in native testnet NEAR for bounded
compute and a single-source public price lookup; the returned value was used
in three Circle-funded development-resource orders. A separate probe funded
with fake testnet USDC.e and native NEAR returned HTTP 405, not useful API data
or a commercial service. An optional model translates objectives into tasks within
an owner-controlled catalog; it does not choose financial authority. Bounded
delivery checks and a local journal gate later payments. See
[AI agent setup](bouncer/docs/AI_AGENT.md) and
[guarded independent compute](bouncer/docs/OUTLAYER.md). A separate marketplace
catalog search is read-only. No model or inference service is bundled. This is
unaudited testnet software, not suitable for real funds.

## Website preview (read-only)

**[Open Bouncer](https://www.madethis.website/s/njatdkbb/)** — a public,
temporary preview hosted by madethis.website, expiring **6 November 2026 at
14:45 UTC**. Anyone with the link can view it. It is a snapshot, not a
production deployment, and the private repository remains private.

`bouncer/web/` explains the prototype's request → quote → guarded payment →
fulfillment flow and links to the latest oracle-led Circle testnet mission and
recovery proof. It also retains an interactive walkthrough of three real,
**recorded** requests from an earlier multi-token run. A separate test used a
local AI model to propose tasks; the latest oracle mission used prepared goals. The
two credit tokens in the earlier example are synthetic and fulfillment was
self-hosted. The site
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

## Six-track roadmap: evidence and gaps

Bouncer is a resource-buying agent; the on-chain firewall is its spending
kernel, not the whole product. These are connections to the tracks, not claims
that all six are complete.

| Track | Evidence today | Still needed |
| --- | --- | --- |
| AI Security & Defense | 1-yocto guard, scoped keys, caps, pinned project/input and delivery gating. | Independent audit and stronger prompt defenses. |
| Agent Economy | Native-paid independent price execution feeds three FT-paid development resources. | Independent FT-paid commercial API/storage providers and signed receipts. |
| Autonomous Business | AI planning in a separate run; multi-resource payments, delivery checks and recovery. | Real customers, invoicing and production operations. |
| Real-World Money | Circle testnet USDC paid for three self-hosted resources; fake USDC.e funded a separate probe. | Independent providers and real-money rails; testnet USDC has no real value. |
| Unstoppable DeFi | Owner-setup Ref testnet swaps acquired test tokens, including Circle testnet USDC. | Agent-guarded swaps and cross-chain settlement. |
| AI Swarms | One coordinator sequences multiple resources. | Multiple autonomous agents and secure handoffs. |

## Contract capabilities in this branch

The source in this branch reports v9 and needs a **fresh deployment**; no
migration from older state is provided. Two incompatible earlier layouts both
reported v6, so a version string alone does not establish upgrade safety. The
checked-in `bouncer.wasm` is the CI-built v9 artifact (SHA-256
`835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee`).
CI checks that its version marker matches the source; this sanity check is not
an audit or proof that a deployed contract has the same code. Earlier live
runs used the fresh WASM built by their own CI jobs.

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
- An FT transfer failure callback attempts to refund the vault and the original
  spend bucket. A failed callback can still leave a debit unresolved.
- V5 separately tracks native NEAR. An owner-pinned OutLayer program and an
  `execute_outlayer`-only key can request a bounded testnet execution under the
  same cap, budget and allowlist controls. The **full maximum deposit** remains
  counted against the budget; OutLayer's unused deposit goes directly to the
  owner, not back into the Bouncer vault. It is not an FT payment.
- V8 adds `execute_outlayer_pinned`: the owner pins the exact input as well as
  the program and policy/payee revisions. The new agent key must be restricted
  **only** to that method; the older `execute_outlayer` method still permits
  an authorized key to choose input. Edits and revocations invalidate old
  pinned routes.
- V9 adds a separate native-only `execute_outlayer_native_project` route: the
  owner pins the OutLayer project/version, exact JSON input, limits and policy
  revisions. It supplies no secrets or FT spending parameters. Its testnet
  oracle runner checks the registry and final project UUID, resolved WASM hash,
  payment and result; views are non-atomic and provider/RPC remain trusted.
  A live result is reported separately, not assumed.

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
  use them for valuable funds. Later versions add state and also require a
  fresh deployment; no migration is provided. The scripts create fresh accounts.
- The security check uses **one token (wNEAR)**. The separate multi-token check
  creates two synthetic testnet credit FTs and sends payments to three vendor
  accounts. It is not a USDC/stablecoin demonstration.
- A self-hosted development provider can verify a payment and perform a small
  compute job, store a local file, count text or fetch public GitHub repository
  metadata. GitHub data is live, unauthenticated third-party data; availability
  is not guaranteed. The provider is not commercial. It can handle up to eight
  unrelated redemptions concurrently within one process and deduplicates the same
  in-flight transaction, but has no multi-host coordination, authentication or
  production durability. An optional selector compares quotes from owner-approved endpoints only, within one token per
  resource; every quote must match the approved constraints. The model proposes
  tasks but cannot choose financial authority. It requires a separately supplied
  model. Delivery checks cover only the bounded example protocols: storage is
  one readback from the same provider, and GitHub checking covers repository
  identity only, not the truth or freshness of its other fields. Local receipts
  are editable records, not signed invoices. The separate public catalog search
  is read-only, not a purchasing integration. OutLayer uses its own native and
  prepaid FT interfaces, not this experimental FT-provider protocol. The paid
  connector returned HTTP 405 rather than useful API data. The separate native
  price execution consumes a public endpoint, not an FT-paid API subscription.
  Independent FT-paid storage/commercial API purchases, invoices, real-value
  stablecoin payments and NEAR Intents remain unfinished.
- Token trust is not enforced; configure policies only for trusted FTs. The
  planner and configured development provider accept owner-pinned 64-hex token
  IDs on a testnet-reported RPC. The independent OutLayer probe used fake
  testnet USDC.e, not Circle USDC. A separate Circle testnet USDC mission paid
  only a self-hosted development provider; its tokens have no real value.
  Changing a policy's token retains its numeric spend history even if the new token has
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
`NEAR_TESTNET_RPC` to override the default FastNEAR testnet RPC. Remote RPCs
must use HTTPS without URL credentials, query or fragment; loopback HTTP is
allowed for local testing. The runner checks the reported chain ID, but still
trusts the RPC. Daily budget tracking uses conservative hourly buckets rather
than resetting at midnight.

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
OpenAI-compatible endpoint is required. An optional Linux x86_64 bootstrap
script downloads and verifies a pinned local model; it is not bundled. In the [AI-planned testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40579499294),
a local Qwen2.5 1.5B model generated the three synthetic tasks; Bouncer checked
them, paid three testnet FTs and verified the local deliveries. The model's
inputs were checked against the requested literals before any accounts were
created. A [later AI job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40581368718/job/122462232919)
also paid synthetic API credits for live public GitHub repository data and
checked the result against a second GitHub read. That workflow's separate
security job failed on an RPC nonce error. A [subsequent run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40582306741)
passed both the four-payment AI flow and its separate restricted-key security
and refund job after a process-local nonce mitigation. That mitigation does not
coordinate multiple writers or retry ambiguous sends. The original v4 run linked
above used deterministic inputs. These are self-hosted development services,
not commercial vendors.

### Owner-approved provider comparison

The optional `--compare-providers` path compares valid quotes only within the
resource's owner-pinned token. It chooses the cheapest using exact integer
amounts, saves the selected route and price, and rechecks that price before the
normal on-chain policy preflight and payment. Up to five quotes are requested
concurrently; an invalid or unavailable quote stops queued requests and the
comparison fails without a partial selection. See [setup and recovery limits](bouncer/docs/AI_AGENT.md#compare-owner-approved-providers).

In the [live comparison job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40666249071/job/122742140751),
two self-hosted development endpoints quoted 0.10 and 0.08 wNEAR for the same
explicitly supplied compute task. Bouncer selected the approved cheaper payee,
[paid it on testnet](https://testnet.nearblocks.io/txns/3ztdLNn4M91nDtqQNUSZZqgwEg3Fh9CaU3XP7BnD8T3S),
verified the local result and replayed without a second payment. The comparison
task was deterministic. A [later combined AI run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40667233621/job/122745427128)
used the local model to propose the comparison task, selected the same cheaper
quote and [paid on testnet](https://testnet.nearblocks.io/txns/HbibFp8eUpNgdQUV4azi1jG9PVekEY9teupjHgHrDhki).
That run also completed the three-resource and public-data purchases and replay
checks. Both tests used self-hosted services, not independent commercial
providers, and do not guarantee future delivery.

### Guarded independent compute on testnet

A separate-owner [live check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40682550107/job/122797278579)
used an `execute_outlayer`-only key to call the independently operated
`outlayer.testnet` through a fresh Bouncer v5 deployment. In
[transaction `HPYW…99rQ`](https://testnet.nearblocks.io/txns/HPYWoHrEozKWirbZdgiJkRDp9hShJBmzXSShJd2d99rQ),
the 0.1 NEAR maximum produced a number in the requested 1–100 range. The
provider charged 0.0010185 NEAR and the unused 0.0989815 NEAR was verified as
refunded to the separate owner. The demo rejected over-cap and zero-deposit
program-escalation attempts, injected a local evidence fault, and used a
separate key-free CLI to recover the same transaction without a second payment.
The maximum 0.1 NEAR remained in
the rolling budget.

The verifier trusts the configured RPC and OutLayer contract. An in-range output
is **not** independent verification of TEE attestation or randomness quality.
This is one bounded random-number program, paid in testnet native NEAR; it is
not a general independent cloud marketplace or a USDC purchase. A mixed-mission
runner can combine that owner-selected task with FT-backed resource goals; its
previews are non-atomic and earlier payments cannot be rolled back if later
work fails. In the [full mixed test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40682550107/job/122797278689),
the same separate-owner deployment paid [OutLayer](https://testnet.nearblocks.io/txns/5ShjrS8JiJ5yyQPKDvFGnwtobpL2vQUbXTFchPuGD53r)
and then fulfilled AI-planned compute, storage, API and public-data goals using
three FTs and self-hosted development providers. The model did not select the
OutLayer task. An injected FT-result fault stopped later payments until the same
transaction was recovered. See [setup, recovery and trust boundaries](bouncer/docs/OUTLAYER.md).

### Oracle-led Circle testnet mission

In the [v9 live test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41073097919/job/124122803916),
Bouncer paid [OutLayer](https://testnet.nearblocks.io/txns/4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ)
for an owner-pinned project version and exact request to Coinbase's public
NEAR/USD endpoint. The project returned **4.27625 USD** as a single-source
number. OutLayer reported charging `1111600000000000000000` yoctoNEAR and
refunding `98888400000000000000000` to the owner; Bouncer retained the full
`100000000000000000000000` maximum against the rolling budget. An injected
lost response was recovered by the original hash without a key or second send.

The returned number was included in three separate orders, paid with 1,000
micro-units each of Circle **testnet** USDC: [compute](https://testnet.nearblocks.io/txns/7XxeU466RVYvVN3wBrWqXHu2zeHHyFPcs4WhNuFX2GbJ),
[storage](https://testnet.nearblocks.io/txns/GJkJMWBF2CCh1H5uh9uAKJJciTsqcvcgKvNXvnJrEvjL),
and [API](https://testnet.nearblocks.io/txns/7RxBwG4G6FRqG1o2shYRN2ES2WsxVFdEMd8NWp7zA5vy).
A corrupted compute delivery stopped later purchases; recovery reused the first
payment before continuing. Both layers of the 1-yocto escalation guard and the
request-substitution and per-transaction-cap checks rejected their probes. The
owner's [Ref setup swap](https://testnet.nearblocks.io/txns/CqXgcgZ5RuN4n5hTgkgZFx51EH5t1WeVU7SsiNyNeVwt)
and [vault funding](https://testnet.nearblocks.io/txns/BaScmpZxC7tqAdQC515A3xoj8ev9exFxsN7T4KjHFppw)
were owner setup actions, not guarded agent purchases.

The price was paid for with **native testnet NEAR**, not USDC; Coinbase's data
endpoint is public, and the three FT-funded products came from our self-hosted
development provider. The oracle returns only a numeric field and a worker
request timestamp: neither the original response, market freshness, accuracy,
consensus nor TEE attestation is independently verified. Payments and previews
are non-atomic; later failure cannot undo earlier purchases. See [the full
failure history and trust boundaries](bouncer/docs/OUTLAYER.md).

### Paid-provider mission and recovery

In the [28 October 2026 test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40699116807/job/122854642930),
Bouncer used separately scoped keys to [deposit 15,000 micro-units of fake
USDC.e](https://testnet.nearblocks.io/txns/JA8TEBybh8Gj6JkfghyeopMrAvWNKYMv2nSU2NAnJ75d)
and [pay for the pinned OutLayer test probe](https://testnet.nearblocks.io/txns/3WSS8Cma8SBqtnk9Krb6g7cNhSgpX2m7wpbKBdtiEuny)
under fake-token and native-NEAR budgets. It returned HTTP **405**, not API data.
The unified runner recovered those already-settled transactions and then paid
and verified self-hosted [compute](https://testnet.nearblocks.io/txns/B9PLx9GQaaJc7im6VvmJ5rXoBSKm5N11ZRGNWA6EPPz5),
[storage](https://testnet.nearblocks.io/txns/FCR2LtrGjjXAfWLK3XhEkkU6Mo8P9CFWLGs8NXXuBTau)
and [API](https://testnet.nearblocks.io/txns/6GZ18f7y3H6vm8LXYrjKTfZccnfzLJHH8JvojHt3kXa9)
tasks in wNEAR using the durable direct-payment path. A locally corrupted compute
result stopped later payments; recovery reused that same compute transaction
before continuing. The unified
runner's initiation of *all* stages is covered offline, not yet proved live.
Previews are non-atomic, and earlier payments cannot be rolled back. The
preceding Ref swap was owner setup, not agent-guarded DeFi.

### Circle testnet USDC resource mission

The [Circle testnet mission](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40697938370/job/122850532589)
used Circle's [canonical NEAR testnet USDC contract](https://testnet.nearblocks.io/address/3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af)
with six decimals. A full-access owner first acquired the token with a small,
bounded [Ref swap](https://testnet.nearblocks.io/txns/8tAYE8uubKqwv8rAU9T5dcgPkXQ3AweuvwyC7Py3gNHP)
and [funded the vault](https://testnet.nearblocks.io/txns/7X7xYBTA9nhau9MnZrrQHHT25XFJkVQ6uu2sLtTEotAk).
That setup swap was **not** agent-guarded. A restricted Bouncer key then paid
1,000 micro-USDC each for self-hosted [compute](https://testnet.nearblocks.io/txns/2yB7fdPGjZreSLu2Ksjf66wR9GDZ1Lwf3j1fNDdnKKP5),
[storage](https://testnet.nearblocks.io/txns/8JnKhKUGYJsQYdKQKuMxoGyhXJakfJiSNMiuiDuppeYc)
and [API](https://testnet.nearblocks.io/txns/5YcQToX4Zj7ABrVsnXJL5Q6u2bob9KvaE9wPHJaF4GCQ).
The run rejected a zero-deposit owner-policy escalation, token substitution and
over-cap payment. After the real compute payment, it simulated a lost RPC
response and recovered the pre-recorded hash without a key or second payment.
A deliberately corrupted compute result then blocked later payments until the
original delivery was verified. These are prepared goals, a development provider
and testnet funds with **no real value**, not commercial delivery or mainnet payments.

### Read-only independent marketplace discovery

```sh
npm run discover --prefix bouncer -- --query research --limit 5
```

This optional command makes a bounded, fixed-origin GET to the public
[NEAR Agent Market catalog](https://market.near.ai/v1/agents?limit=3). It has no
wallet, credentials, model or policy access and cannot quote, hire or pay. The
  catalog is for a **mainnet marketplace**, not proof of a testnet service or any
Bouncer-compatible vendor. Search terms are sent to the marketplace; do not use
secrets or private objectives. Listing text, availability, payment-method labels
and reported metrics are untrusted, may contain prompt injection, and are not
validated quotes or endorsements. They are not fed into the planner, allowlist
or payment runner. An owner must independently vet any potential integration;
the [experimental provider protocol](bouncer/docs/PROVIDER_PROTOCOL.md) documents
the current testnet interface and its trust requirements.
The advertised [x402 hiring flow](https://docs.market.near.ai/a2a/hire-agent-using-x402)
uses direct delegated FT transfers, which would bypass the current Bouncer
restricted-key policy. Bouncer deliberately does not perform that flow. The
[read-only live check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40675524400/job/122772818985)
returned three public listings without credentials or payments; it did not
validate, hire or transact with their providers.

### Delivery checks and local receipts

The resource agent recomputes bounded SHA-256 and text-statistics results,
checks a single storage readback against the ordered bytes, and checks GitHub
repository identity against a separate fixed-origin read. Other GitHub fields
remain unverified. After a successful check, its private journal records the
payment, result, verification scope and result hash. A bad or unavailable
result leaves the payment completed and delivery unverified; a new-format
journal can retry delivery with the same transaction without fetching a new
quote or sending another payment; the recorded provider route must still match.
After whole-batch preflight, each newly confirmed payment is fulfilled, checked
and journaled **before** the next payment. An unverified delivery, receipt write
failure or execution-time policy block stops later payments; previous payments
cannot be rolled back. In the [AI-planned live test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40675524400/job/122773588238),
a locally corrupted first reply halted the batch with both later vendor balances
at zero; recovery reused the [first payment](https://testnet.nearblocks.io/txns/SVdv3Fc4dMwSxChpCfvijiVUDx3A4478U5gcwHAWjJV)
and then verified the remaining deliveries. The fault was injected locally, not
provider misconduct. That run's separate security smoke job failed on a testnet
transaction expiry during account setup. The [next full run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40676850305)
passed the AI and deterministic flows with a separate policy owner, as well as
the restricted-key security and [refund check](https://testnet.nearblocks.io/txns/APWAXeExseG1TMgNvVgo7xPKiHyne9VPWot2VWYQozTM).
Both used self-hosted providers. These are local, editable records—not signed
invoices, generic compute proofs or guarantees of future storage. See the
[verification and recovery details](bouncer/docs/AI_AGENT.md#delivery-checks-and-local-receipts).

In the [live testnet verification job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40671752050/job/122760598105),
Bouncer paid the selected self-hosted compute provider, deliberately corrupted
the reply locally, rejected it and recovered using the [same payment](https://testnet.nearblocks.io/txns/GewpbPFkGtbBnNzWbuFrwcmWqb6hCHFkqoaBBmN3u7eh)
without requoting. The fault was injected by the demo, not evidence of provider
misconduct. The job also checked storage readback, text statistics and receipts.
A [separate security/refund job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40671752050/job/122760598164)
passed; the AI job in that run failed during setup on a testnet expiry error.
A [subsequent combined AI job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40673056154/job/122765249942)
passed with the synced journal: the local model planned the tasks, all five
payments completed, and the injected bad reply was rejected and recovered
using the [same transaction](https://testnet.nearblocks.io/txns/5JnhhrRpWSfuSBVvfw25BSVrtQPQWRoyTnff2dKAayvf).
The GitHub check verified repository identity only; the providers were still
self-hosted development services.

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
retry automatically. Direct procurement, the resource and autonomous agents,
and the mixed/paid mission CLIs offer an opt-in `--durable` path for direct FT
resource payments: it validates the signed transaction, persists its
hash before the one broadcast, and can re-query matching final receipts without
a key using `bouncer/agent/recover-direct-payment.mjs`. This confirms payment
only; delivery must still be verified before later purchases. Older entries and
runs without `--durable` can require manual reconciliation. An unknown or
expired transaction stays unresolved; it is never resent automatically. Do not
delete or change journals to bypass this safety check. Keys must be kept private,
and different journal paths or multiple writers can still duplicate payments.

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
- `bouncer/demo-circle-usdc.mjs` — Circle testnet USDC multi-resource and failure-recovery check.
- `bouncer/agent/procurement.mjs` — plan-driven, testnet-only procurement runner.
- `bouncer/agent/recover-direct-payment.mjs` — key-free receipt-based recovery for opt-in signed direct payments.
- `bouncer/agent/resource-agent.mjs` — quote, guarded payment, fulfillment orchestration.
- `bouncer/agent/verify-delivery.mjs` — bounded result checks and local receipt validation.
- `bouncer/agent/market-discovery.mjs` — isolated, read-only public catalog search.
- `bouncer/agent/goal-planner.mjs`, `autonomous.mjs` — model proposals constrained by the owner catalog.
- `bouncer/agent/quote-comparison.mjs` — opt-in, same-token selection among owner-approved providers.
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
