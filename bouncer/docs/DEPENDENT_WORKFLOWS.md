# Owner-reviewed dependent resource workflows

**Status: unaudited testnet prototype. Do not use real funds.** The workflow
runner connects a verified independent OutLayer result to later, ordered
compute, storage and API requests. The end-to-end coverage for this new runner
uses **synthetic chain receipts and a self-hosted development provider**; it is
not a new live test or evidence that an independent FT seller supports Bouncer.
Earlier live transactions are documented separately in the [README](../../README.md).

## Optional isolated testnet check

The opt-in `node bouncer/demo-oracle-mission.mjs --dependent-workflow` script
sets up a **new** testnet account and v9 contract, then exercises the workflow
runner rather than the older static mission. It uses an independent OutLayer
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
unpaid. Its public journal, workflow, orders, provider state and optional
success evidence are uploaded for 90 days. They contain no private keys but
may disclose task data; do not use this public-artifact configuration for
private workloads. The ephemeral demo keys are not retained, so unpaid steps
cannot be resumed after the live process exits. Key-free recovery of already
paid steps still requires the preserved workflow, original journal and seller
state; when relocating the artifact, update only the local provider config's
`data_dir` to its restored directory, never the frozen workflow or journal.

The opt-in script makes new testnet transactions each time: do not rerun it to
"fix" an ambiguous outcome. Preserve its logs and artifacts and investigate the
recorded hash without paying again. It never adopts or touches the unrelated
unresolved project transaction described below. The presence of this harness or
passing synthetic tests alone is **not** a claim of a successful live run or an
independent FT-paid service.

## What is reviewed

The owner supplies a JSON manifest such as
[`dependent-workflow.example.json`](../examples/dependent-workflow.example.json).
That file is a **schema example**, not a deployable configuration: its owner,
contract, seller and provider origin are placeholders, its policy revisions and
limits must match an actual deployment, and its Circle USDC ID is for testnet.
Never treat a token ID alone as proof of network or token trust.

The manifest specifies one source and 1–10 sequential resource steps. Each step
pins its ID, resource, policy, token, payee, maximum amount, input template,
and optional exact quote amount, provider ID and provider origin. All amounts
are raw integer strings in the token's units, not automatically converted USD.
The source and every step share one owner/contract and use distinct goal IDs.
The runner snapshots the normalized manifest before any asynchronous work; extra
fields, duplicate IDs, forward references and dynamic financial fields fail.

A data binding such as `{"from":"price"}` is permitted **only** in compute
`text`, storage `content`, or text-API `text`. It inserts a bounded JSON
artifact from an **earlier, verified** stage: `version`, `kind`, `goal_id`,
`tx_hash` and a canonical `result`. Oracle warnings and unrecognized output
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
exact downstream quote until its verified input exists. Execution rechecks the
real quote and on-chain policy for every new step. `--recover-only` reads chain
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
keys and transaction hashes; it can contain sensitive task data. Protect and
back it up, never commit keys or private inputs. File locking/fsync covers one
local journal on a filesystem that honors those operations, not multiple hosts,
directories or users. Deleting, editing or replacing the journal—or changing
all IDs and using another journal—can allow duplicate spending. Treat the host,
RPC, deployed contract, token, provider, manifest and any injected code as
trusted; this is not a distributed idempotency system, marketplace or audit.
