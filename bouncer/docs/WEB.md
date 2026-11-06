# Website, testnet wallets and Google sign-in

`bouncer/web/` is the responsive Bouncer testnet walkthrough, not a live
purchasing dashboard. The Workspace, Overview, Resources, Guardrails, On-chain
proof, Wallet & AI, optional tour, and three evenly spaced animated resource
icons remain. Motion respects the browser's reduced-motion setting. Recorded
examples and transactions are explicitly labeled; independent FT-paid delivery,
refund recovery and an independent vault audit remain open.

The account picker offers NEAR Mobile, Meteor, Intear, Nightly, Ledger and
NEAR CLI on testnet, with Google sign-in last. The separate WalletConnect QR
option and project-ID requirement are removed. The old production release is
unchanged until this branch is reviewed and merged. The new Google flow is
**not live or verified with a real Google account yet**.

Wallet sessions are restricted to approved dedicated, top-level origins, with
GitHub Pages and shared guest origins blocked. The curated executors are
sandboxed and their pinned bytes are SHA-256 verified before use. NEAR Mobile
and CLI use fresh, off-chain login messages checked against testnet; the other
wallets report an account but do not independently prove ownership to Bouncer.
No transaction, access key or vault spending authority is requested by this
picker. Wallet extensions, provider availability and real-device sign-in still
need end-to-end testing; unit and mocked-browser tests are not live logins.

## Configure Google Identity Services

The Bouncer Vercel project currently has no Google OAuth client ID. An owner of
a Google Cloud project must create or select a **Web application** OAuth
client in [Google Auth Platform](https://console.cloud.google.com/auth/clients),
configure the consent screen (including test users if in testing mode), and
add exactly this **Authorized JavaScript origin**:

```
https://bouncer-near.vercel.app
```

Provide only the public client ID, ending in `.apps.googleusercontent.com`, for
`BOUNCER_GOOGLE_CLIENT_ID` on the Bouncer Vercel project. Do **not** send a
Google client secret, password, private key, access token or one-time code.
The GIS JavaScript popup flow uses a callback rather than a redirect URI. The
server receives the client ID at runtime; it is not a secret. Vercel must deploy
the reviewed branch after its usual production-merge heads-up. Then test a
real sign-in and sign-out on the dedicated origin, including a page reload.

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
node bouncer/scripts/dev-web.mjs
node --test bouncer/tests/google-session.test.mjs bouncer/tests/wallet.test.mjs bouncer/tests/cli-login.test.mjs bouncer/tests/web.test.mjs bouncer/tests/public-web-staging.test.mjs
cd bouncer && npm run build:web
```

`dev-web.mjs` binds to `0.0.0.0` for preview, serves only the reviewed public
assets, and uses relative API URLs. Its account endpoint deliberately refuses
non-production hosts. Open the preview in its own tab to use testnet wallets;
embedded iframes are blocked by the wallet-origin policy.

`scripts/test-web-browser.mjs` uses synthetic Google responses, a mocked Meteor
wallet, and the real vendored Intear adapter with a synthetic wallet page.
`scripts/test-wallet-adapters.mjs` optionally tests the other pinned executors:
Meteor, Nightly and Ledger prompts open and cancel; Mobile and CLI validate
synthetic signatures against a mocked read-only RPC and reject forgeries. CI
obtains and hash-checks the pinned public blobs. No real wallet, extension,
Ledger device, Google login or transaction is tested. `google-session.test.mjs`
uses locally generated RSA keys to test signatures, claims, nonce, CSRF,
expiry, restoration, sign-out and key rotation.

`stage-public-web.mjs` publishes only the 13 allowlisted website files. The
Vercel API function is separately detected from `web/api/google-session.mjs`;
it is not published as a static source file. The public URL is
https://bouncer-near.vercel.app/. The site and session API remain unaudited.
