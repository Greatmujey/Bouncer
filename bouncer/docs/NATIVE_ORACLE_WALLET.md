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
  signing wallet; the unconnected browser adapter can do so after a valid claim.
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
- `web-src/native-oracle-setup-wallet-prompt.mjs` is an unconnected one-shot
  adapter that reconstructs all four reviewed action lists, checks the pinned
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
  preview/recording and completion check. The HTTP bridge is **off by default**
  and the client is not connected to the hosted wallet UI. A synthetic test
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
  switches are off by default. This wiring and its disposable DB/local Git
  tests are **not** an independently operated deployment, live phone flow or
  approval to fund a vault. The review catalog is reconstructable across
  instances but is not an independent historical backup. The post-witness
  check reduces the Git-delay problem but the resulting five-second window can
  still expire during database, network or browser latency.
- `web-src/native-oracle-device-key.mjs` can generate and retain one local,
  non-extractable Ed25519 WebCrypto key per owner and test its possession
  without exporting the private key. It has no transaction-signing, network or
  wallet API and is not connected to the UI. Synthetic IndexedDB tests and a
  390px Chromium test cover concurrent creation and reload, not real phones or
  durable backups. Storage eviction or device/origin loss can lose this key;
  same-origin scripts/XSS can still use it. Missing local data does not prove
  an on-chain key was never installed. Owner-led on-chain revocation and a
  complete recovery process are still required before funding.
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
3. Integrate fresh stage preflights, original-hash receipt closure and retained
   claims into the owner interface. The owner must review and approve each
   stage. Check state and original receipts again after each approval and before
   proceeding. Do not expose an enabled funding/deployment button before these
   gates and custody recovery are complete.
4. Only after setup is verified, perform a separately bounded native oracle
   request, preserve its original signed hash before the one broadcast, and
   verify its actual provider receipt, result and refund. Label the outcome
   according to the evidence, not a mock or a screenshot.

The older V3 owner's originals remain unresolved; this plan explicitly excludes
that owner. V12 native-oracle runner compatibility has not been established;
this plan deliberately uses V9 rather than assuming compatibility. No
production spending is enabled by these modules.
