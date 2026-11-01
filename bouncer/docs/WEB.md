# Website, onboarding and testnet wallet

`bouncer/web/` is a static product walkthrough, with a first-visit tour and
historical examples. The optional wallet control uses NEAR Connect on testnet
and requests **account-only sign-in without adding an access key**. The page
shows the account reported by the wallet; it is not cryptographic proof of
ownership and does not create or connect a Bouncer vault, configure policies,
permit the agent to spend, sign messages or send transactions. No seed phrase
or private key should be entered into Bouncer. The connector has been tested
with a mocked sandbox wallet; the pinned Meteor UI has also been opened and
cancelled with its backend blocked. A later attempt to open the real Meteor
login page from a GitHub Actions runner encountered a Cloudflare access block.
An actual wallet sign-in has not yet been independently verified end to end.

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

## Durable public hosting

The public site is available at `https://bouncer-testnet.vercel.app/` while the
source repository stays private. The initial Vercel deployment used working-
branch commit `a05fc8d`. The site is a historical walkthrough, **not** a live
agent dashboard: only its optional balance-refresh button performs read-only
NEAR testnet RPC calls. Links to GitHub Actions evidence in a private repository
will not be accessible to visitors without repository access. A durable URL is
not a security audit, real wallet sign-in, or proof of independent FT-paid
fulfillment.

`.github/workflows/github-pages.yml` is prepared to publish on changes to the
website on `main`, or by manual dispatch, **after** it is merged and GitHub
Pages is enabled with GitHub Actions as the publishing source. It does not turn
on Pages or change the repository's visibility. GitHub Pages is available for
private repositories only on supported paid plans; the current plan and Pages
permissions must be checked separately. The conventional project URL would be
`https://greatmujey.github.io/Bouncer/`, but it must not be
advertised as live until deployment and public access have been verified. An
attempt to enable Pages through the GitHub API on 1 November 2026 was rejected
with HTTP 403 because the connected integration lacks the required Pages and
repository-administration write permissions. The account plan was not exposed.
The site workflow and these settings must both be in place; if Pages is enabled
after the workflow is merged, run the workflow on `main` to publish it.

The opt-in `[test-github-pages]` CI job serves staged files to a phone-sized
browser by intercepting requests at the GitHub Pages origin and `/Bouncer/`
path. It checks nested asset loading and wallet safety without contacting Pages;
this is an offline simulation, not a deployed GitHub Pages site.

The Pages workflow, the temporary preview uploader, and a production hosting
build can all use `scripts/stage-public-web.mjs`'s common allowlist. Staging
creates a new directory containing exactly seven reviewed website assets; it
refuses symlinked assets, an existing output directory, and any nonempty or
duplicate wallet-origin override. It does not copy the checkout, secrets,
credential envelopes, journal files, or evidence artifacts. Vercel is an
alternative host: its Git integration can read the private repository to build,
but the public output should be only the seven staged files. Verify the final
public files and access before sharing any deployment.

GitHub Pages project sites under the same account share the `owner.github.io`
origin, even when their repository paths differ. The wallet connector blocks
`github.io` hosts even if an origin is explicitly approved. Other public hosts,
including Vercel, remain unapproved by default, and public staging currently
requires the wallet origin to be empty. A future wallet-enabled deployment needs
an isolated custom origin, a separate security review and real end-to-end
sign-in testing; do not enable it merely because a URL is stable.

## GitHub account rename

The current repository is `https://github.com/Greatmujey/Bouncer`. Website,
package and documentation links use the new owner directly instead of relying
on the old username's redirect. The repository remains private, so its GitHub
Actions evidence links still require access. GitHub's old redirects are not a
permanent identity guarantee and can stop working if the former name is reused.
After the rename, a push produced a Vercel preview from `Greatmujey/Bouncer`,
and the website was promoted from working-branch commit `2bd4a04`. Future
feature-branch changes normally receive previews, not automatic production
updates; the configured production branch is `main`.

An archived evidence JSON and the original, already-completed one-shot Ref
sweep scripts deliberately retain their historical repository identifiers. Do
not rewrite their safety fences to the new owner or run them again: the
original sweep has already happened. For historical job links, use the same run
and job identifiers under the new repository URL instead of modifying evidence.
