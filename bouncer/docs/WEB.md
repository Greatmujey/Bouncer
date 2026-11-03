# Website and testnet wallet

`bouncer/web/` is Bouncer’s responsive testnet product walkthrough. It shows
real transaction links and historical examples, but it is **not** a live
purchasing dashboard. Independent FT-paid provider delivery, refund recovery
and an independent vault audit remain open.

## Workspace and connecting a wallet

Overview, Resources, Guardrails, On-chain proof, and Wallet & AI are separate
client-side views with linkable URL fragments and browser history. Existing
`#connect`, `#proof`, `#how-it-works`, and recorded-resource links continue to
work. With JavaScript disabled the document remains readable. The animated flow
is conceptual; it is not a live activity feed. Decorative motion respects the
browser's reduced-motion preference.

The Connect button opens a keyboard-accessible wallet picker (a bottom sheet on
phones, a centered dialog on desktop). It uses pinned NEAR Connect on **testnet**
with NEAR Mobile, Meteor, Intear, Nightly, Ledger and NEAR CLI choices. Testnet
support is advertised by the corresponding adapters but real sign-ins have not
been independently verified. NEAR Mobile's testnet availability depends on the
installed app and its configuration; its upstream manifests disagree about testnet.

The normal connection path requests an account only: no access key, signature,
or transaction. **NEAR Mobile is different**: Bouncer asks it to sign a fresh
NEP-413 login message off-chain. The pinned Fastnear adapter verifies the
signature and the signing key against testnet RPC. Its ordinary `signIn` may
request a FullAccess AddKey transaction and `signOut` may delete a key, so
Bouncer calls neither method; Mobile's session is memory-only and requires a
new message after reload. The pinned Fastnear executor saves native `fetch` as
a class method, which fails with “Illegal invocation” in browsers. After the
executor bytes pass integrity checking, Bouncer binds `fetch` to the sandbox
window before running them; the browser test covers the real executor with a
synthetic signer and RPC. This is not a live phone login. Other returned accounts are wallet-reported rather
than cryptographic proof of ownership. NEAR CLI specifically accepts a manually
entered account ID at this stage; it does not prove that the user controls it.
No connection creates a vault or grants spending access. Never enter a seed
phrase or private key into Bouncer. Named `.testnet` accounts and 64-hex
implicit accounts are accepted; the connector is
fixed to testnet. If browser storage is unavailable, the connector keeps its
selection in memory, though individual wallet executors may still need storage.

Intear creates an off-chain application communication key in browser storage;
this is not a NEAR account access key. It requires browser WebCrypto Ed25519
support (for example Chrome 137+, Firefox 129+, or Safari 17+). Its adapter is
separately licensed under AGPL-3.0 and built from vendored source pinned to
`INTEARnear/wallet@e958da12017cdd43b41947e4f201e72aa1135bf6`. The picker links
to its corresponding source archive. Regenerate it with
`python3 bouncer/scripts/build-intear-source.py` after updating the source.

WalletConnect is explicitly shown as unavailable: the site does not yet have a
WalletConnect/Reown project ID or client integration. A project ID alone would
not enable it. In particular, do not borrow another project's ID or use the
upstream adapter's transaction-capable namespace without reviewing permissions.
The Ethereum-wallet bridge is also omitted because its current sign-in may
onboard an account with an AddKey transaction, contrary to this identity-only
connection policy.

The dedicated `https://bouncer-near.vercel.app/` origin is explicitly approved
for wallet connection. Hosting on Vercel is not itself a security audit: the
host, DNS, browser, wallet integrations and wallet provider remain trust
boundaries. The site is unaudited and intended for testnet only. NEAR Connect’s
executor cache is bypassed. Remote executor URLs use immutable Git commits, and
all executor bytes, including the locally built Intear component, are checked
against SHA-256 digests before execution. This is not a security audit or proof
that upstream wallet services are safe. Arbitrary debug, injected, and parent
frame wallet manifests are not trusted.

Wallet connection remains disabled inside iframes and on path-shared guest
hosts, including `madethis.website` and GitHub Pages; those environments share
browser storage or can obscure the real origin. A visible link opens the site in
a new tab instead. Localhost, top-level Codespaces and Arena port hosts are also
supported for development. A stable URL does not prove real wallet sign-in:
the sandbox bridge is exercised with a **mock** wallet in browser tests, and the
pinned Meteor UI was opened and cancelled with its backend blocked. An actual
wallet login has not yet been independently verified end to end.

The welcome tour is optional and can be opened from the header; it does not
block the first visit. Compatible local MCP clients can inspect policies and
preview quotes without receiving wallet secrets. Hosted MCP authentication and
model conversations are not yet verified.

## Brand mark

The selected Bouncer mark—the lowercase b and upward arrow, without the
outer arc—lives in `bouncer/web/favicon.svg`. The same vector paths appear in
desktop and mobile navigation, the welcome tour and the browser tab. The mark
is decorative next to the accessible Bouncer wordmark; its main color is
lightened against the dark sidebar.

## Build and deployment

```sh
npm ci --prefix bouncer
npm run build:web --prefix bouncer
node --test bouncer/tests/wallet.test.mjs bouncer/tests/web.test.mjs bouncer/tests/public-web-staging.test.mjs
```

Vercel’s `bouncer` project uses `bouncer/web` as its root and
`node ../scripts/stage-public-web.mjs public-site` as its build command. Staging
copies only twelve explicit public assets, including the bundled connector, local
font and its OFL license, and the Intear executor and corresponding source. It
rejects symlinks, existing output directories and any wallet-origin override
other than the exact dedicated origin. It does not publish checkout files,
credentials, journals or private evidence.
`bouncer/web/vercel.json` sets basic response headers; no production-ready
security or CSP review is implied. The public repository is
`https://github.com/Greatmujey/Bouncer`.

The project’s production branch is `main`; working-branch previews and the
production domain can therefore serve different commits. On 3 November 2026 UTC the
expanded testnet wallet picker was deployed directly from working-branch commit
`084467e` to `bouncer-near.vercel.app` without merging to `main`. A future
production build from `main` could replace it. The deployed Intear source ZIP has
SHA-256 `2fe277baae87ff16d7b1efee9853cba26a46b1f9813302bf507f5ca53d2e0291`.
Verify deployed assets and wallet behavior after deployment rather than assuming
a branch push updated production.
GitHub Pages could use
`https://greatmujey.github.io/Bouncer/` if enabled and deployed, but it has not
been reverified as live. Its shared origin is deliberately not wallet-enabled.

The browser tests exercise responsive layouts, keyboard navigation, an optional
tour, historical data, origin restrictions, integrity-check rejection, and
mocked wallet backends through the connector bridge and pinned Mobile, Intear,
and CLI executors. They do not demonstrate a real wallet login, an independent
security review or provider delivery.
