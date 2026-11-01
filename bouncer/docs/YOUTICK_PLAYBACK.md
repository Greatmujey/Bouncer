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

Experimental single-host code now reserves a distinct playback key before an
order in the encrypted journal; checks the original payment, a supplied trusted
FINAL publication and local source; and builds the exact session proof and
legacy token-request envelope. A receipt verifier checks the linked owner →
vault → access-contract grant and matching live grant views. These checks have
**synthetic tests only**; the caller must supply authentic FINAL observations,
and there is no transaction-broadcast runner, token HTTP client or HLS retrieval
flow here. A separately scoped v5 testnet recovery envelope can protect the
prototype's owner/deploy/agent/playback keys, but has not been used for a live
grant.

The upload transport similarly has synthetic and loopback recovery tests but has
not uploaded to YouTick. Before any paid job we still need a verified grant
transaction and authorized HLS/segment retrieval, a provider-tested uploader,
an appropriate fresh vault/funding plan, an unexpired owner-reviewed
policy/quote, and acceptance of provider/refund risk. Even those checks cannot
prove the provider's integrity or deployed/source equivalence.
