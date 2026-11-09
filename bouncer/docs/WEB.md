# Website, testnet wallets and Google sign-in

`bouncer/web/` is the responsive Bouncer testnet walkthrough, not a live
purchasing dashboard. The Workspace, Overview, Resources, Guardrails, On-chain
proof, Wallet & AI, optional tour, and three evenly spaced animated resource
icons remain. Motion respects the browser's reduced-motion setting. Recorded
examples and transactions are explicitly labeled; independent FT-paid delivery,
refund recovery and an independent vault audit remain open.

The account picker offers NEAR Mobile, Meteor, Intear, Nightly, Ledger, NEAR CLI,
experimental Ethereum Wallets, and WalletConnect QR on testnet, with Google sign-in last. WalletConnect uses
the existing public project configuration, so users do not need to supply a
project ID. The new Google flow has **not been verified with a real Google
account**. Site updates reach production only after review and deployment.

Wallet sessions are restricted to approved dedicated, top-level origins, with
GitHub Pages and shared guest origins blocked. The curated executors are
sandboxed and their pinned bytes are SHA-256 verified before use. Immediately
following an explicit connection, named testnet wallets that support NEP-413
are asked for an off-chain identity signature. The browser verifies it and
checks the public key for Full Access using a read-only final testnet RPC query.
NEAR Mobile and CLI already sign a fresh login message; it is reused only after
that same signature and key check, avoiding a second prompt. If verification is
cancelled, blocked or unavailable, the wallet remains connected but unverified
and the picker offers a retry. The button disappears after success. A restored
session never triggers an unsolicited signature; the user can verify it from the
picker. Verification lasts only for that browser session; it is not server
identity, transaction approval, a vault, or agent spending authority. Account
entry and WalletConnect are view/account-only; the Ethereum adapter does not
support this message verification and its own onboarding may request an approved
testnet setup transaction. Wallet extensions, provider availability and
real-device sign-in still need end-to-end testing; unit and mocked-browser tests
are not live logins. Never enter a seed phrase into Bouncer.

Vault review, setup and encrypted recovery live in **Guardrails**; mission and
direct-provider controls live in **Resources**. Their existing origin, owner,
readiness and explicit-action gates remain. Connecting or verifying does not
run a mission or enroll a recovery checkpoint. For any existing or uncertain
setup, recover the retained copy and original instead of preparing or enrolling
another candidate.

WalletConnect requests only `near_getAccounts` on `near:testnet` and rejects
broader permissions. Pairing keys remain in the browser; a limited fallback
may relay encrypted messages through Bouncer's server. Pairing QR codes contain
sensitive information: do not publish or reuse a photographed code. Cancel and
generate a fresh one if it has been shared.

## Vercel deployment policy

`web/vercel.json` and `testnet-relay/vercel.json` set
`git.deploymentEnabled` to `false`. On branches containing those files,
Git pushes should not automatically create production or preview deployments
for either project. The intent is to use Vercel only for a deliberately chosen,
reviewed release, not for every commit. CLI/API/dashboard deployments and deploy
hooks are separate triggers and must not be launched automatically; neither
this setting nor repository tests restricts another Vercel account holder.

This is **branch-scoped source configuration**, not a dashboard-wide switch:
`main` or an older branch without the change can still trigger deployments.
Do not claim account-wide protection until the configuration is merged to the
relevant branches or the owner disconnects the Git integration in both Vercel
project settings. Disconnecting affects Git-sourced releases; choose a tested
manual upload/reconnect process first. Other projects share the team's quota.
Don't use an Ignored Build Step as a quota guard: Vercel can count canceled
builds. Keep the live site unchanged until a deliberate deployment is approved
and the quota is available; an older live site does not prove new deployments
are currently allowed.

## Configure Google Identity Services

The public Google OAuth client ID supplied by the owner is configured as
`BOUNCER_GOOGLE_CLIENT_ID` in Vercel for production and preview deployments.
The corresponding **Web application** client in [Google Auth Platform](https://console.cloud.google.com/auth/clients)
must have a configured consent screen (including test users if in testing
mode) and include this exact **Authorized JavaScript origin**:

```
https://bouncer-near.vercel.app
```

The GIS JavaScript popup flow uses a callback rather than a redirect URI. The
client ID is public; do **not** send a Google client secret, password, private
key, access token or one-time code. Origin authorization and consent settings
have not been independently verified. A new deployment is required for the
configured environment variable to take effect. Then test a real sign-in and
sign-out on the dedicated origin, including a page reload.

The optional static GitHub Pages address is
https://greatmujey.github.io/Bouncer/ if Pages is enabled for this repository;
it cannot run the Google session function and is not the sign-in origin.

If the client ID is missing or malformed, the endpoint returns 503 and the
page says sign-in is not configured; it never invents an identity. The backend
rejects identity requests on other domains. GitHub Pages, temporary guest sites,
Arena previews and `localhost` cannot host a working production sign-in merely
by copying the static files. A successful synthetic test is not a live login.

## Security and boundaries

The actual Google-rendered button is loaded inside the account picker. The
server supplies a 5-minute random nonce in a secure host-only HttpOnly cookie.
The Google credential is sent over same-origin JSON; the API requires a custom
header, exact Origin and fetch-site checks. It uses the fixed Google HTTPS
JWKS endpoint and verifies an RSA signature, issuer, exact audience, authorized
party if present, expiry/issuance, and nonce before accepting the stable Google
`sub` as identity. JWKS rotation is supported and verification fails closed.
No email is used as an identity key.

A host-only `Secure; HttpOnly; SameSite=Lax` cookie holds the signed ID token
for at most one hour, and the server re-verifies it on session reads. Sign-out
clears this browser's cookie; this stateless prototype has **no server-side
revocation list**, so a copied token may remain usable until expiration. Only a
small profile is returned to the browser and it is rendered as text, never
HTML. Tokens are not placed in `localStorage`, URLs, logs or Git. This is an
unaudited testnet prototype and not yet a production account system.

**Google identity is not NEAR authority.** Login does not create a NEAR
account or vault, control a private key, approve owner policy changes, or let
an AI agent spend. Those capabilities need a separate secure custody and
explicit authorization design; never put seed phrases in the website. The
1-yoctoNEAR owner-policy boundary remains independent of Google sign-in.

## Preview and tests

```sh
cd bouncer
npm ci
npm ci --prefix walletconnect --ignore-scripts
npm run build:web
node --test tests/google-session.test.mjs tests/wallet.test.mjs tests/cli-login.test.mjs tests/walletconnect.test.mjs tests/walletconnect-bridge.test.mjs tests/web.test.mjs tests/public-web-staging.test.mjs
# Run separately to serve the site: node scripts/dev-web.mjs
```

`dev-web.mjs` binds to `0.0.0.0` for preview, serves only the reviewed public
assets, and uses relative API URLs. Its account endpoint deliberately refuses
non-production hosts. The optional public `BOUNCER_WALLETCONNECT_PROJECT_ID`
environment variable enables direct-relay QR testing; the fallback gateway is
restricted to the production origin. Open the preview in its own tab to use
testnet wallets; embedded iframes are blocked by the wallet-origin policy.

`scripts/test-web-browser.mjs` uses synthetic Google responses, a mocked Meteor
wallet, and the real vendored Intear adapter with a synthetic wallet page.
`scripts/test-walletconnect-browser.mjs` checks the real QR renderer and
synthetic pairing/cancellation, including independence from Google identity.
`scripts/test-wallet-adapters.mjs` optionally tests the other pinned executors:
Meteor, Nightly and Ledger prompts open and cancel; Mobile and CLI validate
synthetic signatures against a mocked read-only RPC and reject forgeries. CI
obtains and hash-checks the pinned public blobs. No real wallet, extension,
Ledger device, Google login or transaction is tested. `google-session.test.mjs`
uses locally generated RSA keys to test signatures, claims, nonce, CSRF,
expiry, restoration, sign-out and key rotation.

When this revision is deployed, after verifying `great_mujey.testnet`, the
Vercel and Railway workspaces can prepare an encrypted **local setup candidate** for the illustrative 6 test
NEAR vault funding. The browser generates a vault-only temporary key and a
checkpoint capability, encrypts them with a separate passphrase, and lets the
user save/re-import the file with a separately recorded SHA-256 backup ID.
It lazily fetches the public, non-executable `v14-bootstrap-artifact-v1.json`
and checks both compressed and inflated artifact hashes; this is not an audit. Preparation
and checking request no additional signature, enrollment or transaction. The
file contains no original transaction history and is not an owner-attested
recovery export. Verifying it does not establish that a separate backup exists,
that any history is latest, or that the vault/account is absent on-chain. A
mismatched owner key is reported and requires manual reconciliation. Never
repeat an uncertain setup. If installed later, the temporary key can control
the vault until its deletion is final; a lost passphrase/file can strand funds,
and a compromised browser can steal unlocked secrets. This feature is not a
live setup transaction path or proof of a real-phone recovery.

A separate enrollment control appears only when the default-off checkpoint
reports enabled. It rechecks the saved file, backup ID, passphrase, pinned
artifact and current owner key, then asks for one owner identity signature; it
sends only the encrypted kit and public review, not the passphrase or unlocked
keys. The owner message check reads the owner's current testnet key, but it
never requests a NEAR transaction. Before the POST it requires a
persistent same-origin browser stop marker; a lost or malformed acknowledgement
stops further attempts in that browser and must be reconciled by recovery, not
by re-enrolling. When that marker exists, generating a replacement candidate
is also disabled in that browser, but checking the saved file remains available.
This marker is not a cross-tab lock and does not coordinate other browsers or
devices. An acknowledgement is not proof of a separate restore, latest original
history, vault state or final receipts, and does not authorize setup.
The endpoint is default-off in code; it was separately enabled for a
recovery-only real-owner test. Enabling it alone does not establish enrollment,
an independent restore or transaction readiness.

Recovery first offers a check of the **original saved preparation file** against
an existing checkpoint. It verifies the separately recorded backup ID, the
passphrase, the pinned plan and the current owner key locally before asking for
one read-only owner message. It then verifies the enrollment attestation and
compares the exact encrypted kit and public review. The file, backup ID,
passphrase, temporary key and checkpoint capability are not sent in the read.
A match does not authenticate transaction history, prove another backup or the
latest head, check a vault or receipts, or authorize a transaction. A changed
owner key stops before the read message; mismatch, unavailable or uncertain
responses require reconciliation rather than re-enrollment. The comparison does
not replace an imported or unlocked recovery export.

The read-only funding review also checks the verified session's specific
message-signing key at the same FINAL block when a verified wallet is connected.
A missing, restricted or unrepresentable key is a blocker. This does not prove
the wallet will use that key for a later transaction or establish backup,
receipt, latest-head or spending approval. A separate source-only create
preflight rebuilds the enrolled plan and checks that exact owner key, funding,
gas and vault absence together; it is not connected to a live wallet prompt.

The source-only temporary-bootstrap original retainer records a returned wallet
hash in both existing witness copies, or leaves a one-shot claim if the wallet
result is unknown. A hash later found in wallet history must pass the exact
FINAL create receipt and fresh temporary-key check before being retained; it
never opens or repeats the wallet. A wallet-selected transaction key may differ
from the verified message key: the verifier requires both to be current owner
FullAccess keys at the same FINAL block and checks the actual transaction and
receipt signer consistently. For the later locally signed deployment it
checks the exact pinned actions, transaction hash and signature before
retaining the hash in both copies. These source-only pieces are not wired to
the live wallet; neither matching copies nor a hash proves an independent backup
or a latest head.

The new one-shot create coordinator joins the reviewed actions and cost
snapshot, fresh exact-key preflights, two-copy claim, one wallet call and
original retention. It stops if prices increase beyond the reviewed estimates,
the account or session changes, or either claim is uncertain. A lost wallet
response stays claimed and is recovered by the original, never another prompt.
Its public entry point **always blocks invocation**: a real independent restore
and latest-head gate is not implemented. An explicitly isolated sandbox uses a
simulated gate and disposable wallet; this is not evidence to open the live
gate. Estimates cannot guarantee future network charges and the wallet may
choose a different signing key.

A separately hosted Railway-volume recovery anchor is implemented but **off by
default and not initialized**. It can retain the same owner-attested encrypted
kit and append-only original history with a different capability derived in
the browser from the temporary key; it never receives the passphrase, the
Supabase capability or a wallet key. Fresh owner-message verification can read
its encrypted backup without already having the temporary key. An exclusive,
fsynced write marker fences overlapping processes; an interrupted write leaves
a stop marker for manual reconciliation, never automatic repair. Local-volume
and HTTP tests are synthetic. When explicitly enabled, the workspace offers a
save of the existing checkpoint and an owner-message restore from Railway; it
does not re-enroll the Supabase checkpoint. The controls are hidden while the
route is off. Railway volume durability, a real restore and an independently
retained latest head still need verification; two matching service copies are
not proof against rollback, a compromised operator or a shared failure.
Enabling this recovery route would not enable transactions or missions.

A narrowly scoped diagnostic on the existing Railway standby service checks the
`/data` volume using a separate non-secret random marker, never a checkpoint or
wallet key. Its first deployment creates and fsyncs the marker; the follow-up
is observation-only and must not recreate a missing marker. A matching public
fingerprint across those deployments shows only that this small marker survived
that restart. It does not prove crash durability, backup restore, operator
independence, an untampered latest head or permission to transact.

The source-only temporary-bootstrap completion verifier can check a separately
retained deployment original against its exact reviewed actions, a FINAL
outcome, and one fresh block's V14 code, contract owner and keyless vault state.
If nearcore omits a self-transaction's local root receipt body, the result says
so; it never invents that body. It trusts the RPC and does not prove independent
original retention, latest history, consent, or that no other transaction is in
flight. It does not sign, broadcast or authorize a transaction and is not wired
into the live workspace. Actual setup and real-device recovery remain unverified.

Recovery also permits a user to import and locally MAC-check a saved encrypted
recovery export, then compare that exact snapshot with an owner-signed online
read. The comparison reports a match, a file ahead of the service, claimed
additional online events, or divergent/different setups. Online-only extra
events are not authenticated by an older file; any disagreement requires a
stop and reconciliation. Even a match cannot prove the file is independently
stored, either snapshot is latest, or receipts are final, and it does not
permit a transaction. The UI clears the prior comparison if another file is
selected or the unlock fails. These checks have synthetic browser and database
coverage, not a real-device restore.

`stage-public-web.mjs` publishes only the 19 allowlisted website files,
including that public, lazily loaded artifact. Vercel separately detects the
Google and WalletConnect functions and fixed-action mission/read-only setup
proxy functions under `web/api/native-mission/`; none is a static source
file. The mission proxies are disabled unless explicitly configured, and do not
provide a backend or authorize spending by themselves. The experimental
Vercel/Railway split and its unverified hosting limits are described in
[NATIVE_MISSIONS.md](NATIVE_MISSIONS.md). The public URL is
https://bouncer-near.vercel.app/. The site and functions remain unaudited.
