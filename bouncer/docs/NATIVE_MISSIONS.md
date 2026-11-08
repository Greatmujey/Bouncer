# Guarded native-NEAR missions (experimental testnet)

This is the **standard Bouncer-guarded** path, not the separate direct
wallet-to-OutLayer test. A fixed, owner-reviewed manifest can sequence random
compute, a price/API result and a **public, self-hosted NEAR contract storage**
write. The storage value can be assembled from earlier verified compute/API
results and their original transaction hashes. This is not an independent
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
shows all three kinds in order and a storage goal referencing the first two.
One storage goal must pin the actual V14 deployed-code hash; multiple storage
goals must agree on it. The mission checks the reviewed hash and an empty
vault access-key list at FINAL before each leg, and verifies the reported
execution-block code/keyless state when reconciling every leg. These are trusted
RPC end-of-block views: they cannot prevent a later owner-authorized upgrade or
prove ordering within a block.

The programmatic entry point is `runNativeMission({ mission, provider, journal,
signers, execute, recoverOnly })`. Preview is the default (`execute: false`).
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

## Optional browser review and service

The wallet panel offers **Review a guarded testnet mission** after identity
verification. If an operator has deliberately mounted the optional same-origin
backend, it displays the exact manifest, hash, maximum plus gas, public-storage
and non-atomic/no-retry warnings before an explicit NEP-413 owner approval.
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
wires these pieces to the reviewed website in **one fixed-origin, single-host
Node service**; it is disabled unless explicitly configured. It serves the
same site and mission API for computer and phone, as well as the optional
WalletConnect relay and Google identity endpoint when configured. Its startup
performs no wallet prompt or transaction. It is not a deployment, and has not
been tested with a real wallet or live mission.

The operator still needs a dedicated HTTPS host, PostgreSQL challenge store,
persistent original journal, and an owner-authorized fresh V14 vault with
policies/allowlists and scoped keys. There is no complete browser provisioning
flow for that setup yet. A static Netlify or Vercel deployment alone cannot run
missions. The development server's separate `BOUNCER_NATIVE_MISSION_PREVIEW=1`
switch only proxies to an already running loopback service and provisions
nothing.

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
only and must be behind the dedicated TLS proxy; this has not been deployed.

To investigate retained originals without loading agent keys or the consent
database, start with `BOUNCER_NATIVE_MISSION_MODE=recover` and the same mission,
RPC, original encrypted journal and key. Recovery cannot issue challenges or
sign/send. Graceful shutdown waits for in-flight work, even after a browser
disconnect; a forced kill or lost disk still requires reconciliation. The
filesystem, database and operator may be compromised or rolled back. A missing
hash never proves that a transaction did not happen.

Mobile V14 provisioning is also unresolved. At commit `42255e1`, the CI-built
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
