# Website, testnet wallets and Google sign-in

`bouncer/web/` is the responsive Bouncer testnet walkthrough, not a live
purchasing dashboard. The Workspace, Overview, Resources, Guardrails, On-chain
proof, Wallet & AI, optional tour, and three evenly spaced animated resource
icons remain. Motion respects the browser's reduced-motion setting. Recorded
examples and transactions are explicitly labeled; independent FT-paid delivery,
refund recovery and an independent vault audit remain open.

The account picker offers NEAR Mobile, Meteor, Intear, Nightly, Ledger, NEAR CLI
and WalletConnect QR on testnet, with Google sign-in last. WalletConnect uses
the existing public project configuration, so users do not need to supply a
project ID. The new Google flow has **not been verified with a real Google
account**. Site updates reach production only after review and deployment.

Wallet sessions are restricted to approved dedicated, top-level origins, with
GitHub Pages and shared guest origins blocked. The curated executors are
sandboxed and their pinned bytes are SHA-256 verified before use. NEAR Mobile
and CLI use fresh, off-chain login messages checked against testnet; the other
wallets report an account but do not independently prove ownership to Bouncer.
No transaction, access key or vault spending authority is requested by this
picker. Wallet extensions, provider availability and real-device sign-in still
need end-to-end testing; unit and mocked-browser tests are not live logins.

WalletConnect requests only `near_getAccounts` on `near:testnet` and rejects
broader permissions. Pairing keys remain in the browser; a limited fallback
may relay encrypted messages through Bouncer's server. Pairing QR codes contain
sensitive information: do not publish or reuse a photographed code. Cancel and
generate a fresh one if it has been shared.

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

`stage-public-web.mjs` publishes only the 16 allowlisted website files. Vercel
separately detects `web/api/google-session.mjs` and `web/api/wc-relay.mjs`;
neither function is published as a static source file. The public URL is
https://bouncer-near.vercel.app/. The site and functions remain unaudited.
