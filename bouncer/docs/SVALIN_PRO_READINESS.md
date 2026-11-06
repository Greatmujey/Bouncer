# Independent Svalin Pro: testnet discovery and experimental buyer

**Status: the public offer and free route have been observed. The buyer and
original-hash recovery passed on a disposable nearcore chain with a fake seller
and mock FT. Activation and report paths have synthetic tests and an optional
local test against the pinned independent seller source; that source test uses
a simulated chain/indexer and a labelled sample portfolio. No real checkout has
been reserved, no provider-linked bearer code created, no live testnet token
sent to Svalin, and no independent FT-paid fulfillment verified. The adapter
is experimental, unaudited, and not ready for consequential use.**

On 1 November 2026 at about 19:25 UTC, the independent Svalin service's
[public offer](https://svalin-api.noobshole.workers.dev/v1/pro) advertised a
monthly pass for **5 testnet USDC** plus a small exact-amount suffix, 30 days,
and 100 paid-route calls per day. Its NEAR offer named `near:testnet`, Circle's
[testnet USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses)
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7b23cc04ea7eb7a6c3c32520d03d4afcb8af`,
and `svalin-agent.testnet`. Testnet USDC has no real value. The free
`/v1/demo/risk/root.near` returned a JSON report; this is neither paid delivery
nor a validation of the report's accuracy. A later anonymous GET on 6 November
at approximately 16:20 UTC listed the monthly pass at **9**, not 5 test USDC.
The historical 5-USDC profile below must not be treated as the current price;
all prices and availability may change.

## Why this may close part of the FT gap

In Svalin's [source at commit `7ebfb14`](https://github.com/noobshole/svalin-agent/tree/7ebfb14f35630dfc1665b04993e684b5444133fb),
`POST /v1/pro/near` reserves a **unique exact USDC amount** against a secret
Pro code, and `POST /v1/pro/activate` looks up the token's transfer events via
FastNEAR. The [reader](https://github.com/noobshole/svalin-agent/blob/7ebfb14f35630dfc1665b04993e684b5444133fb/apps/api/src/payments/pro-payments.ts)
counts NEP-141 events in successful token receipts, net of transfers from the
seller in the same transaction; it does not require the outer transaction to
call the token directly. This *suggests* compatibility with Bouncer's nested
`ft_transfer`, without requiring canonical x402's incompatible direct delegated
transfer. A previous **self-hosted vendor** transaction was independently shown
to be FINAL and discoverable by the same testnet FastNEAR account/transaction
endpoints ([historical evidence](../evidence/multiagency-read-20261101/readiness-corrected.json)).
It was **not** a Svalin payment. Source code is not an attestation of the
running service, and the different payee, scan window, paging and timing still
need a real end-to-end test.

The pinned source matches an exact amount, network and reservation time, **not
the payer**. It uses a bearer code: anyone who gets the code can use the pass.
Amounts are reserved for two days and are held against reassignment longer;
activation waits at least 15 seconds before inspecting new NEAR transactions,
and scans a bounded history. Another sender could pay the same reserved amount;
misattribution, duplicate payments, late transactions, incomplete indexing,
merchant downtime and refunds remain risks. A successful transfer alone is not
proof that the seller activated the right code or delivered useful data. In an
in-process test of this source, a simulated different sender paid the same
amount and the seller credited that different transaction even while Bouncer's
separate simulated receipt showed its own transfer. Bouncer correctly kept
`seller_attribution_verified: false`. This demonstrates the source-level
ambiguity, not a real payment or an observation of the deployed seller.

## Owner authority and the narrow trial profile

The on-chain 1-yocto guard authenticates the **immediate owner account** and
attached deposit, not a human decision. If that owner is a contract, it may
forward a 1-yocto call and the vault intentionally trusts the contract's own
authorization. This is an existing, tested trust boundary, **not a demonstrated
live exploit** and not a judgment that all contract wallets are unsafe.

For this Svalin trial only, setup preflights, the separate pre-reservation
preflight, the reservation function and the payment runner require the trusted
RPC's owner account view at the pinned FINAL block to indicate an initialized
account with the empty local code hash and no global-contract hash or account
reference. Missing, malformed, wrong-block or unavailable data blocks the
relevant check. The reservation function enforces this **narrow owner check**
before seller contact; the full balance/policy preflight is still a separate
operator-run check, not automatically enforced by reservation. The payment
runner checks before signing and again at a fresh FINAL snapshot after writing
the signed hash but before sending. If the recheck fails, the original hash
remains fenced and must not be automatically replaced or resent. Other adapters,
including MultiAgency, retain their existing owner-contract behavior and need a
separate assessment.

This is a point-in-time, off-chain risk reduction, **not an on-chain fix**.
The owner may deploy or adopt code later; already queued receipts may execute
later; a trusted RPC can lie; full-access keys can be compromised; and a
code-free view does not prove owner consent or rule out other privileged
transactions. Independent artifact/owner-path review and explicit approvals are
still required. Original-hash recovery must not be blocked or replaced merely
because the owner's current state has changed.

## What Bouncer can do today

- `agent/svalin-setup-plan.mjs` prepares **offline, unsigned** NEAR SDK action
  batches for a new, direct-child V11 testnet vault. It groups account creation,
  initial NEAR transfer, deployment and `new` in one receipt without adding a
  vault key; groups policy, payee, irreversible exact-intent lock and agent
  grant in another; describes the owner's restricted `execute_exact_ft` key;
  and prepares separate Circle `storage_deposit` and `ft_transfer_call`
  batches. The reviewed registration deposit is capped at 0.1 test NEAR and
  must match the current Circle minimum before a future separately approved
  registration. The lock is ordered before the agent grant, and every
  configuration call attaches exactly one yoctoNEAR. Owner/seller registration
  and acquisition of test USDC remain separate prerequisites, not assumed
  successes. This planner has **no signer, RPC, journal, broadcast, actual
  registration, seller request or execution path**.
  Its artifact hash, V11 marker, function exports and action commitments catch
  some accidental substitutions, but can be forged and are not an audit,
  approval, a real transaction hash, or proof that the binary came from this
  source. The action objects are mutable; the library can compare them to a
  separately retained review before any approved signing workflow. An
  experimental CLI is described below; neither it nor the artifact has been
  independently reviewed or used for a real V11 deployment.
- `agent/svalin-setup-evidence.mjs` is an **offline library**, not an
  executor. It can verify an already-signed SDK transaction's Ed25519
  signature and exact reviewed bytes and derive its real transaction hash; it
  does not sign or retain the broadcastable signed bytes. Given the original
  retained plan, an independently retained review digest, original transaction
  hash and owner public key, it checks a supplied receipt-inclusive `FINAL`
  result against the constrained batch, signer,
  receiver, transaction and root receipt. Deployment actions compare the
  base64-encoded SHA-256 in NEAR's action view, not raw WASM. For the new
  Circle registration it requires the reviewed deposit, the expected returned
  storage balance and no refund child. This models Circle's inspected source;
  the deployed token and real receipts have not been verified. For the later
  Circle `ft_transfer_call`, it additionally requires the exact token transfer
  event, linked vault callback, full resolver result and the promise-data
  dependency from that callback to that resolver. Missing or mismatched data
  is unresolved; a FINAL failure is a warning to reconcile, not permission to
  retry. It fetches nothing and has no journal, signer, sender or retry path.
  The caller must keep the original review, hash, public key and durable
  authenticated journal safe; neither this library nor a digest proves approval
  or journal integrity. Signed bytes can be broadcast and must be protected;
  the offline signature check does not verify current key permissions, nonce or
  block freshness. Receipt inspection trusts the supplied RPC: a transaction
  view need not include its reference block, so it does not independently
  reconstruct the signed hash from that view. Matching historical receipts does
  not prove the deployed code at execution, present balances, or seller delivery;
  fresh state and code require separate checks. Tests use synthetic data only.
- `agent/svalin-setup-journal.mjs` adds a **local, encrypted, single-journal
  write-ahead fence**, still without a signer, RPC client, network call or
  broadcaster. After explicitly initializing the original owner/vault-scoped
  manifest, it verifies an already-signed reviewed stage and durably writes
  its public hash before any future send. A second attempt for that stage is
  refused. A supplied matching `FINAL` receipt result can mark the original
  stage complete; an unknown or FINAL failure stays fenced, and later stages
  cannot be recorded past an unresolved earlier stage. Receipt matching is not
  a current-state check: independently verify deployed code, policy, keys,
  balances and registrations before each separately approved action. The module
  neither retains signed bytes nor proves they were sent, the owner approved,
  backups exist, or the seller delivered. The tests use disposable keys, a
  synthetic chain and an actual subprocess crash after a local fsync. A crash
  can leave a stale lock; never remove it while the original process may still
  be running. Deleted, stale-restored, bypassed or separate journals can still
  permit duplicates. Preserve and securely back up the original encrypted
  journal **and its separate key**, including later updates.
- `agent/svalin-setup-preflight.mjs` assesses the **uncreated** vault and
  owner at one fresh, pinned FINAL testnet block. It checks the owner's full
  access key and safely represented nonce, an unused agent key, structured
  evidence that the direct child does not exist, Circle registration bounds
  and owner/vault/seller registrations, and the owner's test-USDC balance and
  deficit. It also requires the trusted RPC's pinned protocol configuration to
  report four selected WASM feature gates as enabled; a missing, false or
  malformed flag blocks. This is not full runtime validation or RPC attestation.
  It estimates
  native storage and a reserve, but these estimates are not guarantees of gas
  or future storage. It reports unavailable and mismatched views as blocked or
  unknown; it never signs, sends, touches a journal or contacts the seller.
  A passing indication is not a code review, backup, owner consent or permission
  to broadcast. It has only been exercised against mocked RPC responses.
- `agent/svalin-setup-stage-preflight.mjs` adds a **read-only library** for each
  next setup stage and the post-funding profile. It checks the original encrypted
  journal before and after one fresh pinned FINAL snapshot: all prior original
  stage evidence must match, and the requested stage must normally be
  unrecorded. The specific self-addressed restricted AddKey stage can instead
  use a separately labeled trusted-RPC local outcome if nearcore omits its root
  receipt body; the following fresh snapshot must still verify key permissions.
  An exact pending hash may be supplied **only for a read-only recheck**; this
  never grants permission to send or retry it. Later snapshots
  check the owner's full-access key and safely represented nonce, reported
  selected WASM feature gates, reviewed keyless vault/code/owner, policy lock
  and agent grant, exact restricted-key permission, token registration and
  bounds, and stage-appropriate balances.
  The post-funding profile requires matching tracked and token balances. Before funding, V11's specific `check` failure for an
  empty balance is used as a behavior-dependent indication that the expected
  payee passes earlier checks; it cannot enumerate all payees or agent grants.
  Neither matching a journal nor matching a trusted RPC proves consensus,
  artifact review, backups, owner consent or future state. A journal can still
  be erased, restored stale or bypassed. This library signs and sends nothing;
  its tests use invented receipts and mocked views. An optional integration
  also executes the hash-pinned V11 bytecode in a synthetic host through those
  staged checks; it is not nearcore or a real Circle token. The checker itself
  does not sign or send.
- `agent/svalin-setup-runner.mjs` and `agent/svalin-setup-rpc.mjs` add an
  **experimental single-stage coordinator and one-shot testnet transport**.
  Unlike the read-only checker, these libraries can sign and submit a setup
  transaction when explicitly invoked by a caller. The separate experimental
  CLI exposes one stage at a time; there is no automatic multi-stage execution.
  The coordinator checks a fresh pinned snapshot and
  full-access nonce, validates the owner signer and exact reviewed bytes, fsyncs
  the original hash to the encrypted journal, rechecks the stage and nonce,
  and attempts at most one transport call. It holds the same in-process journal
  fence as participating payment/session operations throughout, with nested
  journal helpers sharing only an internal, short-lived scope. Any ambiguous
  result or post-record failure remains fenced for same-hash read-only recovery;
  it never retries. A compliant transport repeats the signed-byte, approval and
  snapshot-freshness checks synchronously immediately before its one HTTP send.
  The bundled transport checks the reported testnet chain but trusts the
  selected RPC. A transport-call count is not proof that an HTTP request
  actually reached the network; an injected transport must independently honor
  the before-submit guard and one-attempt contract.

  **Not ready for live use:** synthetic coordinator/transport tests use
  fabricated RPC and receipts, including an optional test that signs the exact
  recovered artifact. A separate [nearcore sandbox run](V11_SANDBOX.md) exercised
  the coordinator and one-shot transport with ephemeral keys, a mock FT and
  simulated chain identity and approvals. No V11 stage has been submitted on
  live testnet or independently audited. The explicit per-stage booleans are
  caller assertions—not evidence of human
  consent, independent artifact review or a usable backup. Deleted, stale,
  bypassed or separate journals, concurrent owner-key users, mutable chain state
  and a dishonest RPC remain outside the guarantee. The original journal and
  its separate key must be backed up before any specifically approved use and
  after updates. A keyless V11 vault currently has **no upgrade, account delete
  or Circle `storage_unregister` method**: the initial storage stake and token
  registration deposit may remain permanently locked. Independent artifact and
  execution-path review, live-testnet compatibility, a funded owner and explicit
  authorization are still required.
- `agent/svalin-setup.mjs` is the **experimental owner CLI** over those
  components. It reconstructs every stage from the unchanged canonical planner
  JSON and exact artifact, verifies a separately retained review digest and
  owner public key, and requires the original encrypted journal. Local status,
  pinned-stage checks, original-hash recovery and each one-stage execution are
  separate actions; only execution opens the owner private key or can submit.
  Execution requires explicit artifact-review, backup, keyless-risk and
  one-stage flags and first checks state without opening the key. These flags
  are assertions, not evidence of approval or backup. A loopback synthetic RPC
  test drives all five stages, a lost response and same-hash recovery; an
  optional test signs the recovered WASM against fabricated receipts. Neither
  is a nearcore or live test. See [owner CLI operation](#experimental-owner-setup-cli).
- `agent/svalin-pro-readiness.mjs` makes a bounded anonymous offer GET and
  validates a later checkout **offline** against the reviewed monthly
  testnet profile. Drift, mainnet, wrong token/payee, malformed amounts and
  unusable expiry fail closed. It does not create a checkout, keep a bearer
  code, prepare an intent, authorize or sign a payment.
- `agent/svalin-pro-preflight.mjs` is a **read-only, pre-reservation**
  check for the narrow one-purchase trial described below. It verifies the
  public offer and a fresh, single-FINAL-block vault/key/policy/balance and
  registration profile. It sends only an anonymous seller GET and read-only
  RPC queries, creates no journal or signature, and reports every failed or
  unavailable prerequisite as blocked/unknown. Matching a caller-supplied code
  hash is **not** an audit or evidence of owner consent.
- `agent/svalin-pro-session.mjs` is an **experimental session library**. It
  creates a 256-bit random Pro bearer code locally and
  fsyncs it inside the original encrypted owner/vault-scoped journal before
  any reservation. With separate explicit execution and journal/key-backup
  acknowledgments it checks the owner code at a fresh pinned testnet block,
  then can make one bounded reservation POST; an ambiguous response is never
  automatically reposted. The rest of the full preflight is separate. A
  separately approved `/v1/pro/activate` POST can attempt to recover the
  original pending amount using the same code, but activation may **mutate
  seller state**. An unknown,
  active, absent, multiple or ambiguous response remains unresolved and is
  never automatically retried. It can prepare unsigned V11 owner/agent calldata
  with the exact amount and a commitment to the high-entropy code; neither the
  code nor an authorization is printed or put in the public memo. The commitment
  does not authenticate the seller or prove the code/amount association.
  Tests use an injected synthetic provider or the in-process upstream source,
  not the running service. Treat the encrypted journal **and its separate key** as sensitive recovery material;
  back both up independently and protect the backups. JavaScript cannot
  guarantee wiping bearer strings from process memory. No local lock detects a
  deleted, stale-restored, bypassed or separate journal.
- `agent/exact-ft-runtime.mjs` and `agent/svalin-pro-runner.mjs` add the
  experimental payment path. For the **already owner-pinned** V11 intent,
  they check a FINAL snapshot for the reviewed keyless vault, code hash,
  owner, policy and payee locks, Circle token, recipient registration and
  restricted agent key. At payment time it also requires the key's remaining
  gas allowance to be positive and no greater than one testnet NEAR; this is
  not a guarantee that the allowance suffices. A policy denial stops without
  a send. The runner rechecks the public offer and original encrypted
  reservation, signs only `execute_exact_ft` with zero attached NEAR, fsyncs
  the signed transaction hash, and broadcasts at most once. It verifies the
  original FINAL receipt graph, historic vault/consumed intent, Circle event and callback. It rejects
  a FINAL block more than 120 seconds old or more than 30 seconds in the future
  relative to the local clock and rechecks that same snapshot during review
  and before broadcast. The exact-FT runner and recovery reject contract-view
  responses whose block hash differs from the pinned current or historical
  block. Recovery needs no signing key and looks up only the original hash; it
  is not blocked simply because that historical transaction is old. The on-chain contract, not the advisory preflight, makes the final
  policy decision.
- Activation is a **separately approved**, journal-fenced seller POST after
  recorded FINAL settlement and a minimum 30-second wait. That delay does not
  guarantee seller indexing; a lost or ambiguous result is never reposted
  automatically. After such a POST, a separate approved `GET /v1/keys/me`
  can inspect the original code and record seller-reported active status
  without another activation POST. The pinned source implements this status
  GET without claiming a payment or consuming a paid call; the running code is
  not attested. Neither response identifies the credited transaction.
- A separately approved one-shot paid `GET /v1/risk/{account}` discloses the
  chosen public NEAR account and bearer to the seller and may consume a daily
  call. It journals the attempt first, bounds the response, checks the pinned
  methodology, target, score/grade and paid-response profile, and returns only
  numeric values and allowlisted finding categories/severities. The seller's
  `dataSource` must be `fastnear` or `mock` for this pinned NEAR profile; it is
  preserved as `seller_reported_data_source`, with `sample_data: true` and an
  explicit warning for `mock`. A `fastnear` label is only the seller's claim,
  not independently verified provenance. Unknown/missing labels fail closed.
  Older recorded summaries without the label also fail closed on reuse; retain
  the original journal and do not automatically call the seller again.
  Arbitrary seller text and bearer echoes are discarded rather than treated as
  agent instructions. An invalid or lost response is unresolved and never
  automatically repeated; this prototype permits one risk request per original
  session. A seller-reported report is not independent proof of its accuracy or
  proof that the original transfer funded the pass.
- `agent/svalin-pro.mjs` exposes explicit operator actions; `npm run svalin-pro -- --help`
  is safe and makes no network request. External actions have
  separate flags for backup, seller mutation, bearer/target disclosure or
  quota use as appropriate. A new journal is allowed only during explicit
  first initialization; all other actions require the original. The CLI
  cannot independently prove backups exist. Its end-to-end test uses a
  synthetic seller and synthetic chain, including a lost-send recovery.
- `agent/svalin-liquidity-readiness.mjs` inspects seller token registration
  and a few testnet Ref pool views. At 19:29 UTC on 1 November, a
  [read-only GitHub job](https://github.com/Greatmujey/Bouncer/actions/runs/41341994197/job/124953799547)
  observed the seller registered and, among the two pools and three inputs it
  checked, 10 testnet wNEAR in the best single pool indicated 4.113357 test
  USDC—below the pass's minimum 5.000001. The job did not check any wallet's
  balance or establish that other funding routes are impossible. The updated
  probe also checks 15 and 20 test wNEAR inputs against a single fresh FINAL
  snapshot, but has not been run live with those inputs. All results are
  stale-able indications, **not** funding or executable swap quotes.
  A separate public NearBlocks page on 2 November around 12:21 UTC displayed
  approximately 2.87376 test NEAR and 0.003936 Circle test USDC for the
  [historical self-hosted trial owner](https://testnet.nearblocks.io/address/owner.bouncer-oracle-1ab0b52f.testnet/assets).
  The displayed USDC alone is 5.006063 below this profile's maximum funding
  amount of 5.009999. This is an indexed indication, not a pinned FINAL RPC
  balance, a selected V11 owner, proof of usable keys, or proof that other
  funding sources do not exist. Both values can change.
- `scripts/probe-svalin-pro.mjs` runs those anonymous GET/RPC reads; use a
  network environment that can reach the provider and NEAR testnet. It does
  not create a reservation, pay, activate, or call a paid endpoint.
- V11 is a separate experimental fresh-state contract; it has been exercised
  on an isolated nearcore chain but **not** deployed on live testnet.
  Independent review, an owner-approved deployment, securely verified operational
  backups, sufficient test-token funding, an available seller and real
  end-to-end testing are still missing. The local sandbox and its mock token do
  not prove any of those. Independent review remains recommended, but the
  testnet-only setup path can proceed with explicit unaudited-risk acceptance;
  that acceptance does not constitute an audit or make the artifact safe.

## Smallest testnet trial: before making a reservation

This is a plan for **one independent API/data provider**, not the complete
compute/storage/API multi-resource proof. A seller reply or GitHub report
permission is not a prerequisite to inspect or use its publicly offered API;
its amount-only attribution remains a known limitation. No setup, reservation,
intent, payment, activation or paid call is authorized by this plan.

1. Verify the exact separate V11 artifact and its NEAR code hash, then obtain
   explicit owner approval for a **new testnet vault** and each setup stage.
   V11 is not deployed; the artifact and experimental owner CLI have not been
   independently reviewed or live-tested. Independent review is recommended;
   a testnet operator who chooses to proceed without it must explicitly accept
   the unaudited-artifact risk. A hash is not an audit or a reproducible-build
   proof. Do not upgrade an old V9/V10 vault. The owner must control its own
   key; the deployed vault must have **no access keys**. The current contract
   exposes no upgrade/delete or Circle `storage_unregister` method:
   a keyless vault can leave its storage stake and token-registration deposit
   locked. Its owner can withdraw tracked tokens and eligible native surplus,
   subject to the contract and token rules.
2. After separately approved setup, configure a Circle-test-USDC policy
   allowing `svalin-agent.testnet`, with per-transaction **and rolling daily**
   caps of `5009999` atoms (5.009999 test USDC). Lock the policy to exact
   intents under the 1-yocto owner guard. Grant an agent public key on this
   policy and separately install it on the owner account as a function-call
   key restricted to the vault and **only** `execute_exact_ft`; this trial
   requires a positive, bounded gas allowance of at most one testnet NEAR.
   The 1-yocto guard is an on-chain authority boundary, not a human-approval
   mechanism. Owner setup requires several transactions; nothing here sends
   them automatically.
3. Verify Circle storage bounds and registration for the owner and seller,
   and check the reviewed vault registration transaction against the current
   minimum before any separately approved send. Arrange enough **testnet**
   token funding for the owner to fund the vault. A deposit must go through
   `ft_transfer_call` so the vault's `ft_on_transfer` updates its internal
   accounting; a plain transfer is not sufficient. The conservative preflight
   checks both actual token holdings and tracked balance against the **maximum**
   possible checkout, 5.009999. Thus it can block an otherwise affordable
   smaller exact checkout; it does not decide how to acquire funds. Also fund
   testnet native NEAR for storage, calls and the vault's forwarded yocto.
4. On a trusted machine, prepare a **public** JSON goal containing the existing
   Svalin goal fields: version `1`, a new `id`, `vault`, `owner`, independently
   reviewed `vault_code_hash`, `policy_id`, and the two explicit risk flags
   `accept_unsigned_seller_risk` and `accept_exact_amount_matching_risk`.
   This file and the agent public key contain no private keys or bearer code.
   Setting flags to `true` configures the prototype; it does not substitute for
   actual approval. A help-only command is safe offline:

   ```sh
   npm run svalin-preflight -- --help
   ```

   With the real public goal, public key and trusted **testnet** RPC, the
   documented command performs one anonymous offer GET and bounded read-only
   RPC calls. The CLI exits `0` for `READ_ONLY_PROFILE_MATCH`, `2` for
   `BLOCKED_OR_UNKNOWN`, and `1` on invalid input or unavailable/stale final
   block. Its RPC transport rejects transaction methods; it writes no journal,
   creates no seller code and does not sign. Its strict profile also requires
   zero current policy spend, an exact-policy lock and no earlier token/payee
   lock **on this vault**. This last view cannot prove that no seller-side
   reservation or other transaction exists elsewhere.
5. Only after an independent artifact review, real funding/fee check and
   verified backups of the original encrypted journal **and its separate key**,
   obtain explicit approval for one two-day seller reservation. Then review the
   returned exact amount/expiry and obtain separate approval for the 1-yocto
   intent and one payment. Preserve the original journal and signed hash; never
   automatically repeat a reservation, activation or ambiguous payment.
   Activation, bearer/target disclosure and a paid risk call require their own
   approvals. A pass or useful report still cannot prove Svalin credited our
   particular payment under the inspected amount-only matcher.

## Offline setup-plan review

From `bouncer/`, help and the planner's simulated tests require no wallet,
network, real V11 artifact or seller:

```sh
npm run svalin-setup-plan -- --help
npm run svalin-setup-preflight -- --help
npm run svalin-setup -- --help
node --test tests/journal-operation-scope.test.mjs tests/svalin-setup-plan.test.mjs tests/svalin-setup-evidence.test.mjs tests/svalin-setup-journal.test.mjs tests/svalin-setup-preflight.test.mjs tests/svalin-setup-stage-preflight.test.mjs tests/pinned-access-key-nonce.test.mjs tests/svalin-setup-runner.test.mjs tests/svalin-setup-rpc.test.mjs tests/svalin-setup-cli.test.mjs
```

A real plan requires a **public** Svalin goal, a separately obtained and
reviewed V11 WASM, a canonical agent **public** key, and explicit initial-vault,
key-allowance and vault Circle-registration amounts in yoctoNEAR. The last is a
reviewed input, **not** a quote: the read-only setup preflight reports the
currently observed Circle minimum so an operator can prepare a matching review.
This five-stage `v2` review has a different digest and is not compatible with
the earlier four-stage `v1` setup journal. If an earlier plan was ever used,
preserve its original software, review and journal and reconcile its original
hashes; never initialize a new journal to bypass that history. No live setup
attempt is known here. Its goal code hash must equal the
base58-encoded SHA-256 of those exact WASM bytes. The new vault must be an
immediate child of the owner; existing vault upgrades are intentionally not
planned. It accepts at most 50 testnet NEAR of initial vault funding and a
positive key allowance of at most one testnet NEAR and a token-registration
attachment of at most 0.1 testnet NEAR. Those are safety ceilings, **not**
estimates of storage or gas. The offline planner itself does not know whether
the account is available, the owner has the funds, or the token is registered.
The separate read-only `svalin-setup-preflight` command takes the same public
inputs plus owner public key and RPC and reports a pinned snapshot; it is not a
live setup executor. The planner CLI prints
public review metadata, not raw WASM, unsigned transactions, private keys or a
bearer. The library also returns mutable SDK **action batches**, without nonce,
block hash or signature. Each stage includes a domain-separated commitment
computed with a dummy key, fixed nonce and zero block hash; this detects
changes only against an independently retained review and is **not** a NEAR
transaction hash. The entire review has a separate JSON SHA-256; it is not
owner consent. The unit tests intentionally accept a harmless stub with the
right marker and exports to show why these checks cannot authenticate behavior.

The companion evidence library's `prepareSvalinSetupAttempt` returns only a
public record from the plan, reviewed stage, owner **public** key and original
transaction hash; that helper does not compute the hash, sign, write or send.
Alternatively, `verifySignedSvalinSetup` verifies an already-signed transaction
against the exact review and derives its hash, returning public metadata only.
It does not check on-chain key permissions, nonce availability, block freshness
or consent. Signed bytes must be protected. `svalin-setup-journal.mjs` can
initialize an explicitly new original manifest and record that verified hash in
an encrypted `FileJournal`, but this alone does not authorize or send anything.
The separate experimental coordinator rechecks signed bytes and fresh
prerequisites. It has synthetic tests and a test-only nearcore sandbox run,
but is not yet approved for live use. To inspect a supplied result later,
`inspectSvalinSetupAttempt` takes
`plan`, `trustedReviewHash`,
`trustedOriginalHash`, `trustedOwnerPublicKey`, `attempt` and `result`. These
anchors must come from the protected original record, not from an untrusted
replacement result. The library reconstructs the constrained plan and matches
its actions in the transaction and, when supplied, the root receipt. Only the
same-account single-AddKey stage permits an omitted local root body; it reports
`FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH`, not a receipt match. The trusted-RPC
transaction, root outcome and any strictly shaped system gas-refund child must
match, and a fresh state check must separately verify the key. Registration
accepts a linked protocol gas refund, but still rejects a token-created refund.
The resolver/callback graph check is stricter than a successful
`ft_transfer_call` alone. An earlier disposable nearcore run of the verifier found
both incompatibilities and intentionally failed. The [isolated rerun of commit
`b820ce9`](https://github.com/Greatmujey/Bouncer/actions/runs/41430287526)
passed with the example mock FT and reconciled five stages in an encrypted journal;
the AddKey root body remained omitted. A [later isolated run](https://github.com/Greatmujey/Bouncer/actions/runs/41435563441)
also passed the actual setup runner, pinned stage preflights, post-funding check
and same-hash recovery on nearcore, with a test-only simulated network identity
and approval flags. A [subsequent isolated run](https://github.com/Greatmujey/Bouncer/actions/runs/41439528831)
exercised the actual restricted buyer against the same kind of disposable chain:
it journaled before one mock-FT payment, lost the acknowledgement after finality,
reopened the journal and recovered that original hash without a second send.
The offer and reservation were from an in-process fake seller; no Svalin
activation, attribution or delivery was verified. A [fresh isolated run of
`bee6160`](https://github.com/Greatmujey/Bouncer/actions/runs/41444752557)
passed after the plain-owner and capped-gas-allowance checks were added; the
sandbox owner and key satisfied those checks. Synthetic tests cover hostile or
unavailable owner views and post-sign drift; this nearcore run did not exercise
an adversarial global-code owner. Its [normal CI build](https://github.com/Greatmujey/Bouncer/actions/runs/41444752580)
reported the same V11 SHA-256 as the sandbox input, but did not independently
attest reproducibility. There has been no V11 testnet deployment or Circle
funding transaction. A future live workflow requires authorization and must
explicitly disclose that independent review has not occurred.
On 1 November 2026, the approved private push build `41361570652` and its PR
build `41361575492` succeeded and independently reported the same 536,325-byte
V11 artifact SHA-256,
`1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921`.
Both builds ran the same GitHub workflow around the same time; matching hashes
are not an independent audit or proof of reproducibility. The sandbox could not
reach the standard artifact host. The approved fallback exported four long
notices, but GitHub returned only 4,096 characters from each. The extractor
correctly rejected those incomplete chunks and wrote no WASM file; the hash
annotation alone does not retrieve or review the artifact.

The separately approved retry, push run `41362684342`, used 4,000-character
chunks; GitHub retained only 49 of the 53 required chunks in that check. The
extractor again failed closed and wrote no WASM. The later main-branch build
`41366026760`, triggered by the owner's merge, also reported the same size and
hash; it did not establish an independent build or retrieve the binary here.
The old private-only annotation exporter cannot run while the repository is
public and must not be used for credentials or private data.

With the owner's approval, the public first-push workflow
`.github/workflows/v11-existing-artifact-bridge.yml` ran once as
`41371637056` and copied existing artifact `13105539480` into the unreferenced
Git blob `c67c70401dc733a0905e79258cc8169c2e6b5210`. The workflow checked the
archive and WASM size and hashes before its one blob POST; it did not deploy,
sign, fund or contact a seller. The GitHub credential was restricted to the
GitHub API, not the signed storage host. The resulting blob was separately
retrieved through the GitHub API and independently checked: 536,325 bytes,
Git blob SHA-1 `c67c70401dc733a0905e79258cc8169c2e6b5210`, and WASM SHA-256
`1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921`.
The accompanying normal CI run `41371636589` passed and its new build reported
the same WASM hash. The blob is **unreferenced** and may be garbage-collected;
the original Actions artifact expires on 30 January 2027. Preserve a verified
copy separately. Repeated builds from the same workflow are not an independent
source-to-binary review, and transport integrity does not authorize any deployment.

The optional `tests/v11-bytecode-offline.test.mjs` loads only that exact hashed
binary and executes selected methods in a deliberately incomplete synthetic
host. It checks the 1-yocto owner guard, a single consumed intent and mocked
success/failure callbacks, and uses those bytes in an unsigned synthetic setup
review. It is not nearcore and does not establish gas, access-key, receipt, FT,
consensus or deployed-chain behavior. Run it with
`BOUNCER_V11_WASM_PATH` set to a local verified copy; without that input it
skips rather than fetching or trusting an arbitrary artifact.

A separate [static compatibility indication](../evidence/v11-static-review-20261102/README.md)
compares all 41 imported function names and signatures to pinned nearcore
2.14.0 declarations; none differed. WABT 1.0.39 also validated the artifact
with SIMD and multi-value disabled, and observed a bulk-memory `memory.copy`.
The 2.14.0 release's selected config diffs enable bulk memory at protocol 84,
gas-key host functions at 85 and the imported universal-accounts host function
at 88. A [second static comparison](../evidence/v11-static-testnet-rc5-20261102/README.md)
checked the exact source commit reported by one testnet node: its **rc.5 source**
also matches all 41 signatures but enables universal accounts at **87**, not
88. The two source profiles differ in their protocol-87/88 configuration; the
setup deliberately keeps 88 as a conservative common floor. Neither review
executes nearcore, checks all limits, attests the running network, proves
source-to-binary provenance or constitutes an audit.

**Runtime-version warning:** the recovered binary imports
`env.promise_batch_action_universal_state_init`, gated by `UniversalAccounts`
even when the function is never called. At approximately `2026-11-02T08:51Z`,
public status endpoints reported testnet protocol 88 and mainnet protocol 86.
In both selected source configurations, protocol 86 predates the gate; it
would not provide that import. These self-reported observations can change and
are not a live deployment test or proof of the running runtime configuration.
The preflight blocks a missing, malformed or less-than-88 pinned testnet
protocol version. It also requires reported `wasm_config` flags for
`global_contract_host_fns`, `reftypes_bulk_memory`, `gas_key_host_fns` and
`universal_accounts` to be boolean `true` at that pinned block. These are
selected gates from the inspected binary and nearcore source, not a full
validator: a dishonest RPC can fabricate them and a future artifact may need
other features. Recheck a trusted fresh RPC and independently review
compatibility before any action.

The Rust contract has no tracked Cargo lockfile, and CI selects a stable
toolchain and installs Binaryen rather than pinning a complete reproducible
build environment. A CI artifact or its hash is therefore not, by itself, an
independent source-to-binary review.

The five batches respectively create/init the keyless vault, configure its
locked policy, add the restricted agent key on the owner, register the vault
with Circle, and deposit the test USDC. The pre-creation check deliberately
blocks an already-registered vault: this version does not silently skip the
registration or assume a refund. Registering an unregistered owner and acquiring
its test USDC are not part of these batches. NEAR's [batched-action
rules](https://docs.near.org/smart-contracts/anatomy/actions) describe actions
in one receipt as atomic; there has been no V11 testnet deployment. The later
FT deposit invokes asynchronous token/receiver receipts and
must be reconciled along with the vault's tracked and actual balances. Never
repeat an unresolved setup transaction simply because a response was lost.

## Experimental owner setup CLI

**Experimental testnet only:** the artifact and execution path are unaudited
and have not been live-tested. Independent review is recommended; the CLI does
not require a claim that one happened, but requires explicit acceptance of that
risk for each stage. Real-chain compatibility, secure verified backups, a
funded testnet owner and explicit approval for each intended transaction remain
necessary. The command is capable of sending testnet transactions; merely
invoking `--help` never does. It is not a wallet, faucet, Circle acquisition
route, seller call or proof of independent fulfillment. A separate, not-yet-live-
verified native-NEAR helper is documented in [TESTNET_NATIVE_FAUCET.md](TESTNET_NATIVE_FAUCET.md).

1. Keep the planner's complete JSON output **unchanged**, including its trailing
   newline. To save it as JSON, invoke `node agent/svalin-setup-plan.mjs` directly
   or use `npm run --silent svalin-setup-plan -- ...`; normal npm banners would
   corrupt a redirected JSON file. Independently retain its `review_sha256`, the
   reviewed exact WASM, owner public key and all five stage descriptions. The CLI reconstructs and
   compares the entire constrained plan, digest and WASM; the digest alone is
   not a signature, an audit or consent. Use the same original review and
   software throughout. Keep owner and agent private keys out of the repository,
   chat, command-line values and logs.
2. On a trusted machine create a separate owner-only 32-byte file-journal key
   with `npm run init-file-journal-key -- --help`; securely back up that key.
   Set `BOUNCER_FILE_JOURNAL_KEY_FILE` to its path. The journal must be a
   separate file from the review, WASM and keys. Only for a genuinely new setup,
   use `--init-journal --confirm-new-journal --ack-key-backup` and then securely
   back up the **new original journal as well as its separate key**. A missing
   or rolled-back journal can mask prior work: never initialize a replacement
   if any earlier setup may have been attempted.
3. Every action requires `--review`, `--review-sha256`, `--wasm`,
   `--owner-public-key` and `--state`, plus the original journal-key environment
   variable. `--journal-status` reads the local fence without network access.
   `--check-stage STAGE --rpc TRUSTED_TESTNET_RPC` performs only read-only RPC
   queries. The RPC must be HTTPS (HTTP is allowed only on loopback), report
   testnet and be trusted; the checks use a fresh pinned FINAL block and require
   the selected WASM feature flags in its protocol configuration. A match is
   neither consent nor proof that balances, storage, runtime linkage or gas
   will remain sufficient. A blocked/unknown check exits 2; invalid input exits 1.
4. Only after inspecting the exact artifact and plan, backing up recovery
   material and obtaining **separate approval for one exact stage**,
   `--execute-stage STAGE --rpc TRUSTED_TESTNET_RPC --owner-key OWNER.json`
   additionally requires `--execute --ack-backups --accept-unaudited-artifact
   --accept-keyless-lock`. The unaudited flag accepts risk; it does not attest
   that anyone reviewed the binary. The owner-key JSON must contain `account_id`
   and `private_key`, match the retained public key, and be an owner-only regular
   file, not a symlink or hard link. The signer file is opened only after an
   initial matching read-only check. JavaScript cannot guarantee that secret
   strings have been erased from memory. All flags are **operator assertions**;
   the program cannot establish risk comprehension, backup or human consent.
   Each invocation attempts at most one transaction and never contacts the
   seller. It cannot automatically execute subsequent stages.
5. The order is `create_keyless_vault`, `configure_locked_policy`,
   `install_restricted_agent_key`, `register_vault_for_test_usdc`, then
   `fund_vault_with_test_usdc`. Inspect and back up every updated original
   journal and separately check the next stage before any further approval.
   Registration and funding use test assets, and owner/seller registration and
   acquiring owner test USDC are separate prerequisites, not actions this
   command performs. Initial storage and registration deposits can remain locked.
6. If a result is unknown, a stage fails, the process crashes, or a hash is
   recorded without a confirmed result, **stop; never rerun that stage or
   replace the journal**. `--recover-stage STAGE --rpc TRUSTED_TESTNET_RPC`
   looks up only the original hash and changes no journal entries. Add
   `--record-evidence --ack-backups` only when deliberately recording matching
   FINAL evidence; it still never signs or broadcasts. A FINAL failure remains
   blocked for manual reconciliation. Retain the latest original journal and
   separately protected key; stale backups, bypassing the journal, another
   process, a dishonest RPC or compromised local machine defeat the fence.
7. After all five original stages are reconciled—including the separately
   labeled outcome-only AddKey evidence if its root receipt was omitted—
   `--check-stage verify_funded_vault --rpc TRUSTED_TESTNET_RPC` checks the
   current reported keyless vault, policy, restricted agent key, Circle registrations and both
   tracked and on-token balances. `READ_ONLY_FUNDED_VAULT_PROFILE_MATCH` is a
   trusted-RPC indication, not a consensus proof, code audit, consent or seller
   delivery. Buyer-side checks do **not** fix Svalin's payer-attribution issue.

## Preflight trust limits

The preflight trusts its selected RPC, token and local clock. It rejects mixed
block hashes and FINAL headers over 120 seconds old or over 30 seconds in the
future, both initially and at completion. Its offer GET is not part of that
blockchain snapshot. A positive native balance and bounded key allowance do
**not** prove gas/storage is sufficient; the tool does not prove backups,
artifact review, unspent state elsewhere, owner consent, merchant acceptance,
attribution, current pool liquidity or future delivery. A failed/unavailable
view is not proof an account or balance is absent. On November 1, a separate
[read-only web check](../evidence/svalin-pro-read-20261101/offer-and-stale-read-2121z.json)
returned a NearBlocks head timestamped September 27 and a Web4 testnet error
at a much older height; those responses were not used as current balance,
registration or liquidity evidence. The public offer was still advertised at
that observation, but the sandbox could not directly query a current NEAR RPC;
**no current owner/vault balance was checked**. Provider and chain views can
change, and a malicious RPC can fabricate a fresh-looking block.

## Optional upstream source interoperability test

The local suite runs Bouncer's actual session/payment/recovery/report code
against Svalin's actual `createApp`, reservation/claim store, NEAR payment
reader and risk engine from commit `7ebfb14f35630dfc1665b04993e684b5444133fb`.
It supplies a **simulated** NEAR RPC/FINAL receipt graph, FastNEAR account and
transaction index, clock, facilitator and upstream `MockPortfolioSource`. The
in-process seller returns sample holdings and labels them `mock`; Bouncer keeps
that label. The suite tests a nested transfer, lost-send recovery by the same
hash, seller reservation and activation recovery, an unavailable indexer,
refund/failed-receipt handling and the different-payer misattribution case. It
also confirms that looking up one reservation can claim a payment for another
seller reservation, which is why recovery requires explicit seller-mutation
acknowledgment. Global `fetch` is stubbed and the test has no intended network or blockchain
side effects. Passing is not evidence of a real testnet transaction, independent
fulfillment, deployed source identity, live indexer behavior or an audit.

The upstream source is [Apache-2.0 licensed](https://github.com/noobshole/svalin-agent/blob/7ebfb14f35630dfc1665b04993e684b5444133fb/LICENSE)
and remains separate; its `LICENSE` and `NOTICE` are in that source tree. No
third-party code is vendored in Bouncer. To reproduce on a trusted Linux/Node 22
machine from `bouncer/`, with npm, `curl`, `tar` and Corepack available:

```sh
npm ci --ignore-scripts --no-audit --no-fund
SVALIN_DIR="$(mktemp -d)"
curl -fsSL https://codeload.github.com/noobshole/svalin-agent/tar.gz/7ebfb14f35630dfc1665b04993e684b5444133fb | tar -xz -C "$SVALIN_DIR" --strip-components=1
(cd "$SVALIN_DIR" && corepack pnpm install --frozen-lockfile --ignore-scripts --filter @svalin-agent/api... && corepack pnpm --filter '@svalin-agent/api^...' --recursive --workspace-concurrency=1 build)
BOUNCER_SVALIN_SOURCE="$SVALIN_DIR" npm run test:svalin-upstream
```

This downloads and runs third-party tooling and source: review and trust them
before running. The runner checks digests of the pinned source tree and the two
built workspace packages, failing if they drift; it does **not** attest the
installed `node_modules`, Node runtime, network, seller deployment or package
supply chain. Its pinned lockfile and `--ignore-scripts` reduce some install
risk but do not remove it. The suite is optional and is not part of `npm test`.

## Smallest seller change that would improve attribution

The buyer cannot fix the seller's matching semantics by itself. A potential
collaboration would add an explicitly negotiated, backward-compatible checkout
profile that:

1. Records an expected testnet **vault account** and a public, non-secret
   payment memo with the exact amount and reservation window; never put the
   Pro bearer in that memo or a URL.
2. Reads the FINAL Circle token event and its receipt graph, checks the event's
   actual `old_owner_id`, seller, amount and expected memo, and accounts for
   relevant refunds before crediting the reservation. Matching an arbitrary
   payer or merely seeing an amount is insufficient.
3. Atomically claims each transaction and reservation once across the seller's
   workers, with bounded indexer lag and explicit recovery for late, ambiguous
   or unmatched transfers. An event index can be incomplete; lack of an index
   result must not be treated as proof that a payment never happened.
4. Returns the credited transaction hash and reservation commitment via an
   authenticated, replay-resistant receipt or an appropriately authenticated
   status interface. Bouncer can then compare that hash with its **original**
   FINAL receipt; a seller-signed statement still does not establish the truth
   or quality of the delivered report.

This is a proposed seller-side change, not present in the inspected source or
claimed as deployed. Its exact schema, identity model and refund behavior require
agreement and independent security review. An owner-approved attempt to send a
[private report](SVALIN_COLLABORATION_DRAFT.md) was rejected by GitHub with
HTTP 403; no report was created or delivered. The seller's security policy
requests private reports, not public issues. Resolve GitHub permissions before
any separately approved retry; do not automatically repeat the request.

## Required before a consequential test

1. Verify the current testnet offer, seller registration, test-token funding,
   provider terms and the exact V11 deployment. Independent review remains
   recommended; a decision to test an unaudited artifact must be explicit and
   must never be described as an audit. Do not reuse or resend any prior
   ambiguous funding/payment operation.
2. Get explicit owner approval for the provider, monthly testnet amount range,
   desired public-account data, timing, side effects and risks **before** a
   two-day checkout reservation. Persist and independently back up the bearer
   code securely before requesting the reservation; never put it in GitHub
   logs, comments, unencrypted artifacts or a URL.
3. Review the exact returned amount, expiry, payee, token, policy and recovery
   plan; obtain separate explicit approval before paying. Persist the signed
   transaction hash in the original journal before broadcast, and never
   auto-resend an ambiguous hash.
4. Verify the one original transaction and token event FINAL; separately
   verify that the secret code is active and that a paid API returns bounded,
   relevant data. Treat the seller's results as untrusted and unaudited.

No step above authorizes a purchase, establishes merchant consent, demonstrates
capacity or claims production security. No mainnet or real-value payment is
permitted by this readiness module.
