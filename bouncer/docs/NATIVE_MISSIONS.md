# Guarded native-NEAR missions (experimental testnet)

This is the **standard Bouncer-guarded** path, not the separate direct
wallet-to-OutLayer test. An owner-reviewed manifest can sequence either random
compute and a price/API result, or a **dependent price → calculation** task,
followed by a **public, self-hosted NEAR contract storage** write. The latter
uses a verified OutLayer price as input to a separate pinned WASI calculation.
The public value records both verified results and their original transaction
hashes. This is not an independent
storage purchase, private storage, an availability guarantee, or proof of
permanence. Never store secrets; transaction history remains public even after
release. FT functionality remains separately supported.

**Status:** V14 is a fresh-state, unaudited testnet prototype; it is not an
upgrade or migration of V9. It is not deployed/configured for this mission by
this repository. The exact example below is illustrative, including its
placeholder code hash, IDs, revisions and tiny amounts; it is not evidence of
an existing vault or permission to spend. There is no live multi-resource
fulfillment, real-phone approval, provider-availability guarantee or audit.
Do not use real funds.

## Mission interface and safety

[`native-mission.example.json`](../examples/native-mission.example.json)
shows the original random example. The separate
[`native-market-mission.example.json`](../examples/native-market-mission.example.json)
shows the dependent price → compute → storage sequence. Both are unsigned,
illustrative templates, not live vaults or spending authorization. The market
input names an earlier oracle goal and an owner-reviewed integer quantity.
Bouncer checks the oracle transaction/receipts and freshness, rounds the
reported USD price half-up to micro-dollars, and binds the calculation input to
the oracle's original hash. It independently rechecks the returned integer
product before storing anything. This does not prove market accuracy, TEE
execution, the source's observation time, or that OutLayer can fetch the WASI
program. See the [program and reproducible build](../programs/market-summary/README.md).
OutLayer charges for fetching public data and compute; storage is protocol stake
locked in the vault, not an independent vendor purchase.

One storage goal must pin the actual V14 deployed-code hash; multiple storage
goals must agree on it. The mission checks the reviewed hash and an empty
vault access-key list at FINAL before each leg, and verifies the reported
execution-block code/keyless state when reconciling every leg. These are trusted
RPC end-of-block views: they cannot prevent a later owner-authorized upgrade or
prove ordering within a block.

The programmatic entry point is `runNativeMission({ mission, provider, journal,
signers, execute, recoverOnly, checkpointGoalId })`. Preview is the default
(`execute: false`). Passing `checkpointGoalId` with execution authorizes only
that next unpaid goal; it returns `CHECKPOINT` before the next goal. Omitting it
from a direct programmatic call can run all remaining goals: callers must
supply their own consent boundary. The browser service enforces checkpoints for
market missions.
New calls require the original exclusive journal and `execute: true`.
`recoverOnly: true` must not include signers; it reconciles existing original
hashes without creating transactions. The signers map is keyed by goal ID;
each key must be a single-method function-call key for the reviewed owner and
vault and separately granted by the policy. Do not use full-access keys. Never
put private keys, seeds or credentials in manifests, browser requests or chat.

The manifest fixes one owner and vault, unique IDs, ordered goals, required
resources and a maximum aggregate amount in yoctoNEAR; gas is separate. A
missing required resource blocks before spending. Before any new transaction
the runner reconciles all prior originals, preflights every remaining route,
program, project, owner key and policy, and conservatively checks aggregate
per-transaction caps, rolling budgets and available vault balance. A disabled
rolling cap is blocked. It rechecks remaining budgets, pinned V14 code and
oracle freshness as the sequence proceeds. The contract enforces its policy,
allowlist and 1-yocto owner-only escalation guard; agent calls attach zero.

For storage, the reviewed amount is a maximum: actual incremental protocol
storage stake is debited from the vault and counted against rolling spend.
The vault must also retain backing for its rolling-budget metadata and an
operational reserve. The owner can release data with a 1-yocto action; actually freed stake is
credited back to the vault, a tombstone permanently reserves the object ID,
and the rolling spend is not reversed. OutLayer's independently verified
refunds go to the owner; they do not automatically restore the vault balance
or rolling budget.

Each original signed hash is durably recorded before a bounded one-shot
submission. An unknown result is **not** evidence of non-execution. Stop and
reconcile that original; do not automatically resend or create a replacement.
The steps are non-atomic: earlier work is not rolled back if a later leg fails.
Receipt and object verification trust the RPC and provider; an oracle result is
not a guarantee of truth or a TEE attestation. Preflight is a snapshot, not a
reservation.

## Bounded natural-language proposals

`agent/native-mission-planner.mjs` can ask an operator-selected, OpenAI-compatible
model to choose **market valuation or random compute** and bounded parameters
from an owner-controlled catalog. It creates a normal V14 mission manifest for
review; it never chooses the vault, account, policy, payee, program, amount,
public-storage ID or key. The catalog and proposal are validated before the
normal runner can use them; there is no fake fallback. Model output can still
misinterpret an objective and must be reviewed. The objective is sent to the
chosen model endpoint, which may retain it: never include secrets. Current tests
use mocked model responses. This planner is **not yet connected to the hosted
UI**, and it does not authorize or autonomously spend. A live model-backed
mission remains unproven.

## Optional browser review and service

The wallet panel offers **Review a guarded testnet mission** after identity
verification. If an operator has deliberately mounted the optional same-origin
backend, it displays the exact manifest, hash, maximum plus gas, public-storage
and non-atomic/no-retry warnings before an explicit NEP-413 owner approval.
For a market mission it requires a distinct one-use approval for each next step,
shows the verified prior outputs and each step maximum, and links original
transactions to a testnet explorer. The older random demo retains its one-mission
approval. This is not yet the planned review-once autonomous live mode.
Connecting, entering an account name, or signing the separate identity message
does not grant spending authority. The explicit approval is an off-chain
instruction to the configured agent, not an on-chain transaction signed by
the wallet. This particular approval currently requires a named testnet owner
with a current Ed25519 Full Access key and NEP-413 message support; the
existing EVM-on-NEAR/0x connector is preserved but cannot authorize this route
yet. The frontend never sends private keys, chosen transactions,
receiver addresses or mutable goals to the backend. Recovery uses the original
hashes and no signing keys. Unknown/error results hide the approval button for
that session and offer receipt-only checking, first displaying any matching
original hashes retained by that server's local journal. A missing local hash
is not proof that a transaction never happened.

`agent/authenticated-native-mission-service.mjs` composes a fixed manifest,
server-side scoped agent signers, trusted RPC, `FileJournal` and the existing
PostgreSQL one-use owner authenticator. `npm run native-mission:serve` now
wires these pieces to a **single-host Node service**; it is disabled unless
explicitly configured. Its original loopback mode serves the reviewed website
and mission API, with the optional WalletConnect relay and Google identity.
An experimental Vercel-to-Railway split described below keeps the same browser
origin and runs only the mission API on Railway. Startup performs no wallet
prompt or transaction. Neither setup has been tested with a real wallet or
live mission.

The operator still needs a dedicated HTTPS host, PostgreSQL challenge store,
persistent original journal, and an owner-authorized fresh V14 vault with
policies/allowlists and scoped keys. There is no complete browser provisioning
flow for that setup yet. A static Netlify or Vercel deployment alone cannot run
missions. A mutable deploy-preview alias can serve different bytes from an
older immutable deploy, so neither a visible landing page nor a previous
successful build proves the current preview is safe for wallet approval.
`scripts/verify-hosted-static.mjs` compares the staged public files, HTML
security headers, expected wallet origin and absence of the mission API using
GET requests only. It does not prove a real wallet, backend, or transaction.
A mismatching preview must not be used for approval. The development server's
separate `BOUNCER_NATIVE_MISSION_PREVIEW=1` switch only proxies to an already
running loopback service and provisions nothing.

### Operator setup for the single-host service

This is a **testnet-only operator interface**, not an instruction for a wallet
owner to hand over keys. The owner approves setup and the mission in their own
wallet; the server must never receive the owner's private key or recovery
phrase. Use a single trusted machine with persistent, backed-up storage. Bind
an HTTPS reverse proxy on the reviewed dedicated domain to loopback port 8789;
the proxy must preserve `Host`, set `X-Forwarded-Proto: https`, sanitize
forwarded headers, and never serve the private state directory. Do not put the
journal on an ephemeral serverless filesystem or run multiple replicas.

All paths below are **absolute**, outside the checkout, and in existing
owner-only mode-0700 directories. Create a validated mission manifest using the
actual V14 code hash, accounts, caps and routes; the example is not live
configuration. Set `BOUNCER_NATIVE_MISSION_FILE`,
`BOUNCER_NATIVE_MISSION_JOURNAL_FILE` and `BOUNCER_FILE_JOURNAL_KEY_FILE`.
For a genuinely **new** vault/mission with no earlier attempts, the existing
`npm run init-file-journal-key -- --key-file <new-key>` creates the private
32-byte encryption key; `npm run native-mission:init-journal --
--confirm-brand-new-vault` then exclusively creates the encrypted journal and
retains the reviewed mission intent. Neither tool overwrites an existing file.
**Never initialize a replacement** for a missing/uncertain journal. The tool
cannot prove that the vault is new, and encryption cannot detect rollback.
Back up the original journal and key securely.

Set `BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE` and run `npm run
native-mission:agent-keys -- --confirm-new-agent-keys` once. It writes distinct
new private *agent* keys mode 0600 and outputs only their public keys, required
single vault methods and maximum gas allowance; it does not install or
authorize them. The wallet owner must separately review and approve vault
creation, funding, the exact policy grants and those restricted access keys.
The offline V14 research plan may assist review but is not a wallet onboarding
flow or permission to send. The server checks each key's on-chain single-method
scope, receiver, ≤1 test NEAR gas allowance, owner and pinned keyless vault at
startup; the runners repeat policy/key checks before each new payment.

In a dedicated testnet PostgreSQL primary, set
`BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL` and run `npm run
native-mission:init-auth -- --confirm-dedicated-testnet-db` explicitly. This
creates/checks the consent schema without a wallet prompt. Remote database
connections require `sslmode=verify-full` and a trusted CA. The database URL is
secret and must not appear in the repository, logs or command arguments. Set
`BOUNCER_WALLET_ORIGIN` to the exact dedicated HTTPS origin,
`BOUNCER_TESTNET_RPC_URL` to the trusted testnet RPC,
`BOUNCER_NATIVE_MISSION_MODE=execute` and `BOUNCER_NATIVE_MISSION_ENABLED=1`,
then run `npm run native-mission:serve`. Optional public configuration is
`BOUNCER_WALLETCONNECT_PROJECT_ID` and `BOUNCER_GOOGLE_CLIENT_ID`; port defaults
to 8789 (`BOUNCER_NATIVE_MISSION_PORT`). The server refuses to recreate a
missing journal or initialize its database on startup. It listens on loopback
only in the original same-origin mode and must be behind the dedicated TLS
proxy; the Railway API-only mode below must be explicitly selected instead.
Neither mode has been deployed for this mission.

To investigate retained originals without loading agent keys or the consent
database, start with `BOUNCER_NATIVE_MISSION_MODE=recover` and the same mission,
RPC, original encrypted journal and key. Recovery cannot issue challenges or
sign/send. Graceful shutdown waits for in-flight work, even after a browser
disconnect; a forced kill or lost disk still requires reconciliation. The
filesystem, database and operator may be compromised or rolled back. A missing
hash never proves that a transaction did not happen.

### Experimental Vercel website + Railway API

This is a **recovery-first testnet design**, not a claim that a mission is
provisioned or that a Railway volume is durable. Charges may apply; review the
actual plan and obtain approval before creating a paid service. The website stays on the
exact approved Vercel wallet origin. Six bundled `/api/native-mission/*`
functions are **off by default** and forward only their fixed actions to one
configured Railway HTTPS origin. They do not forward cookies, select a
browser-provided destination, follow redirects, sign, or retry. An ambiguous
execution response must be reconciled by the original hash.

The `bouncer/Dockerfile` builds a persistent Node service with Linux `flock`;
the Railway project root must be `bouncer`. Without explicit mission enablement
it runs a **non-spending standby**: `/` and `/healthz` report `STANDBY`, and
mission endpoints return 404. No mission, vault, keys, consent database or
journal is created, and the mission runtime is not loaded. The container also
runs one fixed, public read-only check at startup; `/readiness` reports whether
it observed the declared mounted directory, a testnet RPC, the pinned oracle
registry and a backend-side hash of the market WASM. It never performs checks
on incoming requests and can be disabled with `BOUNCER_STANDBY_READINESS=0`.
These are point-in-time indications, **not** proof of volume persistence,
backup, provider-side fetch/execution, wallet control or mission readiness.
When configured, `/healthz` returns `ONLINE` without authentication; it is only
process liveness. Every mission API remains gated by the proxy secret. Attach a
persistent volume to **one instance**;
under it, provision an owner-only 0700 directory containing the already
reviewed mission, its dedicated **original** encrypted journal and its key.
The journal must retain that mission's intent and no unrelated entries. The
container user must own those private files. Do not put private state in the build, Git,
serverless `/tmp`, logs, or a browser. The current project has no complete
browser setup to create these files or the V14 vault.

The Railway service must explicitly set `BOUNCER_NATIVE_MISSION_ENABLED=1`,
`BOUNCER_NATIVE_MISSION_MODE=recover`,
`BOUNCER_NATIVE_MISSION_INGRESS=railway-proxy`,
`BOUNCER_NATIVE_MISSION_BIND=0.0.0.0`, the exact `BOUNCER_WALLET_ORIGIN`, a
trusted `BOUNCER_TESTNET_RPC_URL`, and absolute volume paths for
`BOUNCER_NATIVE_MISSION_FILE`, `BOUNCER_NATIVE_MISSION_JOURNAL_FILE` and
`BOUNCER_FILE_JOURNAL_KEY_FILE`. Set `BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN`
to its exact HTTPS `*.up.railway.app` origin and
`BOUNCER_NATIVE_MISSION_PROXY_SECRET` to a newly generated 32-byte random
lowercase-hex secret. Railway supplies `PORT` and
`RAILWAY_VOLUME_MOUNT_PATH`; the service checks the file parents resolve
inside that declared mount. If overriding the port it must match `PORT`.

Only after the backend is checked, the Vercel project can deliberately set
`BOUNCER_NATIVE_MISSION_PROXY_ENABLED=1` and the **same** fixed wallet origin,
backend origin and proxy secret. Store the secret in provider secret settings,
never in Git, the browser or chat. The secret is only a network gate: it does
not authorize the owner, and a compromised host can bypass it. Recovery needs
no agent keys or database. The recovery-only service's original-journal check
creates a `.recovery-started` marker, which is **not** proof that no transaction
occurred or that receipts were verified. Railway execution is explicitly
blocked even after this marker until the independent original checkpoint is
wired into setup and every mission leg and recovery-tested. The separately
reviewed vault, restricted keys and PostgreSQL one-use owner authentication
are also required. A fresh owner signature remains required for each market
leg. Enabling or deploying is not itself permission to spend.

For the Railway mode the runtime holds an exclusive kernel lock on a persistent
`.host-fence` beside the journal and checks that a second open cannot take it.
The process keeps the lock until a drained shutdown or death; never remove or
replace this fence file while a process may be running. On an unclean stop, an
exact marker from this fenced runtime can be reclaimed **only in recover mode**.
A durable `.recovery-required` marker blocks execution across restarts or a
wrong key until recovery has verified all retained mission-original receipts
and the journal records them complete. If there is no verifiable original, or the
marker is legacy, partial or unrecognized, the service fails closed for manual
review. Do not delete locks, reset state, invent an original or retry a payment.
A graceful recovery start alone does not clear the requirement. Tests exercise
this on a local Linux filesystem; actual Railway volume locking, persistence,
headers and routing still need a non-paying deployed check.

This host fence coordinates only cooperating processes sharing that same honest
filesystem. It cannot prevent a second journal, another host, volume loss,
rollback, a forged mount setting, compromised operator or old snapshot. A
backup must never be restored as if it were current authority. Keep a separately
protected record of original hashes and reconcile uncertainty before any new
approval. A research-only two-copy checkpoint is now implemented in
`agent/v14-original-witness.mjs`: it binds the reviewed setup and mission,
provides one-shot methods for recording wallet claims and original hashes,
and stops if copies differ. Its encrypted local `FileJournal` adapter and
separate Supabase compare-and-append schema/Edge adapter are tested with
synthetic data. `agent/v14-setup-rpc-verifier.mjs` can check each separately
retained setup original through the fixed read-only testnet RPC, then validate
cumulative policy, funding and key state at one fresh FINAL block before the
witness records verification. This is tested with synthetic receipts/state and
still trusts the RPC; it is not yet integrated into wallet prompts. Research-only
owner enrollment and recovery helpers verify a
short-lived NEP-413 message and a current testnet FullAccess key at a fresh
FINAL block. Recovery can read the existing public history even if the
checkpoint capability is lost; it cannot rotate that capability or recreate a
journal. The optional read-only wallet panel stays hidden unless its separate
Edge endpoint is explicitly enabled. Enrollment is not wired into the wallet UI.
Research-only mission hooks can now connect the native runners to this witness:
`beforeOriginalBroadcast` is called after the local pending hash is recorded
but before the single broadcast, and `afterOriginalVerified` runs before a
later goal can begin. The V14 adapters bind owner, vault, reviewed mission
hash, goal kind and original fingerprint; they stop on a missing or mismatched
acknowledgement. Recovery may verify the same retained original without
signing or sending again. The runner rechecks its local journal and freshness
after asynchronous callbacks. The hooks are optional for legacy callers: a
callback or its acknowledgement is **not** proof that storage is independent,
durable, authenticated, or that its receipt verifier is honest. Tests use a
simulated independent store and synthetic or isolated-sandbox receipts only.
**These hooks are not enabled in the live mission service, and the checkpoint
is not provisioned for the owner or verified against a real testnet receipt.**
It retains the public review, hashes and commitments, not the journal encryption
key or agent keys; those still require separate durable recovery. `web-src/v14-secret-recovery-kit.mjs` provides an experimental,
passphrase-encrypted *key kit* for the capability, distinct journal encryption
keys and only the three reviewed agent keys; it rejects the reviewed owner
signing key but cannot by itself prove another key is not FullAccess. Never
supply a wallet key. The cryptographic helper performs no network or file I/O.
A key kit is **not** a journal backup or proof of the latest head. Separate
research-only helpers and default-off Edge handlers can bind one encrypted kit
and its owner-signed enrollment to a new checkpoint, then retrieve the
ciphertext with current-owner authentication. The V2 schema is installed in
the separate checkpoint database after disposable PostgreSQL 17.11 tests; its
function bodies and restricted grants were checked against the reviewed source.
No V2 Edge handlers are deployed or enabled, and no owner scope or kit exists.
For phone or desktop, the experimental `v14-browser-witness-store.mjs` keeps
an encrypted IndexedDB copy and performs an atomic compare-and-swap between
same-origin tabs. `v14-browser-original-witness.mjs` compares it with a
separately retained copy and can record a one-shot claim before a prompt.
The experimental phone prompt adapter reconstructs all six action commitments
and requires that claim plus fresh preflight callbacks before calling a wallet.
A read-only preflight implementation checks each retained prior original and
fresh cumulative state at the pinned testnet RPC; synthetic integration covers
all six stages. A separately default-off, secret-gated Railway/Vercel route and
same-origin browser client exist in source; they are not deployed, enabled or
connected to the live UI. The browser checkpoint bridge is also default-off
and not deployed. A missing,
evicted, rolled-back or mismatched copy stops the flow rather than silently
creating a replacement. Synthetic desktop and phone-sized Chromium tests do
not prove a physical phone, wallet, or browser-storage durability. Live
wallet/UI wiring, secure Railway handoff, durable mission-journal backup and
restoration remain unfinished. The separate read-only setup flags must not be interpreted as
mission execution or loader enablement; neither is active on the deployed
services. Public research binaries in `web/artifacts/` match the hashes in
`shared/v14-phone-research-artifacts.mjs` and the explicitly checked V14 build.
They are not included in static-site staging, and remain disabled and
unaudited; their availability is not approval to use them. Plan bytes must match independently retained artifact pins, not pins
obtained from the server being checked. A wallet returning no result after navigation
leaves its claim blocked until the original is reconciled, never retried.
An administrator able to roll back both copies can defeat it. Never infer independent durability from
two adapter names or silently recreate a
missing copy. Railway says
[trial volumes can be deleted 30 days after trial credits
expire](https://docs.railway.com/pricing/free-trial#data-retention); a trial volume
must never be the sole copy of originals. Railway and Vercel remain unavailable
for this mission until their actual service, cost, configuration and deployed
behavior are verified.

A separate manually dispatched V14 public preflight reads a named owner and
candidate direct-child vault at one fresh FINAL testnet block. It reports the
pinned artifact identity, account/registry checks and an **unapproved estimate**
for storage funding and the example mission cap, with gas additional. An
unknown candidate-account view is not treated as absence. These public reads
cannot prove wallet control, consent, delivery or an independently retained
original. The example amounts are not instructions to fund or sign.

Mobile V14 provisioning is also unresolved. The identified CI-built
WASM was 499,063 bytes; its 665,420-byte base64 code field alone exceeds the
Meteor mobile bridge's 400,000-byte request limit. CI also investigates a
separately pinned compressed loader, **research only**: at commit `236aeca`,
the synthetic Meteor request was 242,375 bytes and isolated tests covered a
failed upgrade and explicit owner refund. An asynchronous upgrade can still
fail, and the UI, retained original, owner-controlled recovery and real wallet
behavior need end-to-end verification. `agent/native-v14-phone-plan.mjs`
constructs an **unsigned, offline research plan** from independently reviewed
artifact digests, explicit limits and three distinct restricted public keys.
It makes no wallet prompt, does not check live state, and is not connected to
the UI or a durable setup fence. A separate research receipt inspector matches
only independently retained originals against the reviewed actions and loader
upgrade; failure or a missing result never permits a retry. Its trusted-RPC
receipt checks do not establish a prompt fence or current state. A read-only
completion inspector can also compare all six originals' bounded outcome graphs
and the installed policies, keyless vault and restricted keys at one fresh
FINAL block. NEAR may omit the local AddKey receipt body; neither the graph nor
the snapshot authorizes setup prompts or establishes key custody. Fitting
a code field within a bridge limit would not verify the complete wallet request. A published NEAR
global contract referenced by immutable code hash could
reduce a wallet payload, but the [pinned Meteor mobile bridge](https://github.com/Meteor-Wallet/meteor_wallet_sdk/blob/53a8b39d1aaaf067502c11e49ebb050c75df019e/packages/meteor-sdk-v1/src/MeteorConnect/target_clients/mobile_bridge/sdkActionToMobileBridge.ts)
does not map `UseGlobalContract`. Bouncer does not currently implement or
claim a global-contract setup route; no global artifact was published here.

A static Netlify build is provided by the root `netlify.toml`. Its staging
script approves exactly the dedicated HTTPS site URL supplied by Netlify (or
`BOUNCER_WALLET_ORIGIN`), rather than trusting every Netlify preview origin.
Deploy previews on a different hostname stay wallet-disabled unless separately
reviewed and staged for that exact origin. The static build does not provision
Google's session backend, the optional WalletConnect relay, or the mission
backend. A public WalletConnect project ID can be supplied separately through
`BOUNCER_WALLETCONNECT_PROJECT_ID`; an empty ID leaves that option disabled.
Actual wallet, RPC CORS and phone behavior on a new host still require testing.

The server operator, signer custody, RPC, database and local filesystem are
trust boundaries. `FileJournal` locks only cooperating processes using that
file; it is **not** an independent checkpoint and cannot prevent rollback,
separate journals, bypass or cross-device duplicate execution. Do not expose
this prototype as a production spending service; it needs independent durable
coordination, deployment hardening and review. The injectable runner is for
offline tests only.

## Evidence

Unit tests use synthetic FINAL receipts and ephemeral keys for three-leg
sequencing, budget checks, storage readback, authentication, challenge
replay/tampering, unknown results and original-only recovery. The configured
single-host service is also tested with a disposable PostgreSQL instance and
fabricated RPC, including a real one-use signed challenge and a policy change
that blocks before sending. Separate loopback-only nearcore scenarios exercise
a disposable V14 contract and all three real guarded JS runners. The
three-leg scenario uses a fabricated local provider: its outputs are not
independent OutLayer execution, although the sandbox executes the vault calls,
storage writes and refund transfers. These tests cannot prove live OutLayer
delivery, independent storage, a real wallet approval or safe deployment.
Mocked desktop and mobile browser tests also check review/recovery UI and the
dedicated Netlify origin. See the corresponding
CI run for its actual result; a script's existence is not a passing test.
[Run 42503338044](https://github.com/Greatmujey/Bouncer/actions/runs/42503338044)
passed the isolated three-leg/fabricated-provider scenario and the mocked browser
checks at commit `5d2f894`. [Run 42504217242](https://github.com/Greatmujey/Bouncer/actions/runs/42504217242)
also passed the separate compressed-loader research scenario at `236aeca`.
Neither was a public-chain or real-wallet test.
