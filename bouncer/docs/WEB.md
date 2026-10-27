# Website, onboarding and testnet wallet

`bouncer/web/` is a static product walkthrough, with a first-visit tour and
historical examples. The optional wallet control uses NEAR Connect on testnet
and requests **account-only sign-in without adding an access key**. The page
shows the account reported by the wallet; it is not cryptographic proof of
ownership and does not create or connect a Bouncer vault, configure policies,
permit the agent to spend, sign messages or send transactions. No seed phrase
or private key should be entered into Bouncer. The connector has been tested
with a mocked sandbox wallet; the pinned Meteor UI has also been opened and
cancelled with its backend blocked. An actual wallet sign-in has not yet been
independently verified end to end.

The bundled NEAR Connect version is pinned, and the curated Meteor, Nightly and
Ledger executor URLs use immutable Git commit IDs. NEAR Connect's shared
IndexedDB executor cache is disabled to avoid running stale cached code. The
wallet providers, their sandbox integrations, their websites, browser
extensions and the site's host remain trust boundaries. This is unaudited,
testnet-only prototype software, not suitable for real funds.

## Origin isolation

NEAR Connect stores session data in the browser origin. The wallet control is
therefore disabled in iframes and on path-based shared guest hosting, including
`madethis.website`. It is enabled for top-level localhost, Codespace forwarded
port hosts and Arena port hosts. The latter may only be accessible through an
embedded preview, in which case the wallet remains disabled. Other hosts are
blocked by default.

For a dedicated HTTPS origin you control, an operator may set the exact origin
in the `bouncer-wallet-origin` meta tag in `index.html` before deploying. Never
approve a host where unrelated sites share the same origin or can inject
scripts, even if they use different paths. A domain/subdomain alone is not proof
of safety: trust and control over hosting, DNS, TLS and all scripts matter.
Choose a secure isolated host before connecting a testnet wallet. Production
wallet security, vault creation and ownership authentication are unfinished.

To regenerate the checked-in browser bundle after changing the connector source:

```sh
npm ci --prefix bouncer
npm run build:web --prefix bouncer
```

The CI browser test checks tour behavior and a **mock** wallet executor through
the real bundled NEAR Connect sandbox bridge. It also opens and cancels the
pinned real Meteor wallet UI with its backend blocked. It does not claim a real
wallet login. The guest-publication workflow uploads only the explicit static files;
wallet connection stays disabled on that shared-origin preview.
