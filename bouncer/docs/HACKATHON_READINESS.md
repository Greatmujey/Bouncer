# Hackathon readiness — in progress, not a submission

Status updated on November 2, 2026. Re-read the [official live rules](https://nearhackathon.com/HACKATHON.md) before any submission; they may change. The development/submission deadline currently stated there is **November 14, 2026 at 23:59 UTC** (November 15 at 00:59 in Lagos). There is one submission per project. Testnet-only projects are eligible; using any particular partner integration is not mandatory.

## What judges can reproduce now

- The [README quickstart](../../README.md#reproduce-the-safety-checks-without-a-wallet) gives a fresh-install, offline test command and expected results. These checks use fixtures and a mock runtime; they are **not** a live independent purchase.
- Earlier real testnet evidence includes the 0-yocto rejection linked in the README, native-NEAR-paid OutLayer work and Circle testnet USDC payments to self-hosted development services. Testnet USDC has no real-world value.
- The default contract and separate V11 feature are built and unit-tested in CI. V11 has also been exercised on a [disposable nearcore chain with a mock FT](V11_SANDBOX.md), including the 1-yocto guard and buyer recovery. It is **not deployed on live testnet or independently audited**; a version marker is not proof of deployed code. Payment settlement alone is not delivery.
- Bouncer has **not** verified useful independent FT-paid fulfillment. Svalin observations are a read-only lead: no real checkout, payment, activation or paid report has been performed. Its actual buyer and original-hash recovery passed on a local nearcore chain with a fake seller; an optional separate test uses pinned independent seller **source** with a simulated chain/indexer and sample data. Neither establishes seller attribution. A [separate Buffer code comparison](https://github.com/Greatmujey/Bouncer/actions/runs/42277687212) matched the pinned public source build to its deployed testnet code hash at one trusted-RPC FINAL block; it was not a payment, delivery or audit. The V11 owner setup runner also passed in the isolated sandbox, but no V11 setup has been used for a live deployment or Circle funding. MultiAgency's exact-FT path has synthetic tests but no completed live purchase or task.

## Track fit: evidence, not six claims of completion

The official [FAQ](https://nearhackathon.com/) explicitly says a project may
select **every track it fits**, with **one submission per project**. The
[submission contract](https://nearhackathon.com/HACKATHON.md) likewise accepts
one or more track IDs. Although the website's getting-started section says
“choose a track,” the FAQ explicitly clarifies that multiple tracks may be
selected. Recheck the live rules before submitting. No particular partner
integration is mandatory (Q-011).

The entrant must select the tracks. `security` (policy, scoped keys and owner guard) and `agents` (resource procurement) are the clearest current fits. `business` and `realworld` are early prototypes, not proven business operations or real-money rails. `defi` has historical testnet swap work but no finished guarded swap/output-accounting flow. `swarms` is an aspiration, not a demonstrated multi-agent economy. See the six-track table in the README and select additional tracks only if the completed work actually supports them.

## Public repository — security and publication review remains open

The owner subsequently made [the repository public](https://github.com/Greatmujey/Bouncer); the GitHub API confirmed this on November 2. This already exposes repository history and potentially Actions history/artifacts; changing visibility did **not** complete the outstanding security, privacy or rights review. In particular, the previously prepared Svalin report draft became publicly readable. Do not separately publicize it or retry the failed private report without approval.

1. Review **all remote branches, tags and reachable history**, plus releases, issues, pull requests, workflow logs and Actions artifacts. Include commit author names/emails, task inputs, screenshots, URLs and source rights, not just private keys. See [GitHub's visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) and [artifact API documentation](https://docs.github.com/en/rest/actions/artifacts).
2. A limited offline scan on November 1 inspected 1,582 unique blobs reachable from the eight then-visible remote branch heads, using a few high-confidence credential patterns. It found no matches for those patterns; 22 binary blobs were not scanned. A separate current-tree detector flagged candidates in **91 files** for human review. Neither result establishes that any finding is safe, that all secrets were detected, or that history/logs/artifacts are clear. The inventory and scans still need to be refreshed and reviewed.

   To repeat the limited history scan on a full clone, with all remote refs available locally:

   ```sh
   python3 bouncer/scripts/audit-git-history.py --remote origin --report "$HOME/bouncer-history-review.json"
   ```

   It makes a read-only remote ref listing, prints counts but no paths or values, and creates a **new** mode-0600 path-only report outside the repository; choose a different unused filename for each run. A shallow clone, missing remote object, existing report or scanner error fails closed. A no-match exit does **not** establish safety: it skips binary/large blobs, uncommitted files, LFS content, Actions, issues and personal-data/rights review. Use additional detectors and manually triage their results.
3. GitHub listed **757 Actions artifacts** on November 2; their contents have not been fully audited and include recovery material. Seller-v3 journals can contain replayable testnet bearer claims and task data; some unresolved recovery records are encrypted and their separate keys are unavailable. Preserve and reconcile needed state before considering any removal or access change. Do **not** delete recovery artifacts, rewrite history or force-push as an automatic cleanup.
4. Verify contributors' rights and the intended scope of the existing MIT license. The root `LICENSE` matches the project's two pre-existing MIT license files. No scan can substitute for that review, or for explicit approval of any additional publication.

Existing private-repository and first-attempt CI gates do not retroactively protect old logs/artifacts or other branches. They also do not replace human approval before signing or spending.

## Finish before submitting

- [ ] Complete and verify the intended independent FT-paid multi-resource flow; distinguish any still-missing resource and provider behavior.
- [ ] Complete the outstanding security, privacy and rights review of the now-public repository and Actions history; get explicit approval before any additional publication.
- [ ] Keep the hosted testnet site available; wallet connection is identity-only and the page is not a live purchasing dashboard. Verify real wallet sign-in end to end and preserve the shared-origin restrictions.
- [ ] After the full intended flow works, the human records and posts the public X demo: state it was built at NEAR HACKATHON, include `@NEARProtocol` and `#NEARHackathon`, and attach the appropriate video or screenshots. A local-only demo requires video under the current rules. Do not post on the human's behalf.
- [ ] The human supplies the project/team/contact details, track choices, entrant-controlled **mainnet** payout account ID, public repo and demo-post URLs, description, and the required consent. Never request or store a wallet seed or private key.
- [ ] Re-read the rules, print the exact submission payload, and wait for explicit approval before sending it. Generate one request ID and reuse it on any permitted retry; never commit the payload or submit twice.
