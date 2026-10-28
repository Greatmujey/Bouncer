# Guarded independent compute (testnet)

Bouncer v5 and later can pay an independently operated provider, `outlayer.testnet`,
for a **bounded random-number example**. That particular integration uses
native testnet NEAR, not wNEAR, USDC or another fungible token. The current v7
source also supports a separately guarded prepaid FT funding and priced
connector path; its live test used fake USDC.e and returned HTTP 405, not useful
API data. Storage, API/data and the other compute examples still use Bouncer's
self-hosted development services. This is unaudited software; do not use real funds.

## What has been demonstrated

The [guarded live job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40682550107/job/122797278579)
created a fresh contract and a **different owner**. The owner pinned a WASM
URL and SHA-256, WASI target, instruction/memory/time limits, a native policy,
OutLayer payee and caps. A separate function-call key could call only
`execute_outlayer`; contract-level policy also had to grant that key. A probe
key's zero-deposit attempt to change the program was rejected, as was an
execution above the per-transaction cap.

The [guarded payment](https://testnet.nearblocks.io/txns/HPYWoHrEozKWirbZdgiJkRDp9hShJBmzXSShJd2d99rQ)
attached a maximum of 0.1 testnet NEAR and returned `93` for the requested
1–100 range. OutLayer reported a charge of `1018500000000000000000` yoctoNEAR
(0.0010185 NEAR); the verifier found a successful transfer of the remaining
`98981500000000000000000` yoctoNEAR (0.0989815 NEAR) to the separate owner.
An intentionally corrupted **local** evidence response was rejected; a
separate CLI process recovered the same transaction without a private key and
made no second payment. The
full maximum remained charged against the rolling budget, and the owner
withdrew the remaining tracked native vault balance.

The [AI-planned mixed mission](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40682550107/job/122797278689)
then combined an owner-selected [independent OutLayer payment](https://testnet.nearblocks.io/txns/5ShjrS8JiJ5yyQPKDvFGnwtobpL2vQUbXTFchPuGD53r)
with model-proposed compute, storage, text API and GitHub-data tasks on the
same separate-owner Bouncer deployment. The three FT assets were wNEAR and two
synthetic credits; their providers were self-hosted development services.
An intentionally wrong local FT result stopped later FT payments, and recovery
used the same transaction. The model did not choose the OutLayer task or any
financial settings.

This result trusts the configured RPC and the OutLayer contract. Checking a
number is in range does **not** independently prove TEE attestation, correct
execution, or statistical randomness. It does not establish any delivery SLA,
production reliability, independent storage/API service, FT payment to this
native compute example or a real-value stablecoin purchase. The local fault
does not imply provider misconduct.

## Asset and policy semantics

- `deposit_native` tracks an explicit native vault balance, distinct from FTs,
  storage collateral and the contract's operational balance. Anyone can fund
  it; only the owner can withdraw it with **exactly 1 yoctoNEAR**.
- The owner creates a policy with the reserved asset name `native`, allows
  `outlayer.testnet`, pins the program via `set_outlayer_program`, grants a
  signing key to that policy, and separately installs that key as a NEAR
  function-call key restricted **only** to `execute_outlayer`. Policy changes,
  key grants, program changes and withdrawals are owner-only 1-yocto calls.
  The on-chain call itself requires zero attached deposit and verifies the
  owner signer, key grant, payee allowlist, native vault, per-call cap, rolling
  daily budget, exact program and an at-most-4096-byte JSON object. The JS
  runner further restricts the random-number input and output.
- OutLayer receives the specified maximum deposit. Bouncer immediately debits
  and counts that **entire maximum**, even if OutLayer charges less. For an
  accepted execution the provider is instructed to refund unused native NEAR
  **directly to the owner**, not to the Bouncer vault. There is no automatic
  restoration of the unused amount to the native vault or daily budget. This
  conservative reservation prevents an ambiguous callback from creating
  spendable balance that may no longer exist.
- A request rejected before OutLayer accepts it may return NEAR to the contract
  itself rather than to the owner. Such a transfer is not automatically credited
  to the tracked vault or budget. After examining final receipts, the owner can
  use `withdraw_native_surplus` with 1 yocto to withdraw available **untracked**
  balance above storage, tracked vault and a fixed reserve; that method does not
  identify the source of surplus or change the budget. An accepted but failed
  execution may instead charge part of the deposit and refund part to the owner.
  Do not assume any full refund from a failed promise.
- `native` is a reserved accounting sentinel, not a NEP-141 contract; the FT
  runner rejects it. OutLayer's separate prepaid FT payment keys and direct
  x402 delegation are not this guarded per-call payment and are not used here.

## Separate prepaid FT and priced connector path

V7 can fund an owner-pinned OutLayer prepaid balance using `execute_ft_call`,
then call an owner-pinned project under **separate** native and prepaid-token
policies. The FT route fixes the token, receiver and exact message, with policy
and route revisions; the project route fixes its version, input, fee and
resource limits. Separate restricted keys and policy grants are required. FT
settlement proves only how much the trusted token reports as used, not that a
provider delivered anything.

The [live paid-provider test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40699116807/job/122854642930)
funded OutLayer with fake testnet USDC.e, then paid for a version-pinned
connectivity probe using that prepaid balance and native NEAR. The probe
returned HTTP **405**; it is not useful API data or a commercial API purchase.
The unified mission recovered that payment and continued to self-hosted FT
resources, stopping later payments until a corrupted local delivery was checked.

Provider-held credit is distinct from Bouncer's FT vault. In this path a project
refund can be credited to Bouncer's balance **at OutLayer**, not returned to
Bouncer's vault. The conservative local ledger can understate returned credit
and strand it; no general user-balance withdrawal is assumed. Provider and
contract balance views are non-atomic. Reconcile any ambiguous or failed payment
manually; never automatically repay. Pricing, versions, contract code, RPC and
provider behavior remain trust assumptions. Inspect `ft-call.mjs`,
`outlayer-project.mjs` and `paid-mission.mjs` with `--help` for their separate
reviewed goals and journals.

## Try the mixed mission

The optional demo creates **fresh testnet accounts**, a v7 deployment, synthetic
FTs, local development services and a small native OutLayer budget. It uses two
separate restricted keys and saves them privately in
`~/.near-credentials/testnet/`; goals and journals are in `~/.bouncer/testnet/`.
No external wallet or faucet website is needed. Testnet availability can change.

```sh
cd /workspaces/Bouncer
git pull --ff-only
npm install --prefix bouncer
BOUNCER_DEMO_OUTLAYER=1 BOUNCER_DEMO_SEPARATE_OWNER=1 BOUNCER_DEMO_COMPARE=1 BOUNCER_DEMO_BAD_DELIVERY=1 node bouncer/demo-multi-resource.mjs
```

The owner-selected independent example is added to the same contract and
journal as the FT goals. The reusable `mixed-mission.mjs` runner previews the
native policy and the entire FT batch before a new payment, verifies the
OutLayer result before starting the FT payments, and then lets the FT runner
verify each resource before paying the next. If the first FT delivery was
previously paid but unverified, a **new** OutLayer payment is blocked until
that earlier delivery is reconciled; if the OutLayer payment already exists,
the runner recovers it by hash and resumes the FT recovery path. Neither
preview reserves funds on chain. Policies, balances or quotes may change after
preview, and a later failure cannot undo an earlier payment.

The regular planner can supply the FT goal inputs, including model-proposed
inputs checked against the owner catalog. In the demo the independent random
task is **owner-selected**, not generated by the model. The optional model is
not given the keys or authority to change a policy, program or payment amount.

The demo writes `<contract>.mission.json` and separate `.agent.json` and
`.outlayer-agent.json` keys. To inspect or replay the saved mission using the
same journal and local development provider, omit `--execute` for a dry run;
only add it after reviewing every goal. A completed mission reuses its recorded
payments rather than paying again. A different/deleted journal removes that
protection. Run `node bouncer/agent/mixed-mission.mjs --help` for the CLI.

## Recovery and privacy

Before broadcasting a new OutLayer transaction the runner signs locally and
persists its transaction hash, reviewed goal and **public** signing key in the
file journal. A timeout, crash, unavailable receipt or invalid delivery leaves
that hash pending; the runner never automatically signs or broadcasts a
replacement. Recovery fetches that same hash with `FINAL` and needs no private
key. A pending hash might never have been broadcast or might have expired: an
RPC saying it is unavailable is not permission to resend. Reconcile manually.
If the journal write fails, the send is not attempted.

To recover a standalone goal, keep its reviewed JSON and original journal and
run `node bouncer/agent/outlayer.mjs --goal GOAL.json --state JOURNAL.json --recover`.
The command does not send a transaction. Older journals without the public key
require the original signing key through the regular execution path. Do not
remove or replace the journal to bypass a blocked state. The file and directory
are synced on writes and protected by an exclusive local lock, but the journal is editable
and cannot prevent duplicates across different files, hosts or compromised
machines. A crash can leave a stale `.lock`; confirm no writer is running
before removing only that lock, never the journal. Nonce tracking is
process-local. Preserve backups securely.

Inputs, provider URLs and results can be visible to OutLayer, the RPC, the
chain and local journal. Never put secrets in them. The opt-in CI jobs upload
only their **synthetic** testnet journals on failure, not keys; do not upload
real/private journals to a public artifact store. The verifier checks finalized
transaction arguments, the matching OutLayer request/completion, the exact
charge/refund and refund transfer, and the output shape. It is not a light
client, provider attestation verifier, invoice or guarantee of future service.
