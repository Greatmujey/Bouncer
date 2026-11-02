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

The [guarded live job](https://github.com/Greatmujey/Bouncer/actions/runs/40682550107/job/122797278579)
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

The [AI-planned mixed mission](https://github.com/Greatmujey/Bouncer/actions/runs/40682550107/job/122797278689)
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
[opt-in live test](https://github.com/Greatmujey/Bouncer/actions/runs/41069232857/job/124109266232)
proved that changing the pinned input and exceeding the native cap were rejected
on chain, but [the requested lookup](https://testnet.nearblocks.io/txns/8hqLZGkuYAgB8EqMhjN58MeGcLNApHJ7EFi5jLNhk2Dy)
returned `null`. Recovery did not accept it as delivery, and no subsequent
resource purchases were sent. [Read-only receipt inspection](https://github.com/Greatmujey/Bouncer/actions/runs/41069934314/job/124111032227)
found that the published WASM imports project storage, which is unavailable to
an inline `WasmUrl` request. OutLayer reported charging
`1123300000000000000000` yoctoNEAR and refunding `98876700000000000000000`
to the owner. The hash must not be automatically retried; this was not a
successful independent price-data purchase.

The corrected [v9 Project-mode attempt](https://github.com/Greatmujey/Bouncer/actions/runs/41071182834/job/124116356927)
reached the oracle WASM, but its requested CoinGecko API returned HTTP 403. The
[final transaction](https://testnet.nearblocks.io/txns/HNPWAhuYaoctcCWd16E76rHcG2Amm3yKFGJYLEnhhJpx)
returned `success: false`; recovery refused it and no downstream Circle resource
payments were sent. OutLayer reported a completed WASM execution but an
application-level HTTP error, charging `1120300000000000000000` yoctoNEAR and
refunding `98879700000000000000000` to the owner. [Read-only reconciliation](https://github.com/Greatmujey/Bouncer/actions/runs/41072024180/job/124118338158)
confirmed the project ID, UUID and resolved hash. Both the zero-deposit contract
guard and the protocol's one-yocto restricted-key guard rejected escalation
probes. This hash must not be resent.

A [read-only research probe](https://github.com/Greatmujey/Bouncer/actions/runs/41072024180/job/124118338158)
found Coinbase's public NEAR/USD endpoint reachable from the GitHub runner,
which alone did not establish OutLayer worker reachability. An explicitly
separate [successful v9 mission](https://github.com/Greatmujey/Bouncer/actions/runs/41073097919/job/124122803916)
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

### V11 compatibility and present limits

The FT-call and project runners now recognize the pinned V11 code only after a
fresh, single-FINAL-block check of its owner, code hash, zero vault keys, a
finite-allowance **one-method** owner access key, and the relevant exact-intent
policy and token/payee locks. The funding route, policy, grants and (for a
project) provider price, version and credit are read from that same block. A
V11 project preflight also checks that OutLayer reports at least the vault's
tracked prepaid allowance for the **vault account**, the actual predecessor;
a deficit blocks spending for reconciliation. Excess provider credit is not
made spendable automatically. The runners still require the exact owner-pinned terms and original-hash journal;
settlement is not provider delivery. Older versions keep their existing checks.
The current replacement Circle agent's two-method key does **not** satisfy
these runner requirements; provider-specific keys have not been installed.

V11 enforces the exact-policy lock on-chain for both methods, and the
exact-token/payee lock for direct FT calls. **Its prepaid project method does
not enforce the token/payee lock on-chain.** The runner's additional pair-lock
check is only a snapshot: it can race, and a signer calling the contract directly
can bypass it. Do not treat that off-chain check as an on-chain isolation
primitive. Provider-held credit and refunds also need explicit recovery review:
a later plain-FT return to the keyless vault does not restore its tracked FT
ledger. No new OutLayer funding or execution is authorized merely by adding
runner compatibility; live prices, configured token, deployed code/behavior,
terms and a safe recovery path still need verification. OutLayer currently uses
fake `usdc.fakes.testnet`, **not Circle test USDC**.

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
using [archival testnet receipts](https://github.com/Greatmujey/Bouncer/actions/runs/41287377861/job/124791317765).
It matched the independently pinned transaction, signing key, route and 10,000
base-unit settlement and rejected substituted receipt links and payee. The
check sent no payment and inspected neither the unresolved project transaction
nor a service result. It proves neither independent FT-paid delivery nor Circle
USDC support. `node scripts/verify-ft-call-history.mjs` repeats only this fixed
read-only check; old receipts may require an archival RPC.

The [live paid-provider test](https://github.com/Greatmujey/Bouncer/actions/runs/40699116807/job/122854642930)
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
[30 October diagnostic](https://github.com/Greatmujey/Bouncer/actions/runs/41106347709/job/124237940287),
[funding](https://testnet.nearblocks.io/txns/3uMBAaenMBQzJyxPxEdH8tBg5M3rvAuoQy5oRpNx56MY)
credited OutLayer with 10,000 fake-token micro-units; the subsequent project
send remained unresolved. Its journaled hash is
`DTJyQq7zMVtQFExeAtVSfKLSEkDSdmZerP3CJkWx8YUD` for
`owner.bouncer-ft-69756b49.testnet`. A [read-only reconciliation](https://github.com/Greatmujey/Bouncer/actions/runs/41212677218/job/124570783704)
could not retrieve FINAL receipts: one RPC timed out and the other returned HTTP
408. A [later status-only recheck](https://github.com/Greatmujey/Bouncer/actions/runs/41290865530/job/124801658634)
received RPC errors or missing results from both configured endpoints and did
not resolve the transaction; it submitted **zero** new payments. The explorer
did not show the hash, but absence there is **not** proof of non-execution. The
[public recovery evidence artifact](https://github.com/Greatmujey/Bouncer/actions/runs/41212677218)
contains the original journal and goal and expires 29 January 2027. Preserve them
and never automatically resend this transaction. The reconciliation script makes
only bounded status reads: it first asks for the current status, then requests
`FINAL` if needed; neither `NONE`, an unknown hash, nor a timeout establishes
non-payment. It labels endpoints by number and omits RPC error payloads and
failure details rather than logging potentially credential-bearing RPC paths.
The RPC is still trusted for its response. This diagnostic uses neither Circle
USDC nor a TEE attestation.

The runner also has a **synthetic-only `vrf` diagnostic path**. The goal pins a
canonical seed, the fake-token price, project/version, and an independently
obtained 32-byte testnet public key. It verifies the exact guarded transaction,
linked provider request/completion, fee split and native refund, then checks an
Ed25519 signature over `vrf:{request_id}:{owner}:{seed}` and recomputes the
SHA-256-derived output. A returned public key alone is not sufficient: the goal
must contain a separately reviewed pin, and a mismatched key is rejected. This
checks a signed value, not the fairness of the key or a TEE attestation. The
connector's own documentation calls it a test probe, not a commercial API; no
live FT-paid VRF fulfillment has been demonstrated. The [public testnet key
endpoint](https://testnet-api.outlayer.ai/vrf/pubkey) and current registry views
must be rechecked before any new, explicitly approved order. Do not use this as
a substitute for resolving or replaying the separate ambiguous burn transaction.

An opt-in one-shot harness for this VRF diagnostic has not yet shown a live
result. Its [first live attempt](https://github.com/Greatmujey/Bouncer/actions/runs/41301880679/job/124834811981)
used a fresh testnet contract, account and fixed new seed—not the unresolved
burn account or hash. It acquired and funded fake test tokens, then stopped
before any OutLayer deposit or project payment when the separately journaled
wNEAR refund-test funding returned `Expired`. Its original setup hash
`HUW8m6dQjyhBEr1KihELt6qXA92cuWzjSJ84q7AbRy3D` and artifact `13081947040`
must be retained and reconciled; do not resend it automatically. A later
[key-free inspection](https://github.com/Greatmujey/Bouncer/actions/runs/41303152030/job/124838094977)
confirmed the first two original hashes FINAL and fake-token ledger/balance
`10000`, but the third remained unavailable, with the observed wNEAR vault
ledger and OutLayer prepaid balance both zero. These point-in-time balances
are not proof that the missing hash never paid. The inspection made no sends
or journal writes. Before
creating an account, the earlier harness sealed its disposable keys to a
recovery public key. **Its matching private key has not been located in this
workspace**; do not assume the old envelope can be opened. Its owner setup
transfers, OutLayer prepaid deposit and project payment each record an original
hash before broadcast. An uncertain outcome stops and is not retried. The
envelope is testnet-only, does not authenticate its creator, and does not replace
checking recovered keys against FINAL chain state. A genuine signed diagnostic
would still not establish an independent commercial seller, Circle-USDC
acceptance, unbiased key selection or a TEE attestation.

### Fresh one-shot VRF2 attempt

`paid-vrf2-once.mjs` is a separately fenced, **testnet-only** diagnostic: a
fresh vault, owner, keys and random seed; a known local recovery private key;
and no dependency on the earlier unrelated wNEAR refund test. Before creating
accounts it checks the provider's exact current token, version, VRF key, price,
bounded native estimate, storage prices and a bounded Ref quote. The same
read-only checks are available separately in `probe-vrf2-ready.mjs`. A small
**owner-setup** Ref swap acquires fake `usdc.fakes.testnet`,
not Circle USDC. An owner funds and configures the fresh V9 vault using reviewed
1-yocto policy calls and two restricted agent keys. The project is preflighted
before moving any FT to OutLayer. The maximum provider deposit is 10,000 fake
micro-units; the separate project cap is 10,000 fake micro-units plus at most
0.1 testnet NEAR. Provider terms are rechecked, but these views are non-atomic
and do not prevent later changes or prove worker code.

Every signed setup/payment hash and public intent is persisted and annotated
before its single bounded send; an unknown result is inspected by the original
hash and never automatically repeated. Both payment stages deliberately discard
one complete receipt response, then reopen the encrypted journal and recover by
hash without using a NEAR signing key. The runner requires exact same-FINAL-block
vault/provider balance and rolling-budget snapshots. `inspect-paid-vrf2.mjs`
is a separate read-only reinspection of the original FINAL receipts, owner
1-yocto configuration actions, scoped keys, pinned vault code, snapshots,
provider settlement and the seed/identity-bound VRF signature. Its signature
verification relies on an independently pinned key and trusted RPC; it does not
prove key selection is unbiased or a TEE was used. Send counts are local
instrumentation, not a chain-wide proof that nobody else submitted a payment.

A [read-only readiness check](https://github.com/Greatmujey/Bouncer/actions/runs/41318158244/job/124882513959)
on November 1 observed the reviewed terms and a bounded test-token quote; it
created no accounts and sent nothing. The [first fenced VRF2 job](https://github.com/Greatmujey/Bouncer/actions/runs/41318427551/job/124883910483)
stopped at the WASM hash gate **before key generation, account creation or any
send**: the newly compiled CI artifact did not equal the reviewed committed V9
binary. It produced no VRF2 recovery artifact. The corrected fence used the
exact committed binary and rechecked its full pinned SHA-256; this does not
prove source-to-binary reproducibility. On a later push, CI automatically
committed a different 452,675-byte build (`0b64d56ba4de76d63a915dc96887d1eb5ec63d11c09e110b5caa589dea163994`)
over the reviewed binary despite no contract source change. It was not deployed.
The reviewed SHA-256 (`835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee`)
was restored, and CI now only uploads its new builds for review instead of
pushing them into the branch. These observations are preserved under
`evidence/outlayer-vrf2-preflight-20261101/` and do not establish delivery.

The [fresh pinned attempt](https://github.com/Greatmujey/Bouncer/actions/runs/41318744634/job/124885009403)
created and locked vault `bouncer-vrf2-3a0af45958.testnet`, acquired fake test
USDC.e in an owner-setup swap, and stopped on the **original** owner-to-vault
funding hash `uhtVNNJewFmpTSVzZ7fr8ReZnvmVenjWcm92XafQRHn`: its one-shot
response and immediate hash lookup did not establish FINAL status. The runner
never reached the OutLayer prepaid deposit or a VRF order. No provider payment
or delivery is proven. Public original intents are in
`evidence/outlayer-vrf2-setup-20261101/`; the sealed credentials and encrypted
journal were retained in artifact `13088557059`. **Do not resend the original
funding transaction**, even if a later view appears to show no balance. The
read-only `inspect-vrf2-setup.mjs` examines only those original hashes on two
RPC endpoints and a same-block vault/provider snapshot; an unavailable hash
remains unresolved. A [subsequent read-only inspection](https://github.com/Greatmujey/Bouncer/actions/runs/41319333855/job/124886012566)
verified the first five setup hashes FINAL on both FastNear and archival RPCs,
but the original funding hash was still unavailable on both. At FINAL block
`5skusbW8qh6FXDYGqJcya2QWRtqQza4XbBtQ553YCYDF` the owner held 227,853 fake
micro-units, while the vault ledger/token balances and OutLayer prepaid balance
were zero; the funding/project policies had not yet been created. Those views
do **not** prove the unavailable transaction was never accepted. The inspection
sent nothing and wrote no journal entries. The original encrypted journal was
reconstructed and authenticated locally at that time; it recorded the hash
pending. **Recovery-key incident:** after the sandbox restarted, the RSA private
key and local decrypted/reconstructed files that had been stored outside the
repository were no longer present. The private half is currently unavailable;
the artifact still contains the sealed credentials and encrypted journal, but
we cannot presently authenticate or decrypt them. A second encrypted artifact
copy is `13089055574`; both expire 30 January 2027. The public intent and
original hash remain in the repository. Do not treat the ciphertext as an
accessible journal or silently create a replacement payment. The old paid VRF2
script now refuses to run with that retired recovery key before any network
activity.

Only if an independently preserved copy of the original RSA private key is
restored can `unseal-vrf2-journal-key.mjs` derive the original journal key to a
new private file without writing NEAR signing keys. Future live attempts need
an operator-controlled durable key backup verified before any side effects;
an ephemeral sandbox path alone is insufficient. Neither the file lock nor in-process FT/project exclusion
protects against discarded or rolled-back journals, other journal paths,
bypassing callers or multiple independent databases. Injected RPC providers
must independently provide bounded one-attempt sending. Do not rerun the
one-shot CI job or issue a replacement payment if an original hash is unknown.
A successful diagnostic would narrow the independent-FT gap, **not** prove an
independent commercial Circle-USDC compute, storage or API purchase.

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
