# Website and testnet wallet

`bouncer/web/` is Bouncer’s responsive testnet product walkthrough. It shows
real transaction links and historical examples, but it is **not** a live
purchasing dashboard. Independent FT-paid provider delivery, refund recovery
and an independent vault audit remain open.

## Connecting a wallet

The site uses pinned NEAR Connect on **testnet**, with curated Meteor, Nightly
and Ledger choices. Connection requests account-only sign-in, without adding an
access key, signing a message or sending a transaction. The displayed account is
wallet-reported, not cryptographic proof of ownership; connection does not create
a vault or grant the agent spending access. Never enter a seed phrase or private
key into Bouncer. Named `.testnet` accounts and 64-hex implicit accounts are
accepted; the connector is fixed to the testnet network. If browser storage is
unavailable, the connector keeps its selection in memory, though individual
wallet executors may still require storage.

The dedicated `https://bouncer-near.vercel.app/` origin is explicitly approved
for wallet connection. Hosting on Vercel is not itself a security audit: the
host, DNS, browser, wallet integrations and wallet provider remain trust
boundaries. The site is unaudited and intended for testnet only. NEAR Connect’s
executor cache is disabled, and the three executor URLs are pinned to immutable
Git commits. The site does not use arbitrary debug or injected wallet manifests.

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

## Build and deployment

```sh
npm ci --prefix bouncer
npm run build:web --prefix bouncer
node --test bouncer/tests/wallet.test.mjs bouncer/tests/web.test.mjs bouncer/tests/public-web-staging.test.mjs
```

Vercel’s `bouncer` project uses `bouncer/web` as its root and
`node ../scripts/stage-public-web.mjs public-site` as its build command. Staging
copies only ten explicit public assets, including the bundled connector, local
font and its OFL license. It rejects symlinks, existing output directories and
any wallet-origin override other than the exact dedicated origin. It does not
publish checkout files, credentials, journals or private evidence.
`bouncer/web/vercel.json` sets basic response headers; no production-ready
security or CSP review is implied. The public repository is
`https://github.com/Greatmujey/Bouncer`.

The project’s production branch is `main`; working-branch previews and the
production domain can therefore serve different commits. Verify deployed assets
and wallet behavior after deployment rather than assuming a branch push updated
the production domain. GitHub Pages could use
`https://greatmujey.github.io/Bouncer/` if enabled and deployed, but it has not
been reverified as live. Its shared origin is deliberately not wallet-enabled.

The browser tests exercise responsive layouts, keyboard navigation, an optional
tour, historical data, a mocked wallet through the real connector bridge, and
origin restrictions. They do not demonstrate a real wallet login, an independent
security review or provider delivery.
