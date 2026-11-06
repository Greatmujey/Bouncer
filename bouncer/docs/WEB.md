# Website and Google sign-in

`bouncer/web/` is the responsive Bouncer testnet walkthrough, not a live
purchasing dashboard. The Workspace, Overview, Resources, Guardrails, On-chain
proof, Account & AI, optional tour, and three evenly spaced animated resource
icons remain. Motion respects the browser's reduced-motion setting. Recorded
examples and transactions are explicitly labeled; independent FT-paid delivery,
refund recovery and an independent vault audit remain open.

This branch removes the wallet picker, wallet adapters, WalletConnect relay,
QR pairing, CLI login and their published bundles. The old production release
is unchanged until this branch is reviewed and merged. The new Google flow is
**not live or verified with a real Google account yet**.

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

The actual Google-rendered button is loaded on the account view only. The
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
node --test bouncer/tests/google-session.test.mjs bouncer/tests/web.test.mjs bouncer/tests/public-web-staging.test.mjs
cd bouncer && npm run build:web
```

`dev-web.mjs` binds to `0.0.0.0` for preview, serves only the reviewed public
assets, and uses relative API URLs. Its account endpoint deliberately refuses
non-production hosts. The browser test in `scripts/test-web-browser.mjs` uses
synthetic Google responses only; `google-session.test.mjs` uses locally generated
RSA keys to test good signatures, forgery, claims, nonce, CSRF, expiry, session
restoration, sign-out and key rotation. Neither test signs a NEAR transaction.

`stage-public-web.mjs` publishes only the ten allowlisted website files. The
Vercel API function is separately detected from `web/api/google-session.mjs`;
it is not published as a static source file. The public URL is
https://bouncer-near.vercel.app/. The site and session API remain unaudited.
