# Guarded independent compute (testnet)

Bouncer v5 and later can pay an independently operated provider, `outlayer.testnet`,
for a **bounded random-number example**. That particular integration uses
native testnet NEAR, not wNEAR, USDC or another fungible token. The current v9
source also supports a separately guarded prepaid FT funding and priced
connector path; its live test used fake USDC.e and returned HTTP 405, not useful
API data. A separate v9 native execution has since returned a single-source
public price; the FT-funded compute, storage and text-API services in that
mission remain self-hosted development services. This is unaudited software;
do not use real funds.

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

## Pinned price-data mission and earlier failures

V8 adds a pinned-input single-source price lookup and a mixed mission that can
include the returned value in development-resource orders. The first
[opt-in live test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41069232857/job/124109266232)
proved that changing the pinned input and exceeding the native cap were rejected
on chain, but [the requested lookup](https://testnet.nearblocks.io/txns/8hqLZGkuYAgB8EqMhjN58MeGcLNApHJ7EFi5jLNhk2Dy)
returned `null`. Recovery did not accept it as delivery, and no subsequent
resource purchases were sent. [Read-only receipt inspection](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41069934314/job/124111032227)
found that the published WASM imports project storage, which is unavailable to
an inline `WasmUrl` request. OutLayer reported charging
`1123300000000000000000` yoctoNEAR and refunding `98876700000000000000000`
to the owner. The hash must not be automatically retried; this was not a
successful independent price-data purchase.

The corrected [v9 Project-mode attempt](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41071182834/job/124116356927)
reached the oracle WASM, but its requested CoinGecko API returned HTTP 403. The
[final transaction](https://testnet.nearblocks.io/txns/HNPWAhuYaoctcCWd16E76rHcG2Amm3yKFGJYLEnhhJpx)
returned `success: false`; recovery refused it and no downstream Circle resource
payments were sent. OutLayer reported a completed WASM execution but an
application-level HTTP error, charging `1120300000000000000000` yoctoNEAR and
refunding `98879700000000000000000` to the owner. [Read-only reconciliation](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41072024180/job/124118338158)
confirmed the project ID, UUID and resolved hash. Both the zero-deposit contract
guard and the protocol's one-yocto restricted-key guard rejected escalation
probes. This hash must not be resent.

A [read-only research probe](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41072024180/job/124118338158)
found Coinbase's public NEAR/USD endpoint reachable from the GitHub runner,
which alone did not establish OutLayer worker reachability. An explicitly
separate [successful v9 mission](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41073097919/job/124122803916)
then pinned the exact GET URL and `data.amount` field in the owner's Project
input, with no headers, body, secrets or agent-selected URL. The independently
operated OutLayer [execution](https://testnet.nearblocks.io/txns/4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ)
returned `4.27625` USD, reported a native charge of `1111600000000000000000`
yoctoNEAR and a `98888400000000000000000` owner refund, and was recovered by
its original hash after an injected lost response. The full 0.1-NEAR maximum
remained in Bouncer's rolling budget. The input, cap, zero-deposit owner guard
and one-yocto restricted-key guard rejected adversarial probes.

The returned number was included in three orders to a **self-hosted** development
provider: Circle testnet USDC paid [compute](https://testnet.nearblocks.io/txns/7XxeU466RVYvVN3wBrWqXHu2zeHHyFPcs4WhNuFX2GbJ),
[storage](https://testnet.nearblocks.io/txns/GJkJMWBF2CCh1H5uh9uAKJJciTsqcvcgKvNXvnJrEvjL)
and [API](https://testnet.nearblocks.io/txns/7RxBwG4G6FRqG1o2shYRN2ES2WsxVFdEMd8NWp7zA5vy),
1,000 micro-units each. A deliberately corrupted compute result stopped the
other two payments until recovery reused the existing first FT transaction.
The owner's setup swap and funding were not guarded agent purchases. The test
uses no real-value USDC, and does not pay an independent provider in FT.

The oracle returns only a number and the label `custom`, not the original
Coinbase response; the endpoint, provider and RPC remain trusted. Its timestamp
is the worker's, not a verified market-observation time; no TEE attestation,
consensus, accuracy, commercial SLA or production readiness was established.
See [Coinbase's public endpoint documentation](https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices).

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
- V8 additionally provides `set_outlayer_input` and
  `execute_outlayer_pinned`. The owner pins an entire JSON input and the exact
  program, and installs an agent key scoped **only** to the pinned method.
  Route, policy, payee and program edits invalidate earlier signed routes. The
  legacy `execute_outlayer` method still allows that method's key to supply
  its own input: do not give it to an agent that needs exact-input isolation.
- V9 separately pins a native-only **Project** version and exact JSON input via
  `set_outlayer_native_project`; its key is restricted to
  `execute_outlayer_native_project`. The runner checks the public registry's
  project UUID, owner, version, resolved hash and lack of project pricing, then
  verifies that the final provider request carried that UUID and resolved hash.
  Those preflight views are non-atomic and provider-owned code/registry can
  change. Post-payment verification is not a refund or code attestation. This
  route sends `params: null` and no secrets; no prepaid FT is authorized. The
  oracle runner verifies receipts and a single-source result, but trusts the
  provider/RPC and does not verify TEE attestation or market-data accuracy. A
  worker timestamp is not authenticated freshness of the upstream market data.
  Oracle-led batches recheck that timestamp against the local clock before each
  new FT payment; expiry stops later purchases but cannot undo earlier ones.
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
provider delivered anything. The verifier binds the exact signed call and its
gas, unique receipt IDs, initiation, transfer and returned callback to the same
FINAL transaction. Incomplete or altered graphs remain unresolved; never
resend them automatically. It assumes the RPC, token and Bouncer code are
trustworthy and does not make raw Ref output a vault deposit.

The strengthened verifier was checked read-only against an [existing finalized
fake-token funding call](https://testnet.nearblocks.io/txns/3uMBAaenMBQzJyxPxEdH8tBg5M3rvAuoQy5oRpNx56MY/execution)
using [archival testnet receipts](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41287377861/job/124791317765).
It matched the independently pinned transaction, signing key, route and 10,000
base-unit settlement and rejected substituted receipt links and payee. The
check sent no payment and inspected neither the unresolved project transaction
nor a service result. It proves neither independent FT-paid delivery nor Circle
USDC support. `node scripts/verify-ft-call-history.mjs` repeats only this fixed
read-only check; old receipts may require an archival RPC.

The [live paid-provider test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40699116807/job/122854642930)
funded OutLayer with fake testnet USDC.e, then paid for a version-pinned
connectivity probe using that prepaid balance and native NEAR. The probe
returned HTTP **405**; it is not useful API data or a commercial API purchase.
The unified mission recovered that payment and continued to self-hosted FT
resources, stopping later payments until a corrupted local delivery was checked.

The runner also supports the independently operated connector's **`burn` test
operation**, pinned at 10,000 micro-units of fake USDC.e and 3,333 basis points
for the author. It accepts only canonical owner-pinned inputs with 1–200 rounds,
recomputes the iterated SHA-256 checksum locally, and parses the provider's
64-bit JSON number without JavaScript rounding. The live demo's `burn` mode asks
for 50 rounds (50,000 iterated hashes after the initial seed hash), and stages
a later **self-hosted** storage goal containing the verified result and
transaction ID. The operation is a diagnostic
benchmark, not arbitrary compute or a commercial resource. The `burn` path has
passing offline tests, but live delivery has **not** been established. In the
[30 October diagnostic](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41106347709/job/124237940287),
[funding](https://testnet.nearblocks.io/txns/3uMBAaenMBQzJyxPxEdH8tBg5M3rvAuoQy5oRpNx56MY)
credited OutLayer with 10,000 fake-token micro-units; the subsequent project
send remained unresolved. Its journaled hash is
`DTJyQq7zMVtQFExeAtVSfKLSEkDSdmZerP3CJkWx8YUD` for
`owner.bouncer-ft-69756b49.testnet`. A [read-only reconciliation](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41212677218/job/124570783704)
could not retrieve FINAL receipts: one RPC timed out and the other returned HTTP
408. The explorer did not show the hash, but absence there is **not** proof of
non-execution. The [public recovery evidence artifact](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41212677218)
contains the original journal and goal and expires 29 January 2027. Preserve them
and never automatically resend this transaction. The reconciliation script makes
only bounded status reads: it first asks for the current status, then requests
`FINAL` if needed; neither `NONE`, an unknown hash, nor a timeout establishes
non-payment. It labels endpoints by number and omits RPC error payloads and
failure details rather than logging potentially credential-bearing RPC paths.
The RPC is still trusted for its response. This diagnostic uses neither Circle
USDC nor a TEE attestation.

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

The optional demo creates **fresh testnet accounts**, a v9 deployment, synthetic
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
preview, and a later failure cannot undo an earlier payment. If resource goals
opt into `seller-v2`, their quote preview may persist unpaid orders at the
seller; live mixed and paid-project missions require `--durable` before starting
any independent payment. See the [seller protocol](PROVIDER_PROTOCOL.md#optional-seller-v2-binding).

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
