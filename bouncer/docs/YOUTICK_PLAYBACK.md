# Experimental YouTick creator playback: a real interoperability gap

This is **not a live purchase or a delivery proof**. Bouncer has verified an
independent testnet quote, but it has not paid YouTick, uploaded to it, or
retrieved a resulting video. YouTick's mutable bridge, access contract, market,
media provider and RPC are external trust assumptions; the inspected source is
not an attestation of their deployed bytecode. A paid upload job may be
nonrefundable if any later stage fails.

## Why upload alone is insufficient

In the reviewed YouTick V1 source, an FT `create_paid_job` uses the FT sender
(the Bouncer vault) as creator. A published creator is entitled to playback,
but an actual HLS playback token additionally requires a scoped device/session
proof. The V2 wallet-certificate route checks for a full-access key on the
creator account. The previously proven Bouncer V9 testnet vault deliberately
removed its deployment key; its restricted agent is a key on the **owner**
account, not the vault. V9 also has no method to call the YouTick access
contract to issue the legacy Play grant. Therefore an upload or publication by
that locked V9 vault does **not** establish that Bouncer can retrieve it.
Never spend on that route assuming playback is solved.

## Narrow candidate for a fresh deployment

The separately compiled `youtick-playback-v10` testnet-focused artifact adds
`issue_youtick_play_grant`. The default V9 artifact and existing immutable
vaults are unchanged. CI has built and tested the feature as a separate artifact;
this is still an unaudited proposal, **not yet deployed or proven against the
external access contract**. It:

- requires the actual owner and exactly 1 yoctoNEAR; zero-deposit restricted
  agent keys cannot issue grants;
- fixes the external access contract to
  `video-access-v1-260907.youtick-dev-v3.testnet`, the origin hash to the
  public testnet web origin, scope to `Play`, target owner to the Bouncer vault,
  TTL to 10 minutes and attached cross-contract deposit to zero;
- accepts only a bounded job ID, Ed25519 session public key, 32-byte hex device
  hash and 64-byte hex session-key proof; it cannot transfer funds or select an
  arbitrary receiver or method;
- returns the external call as a promise. A successful outer transaction alone
  is not proof that a grant was issued: inspect FINAL linked receipts and the
  exact external grant/verification views. One granted session is a bearer
  credential; keep its private key and tokens encrypted and out of logs.

The named-account suffix checks do **not** prove network identity. A caller must
also check the RPC's testnet chain, pin/review the exact Bouncer and external
contract code hashes, the owner, job and session, obtain trusted FINAL views,
and reconcile the original transaction on any uncertainty. No automatic grant
or payment retry is implied. Creating a grant may consume external storage;
external policies, availability, authorization and revocation can change.

## Evidence and remaining work

On November 1, a [read-only testnet probe](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41307304120/job/124850215824)
observed bridge `playbackReady: true`, an unpaused access contract with issuance
on and a 600,000 ms Play policy. The health response did not identify the media
provider; the reviewed legacy path rejects Stream-backed publications, so the
probe remained **BLOCKED_OR_UNPROVEN**. It also cannot prove the bridge is
configured to use the pinned access account or that the inspected source equals
deployed code. No grant or playback token was requested.

Experimental single-host code reserves a distinct playback key before an order
in the encrypted journal; checks the original payment, publication and local
source; and builds the exact session proof and legacy token-request envelope.
The owner-grant runner in `agent/youtick-grant-runner.mjs` obtains trusted FINAL
views itself, pins testnet, the reviewed vault hash, owner, market/access hashes,
original paid session and scoped proof, and defaults to **read-only review**.
Execution requires an explicit full-access owner signer and exactly 1 yoctoNEAR.
It records the signed transaction **hash before one broadcast** in the original
encrypted file journal, but not replayable signed bytes. The built-in provider's
one-shot send has a bounded timeout, refuses redirects and never retries.
Recovery needs the
original encrypted journal and its encryption key but **no owner signing key or
source file**; it rechecks the original payment, linked FINAL grant receipt and
current access views by the same hash. An unknown result remains pending, and a
second attempt or silent renewal for the same playback session is refused. A
verified expired grant is reported expired, not active. These runner checks
have **synthetic tests only**; there is still no token HTTP client or HLS
retrieval flow.

The separate opt-in `scripts/probe-youtick-owner-grant.mjs` is a **diagnostic**:
it uses freshly funded disposable testnet accounts and a hypothetical job ID,
not a paid publication. It is fenced by an explicit one-shot workflow, and
journals deployment, zero-yocto rejection and positive grant hashes before their
individual broadcasts. CI's V10 optimizer reported `memory.copy`/`memory.fill`
bulk-memory instructions; the probe requires the RPC to report testnet protocol
84 or later, where [nearcore enabled bulk memory](https://github.com/near/nearcore/releases/tag/2.12.0),
before creating accounts. That version check is not a full WASM validation.
Its RSA-sealed recovery envelope and encrypted journal are preserved even on
failure. `scripts/inspect-youtick-grant-probe.mjs` is a
key-free, read-only reinspection of retained hashes. It is not a way to bypass
the paid-publication requirement in the grant runner. No diagnostic result
implies an upload, token, playback, delivery or commercial purchase.

For programmatic use, open the **original** encrypted `FileJournal` for the
owner/vault, use a non-retrying `PaymentRpcProvider`, and call
`runYoutickPlayGrant({ journal, grantId, sessionId, goal, sourceFile,
vaultCodeHash, provider })` to review. Only after reviewing the returned exact
call should the owner supply `account`, `publicKey`, and `execute: true`.
`recoverYoutickPlayGrant({ journal, grantId, provider })` only inspects the
original recorded hash. The `npm run recover-youtick-grant -- --help` CLI
provides the same key-free operation using an existing journal and its original
`BOUNCER_FILE_JOURNAL_KEY_FILE`. Do not delete, replace or restore an older journal to
escape a pending transaction: the single-host lock cannot detect rollback,
another journal, another process bypassing it, a malicious RPC or another
owner acting directly. Injected providers must guarantee one broadcast rather
than retrying internally. Recovery requires both the journal and its original
key; an RSA envelope is only useful if its separate private key remains safe
and available. These prototypes are unaudited and not a scalable distributed
execution service.

The upload transport similarly has synthetic and loopback recovery tests but has
not uploaded to YouTick. Before any paid job we still need a verified grant
transaction and authorized HLS/segment retrieval, a provider-tested uploader,
an appropriate fresh vault/funding plan, an unexpired owner-reviewed
policy/quote, and acceptance of provider/refund risk. Even those checks cannot
prove the provider's integrity or deployed/source equivalence.
