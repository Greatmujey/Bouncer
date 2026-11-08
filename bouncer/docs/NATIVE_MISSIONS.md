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
PostgreSQL one-use owner authenticator. If agent keys are unavailable, the
service can instead be constructed without signers or an authenticator in
**recovery-only mode**: it can list retained hashes and reconcile receipts,
but cannot issue approval challenges or execute. `agent/native-mission-http.mjs` provides
a strict same-origin handler/server factory, **not an automatically enabled
service**. POST requests are exact-shape and origin-checked. The separate
`BOUNCER_NATIVE_MISSION_PREVIEW=1` switch on the development web server only
proxies `/api/native-mission/` to a separately started loopback service; it
never starts or provisions that service. A real operator must separately
provision a dedicated HTTPS same-origin backend, PostgreSQL challenge store,
persistent journal, owner-authorized fresh V14 vault, policies/allowlists and
scoped agent keys. There is no complete browser provisioning flow for that
setup yet. A static Netlify or Vercel deployment alone cannot run missions.

Mobile V14 provisioning is also unresolved. At commit `42255e1`, the CI-built
WASM was 499,063 bytes; its 665,420-byte base64 code field alone exceeds the
Meteor mobile bridge's 400,000-byte request limit. CI also investigates a
separately pinned compressed loader, **research only**: at commit `236aeca`,
the synthetic Meteor request was 242,375 bytes and isolated tests covered a
failed upgrade and explicit owner refund. An asynchronous upgrade can still
fail, and the UI, retained original, owner-controlled recovery and real wallet
behavior need end-to-end verification. Fitting a code field within
a bridge limit would not verify the complete wallet request. A published NEAR
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
replay/tampering, unknown results and original-only recovery. Separate
loopback-only nearcore scenarios exercise a disposable V14 contract and all
three real guarded JS runners. The three-leg scenario uses a fabricated local
provider: its outputs are not independent OutLayer execution, although the
sandbox executes the vault calls, storage writes and refund transfers. These
tests cannot prove live OutLayer delivery, independent storage, a real
phone/wallet approval or safe deployment. A mocked mobile-browser test also
checks the dedicated Netlify origin and review/recovery UI. See the corresponding
CI run for its actual result; a script's existence is not a passing test.
[Run 42503338044](https://github.com/Greatmujey/Bouncer/actions/runs/42503338044)
passed the isolated three-leg/fabricated-provider scenario and the mocked browser
checks at commit `5d2f894`. [Run 42504217242](https://github.com/Greatmujey/Bouncer/actions/runs/42504217242)
also passed the separate compressed-loader research scenario at `236aeca`.
Neither was a public-chain or real-wallet test.
