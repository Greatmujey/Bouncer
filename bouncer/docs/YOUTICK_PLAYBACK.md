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
vaults are unchanged. A fresh disposable V10 vault was deployed for the
**hypothetical grant diagnostic** below; this is still unaudited and has not
been used to buy, upload or retrieve a video. It:

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

On November 1, a [read-only testnet probe](https://github.com/Greatmujey/Bouncer/actions/runs/41307304120/job/124850215824)
observed bridge `playbackReady: true`, an unpaused access contract with issuance
on and a 600,000 ms Play policy. The health response did not identify the media
provider; the reviewed legacy path rejects Stream-backed publications, so the
probe remained **BLOCKED_OR_UNPROVEN**. The chosen adaptive profile hash is in
the [inspected Studio catalog](https://github.com/4rmus/youtick/blob/410dd180f42d25f77c2317b9659923f6a4149245/protocol/paid-media-livepeer-v1/profiles.json),
and that source [selects the adapter by profile](https://github.com/4rmus/youtick/blob/410dd180f42d25f77c2317b9659923f6a4149245/workers/livepeer-bridge/src/index.ts#L7131-L7159).
This is useful source-level evidence, **not** a live Studio-provider or bridge
configuration attestation. A [later read-only check](https://github.com/Greatmujey/Bouncer/actions/runs/41316051699/job/124876224211)
confirmed the adaptive hash was advertised at FINAL block
`HGqa8DVjhipD4mG8EXcdepezQQEPkkFbFwzxEU1EhhJc`, but still received no live
provider kind and remained **BLOCKED_OR_UNPROVEN**. Its bounded public summary
is retained under `evidence/youtick-playback-read-20261101/`. Neither probe can
prove that the bridge uses the pinned access account or that the inspected
source equals deployed code. No grant or playback token was requested in those
read-only probes.

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
verified expired grant is reported expired, not active. The paid-session grant
runner has **synthetic tests only**. An experimental token client and bounded
HLS byte probe now exist as described below; neither has been exercised against
an actual paid YouTick publication.

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

On November 1, the [one-shot testnet diagnostic](https://github.com/Greatmujey/Bouncer/actions/runs/41311832349/job/124864256616)
deployed and locked a fresh V10 vault, then verified that a zero-yocto owner
call was rejected by the guard ([transaction](https://testnet.nearblocks.io/txns/5x9iGNBgrPaEbncnNhRHwRA5Eu3zz4QRTKASBGPK81n7)).
A separate one-yocto owner call produced a matching FINAL access grant for the
hypothetical job ([transaction](https://testnet.nearblocks.io/txns/Dh1H9ojhsHUqnnLQHpKhqPYkQEJZ3u34Gbzn566Vaqe),
access receipt `2VAPLpVfQVNmwtvYp2ivu94VX76S3ifsRaGugHNmC2Ny`). The public
original review and hashes are retained in `evidence/youtick-hypothetical-grant-20261101/`;
the encrypted journal and sealed disposable keys are in the workflow artifact
`youtick-hypothetical-grant-testnet-evidence` (retention ends 30 January 2027).
After the sandbox restarted, the local RSA private recovery key was no longer
present: the sealed credentials and encrypted journal cannot currently be
opened unless an independent backup is found. The original public hashes remain
available for read-only inspection. The old diagnostic script now refuses to
create new accounts or grants using the retired recovery key. No paid YouTick
order was involved. Future probes need an operator-controlled durable key backup
verified before side effects.
The original artifact also contains full public RPC receipts, which can include
transaction signatures and nonces; do not resend them. Later diagnostic runs
redact those fields from stored receipt copies. No plaintext private keys were put
in the artifact. A separate [read-only reinspection](https://github.com/Greatmujey/Bouncer/actions/runs/41312275565/job/124864955447)
rechecked both original FINAL hashes and the current views without signing or
sending; at that finalized block the hypothetical job and publication were
absent and the vault had no entitlement. The grant was active at that point and
expires at `2026-11-01T13:46:36.933Z`. This is **authorization evidence only**:
no quote, FT provider payment, upload, publication, playback token or retrieval
was performed.

## Experimental token and bounded HLS byte probe

`agent/youtick-retrieval.mjs` provides a narrowly scoped next step after a real
paid, published session and its original owner grant have been reconciled:

- `requestYoutickPlaybackToken` defaults to a **read-only review**. With
  `execute: true` it rechecks the original FINAL payment and grant receipts,
  pinned testnet/vault/market/access identity, matching job and publication,
  entitlement and unpaused/current scoped grant. It also re-fingerprints the
  original local source before constructing the signed request. No NEAR
  transaction or FT payment is made by this module.
- It records an attempt in the encrypted, exclusive session journal **before**
  one fixed-host POST. A timeout, redirect, bad response, or crash leaves that
  attempt pending; subsequent calls do not resend it, even if no POST actually
  arrived. There is no supported automatic token reconciliation or renewal.
  A valid short-lived token is stored only inside the original encrypted
  journal, not returned in the result or written to logs.
- It checks the returned URL, playback ID, TTL, JWT claims and ES256 signature
  using the public key embedded in the JWT. **An embedded key is not an
  authenticated identity.** An independently reviewed SHA-256 fingerprint of
  the public key's DER SubjectPublicKeyInfo can optionally be supplied as
  `expectedJwtKeySha256` before the POST and is then enforced and recorded.
  Without that pin, the bridge's claimed signer remains trusted; no independent
  signer fingerprint has been established for the live service.
- `probeYoutickHls` rechecks the original chain evidence and recorded token,
  then fetches at most an initial playlist, one media playlist and one segment.
  It returns and records only byte lengths and SHA-256 digests, not the token,
  URLs or media. Digests can still identify known content; review summaries
  before sharing them. A successful byte probe **does not prove playable media,
  source equality, provider honesty, or durable availability**.
- Requests have a 20-second maximum total HTTP deadline, bounded streaming
  bodies, no automatic retries and manually validated redirects. By default the
  JWT is sent only to `https://playback.livepeer.studio`. The caller may
  explicitly approve exact additional CDN origins from a small source-derived
  allowlist; that decision trusts those hosts with a bearer token, including
  their tenant isolation. Wildcard hosts, query strings, encrypted HLS,
  byte-range and fragmented-MP4 playlists are deliberately unsupported, so
  normal provider delivery may fail closed and require further protocol work.

The token client has synthetic adversarial tests and a real **loopback** HTTP
exercise, not a live provider test. An injected transport must not retry and
must be trusted: a deadline cannot stop a malicious implementation from
sending later. The local clock, DNS/TLS, RPC, bridge, approved CDN, filesystem
and process remain trust assumptions; a malicious RPC can falsify all views.
The file journal is not distributed or rollback-proof. Protect its key and
backups, and never log the signed envelope or token. While the grant remains
active, an expired token is reported expired and is not renewed; after grant
expiry, the current-view check fails closed. These limits make the code useful
groundwork, not a complete player or a reason to make an otherwise unverified,
potentially nonrefundable purchase.

## Programmatic grant use

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
not uploaded to YouTick. Before any paid job we still need a demonstrated
retrieval path for a real publication, an independently provider-tested uploader,
an appropriate fresh vault/funding plan, an unexpired owner-reviewed
policy/quote, and acceptance of provider/refund risk. Even those checks cannot
prove the provider's integrity or deployed/source equivalence.
