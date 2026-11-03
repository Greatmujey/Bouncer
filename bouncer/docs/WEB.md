# Website and testnet wallet

`bouncer/web/` is Bouncer’s responsive testnet product walkthrough. It shows
real transaction links and historical examples, but it is **not** a live
purchasing dashboard. Independent FT-paid provider delivery, refund recovery
and an independent vault audit remain open.

## Workspace and connecting a wallet

Overview, Resources, Guardrails, On-chain proof, and Wallet & AI are separate
views within the Workspace, with linkable URL fragments and browser history.
Both `#overview` and `#workspace`, plus existing `#connect`, `#proof`,
`#how-it-works`, and recorded-resource links continue to work. Overview has a
keyboard-accessible resource selector and links to recorded examples; its
orbiting network and flow are conceptual, not a live activity feed. With
JavaScript disabled the document remains readable. Decorative motion respects
the browser's reduced-motion preference.

The Connect button opens a keyboard-accessible wallet picker (a bottom sheet on
phones, a centered dialog on desktop). It uses pinned NEAR Connect on **testnet**
with NEAR Mobile, Meteor, Intear, Nightly, Ledger and NEAR CLI choices. Testnet
support is advertised by the corresponding adapters but real sign-ins have not
been independently verified. NEAR Mobile's testnet availability depends on the
installed app and its configuration; its upstream manifests disagree about testnet.

The normal connection path requests an account only: no access key, signature,
or transaction. **NEAR Mobile and NEAR CLI are different**: Bouncer asks them
to sign a fresh NEP-413 login message off-chain. The pinned Fastnear Mobile
adapter verifies the signature and signing key against testnet RPC. Its ordinary
`signIn` may request a FullAccess AddKey transaction and `signOut` may delete a
key, so Bouncer calls neither method; Mobile's session requires a new message
after reload. The pinned Fastnear executor saves native `fetch` as a class
method, which fails with “Illegal invocation” in browsers. After the executor
bytes pass integrity checking, Bouncer binds `fetch` to the sandbox window
before running them. Its message-only UI is adapted after verification with a
high-contrast QR, testnet/return instructions, responsive sizing and a cancel
button; the signed payload is unchanged. The browser test covers the real
executor with a synthetic signer and RPC; it is not a live phone login. Live
probe `41613171918` prepared an unsigned message request and QR through the
actual Mobile backend; it did not use a real wallet or approve a signature.

**NEAR CLI:** choose the CLI option, enter a testnet account ID, choose your
OS keychain, local `~/.near-credentials` file, or Ledger, then run the displayed
`near message sign-nep413` command in a terminal with `near-cli-rs` installed.
The Credentials file option uses `sign-with-legacy-keychain`, which works for
legacy CLI credential files without an OS keychain. Bouncer adds that choice
to the pinned adapter after integrity verification. Paste the command's JSON
output into the prompt, not your seed phrase or private key. Bouncer verifies
the signature locally and checks via a read-only final-block testnet RPC query
that the public key is a current Full Access key for the entered account. A
limited key, invalid signature, unavailable RPC, or unsupported Ed25519 browser
fails closed. This proves control of that key at the time of the RPC response,
not an audit or a lasting authorization. An old manually typed CLI account is
not restored as a verified login; a new challenge is required after reload.
GitHub browser smoke `41606224793` exercised the pinned adapter and real
`near-cli-rs` with a temporary synthetic credential, mock RPC, successful
signature verification and disconnect. It did not use an actual user's CLI
wallet or prove a live account login.

The other returned accounts are wallet-reported rather than cryptographic proof
of ownership. Once connected, all Connect controls show a green indicator and
`Connected`; opening one shows the account and disconnect control. No connection
creates a vault or grants spending access. Never enter a seed phrase or private
key into Bouncer. Named `.testnet` accounts and 64-hex implicit accounts are
accepted; the connector is fixed to testnet. If browser storage is unavailable,
the connector keeps its selection in memory, though individual wallet executors
may still need storage.

Intear creates an off-chain application communication key in browser storage;
this is not a NEAR account access key. It requires browser WebCrypto Ed25519
support (for example Chrome 137+, Firefox 129+, or Safari 17+). Its adapter is
separately licensed under AGPL-3.0 and built from vendored source pinned to
`INTEARnear/wallet@e958da12017cdd43b41947e4f201e72aa1135bf6`. The picker links
to its corresponding source archive. Regenerate it with
`python3 bouncer/scripts/build-intear-source.py` after updating the source.

The Mobile adapter’s generic “Sign transaction” button is relabeled “Open NEAR
Mobile” in Bouncer’s message-only flow. Once the adapter verifies the signed
message and checks the key on testnet, the header and wallet panel show the
account as connected. On a phone, return to the same browser tab after approval;
reloading intentionally clears the message-only session.

WalletConnect uses a separately bundled SignClient and is available only when
an owned Reown project ID is configured. It proposes **only** `near:testnet`
and `near_getAccounts`, displays the approved wallet-reported CAIP account, and
never sends a wallet RPC request or asks for transaction signing, `near_signIn`,
`near_signOut`, or an access key. SignClient 2.26 moves the namespace to
`optionalNamespaces` on the wire, but Bouncer still requires that exact
identity-only NEAR testnet namespace in the approved session. A wallet granting
extra methods or networks is rejected; a broader session update closes the connection. Pairing material
and the session stay in tab memory and are discarded on reload or disconnect.
The pairing QR and mobile `wc:` link are bearer secrets: share them only with
your chosen wallet. Cancellation is best effort on the remote wallet; check its
own session list if in doubt. This is account display, **not proof of ownership**.
The QR view distinguishes component loading, pairing setup and wallet approval.
The initial download plus setup has a 50-second outer deadline; before a QR is
shown, Bouncer tries the documented `.org` relay and then `.com`, allowing up
to 18 seconds per attempt (the SDK's own connection timeout is 15 seconds).
It never changes a visible pairing or replays a wallet request. Retry uses fresh
in-memory storage and an isolated SDK core; a previous browser build did not
reliably disable the SDK's shared global core. The browser bundle also uses
standard Uint8Array APIs rather than an extension-injected Node `Buffer`.

A working QR and the `Open wallet app`/copy link represent the same private
pairing. After a compatible wallet approves the account-only proposal, Bouncer
updates to Connected automatically; scanning alone is not approval. Mobile
`wc:` link handling depends on the installed wallet and browser. The pairing
layout adapts to short screens/high zoom, but the actual user's camera and app
have not been tested. If the browser cannot draw a valid QR, the link remains
available. If neither relay works, Bouncer cannot generate a working pairing:
retry, switch networks or use another listed wallet. Diagnostics show only
bounded `WC-…` stage codes, not raw SDK errors or pairing secrets. If a
same-origin HTTP Date suggests a large clock discrepancy, the interface offers
that as a possible explanation, not a confirmed cause. Not every wallet
supports NEAR testnet and this minimal namespace; no real WalletConnect wallet
session has been verified yet. Without an ID the picker says setup is required.
Do not borrow another project's ID.

To enable the deployed site, the owner creates a project at
`https://dashboard.reown.com/sign-up`, copies its public **Project ID**, and
allowlists `https://bouncer-near.vercel.app` in the dashboard. Allowlist changes
can take up to 15 minutes. Set `BOUNCER_WALLETCONNECT_PROJECT_ID` as a Vercel
production build environment variable and redeploy. Staging validates the
32-hex identifier and generates `walletconnect-config.json`; it is public in
the browser and is not a wallet credential. Never put a password, seed phrase,
private key or dashboard API key there. The source template stays blank.

The separately pinned `@walletconnect/sign-client` 2.26.0 includes Reown's
**WalletConnect Community License**, not Apache-2.0. Its redistribution notice
and complete license are included in `walletconnect-NOTICES.txt` and linked in
the picker. The license includes network, usage, commercial-threshold and
dispute-resolution terms; the project owner should review it and Reown's terms
before enabling. The WalletConnect icon comes from its official brand toolkit
(Git blob `d90457adfdfffa9394fbacfd9632ff650ffe5396`); it does not imply an
endorsement. No payment has been made. `npm audit` found no reported
vulnerabilities in the locked WalletConnect dependency tree on 3 November 2026;
that is not an independent security audit.

The Ethereum-wallet bridge is omitted because its current sign-in may onboard
an account with an AddKey transaction, contrary to this identity-only policy.

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
npm ci --prefix bouncer/walletconnect
npm run build:web --prefix bouncer
node --test bouncer/tests/cli-login.test.mjs bouncer/tests/wallet.test.mjs bouncer/tests/walletconnect.test.mjs bouncer/tests/web.test.mjs bouncer/tests/public-web-staging.test.mjs
```

Vercel’s `bouncer` project uses `bouncer/web` as its root and
`node ../scripts/stage-public-web.mjs public-site` as its build command. Staging
copies only fifteen explicit public assets, including the bundled connectors,
WalletConnect notices and public configuration, local font and its OFL license,
and the Intear executor and corresponding source. It rejects symlinks, existing
output directories, invalid project IDs and any wallet-origin override
other than the exact dedicated origin. It does not publish checkout files,
credentials, journals or private evidence.
`bouncer/web/vercel.json` sets basic response headers; no production-ready
security or CSP review is implied. The public repository is
`https://github.com/Greatmujey/Bouncer`.

The project’s production branch is `main`; working-branch previews and the
production domain can therefore serve different commits. On 3 November 2026 UTC,
working-branch commit `3debc92` was deployed to `bouncer-near.vercel.app`
without merging to `main` (Vercel deployment `dpl_Cx85CWcnNBYGHxRb4crisaK5miWh`).
The owner-supplied public Reown project ID is configured for production. Live
smoke `41615256377` checked the Workspace and Mobile backend, then decoded,
cancelled and regenerated QRs and paired a synthetic wallet on the actual
production site. It passed in Windows and Linux Chrome with the primary relay,
and with the primary deliberately blocked and the `.com` fallback used; the
synthetic wallet stayed on `.org`. The same run exercised real near-cli-rs with
an ephemeral synthetic key and mock RPC. No real wallet, transaction, or actual
user's login was used; compatibility with an actual wallet remains unverified.
Local tests passed 1,143 cases with 113 skipped, and the working-branch build
workflow `41614698661` passed.
A future production build from `main` could replace the site. The deployed Intear source ZIP has
SHA-256 `2fe277baae87ff16d7b1efee9853cba26a46b1f9813302bf507f5ca53d2e0291`.
Verify deployed assets and wallet behavior after deployment rather than assuming
a branch push updated production.
GitHub Pages could use
`https://greatmujey.github.io/Bouncer/` if enabled and deployed, but it has not
been reverified as live. Its shared origin is deliberately not wallet-enabled.

The browser tests exercise responsive layouts, keyboard navigation, an optional
tour, historical data, origin restrictions, integrity-check rejection, and
mocked wallet backends through the connector bridge and pinned Mobile, Intear,
and CLI executors. The WalletConnect browser test uses a synthetic SignClient
interface and the real QR renderer; unit tests check namespace limits and
cancellation. Opt-in CI probes can create and cancel a real Reown pairing,
approve and disconnect a synthetic wallet session over the relay, or run
near-cli-rs against an ephemeral synthetic credential and mock RPC. None proves
a real wallet session. If hosted headless Chromium does not deliver a nested-frame tap, the protocol test
reports and uses programmatic activation; that fallback does
not verify touch input. Tests do not demonstrate a real wallet login, an
independent security review or provider delivery.
