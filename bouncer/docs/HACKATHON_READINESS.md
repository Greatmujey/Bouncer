# Hackathon readiness — in progress, not a submission

Status recorded on November 1, 2026. Re-read the [official live rules](https://nearhackathon.com/HACKATHON.md) before any submission; they may change. The development/submission deadline currently stated there is **November 14, 2026 at 23:59 UTC** (November 15 at 00:59 in Lagos). There is one submission per project. Testnet-only projects are eligible; using any particular partner integration is not mandatory.

## What judges can reproduce now

- The [README quickstart](../../README.md#reproduce-the-safety-checks-without-a-wallet) gives a fresh-install, offline test command and expected results. These checks use fixtures and a mock runtime; they are **not** a live independent purchase.
- Earlier real testnet evidence includes the 0-yocto rejection linked in the README, native-NEAR-paid OutLayer work and Circle testnet USDC payments to self-hosted development services. Testnet USDC has no real-world value.
- The default contract and separate V11 feature are built and unit-tested in CI. V11 is **not deployed, independently audited, or tested on chain**; a version marker is not proof of deployed code. Payment settlement alone is not delivery.
- Bouncer has **not** verified useful independent FT-paid fulfillment. Svalin observations are a read-only lead: no real checkout, payment, activation or paid report has been performed. Its new encrypted session/reservation-recovery library has synthetic tests only and is not a complete buyer. MultiAgency's exact-FT path has synthetic tests but no completed live purchase or task.

## Track fit: evidence, not six claims of completion

The entrant must select the tracks. `security` (policy, scoped keys and owner guard) and `agents` (resource procurement) are the clearest current fits. `business` and `realworld` are early prototypes, not proven business operations or real-money rails. `defi` has historical testnet swap work but no finished guarded swap/output-accounting flow. `swarms` is an aspiration, not a demonstrated multi-agent economy. See the six-track table in the README and select additional tracks only if the completed work actually supports them.

## Publication gate — **not cleared**

The owner has chosen to keep the repository private for now. The rules require a public repo by the deadline, so this remains a deliberate unresolved decision, not something to do automatically. Before any change in visibility:

1. Recheck **all remote branches, tags and reachable history**, plus releases, issues, pull requests, workflow logs and Actions artifacts. Include commit author names/emails, task inputs, screenshots, URLs and source rights, not just private keys. A public repo may expose Actions history and artifacts; see [GitHub's visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) and [artifact API documentation](https://docs.github.com/en/rest/actions/artifacts).
2. A limited offline scan on November 1 inspected 1,582 unique blobs reachable from the eight then-visible remote branch heads, using a few high-confidence credential patterns. It found no matches for those patterns; 22 binary blobs were not scanned. A separate current-tree detector flagged candidates in **91 files** for human review. Neither result establishes that any finding is safe, that all secrets were detected, or that history/logs/artifacts are clear. The inventory and scans must be refreshed and reviewed before publication.

   To repeat the limited history scan on a full clone, with all remote refs available locally:

   ```sh
   python3 bouncer/scripts/audit-git-history.py --remote origin --report "$HOME/bouncer-history-review.json"
   ```

   It makes a read-only remote ref listing, prints counts but no paths or values, and creates a **new** mode-0600 path-only report outside the repository; choose a different unused filename for each run. A shallow clone, missing remote object, existing report or scanner error fails closed. A no-match exit does **not** authorize publication: it skips binary/large blobs, uncommitted files, LFS content, Actions, issues and personal-data/rights review. Use additional detectors and manually triage their results.
3. GitHub listed **637 Actions artifacts** at that time, including restricted recovery material. Seller-v3 journals can contain replayable testnet bearer claims and task data; some unresolved recovery records are encrypted and their separate keys are unavailable. Preserve and reconcile needed state before considering any removal or access change. Do **not** delete recovery artifacts, rewrite history or force-push as an automatic cleanup.
4. Verify contributors' rights and the intended scope of the existing MIT license, then obtain explicit owner approval for the exact publication plan. The root `LICENSE` matches the project's two pre-existing MIT license files. No scan can substitute for that review.

The added private-repository and first-attempt CI gates apply to the current working branch; they do not retroactively change old logs/artifacts, other branches or `main` before the changes are merged. They also do not replace human approval before signing or spending.

## Finish before submitting

- [ ] Complete and verify the intended independent FT-paid multi-resource flow; distinguish any still-missing resource and provider behavior.
- [ ] Complete the publication review above and obtain the owner's explicit approval before making anything public.
- [ ] Keep the hosted demo available; its current site is a historical, read-only snapshot and wallet connection is disabled.
- [ ] After the full intended flow works, the human records and posts the public X demo: state it was built at NEAR HACKATHON, include `@NEARProtocol` and `#NEARHackathon`, and attach the appropriate video or screenshots. A local-only demo requires video under the current rules. Do not post on the human's behalf.
- [ ] The human supplies the project/team/contact details, track choices, entrant-controlled **mainnet** payout account ID, public repo and demo-post URLs, description, and the required consent. Never request or store a wallet seed or private key.
- [ ] Re-read the rules, print the exact submission payload, and wait for explicit approval before sending it. Generate one request ID and reuse it on any permitted retry; never commit the payload or submit twice.
