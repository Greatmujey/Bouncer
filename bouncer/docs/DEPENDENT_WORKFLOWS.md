# Owner-reviewed dependent resource workflows

**Status: unaudited testnet prototype. Do not use real funds.** The workflow
runner connects a verified independent OutLayer result, or an explicitly
approved x402 seller response, to later, ordered compute, storage and API
requests. The x402 source is **not** authenticated or proven truthful by its
payment. Offline adversarial tests use synthetic chain receipts. A [1 November 2026 live testnet run](https://github.com/Greatmujey/Bouncer/actions/runs/41258992192/job/124708664361)
verified the full chain and key-free payment recovery; its OutLayer lookup used
native testnet NEAR, while the three Circle testnet USDC resource payments went
to a self-hosted development provider. It is not evidence of an independent
FT seller or a real-value purchase. A [separate v2 live run](https://github.com/Greatmujey/Bouncer/actions/runs/41263055741/job/124720514951)
used distinct seller-issued challenges for all three development-provider orders
and recovered the original compute hash in a restarted, key-free process. It
checked one source broadcast, three resource broadcasts and the locally
persisted seller claims. The [public evidence artifact](https://github.com/Greatmujey/Bouncer/actions/runs/41263055741/artifacts/13066031406)
contains task data, not keys. A [separate fresh seller-v3 testnet proof](SELLER_V3.md#separate-fresh-seller-v3-testnet-proof)
used authenticated v3 claims for all three self-hosted resource orders, with
key-free recovery of the original compute hash. Its restricted artifact contains
replayable signatures and must remain private. Transaction links and limitations
are in the [README](../../README.md).

## Paid x402 data as a workflow source (experimental)

The optional [`onchain-proof-workflow.example.json`](../examples/onchain-proof-workflow.example.json)
shows how a testnet x402 GET can supply one value to seller-v3 compute → storage
→ API steps. **It is a placeholder, not a real seller or funded deployment.**
There is currently no demonstrated independently operated NEAR-testnet seller
supporting this buyer. The example deliberately sets three risk flags to `false`;
the owner must vet the services, configure the actual deployment, account,
policy, seller URL, payees and limits, and explicitly accept all three risks.
The buyer accepts only `onchain-proof` on `near:testnet` with Circle testnet
USDC. Standard NEAR x402 `exact`, Base and mainnet offers are rejected.

The source's `output` pins a path of zero to five simple JSON object keys, a
primitive type (`string`, `number` or `boolean`), a maximum local receipt age
of 1–900 seconds and `accept_untrusted_data_risk: true`. The seller must return
bounded UTF-8 `application/json`; only the selected value enters the artifact.
Strings are capped at 512 bytes and control characters are rejected; integers
must be safely representable JavaScript numbers. JSON floating-point precision
is limited. Unrecognized fields cannot choose a payee, token, URL, policy,
input binding or spending cap. The selected value is still untrusted text/data:
it must not be treated as a command, financial advice, authenticated oracle or
proof of truth. The local receipt age is checked before each new downstream
payment and immediately before broadcast; it relies on the local clock and
says nothing about when the seller's underlying data was produced.

The source's maximum is included in the conservative preflight for both its
policy's daily budget **and** its token's vault, even when downstream steps
use different policies. These views are not a reservation or atomic guarantee;
on-chain checks remain decisive. The source, then each resource, are separate
purchases; there is no rollback. A preview GET obtains a quote without signing,
but the seller can still observe the request or have side effects. Execution
obtains a fresh quote and may therefore make an additional quote GET.

```sh
# Dry-run the reviewed manifest; no signature, payment or redemption.
node bouncer/agent/workflow.mjs --workflow reviewed.json --journal private-journal.json --source-key execute-only.json --ft-key execute-only.json
# Only after review: spend bounded testnet funds. Keep the original journal private.
node bouncer/agent/workflow.mjs --workflow reviewed.json --journal private-journal.json --source-key execute-only.json --ft-key execute-only.json --execute
# If interrupted, reconcile the original hashes without keys or new payments.
node bouncer/agent/workflow.mjs --workflow reviewed.json --journal private-journal.json --recover-only
# ONLY if recovery reports that the x402 seller request has not started:
node bouncer/agent/workflow.mjs --workflow reviewed.json --journal private-journal.json --recover-only --redeem-source
```

`--redeem-source` explicitly permits the **first** seller request for a confirmed
payment; it cannot retry a previously attempted request or repay. A crash,
timeout, bad response, or invalid selected data may leave a purchase unusable:
keep the journal and investigate. Recovery of already-paid resource steps can
contact the supporting resource seller, but never signs or pays again. A stale
source may be inspected as historical evidence, not used to start new purchases.
The x402 proof is publicly observable and neither claimant- nor order-bound;
it can be stolen and is not made secure by the later seller-v3 steps. V3 claims
are themselves replayable bearer credentials. The journal can contain both
claims and paid data: protect it, do not publish it, and see [x402 risks](ONCHAIN_PROOF.md)
and [seller-v3 risks](SELLER_V3.md).

The new source-to-resource composition is tested with the independently published
PipRail 3.3.0 verifier, a test-only NEAR-testnet wrapper, synthetic FINAL receipts
and our local authenticated development seller. Those tests send **no live
transactions**, and do not demonstrate independent seller adoption or real
purchases. The existing separate self-hosted x402 live check is described in
[ONCHAIN_PROOF.md](ONCHAIN_PROOF.md); it did not run this combined workflow.

## Optional isolated testnet check

The opt-in `node bouncer/demo-oracle-mission.mjs --dependent-workflow` script
sets up a **new** testnet account and v9 contract, then exercises the workflow
runner rather than the older static mission. `--seller-v2-workflow` selects the
same flow with v2 order binding required for all three resource steps; without
it, the original workflow uses legacy v1 memos. It uses an independent OutLayer
oracle paid in native testnet NEAR; the following compute, storage and API
orders are paid in Circle **testnet** USDC to Bouncer's self-hosted development
provider. Neither token has real value. The full-access owner performs the
bounded Ref testnet swap and vault funding as setup; those actions are not
agent-guarded. The source and every resource have separate on-chain policies
and restricted function-call keys.

The demonstration previews the combined maximum budget, chains the actual
verified result into each subsequent order, and deliberately discards the
response **after** the first FT transaction was broadcast. It stops, shuts down
the provider and journal, and invokes the ordinary workflow `--recover-only`
CLI in a separate process **without keys**. Only after that exact hash and its
delivery are verified can the FT agent resume the other steps. It checks the
actual data dependencies, one source broadcast, three FT broadcasts, final
vault balances and rolling spend. The GitHub Actions job runs only on an explicit
`[dependent-live]` push after JS, Rust and WASM checks pass; regular pushes are
unpaid. The separate explicit `[seller-v2-live]` push selects
`--seller-v2-workflow` and requires a different, seller-issued challenge for
all three resources. The Actions job runs only on the first run attempt; a
GitHub rerun is skipped rather than repeating payments. A new marker push would
still create a new paid testnet run, so never use one to retry an ambiguous
payment. In synthetic tests, both variants restart the seller and recover in a
real key-free CLI process; a local v2 seller-state check matches the three
persisted claims to the buyer's verified journal. Local state is not independent
proof that a seller behaved honestly or adopted the protocol.

The owner's Ref swap and Circle vault-funding transaction hashes are now
recorded in a separate public setup journal before their single submissions.
Those setup operations are **not** guarded agent swaps, and this journal does
not cover all other testnet setup transactions. The artifacts include the
public setup journal, workflow journal, workflow, orders, provider state and
optional success evidence for 90 days. They contain no private keys but
may disclose task data; do not use this public-artifact configuration for
private workloads. The ephemeral demo keys are not retained, so unpaid steps
cannot be resumed after the live process exits. Key-free recovery of already
paid steps still requires the preserved workflow, original journal and seller
state; when relocating the artifact, update only the local provider config's
`data_dir` to its restored directory, never the frozen workflow or journal.

The opt-in script makes new testnet transactions each time: do not rerun it to
"fix" an ambiguous outcome. Preserve its logs and artifacts and investigate the
recorded hash without paying again. It never adopts or touches the unrelated
unresolved project transaction described below. The published live run above is
one testnet observation, not a guarantee that another run will work or that an
independent FT-paid service has adopted this protocol.

`tests/dependent-history.test.mjs` reconstructs the chained inputs and checks
all three memos against the public execution receipts, entirely **offline**;
these vectors are not raw RPC responses. The optional
`scripts/verify-dependent-history.mjs` can additionally read the existing source
and payment receipts from a testnet RPC, verify the source and seller proofs,
and reject seller substitution. It has no key and sends no transactions. The
`[provider-inspect]` CI marker packs and installs the private SDK in an isolated
seller directory for this read-only verification. A [1 November check](https://github.com/Greatmujey/Bouncer/actions/runs/41259817473/job/124710584367)
verified the source and all three FINAL payment receipts using that installed
archive, rejecting substituted sellers; it sent no transactions. For the v2
run, `tests/seller-v2-history.test.mjs` reconstructs its source-dependent inputs
and three observed v2 memos offline; `scripts/verify-seller-v2-history.mjs`
optionally re-reads the source and each FINAL payment through a testnet RPC,
checking substituted sellers and challenges without signing or paying. A
[read-only job](https://github.com/Greatmujey/Bouncer/actions/runs/41263695312/job/124721960599)
ran that check with a separately installed SDK and accepted the existing source
and three FINAL receipts while rejecting substitutions. These vectors are not
raw RPC receipts; historical RPC availability is not guaranteed.

## What is reviewed

The owner supplies a JSON manifest such as
[`dependent-workflow.example.json`](../examples/dependent-workflow.example.json).
That file is a **schema example**, not a deployable configuration: its owner,
contract, seller and provider origin are placeholders, its policy revisions and
limits must match an actual deployment, and its Circle USDC ID is for testnet.
Never treat a token ID alone as proof of network or token trust. Its compute
step illustrates the optional seller-v2 binding; its other steps default to v1.

The manifest specifies one source and 1–10 sequential resource steps. Each step
pins its ID, resource, policy, token, payee, maximum amount, input template,
and optional exact quote amount, provider ID, provider origin and order binding.
All amounts are raw integer strings in the token's units, not automatically
converted USD.
The source and every step share one owner/contract and use distinct goal IDs.
The runner snapshots the normalized manifest before any asynchronous work; extra
fields, duplicate IDs, forward references and dynamic financial fields fail.

To require a seller-issued unique challenge for an individual resource step,
add the owner-reviewed field `"order_binding":"seller-v2"` to that step. The
seller must actually support v2; otherwise the quote is rejected rather than
downgraded. Omitted means legacy v1 and rejects an unsolicited v2 memo. This
choice is pinned in the journaled manifest; a seller or model cannot change it.
The buyer rejects a repeated seller challenge across paid and newly quoted
steps. The signed transaction hash and exact payment request are synced before
broadcast; after a restart, recovery reuses that exact hash and memo instead of
requesting a new quote or paying again. See the [wire protocol and limitations](PROVIDER_PROTOCOL.md#optional-seller-v2-binding).
The earlier linked testnet run used v1; the later v2 run used a self-hosted
seller, not an independent FT provider. Offline adversarial tests also exercise
v2 challenge reuse, state tampering and recovery.

For claim authentication instead, explicitly use `"order_binding":"seller-v3"`
with a supporting seller and durable execution. The exact reviewed origin is
bound into a signature by the payment transaction key, saved before broadcast;
key-free workflow recovery reuses it. Offline tests and the separate fresh
self-hosted v3 testnet proof exercise the real recovery CLI after a seller
restart. The signature is a replayable bearer credential:
never publish a v3 journal or expose it through the older public-artifact job.
See [v3 terms, wire bytes and limitations](SELLER_V3.md). This does not prove
independent seller adoption or safe distributed replay protection.

A data binding such as `{"from":"price"}` is permitted **only** in compute
`text`, storage `content`, or text-API `text`. It inserts a bounded JSON
artifact from an **earlier stage with verified payment and checked delivery**:
`version`, `kind`, `goal_id`, `tx_hash` and a canonical `result`. Neither a
verified payment nor an HTTP response proves that seller-supplied data is true.
Oracle warnings and unrecognized output
fields are not forwarded. Storage artifacts contain verified metadata, not the
file's contents. Resource-specific byte and CPU bounds are rechecked after
substitution. A literal GitHub `repo` remains supported, but its repository
identity alone is checked; its other returned fields are untrusted.

No source or provider output can select a policy, token, payee, maximum, exact
quote, endpoint, repository name, storage name, compute rounds or later binding.
Artifacts are data, not instructions. The development API currently computes
text statistics or returns fixed-origin public GitHub metadata; it is not a
general AI service. The development compute and storage checks remain bounded
recomputation and one readback, not proofs of arbitrary computation or durable
storage.

## How execution and budgets work

1. The source preflight checks its reviewed on-chain route and policy. For an
   unpaid `project` source, the runner also checks OutLayer's provider-held
   credit before and after the FT budget preview. Missing credit blocks; this
   runner **never funds the provider automatically**.
2. Before a new source payment, it previews every unpaid FT step at its approved
   maximum, or its exact amount if the owner pinned `quote_amount`. Shared
   policy budgets and shared FT vaults are aggregated. An unpaid prepaid
   project's fee is also counted against any shared FT policy's daily budget,
   without subtracting provider-held credit from the FT vault a second time.
   These are conservative, non-atomic views, **not reservations**; maximums may
   block an otherwise affordable set of later actual quotes.
3. The normalized workflow intent is persisted in the original journal before
   the source is signed and broadcast. The runner verifies the source's FINAL
   receipts and result, then materializes a single step. Its actual quote must
   match the exact derived order and reviewed policy, token, seller, price and
   route. A fresh policy check and signed-hash journal write precede payment.
   Delivery must be verified and durably recorded before the next step.
4. A historical oracle result may be replayed for recovery, but it must be
   within its owner-approved age immediately before every **new** resource
   payment, including after asynchronous guards and again after the journal is
   synced. Its timestamp is still provider supplied, not authenticated market
   freshness or a price proof. If the final check fails after journaling, no
   payment is sent; the signed hash remains pending for manual reconciliation.

The source can be `oracle` (the V9 owner-pinned single-source testnet project),
`random` (bounded legacy native OutLayer execution; the older on-chain method
allows an authorized agent to choose input), or `project` (the narrowly pinned
fake-USDC.e `fetch`/diagnostic `burn` connector). The project path requires
already credited provider funds plus separate native and prepaid policies; it
is not a Circle-paid commercial API. Provider refunds may remain in provider
custody. A project preflight and credit check cannot guarantee later execution.

The contract, not these previews, enforces caps, key grants and the payee
allowlist at execution. The owner needs a compatible testnet deployment, funded
vaults, trusted tokens and sellers, and distinct correctly scoped function-call
keys for the source method and `execute`. Policy and route changes still require
the owner's **1 yoctoNEAR** transaction. Views can change between checks; a
later failure can leave earlier payments spent, with no rollback. Providers can
charge yet fail delivery. Verify the deployed code independently; version
strings are not attestation.

## Local tests and commands

Node.js 22 is required. These tests never pay the network. The commented commands
show the guarded CLI shape for an independently prepared testnet deployment;
they will not work with the placeholder example or absent key files:

```bash
cd bouncer
npm ci --no-audit --no-fund
node --test tests/workflow.test.mjs tests/workflow-cli.test.mjs tests/batch-preflight.test.mjs
# After independently preparing and reviewing a private manifest, policy, provider, keys and vaults:
# npm run workflow -- --workflow "$HOME/.bouncer/workflow.json" --journal "$HOME/.bouncer/workflow-journal.json" --source-key "$HOME/.bouncer/source-key.json" --ft-key "$HOME/.bouncer/ft-key.json"
# Only after reviewing the dry run, explicitly opt in to testnet spending by adding --execute to that same command.
# Recovery needs the unchanged original manifest and journal, but no key and no --execute:
# npm run workflow -- --workflow "$HOME/.bouncer/workflow.json" --journal "$HOME/.bouncer/workflow-journal.json" --recover-only
```

The dry run checks the source and maximum-cost budgets, but cannot obtain an
exact downstream quote until its verified input exists; this workflow preview
does not create seller-v2/v3 quotes. By contrast, a standalone resource-agent dry
run or AI quote comparison does request quotes and can persist v2/v3 orders at a
seller. Execution rechecks the real quote and on-chain policy for every new
step. `--recover-only` reads chain
receipts and may contact the approved seller to complete/recheck already-paid
work, updating the journal. It **never signs, sends, requests a new quote or
starts an unpaid step**. Seller redemption must be idempotent for the original
transaction and order. The runner stops at the first unpaid stage. A normal
`--execute` resume first revalidates every paid stage, then may pay remaining
stages if budgets and freshness still permit it. Once the source has a journaled
transaction, the resume needs only the FT key, not the source's private key.

If a source or resource payment is pending, retain its signed hash and original
manifest/journal; an unavailable RPC or seller is not proof of non-payment.
Never automatically resend. This includes the separate unresolved project
transaction [DTJyQq7zMVtQFExeAtVSfKLSEkDSdmZerP3CJkWx8YUD](https://testnet.nearblocks.io/txns/DTJyQq7zMVtQFExeAtVSfKLSEkDSdmZerP3CJkWx8YUD):
the workflow runner does not adopt, fund or repeat it. See the README's retained
evidence and reconciliation status.

The journal stores the complete reviewed manifest, requests, results, public
keys and transaction hashes; it can contain sensitive task data. V3 also stores
replayable claim signatures, so it must be kept private even if the tasks are
public. Protect and back it up, never commit keys, claims or private inputs. File locking/fsync covers one
local journal on a filesystem that honors those operations, not multiple hosts,
directories or users. Deleting, editing or replacing the journal—or changing
all IDs and using another journal—can allow duplicate spending. Treat the host,
RPC, deployed contract, token, provider, manifest and any injected code as
trusted; this is not a distributed idempotency system, marketplace or audit.
