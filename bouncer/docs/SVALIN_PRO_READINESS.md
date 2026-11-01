# Independent Svalin Pro: testnet discovery and experimental buyer

**Status: the public offer and free route have been observed. The buyer,
receipt recovery, activation and report path have synthetic tests and an
optional local test against the pinned independent seller source. That source
test uses a simulated chain/indexer and a labelled sample portfolio. No real
checkout has been reserved, no provider-linked bearer code created, no token
transferred, and no independent FT-paid fulfillment verified. The adapter is
experimental, unaudited, and not ready for consequential use.**

On 1 November 2026 at about 19:25 UTC, the independent Svalin service's
[public offer](https://svalin-api.noobshole.workers.dev/v1/pro) advertised a
monthly pass for **5 testnet USDC** plus a small exact-amount suffix, 30 days,
and 100 paid-route calls per day. Its NEAR offer named `near:testnet`, Circle's
[testnet USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses)
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7b23cc04ea7eb7a6c3c32520d03d4afcb8af`,
and `svalin-agent.testnet`. Testnet USDC has no real value. The free
`/v1/demo/risk/root.near` returned a JSON report; this is neither paid delivery
nor a validation of the report's accuracy. The published offer may change.

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
  separately retained review before any future approved signing workflow.
  No such reviewed deployment workflow is supplied yet.
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
  access key, an unused agent key, structured evidence that the direct child
  does not exist, Circle registration bounds and owner/vault/seller
  registrations, and the owner's test-USDC balance and deficit. It estimates
  native storage and a reserve, but these estimates are not guarantees of gas
  or future storage. It reports unavailable and mismatched views as blocked or
  unknown; it never signs, sends, touches a journal or contacts the seller.
  A passing indication is not a code review, backup, owner consent or permission
  to broadcast. It has only been exercised against mocked RPC responses.
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
  acknowledgments it can make one bounded reservation POST; an ambiguous
  response is never automatically reposted. A separately approved
  `/v1/pro/activate` POST can attempt to recover the original pending amount
  using the same code, but activation may **mutate seller state**. An unknown,
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
  restricted agent key. A policy denial stops without a send. The runner
  rechecks the public offer and original encrypted reservation, signs only
  `execute_exact_ft` with zero attached NEAR, fsyncs the signed transaction
  hash, and broadcasts at most once. It verifies the original FINAL receipt
  graph, historic vault/consumed intent, Circle event and callback. It rejects
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
- `scripts/probe-svalin-pro.mjs` runs those anonymous GET/RPC reads; use a
  network environment that can reach the provider and NEAR testnet. It does
  not create a reservation, pay, activate, or call a paid endpoint.
- V11 is a separate experimental fresh-state contract; it has **not** been
  deployed or tested on chain. Independent review, reviewed owner setup and
  deployment, securely verified operational backups, sufficient test-token
  funding, a consenting available seller and real end-to-end testing are still
  missing. A local mock does not prove any of those.

## Smallest testnet trial: before making a reservation

This is a plan for **one independent API/data provider**, not the complete
compute/storage/API multi-resource proof. A seller reply or GitHub report
permission is not a prerequisite to inspect or use its publicly offered API;
its amount-only attribution remains a known limitation. No setup, reservation,
intent, payment, activation or paid call is authorized by this plan.

1. Independently review and build the separate V11 artifact, confirm its NEAR
   code hash, then obtain explicit owner approval for a **new testnet vault**
   and setup. V11 is not deployed; the offline planner below prepares actions
   but there is no automated reviewed setup or deployment yet. Do not upgrade
   an old V9/V10 vault or use an unreviewed artifact. The owner must control
   its own key; the deployed vault must have **no access keys**. The current
   contract exposes no upgrade/delete or Circle `storage_unregister` method:
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
node --test tests/svalin-setup-plan.test.mjs tests/svalin-setup-evidence.test.mjs tests/svalin-setup-journal.test.mjs tests/svalin-setup-preflight.test.mjs
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
A future executor would still need to recheck the exact signed bytes and fresh
prerequisites at any separately approved broadcast. To inspect a supplied result later,
`inspectSvalinSetupAttempt` takes `plan`, `trustedReviewHash`,
`trustedOriginalHash`, `trustedOwnerPublicKey`, `attempt` and `result`. These
anchors must come from the protected original record, not from an untrusted
replacement result. The library reconstructs the constrained plan and matches
its actions in the transaction and root receipt. The resolver/callback graph
check is stricter than a successful `ft_transfer_call` alone. It has not been
exercised against a real V11 deployment or funding transaction; independent
review and a future authorized live workflow remain necessary.
The CI workflow is configured to expose the built V11 WASM's SHA-256 and byte
length in a check annotation; that identifies the job's output but does not
retrieve the artifact, establish reproducibility, audit it or prove deployment.
A future run is required to produce that annotation. As an optional fallback
for an unreachable artifact host, a separately approved private-repository push
with `[v11-wasm-review-export]` would place compressed, non-secret V11 binary
chunks in check annotations and build logs. The local transport can reconstruct
only a complete matching SHA-256 and is limited to ten notices of 60,000
characters each. It has synthetic tests only: GitHub's live annotation behavior
and capacity are unverified. This exposes the binary to repository log/check
readers and could become visible if the repository becomes public; never use it
for credentials or private data. The marker triggers normal CI and may create
a Vercel preview; it does not authorize deployment,
registration, seller contact or payment. The Rust contract has no
tracked Cargo lockfile, and CI currently selects a stable toolchain and installs
Binaryen rather than pinning a complete reproducible build environment. A CI
artifact or its hash is therefore not, by itself, an independent source-to-
binary review.

The five batches respectively create/init the keyless vault, configure its
locked policy, add the restricted agent key on the owner, register the vault
with Circle, and deposit the test USDC. The pre-creation check deliberately
blocks an already-registered vault: this version does not silently skip the
registration or assume a refund. Registering an unregistered owner and acquiring
its test USDC are not part of these batches. NEAR's [batched-action
rules](https://docs.near.org/smart-contracts/anatomy/actions) describe actions
in one receipt as atomic; this has not yet been exercised with the V11 artifact
on chain. The later FT deposit invokes asynchronous token/receiver receipts and
must be reconciled along with the vault's tracked and actual balances. Never
repeat an unresolved setup transaction simply because a response was lost.

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
   provider terms and independently reviewed V11 deployment. Do not reuse or
   resend any prior ambiguous funding/payment operation.
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
