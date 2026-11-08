# Native OutLayer wallet path (testnet, experimental)

This is a **building block**, not a live wallet purchasing feature. It prepares a
bounded owner-reviewed path to one independent OutLayer price lookup, paid in
native testnet NEAR. It is not the independent FT-paid Buffer purchase, and it
does not prove independent compute, storage and API fulfillment as a group.
The historical [OutLayer price execution](https://testnet.nearblocks.io/txns/4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ)
used a different testnet owner; its single-source result is not a price accuracy,
market-freshness, TEE-attestation or SLA guarantee. The three later resource
examples were **self-hosted development services**.

## What is implemented

- `agent/native-oracle-wallet-plan.mjs` constructs four **unsigned** testnet
  wallet batches for a named owner, fresh direct-child vault and separate
  Ed25519 agent public key. It pins the repository V9 WASM (452,675 bytes,
  SHA-256 `835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee`,
  NEAR code hash `9qpU6d6MHZZXC2ivtQt3k3scGkiHLkkMnaTAiZWbaL6y`). It pins
  `outlayer.testnet`, the reviewed project version and one Coinbase input.
  The trial's per-call, rolling-day and tracked-deposit amounts are each
  bounded to at most 0.1 test NEAR. Only PUBLIC keys go into the review.
- The stages create and initialize a **keyless** vault; configure its native
  policy, allowed provider, fixed project and agent grant using four separate
  **1-yocto** owner calls; deposit native funds; and add a finite-allowance
  owner-account function-call key scoped only to
  `execute_outlayer_native_project`. The agent key cannot attach the 1 yocto
  required for owner-only changes. A typed account ID is not wallet control.
- `native-oracle-readiness.mjs` reports approximate owner, storage, gas,
  project-registry and new-vault conditions at one fresh trusted-RPC FINAL
  block. `native-oracle-wallet-preflight.mjs` checks each next stage against a
  separately retained review, owner key, prior original hashes and matching
  receipt graphs, then reads the current vault, policy, key and project state
  at one fresh FINAL block. These results are **not approvals or prompt
  claims**. They trust the RPC and clock and can race changes after the read.
- `native-oracle-wallet-evidence.mjs` checks original transaction actions,
  signer, receiver, linked receipts and bounded protocol gas refunds. It does
  not prove current state, wallet consent or independent delivery. A missing,
  failed or uncertain original must be reconciled; never automatically retry.
- `git-native-oracle-prompt-witness.mjs` adds a separate public, hash-linked
  reservation/claim/original log for the four stages. The Git-backed store
  uses a branch CAS and checks the acknowledged remote head. A lost claim
  acknowledgment blocks another claim. Git alone is **not** an independent
  latest-head checkpoint or a complete authorization service. The PostgreSQL coordinator,
  receipt gates and NEP-413 checks are wired into an opt-in experimental runtime
  and exercised with synthetic data; there is no hosted owner session or
  independent latest-head retention/monitoring. Git
  administrators or a simultaneous rollback can still defeat it. A hash in this log alone does
  **not** establish a valid receipt or allow a later wallet prompt.
- `anchored-witness-store.mjs`, `git-witness-history-audit.mjs`,
  `git-witness-range-audit.mjs` and `anchored-setup-witness-pair.mjs` provide an
  **experimental adapter**, not a deployed monitor. Given an already trusted
  checkpoint from a separate durable CAS service, each witness append must
  advance and read back that external head before it is acknowledged. The Git
  audit checks ancestry **and every protected owner's witness files on every
  newly reachable parent edge**, including merge-side histories. It rejects a
  witness deleted and later restored between checkpoint updates; a net tree
  comparison alone would miss that. Shallow, grafted, unrelated-root or
  overlong ranges fail closed. Tests use a local Git remote and in-memory or
  disposable PostgreSQL checkpoints, not independently operated infrastructure. The checkpoint must be seeded
  with the latest complete history, operated separately, protected against its
  own rollback, and made mandatory in the live coordinator; otherwise it gives
  no rollback guarantee. An uncertain checkpoint or commit is a stop.
- `postgres-setup-head-anchor.mjs` supplies a concrete experimental CAS/head
  history for a **separately operated** PostgreSQL instance. Explicit one-time
  provisioning pins a verified baseline, normal operations never recreate a
  missing database, update/delete/truncate guards and schema checks fail closed,
  and lost COMMIT acknowledgments stop. Its local tests use disposable databases
  only. It is not deployed, has a 10,000-entry fail-closed limit, and does not
  independently audit Git; the paired Git adapter must do that. A privileged
  writer can bypass the audit and a DB operator can forge or roll back its own
  checkpoint, so independent administration and a further independently
  retained latest revision remain essential. It cannot make the setup DB safe
  merely by placing both schemas in the same database.
- `full-git-witness-history-audit.mjs` walks **every parent edge** of an
  unshallowed reachable Git history, not just the first-to-last tree diff.
  It rejects a deleted witness even if later restored, shallow histories,
  unsupported roots and overlong histories. The read-only operator command
  `npm run audit:witness-history` also compares local and remote branch heads
  both before and after inspection; it neither provisions nor authorizes
  anything. At branch head `af7d91a4c4c55af53ea676086e334a1a3be2a6fb` on
  7 November 2026, the working-tree audit inspected 664 commits and 680 parent
  edges successfully. GitHub API checks of the 14 then-visible branch tips
  found the same single synthetic wallet witness only on this branch, its
  predecessor branch and main; no native or Buffer witness was visible there.
  This is a **limited observation**, not a complete baseline: deleted refs,
  forks, noncooperating clients, off-Git history and races outside the checked
  branch are not covered. No independent head or checkpoint was deployed.
- `independent-setup-checkpoint.mjs` adds an authenticated machine-to-machine
  checkpoint service/client. The separate monitor fetches the exact configured
  Git branch and independently audits ancestry and every protected witness file
  **before** database CAS, rather than trusting the setup server's assertion.
  Its loopback-only bootstrap (`npm run checkpoint:monitor`) refuses missing
  state; it does not provision a baseline, grant DB roles, configure TLS, or
  deploy anything. The bearer belongs only in protected backend secrets, never
  browser code, URLs, logs or the repository. Tests use disposable PostgreSQL,
  local Git and an in-process fake HTTP transport. A real deployment still
  needs a dedicated operator, least-privilege checkpoint DB role, HTTPS reverse
  proxy, verified complete baseline, independent latest-revision monitoring,
  incident procedures and performance testing. A privileged monitor or DB
  operator can still forge or roll back the checkpoint. The native coordinator
  now rechecks the same claimed stage and prior originals after the witness
  acknowledgement, instead of extending an old snapshot. A failed, uncertain
  or expired postcheck consumes the claim: stop and reconcile, never reopen the
  wallet prompt. FT retains its existing preflight behavior.
- `postgres-native-oracle-prompt-fence.mjs` atomically retains one review and
  four stage rows, checks earlier original receipts and fresh native preflights,
  and claims each prompt once. `witnessed-native-oracle-wallet-setup.mjs`
  combines it with the separate Git witness; NEP-413 challenges bind the exact
  native action to a fresh Ed25519 FullAccess-key view (not EVM/0x support).
  Synthetic signatures, disposable PostgreSQL, local Git and in-memory CAS stores
  exercise concurrency, lost acknowledgments, schema tampering and stale checks.
  Both setup coordinators now require the other flow's witness on the **same**
  Git head before reservation or claim; the reservation CAS is tied to that
  checked head. Synthetic tests race separate databases and show at most one
  same-owner witness. A shared-configuration anchored-pair factory prevents
  accidentally selecting two Git branches with a common old head. The setup
  checks do not cover older/bypassing clients, every non-setup FT operation,
  independent wallets, an unanchored or compromised Git history, or release.
  This is not a hosted service or live wallet integration. The latest Git head
  still needs independent retention and monitoring. After the witness commits,
  the native coordinator re-fetches the prior original receipts and performs a
  new same-block FINAL preflight, verifying that the exact DB claim and shared
  owner hold still match before returning it. A failed or stale postcheck is a
  stop, not a new claim; it cannot guarantee that chain state stays unchanged
  while the wallet is open. Those server modules do not invoke a transaction-
  signing wallet; the experimental phone setup panel can do so after a valid claim and a separate explicit user action.
- `postgres-wallet-owner-fence.mjs` now reserves a shared per-owner holder in
  the **same PostgreSQL transaction** as either the native or existing FT
  prompt reservation; both flows must match it before a new claim. Independent
  synthetic processes racing the same disposable database produce at most one
  winner. This is deliberately a **permanent hold** in V1: there is no release
  or handoff, so one owner cannot subsequently start the other flow. Old rows
  without a holder are not silently enrolled or newly claimed; their retained
  originals remain inspectable and recordable for reconciliation. The lock
  applies only to upgraded, cooperating clients sharing one intact database.
  It does not prevent use of an older client or another database, a privileged
  rollback/fork, Git witness rollback, a compromised host or another wallet.
- The read-only completion check requires all four original receipt graphs and
  then verifies the exact keyless V9 vault, native policy, pinned provider route,
  deposit and restricted one-method agent key at one fresh FINAL block. The
  authenticated coordinator compares those hashes with its separate witness.
  It proves neither local private-key custody nor absence of an in-flight
  request, and does not authorize or establish provider execution.
- `web-src/native-oracle-setup-wallet-prompt.mjs` is a one-shot adapter used by
  the opt-in preview panel. It reconstructs all four reviewed action lists, checks the pinned
  V9 bytes and device-key metadata, and requires a fresh witnessed claim before
  calling a wallet. It also rejects repeated calls in one page; reloads and
  other devices still rely on the durable fence. A synthetic end-to-end test
  combined the browser adapter, one-use NEP-413 signatures, disposable
  PostgreSQL, a local bare Git remote and fabricated prior receipts. It did not
  contact a real wallet, public chain or provider, and is not a real-phone test.
  A separate test composes a non-extractable WebCrypto key with a simulated
  IndexedDB store; that store is not a verified durable backup.
  A wallet-returned hash is not FINAL evidence. Preflight can race state changes
  while the owner is approving, and unknown or rejected results must not retry.
- `native-oracle-review-catalog.mjs` deterministically reconstructs the fixed,
  unsigned testnet review from the public agent key and pinned artifact. Its
  public task ID is the complete review SHA-256; it is not a credential or
  proof of any prior action. Identical instances and restarts reconstruct the
  same review without a process-local cache; a changed planner rejects old
  unreserved IDs instead of silently changing terms. There is no task expiry,
  but each owner challenge and each on-chain preflight still has its own short
  freshness window. After authenticated reservation the fenced database
  separately retains the exact review. Missing or reconstructed state never
  proves that no prior prompt exists. Rate-limit review requests before any
  exposure; an existing local device key must match before the prototype client
  requests a review or reservation.
- `authenticated-native-oracle-setup-service.mjs`, the opt-in
  `native-oracle-setup-http.mjs` and `web-src/native-oracle-setup-client.mjs`
  now compose the owner-message challenges, retained native review, both setup
  witnesses, device-key check, four one-shot wallet prompts, original-hash
  preview/recording and completion check. The HTTP bridge is **off by default**.
  The wallet account panel now exposes an experimental native setup screen only
  on the dedicated top-level Bouncer site or approved test preview, after wallet
  control verification and an enabled same-origin backend. It displays storage funding, deposit, caps, gas
  allowance and four separate stage approvals. Each original is retained and
  checked at FINAL before another stage; unknown outcomes go to recovery. The
  screen requests persistent device storage, but does not provide key backup or
  revocation. A separately disabled-by-default testnet trial option now adds
  explicit review, one phone-key submission and read-only receipt/refund checks.
  A synthetic test
  exercises that path with real WebCrypto in simulated IndexedDB, throwaway
  signatures, disposable PostgreSQL, a local Git remote, an **in-memory** head
  checkpoint, fabricated RPC receipts and a fake wallet; lost claim responses
  and unknown wallet results stop without a second prompt. Phone-sized Chromium
  also exercises actual browser WebCrypto/IndexedDB against a fake wallet and
  fake routes, including a lost-claim response. Neither is an actual phone,
  independently deployed checkpoint, chain transaction or purchase.
  Creating a device key does not provide a verified backup or prove an older
  installation absent. Independent checkpoint operations and an authenticated
  recovery/handoff still must be completed before live funding or deployment.
- `experimental-phone-setup-runtime.mjs` and the opt-in preview backend now
  compose both same-branch anchored witnesses, the shared owner fence and the
  independently configured checkpoint. Startup checks the existing native,
  FT and authentication schemas without creating or repairing them and requires
  the separately retained head to match the configured branch. A missing,
  stale or uncertain checkpoint stops startup; it is not automatically reset.
  Native-only preview does not require the V12 FT artifact. Both transport
  switches are off by default; trial submission also requires the separate
  `BOUNCER_ENABLE_NATIVE_ORACLE_TESTNET_TRIAL=1` opt-in with native setup.
  This wiring and its disposable DB/local Git
  tests are **not** an independently operated deployment, live phone flow or
  approval to fund a vault. The review catalog is reconstructable across
  instances but is not an independent historical backup. The post-witness
  check reduces the Git-delay problem but the resulting five-second window can
  still expire during database, network or browser latency.
- `web-src/native-oracle-device-key.mjs` generates a local non-extractable
  Ed25519 key and can now sign **one fixed native oracle trial**, without
  exposing the private key. It reconstructs the reviewed terms, checks the
  supplied completion's shape and five-second freshness, derives the nonce and
  block, and commits the original transaction hash to a strict IndexedDB record
  before releasing a verified signature. The `ownerConfirmed` input is only an
  integration flag, not proof that a person saw or approved anything. A caller
  must authenticate the completion source and display the terms. The key module
  itself has no network, wallet or broadcast API; the separately gated phone
  flow composes it with a one-shot submission.
- `agent/native-oracle-phone-signer.mjs` adapts the existing native OutLayer
  runner to a callback which can return that phone signature. Its witnessed
  variant retains the original hash at the separately anchored witness before
  requesting a signature, refreshes completion and requires a witness readback
  after the runner's local journal write and before its single send. The
  completion supplier does not reserve chain state. A separate phone-side
  composition now obtains an authenticated witness over the opt-in setup API
  and signs locally. `presigned-witnessed-native-oracle-account.mjs` can pass
  those exact signed bytes to the runner after checking the original witness,
  peer and fresh state; the phone UI instead uses the direct one-shot testnet
  RPC path described below, without uploading signed bytes to the setup service.
  Synthetic tests compare Borsh bytes against the NEAR SDK, verify signatures,
  race two tabs and independent journals, simulate unknown sends, and check a
  fabricated result/refund recovered through the runner. Mobile-sized Chromium
  tests use a real WebCrypto key but fabricated setup evidence and no network send.
- The local original record coordinates cooperating tabs **only in one browser
  profile**. Storage deletion, rollback, eviction, another device/origin or
  bypassing clients can defeat it; no local record does not prove a prior
  transaction absent. Same-origin scripts/XSS can use the key. Local storage
  is not an independent backup or a distributed payment fence. Owner-led
  on-chain revocation and integrated device recovery are still required before
  funding.
- `native-oracle-wallet-recovery.mjs` prepares an unsigned owner recovery
  review that deletes the exact agent access key, then calls
  `revoke_agent_key` with 1 yocto. If the key is already absent it can prepare
  only the grant removal. `native-oracle-recovery-preflight.mjs` checks a
  fresh testnet FINAL block and, when applicable, the retained original key
  deletion and its receipt graph before the grant stage. This remains offline
  scaffolding: no authenticated UI, durable recovery prompt fence, wallet
  approval or real-phone revocation is implemented. In-flight requests may
  finish, and removing the key does not recover locked storage collateral.
- The native OutLayer runners require a **bounded one-shot** sender. They
  record the original signed hash before the single submission and recover
  using that hash; they do not fall back to a retrying sender. Their existing
  results still require exact provider request, completion and refund evidence.
- The [isolated nearcore test](https://github.com/Greatmujey/Bouncer/actions/runs/42398475213)
  exercised all four stages, the exact receipt verifiers, the zero-yocto guard,
  the restricted-key 1-yocto rejection and an over-cap rejection. The OutLayer
  registry in that test was fabricated, and no provider request or public-chain
  transaction occurred. A [later isolated run](https://github.com/Greatmujey/Bouncer/actions/runs/42399638463)
  also removed the agent access key, rejected a zero-yocto revoke, verified both
  recovery originals and confirmed that the grant and key were absent. The NEAR Connect converter is separately checked
  offline; that is **not** a real-wallet or real-phone compatibility test.

## Independently retained native-trial original

The experimental witnessed path is deliberately one-shot. After the four setup
originals and current policy/key state match, the runner constructs the exact
unsigned transaction and its NEAR hash. `createWitnessedNativeOraclePhoneAccount`
checks the pinned review, owner key, identity and goal, then calls the anchored
native witness's `claimTrial` **before** it asks the device to sign. The new
`trial_claim` record binds the operation and
review to the goal fingerprint, agent public key and original hash. It uses
compare-and-append plus readback; an uncertain acknowledgement consumes the
claim rather than permitting a replacement. The next completion snapshot must
match the witness head, the four originals and the agent nonce, and be at least
as recent as the initial block. The phone validates both snapshots and the
fixed goal; the runner writes and rereads its journal and witness before its
single submission. Initial completion may be at most 120 seconds old in this
path; the post-witness completion must still be within five seconds at signing.
These checks cannot prevent chain state changing after the snapshot.

The opt-in setup service composes `createAuthenticatedNativeOracleTrialClaim`
with the one-use PostgreSQL/NEP-413 authenticator, both anchored setup
witnesses, the pinned review and a fresh-completion supplier. Its same-origin
`POST /api/native-oracle-setup/trial-challenge` and
`POST /api/native-oracle-setup/trial` routes bind the owner, setup operation,
goal fingerprint, agent key, original hash and expected witness head. The trial
request consumes separate owner-authentication challenges for the exact trial
and the completion check, verifies the other setup witness and fresh state,
then appends and rereads the original. An uncertain response is a stop for
inspection, **not** a reason to submit another original. Neither route signs or
sends a transaction, and an off-chain signature is not approval to spend.

For the phone side, `createNativeOracleSetupClient().claimTrial()` performs
those authenticated requests and verifies the response fields.
`prepareWitnessedNativeOracleTrial()` in `web-src/witnessed-native-oracle-trial.mjs`
constructs the fixed goal from the reviewed setup, exposes terms including the
pinned project/input, maximum, rolling cap, gas limit/allowance, refund
destination and limitations for display, and returns a one-shot `sign()` method. After the caller obtains
explicit human consent, `sign({ownerConfirmed:true})` obtains fresh authenticated
completion, computes the unsigned original locally, retains it through the
witness, refreshes completion, and signs locally. It returns
`SIGNED_NOT_BROADCAST` and does not submit anything. A lost claim response or
any later failure consumes that preparation; inspect the authenticated witness
and recover the retained original instead of trying a different transaction.
A false consent flag cannot start the operation, but a true flag is only an
integration guard, not evidence that a person actually saw or accepted the
terms. The caller must display them and capture explicit approval before setting
it. Treat the returned signed bytes as sensitive bearer material: do not log,
commit, or expose them, and do not send them outside a guarded,
original-hash-recoverable execution path.

When explicitly enabled, the phone UI shows the reviewed price request and
requires a separate authorize action. Before claiming or signing, it checks the
fixed public RPC's CORS reachability and testnet chain identity. It then
witnesses the original, signs locally, rechecks the authenticated completion,
validates the exact signed bytes and signature, and commits a local submission
claim before one direct `send_tx` call. It never automatically resends. A lost
response remains unknown; the owner can recheck the same witnessed original.
The read-only `preview-trial` route verifies the FINAL transaction, OutLayer
request/completion, historical block and refund to the owner; an RPC
acknowledgment alone is not delivery. If the phone key or persistent storage is
unavailable, the owner can inspect a retained trial and check its receipt without
signing, creating a replacement key or submitting again. This does not restore
the lost key. The read-only relay must run the updated code that permits an exact
historical block hash and routes that lookup to the archival testnet RPC; the
existing hosted relay has not been updated here. Local submission claims coordinate
cooperating tabs only, not rollback, other devices or bypassing clients. Signed
bytes are sent to the public testnet RPC, not uploaded to the setup service.
Browser-sized tests use synthetic wallets, witnesses and responses; no real
phone, independently operated checkpoint or actual provider delivery has been
verified by this flow. The trial flag must remain off until those deployment
and recovery prerequisites are independently addressed.

For a phone that has already returned `SIGNED_NOT_BROADCAST`, create
`createPresignedWitnessedNativeOracleAccount` with that result, the same
`goal`, `review`, `identity`, pinned WASM bytes and owner key, both anchored
witnesses and a trusted authenticated fresh-completion supplier. It copies and
verifies the exact signed bytes, signature and goal, checks both witness
namespaces, and verifies the original nonce and four setup hashes against fresh
completion. Pass it to `runOracleGoal` with the reviewed public key and a
**shared durable journal**. The runner rechecks the witness and fresh state
after writing and reading the pending original, then invokes its bounded
one-shot sender. A lost send response remains pending and is never automatically
resent. Neither that adapter nor the phone `sign()` method broadcasts; the
separate opt-in browser path is described above. Any other transport must preserve their secrecy, retain
the exact original, obtain explicit consent, and avoid automatic retries.
Participating calls sharing the same journal are excluded; independent journals,
restored backups, bypassing clients and privileged rollback can still defeat
that coordination.

Alternatively, create the guarded account with the same `goal`, `review`,
`identity`, pinned WASM bytes, trusted review hash and owner public key used by
setup, an owner-authorized witness, a fresh authenticated completion supplier,
and a phone-signature callback. Pass the account to `runOracleGoal`; its
`requiresWitnessedOriginal` guard performs the pre-send witness readback.
For receipt-only recovery on another cooperating device or process, call
`recoverWitnessedNativeOracle` with the same goal/review/identity and trust
anchors, a witness, a scoped durable journal and a trusted provider. It copies
the witnessed original into an empty journal, or checks an existing matching
journal, then verifies the original's receipt graph. It never signs or sends.
A missing original, conflicting journal, unknown receipt, witness outage or
lost acknowledgement is a stop for reconciliation, not proof of non-execution
and not permission to retry. A recovered old result still has its normal
freshness limit when used.

**Trust and deployment:** The signing module checks the shape and consistency
of the supplied witness/completion evidence; caller-supplied booleans are not
cryptographic attestation, proof of an independent anchor, or proof of human
consent. Integrators must use the authenticated claim service, securely
transport its challenge and completion evidence to the phone, display the
terms and obtain real consent. Its witness must use a separately operated,
independently retained and rollback-monitored latest-head checkpoint, with
append-only Git history auditing. A local in-memory store or a public Git repository alone does
not provide that guarantee; privileged or simultaneous rollback of all trusted
systems, bypassing clients, compromised RPCs and same-origin XSS remain outside
it. The tenth witness record changes the format: upgrade all witness readers and
checkpoint monitors together; older readers reject it. Authenticated setup
inspection returns witnessed records, including the trial hash. The new routes
are disabled unless the experimental setup service is explicitly configured.
The opt-in owner UI covers the four setup stages and original recovery, not the
trial; authenticated signed-byte transport and separate checkpoint deployment
remain to be integrated. PostgreSQL and Chromium tests use synthetic
owner, chain and witness data; their local Git/synthetic peer is not an
independent checkpoint and they are not real-phone tests. The PostgreSQL
integration exercises the signed-original handoff through the guarded runner
with a simulated unknown send and receipt-only retry; it sends nothing to NEAR.
No device key is restored by copying an original hash; a replacement device needs a separate owner-led
key-revocation and installation procedure.

## Funding and refunds

The current plan transfers **5.4 test NEAR** to the new keyless vault for
contract storage and operational headroom, plus up to **0.1 test NEAR** as a
tracked vault deposit. Storage collateral can remain locked: a successful
setup is not automatically reversible and there is no claim that the whole
5.4 NEAR can be recovered. The separate 0.5-test-NEAR function-call key
allowance is a *gas spending limit*, not a provider deposit. Readiness uses a
further 1-test-NEAR owner reserve and a pinned gas-price/storage estimate; none
of these estimates guarantees admission, fee levels or future state.

The full authorized execution maximum counts against the rolling budget. For
an accepted execution, unused native funds are expected to go **to the owner**,
not back into the vault or rolling budget; only actual matching receipts can
establish a refund. A rejected request or failed promise may behave differently.
Do not infer a refund or safe retry from a timeout.

A [read-only snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/42397841711)
at FINAL block `9GLMWoW5ubnQVFjsv4RNmWGVUDDrpd7WtPiuns3w32pt` observed about
20.04 test NEAR in `great_mujey.testnet` and passed the then-current
approximate 6.5-NEAR owner-funding check. This is **historical public data**, not
proof of wallet control, a reservation, current balance or permission to spend.
The independently operated OutLayer account had a FullAccess key, so its code
can change. A lookup of global V9 code at one RPC did not return a match; that
is not proof of global absence or a compatible wallet transport.

## Native-only resource path (not a full mission)

`agent/mixed-mission.mjs` now accepts a native-only oracle/OutLayer goal without
an FT goal or FT key. The checked-in `examples/native-oracle-resource.example.json`
is an **unsigned, non-executed example**, not evidence that the candidate vault,
key, provider purchase or delivery exists. Preview is read-only; execution would
require the exact installed owner-approved policy and scoped key, a trusted RPC,
an exclusive local original-hash journal, and an explicit `--execute`. The
native-only CLI still expects a local restricted-key file, **not** the phone's
non-extractable key; it is not a live phone solution. Its `--recover-only` mode
reads an existing native journal without signing keys or new payments. A stale
recovered price is marked unsuitable for current use, not automatically bought
again. The single resource cannot establish a complete compute/storage/API
mission, and the local journal is not distributed rollback protection.

## Experimental backend configuration (not a live-use checklist)

`read-only-preview-backend.mjs` keeps setup routes disabled unless an operator
explicitly sets `BOUNCER_ACK_EXPERIMENTAL_SETUP=testnet-transport-only` and
one or both of `BOUNCER_ENABLE_NATIVE_ORACLE_TESTNET_SETUP=1` and
`BOUNCER_ENABLE_WITNESSED_TESTNET_SETUP=1`. It also requires an already
provisioned dedicated setup database, an absolute checkout path, the actual
session branch, a fully verified baseline, and a separately operated HTTPS
checkpoint. Their configuration names are `BOUNCER_TESTNET_SETUP_DATABASE_URL`,
`BOUNCER_TESTNET_WITNESS_GIT_REPO`, `BOUNCER_TESTNET_WITNESS_BRANCH`,
`BOUNCER_TESTNET_WITNESS_BASELINE`, `BOUNCER_TESTNET_CHECKPOINT_ORIGIN` and
`BOUNCER_TESTNET_CHECKPOINT_TOKEN_FILE`. The bearer must be a canonical
32-byte base64url token in an owner-only regular file; never commit it, put it in
browser code or include it in logs. FT setup additionally requires the pinned
`BOUNCER_V12_WASM_PATH`; native-only setup does not. The relay session settings
remain separate. There is no automatic checkpoint seeding, schema creation or
safe release of an existing hold. A branch advance must be independently
reviewed and checkpointed before startup. These settings are deliberately not
a recommendation to expose the current prototype or lock testnet funds.

## Before enabling a real phone flow

1. Finish, deploy and independently monitor the per-owner prompt fence and
   authenticated owner session for these **four** exact stages. Extend the
   single-database cross-flow hold to an independently anchored, safely
   reconciled handoff/release and establish an operational recovery procedure. Preserve the
   separately anchored review and every original hash across crashes, lost
   responses, browser changes and database or witness rollback. A local browser
   cache alone is insufficient. An uncertain claim or prompt is a stop, not a
   reason to prompt again.
2. Complete and test device-side agent-key custody, recovery
   and revocation without asking for a wallet seed or private key. Verify the
   wallet can deploy the large artifact and install the restricted key on an
   actual phone; feature flags and converter tests are not enough.
3. Independently review and real-device-test the experimental owner interface's
   fresh preflights, original-hash closure and one-shot claims. The owner must
   review and separately approve each stage. Check state and original receipts
   again after each approval and before proceeding. Do not enable the preview
   backend for funding/deployment before these gates and custody recovery are complete.
4. Only after setup is verified, perform a separately bounded native oracle
   request, preserve its original signed hash before the one broadcast, and
   verify its actual provider receipt, result and refund. Label the outcome
   according to the evidence, not a mock or a screenshot.

The older V3 owner's originals remain unresolved; this plan explicitly excludes
that owner. V12 native-oracle runner compatibility has not been established;
this plan deliberately uses V9 rather than assuming compatibility. No
production spending is enabled by these modules.
