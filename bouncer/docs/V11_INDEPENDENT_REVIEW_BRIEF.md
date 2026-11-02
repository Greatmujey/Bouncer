# V11 independent security-review brief (request draft, not an audit)

**Status, 2 November 2026:** No independent reviewer has been engaged and no
V11 deployment on live testnet is verified. This is a scoping document, not a
finding of safety or an authorization to deploy, pay or contact anyone. An
independent reviewer must name the exact source commit, artifacts and scope
actually examined; a contributor's self-review or a passing CI run is not an
independent review. Freeze and provide the final source commit before engaging
any reviewer; a moving branch is not an immutable scope.

## Purpose and proposed scope

Bouncer is a NEAR testnet prototype for autonomous multi-resource purchasing.
V11's exact-FT variant lets an owner approve a single FT transfer while an
agent uses a narrowly scoped, zero-deposit function-call key. The default V9 and
the separate YouTick V10 variant are not V11. Review **fresh V11 state only**;
there is no verified migration from earlier versions.

Request a qualified, unaffiliated NEAR/Rust reviewer to examine, at minimum:

- `contracts/bouncer/src/lib.rs`, `contracts/bouncer/src/exact_ft_tests.rs`,
  `contracts/bouncer/Cargo.toml` and the `exact-ft-v11` feature.
- `agent/svalin-setup-{plan,preflight,stage-preflight,runner,rpc,evidence,journal}.mjs`
  and `agent/svalin-setup.mjs`: keyless creation, owner authority, each of the
  five stages, byte verification, journal durability and receipt interpretation.
- `agent/{svalin-pro-preflight,svalin-pro-session,svalin-pro-runner,svalin-owner-snapshot,exact-ft-runtime}.mjs`
  and the shared pinned block, owner-profile, nonce, signing and journal helpers:
  reservation, exact-intent preparation, one-shot payment and original-hash recovery.
- The trust and evidence limits in `docs/EXACT_FT_INTENTS.md`,
  `docs/SVALIN_PRO_READINESS.md` and `docs/V11_SANDBOX.md`, including the
  third-party seller/token assumptions rather than treating those as audited.

The scope should explicitly state whether the reviewer examines all other
adapters, UI, MCP, databases, external sellers, deployed token code and
infrastructure. Anything omitted must not be represented as covered.

## Priority questions for the reviewer

1. **Authorization and owner path.** Can any unauthorized signer, restricted
   key, cross-contract receipt, contract owner forwarding method, global
   contract, previously queued receipt or code change set policy, lock an
   intent, grant an agent, change payees or spend funds? The 1-yocto guard
   checks predecessor plus deposit, not human consent. The Svalin plain-owner
   profile is off-chain, point-in-time, trusted-RPC risk reduction only.
2. **Policy, accounting and callbacks.** Do exact amount, payee, token, memo,
   nonce, revision, expiry, key restriction, per-transaction and rolling limits
   hold under concurrent receipts, policy edits, failures, callbacks, malicious
   or nonstandard tokens, duplicate execution, overflow and storage exhaustion?
   Assess failed transfers, missing/failed callbacks, refunds, stale buckets and
   permanently consumed intents against the intended invariants.
3. **Irreversible setup.** Can a new direct-child vault be created/deployed and
   initialized safely without keys? What can be stranded if a stage, token
   registration or funding fails? V11 currently has no upgrade, account-delete
   or token-storage-unregister path. Is each original transaction and its
   receipt graph sufficiently bound to the intended stage, including omitted
   local AddKey receipt bodies and protocol gas-refund children?
4. **Recovery and operations.** Can crash, timeout, lost acknowledgment,
   concurrent key use, stale/erased/restored/separate journals, dishonest RPC,
   block drift or signer substitution cause duplicate actions, forged evidence,
   premature progress or unsafe retries? Verify that recovery remains possible
   when current owner code differs and never automatically resends an ambiguous
   original transaction.
5. **Artifact and reproducibility.** Independently review the build inputs and
   feature flags, compare the reviewed source with the candidate WASM, examine
   toolchain/dependency provenance, and document any mismatch or inability to
   reproduce. A SHA-256 match between runs of one mutable workflow is not an
   independent source-to-binary attestation.

## Evidence and reproduction inputs

- Existing isolated nearcore runs are linked in `docs/V11_SANDBOX.md`. They use
  ephemeral keys, a mock FT, fake seller, simulated approval/network flags and a
  disposable local chain. They are **not** Circle funding, live testnet
  deployment, human approval or independent provider delivery.
- Candidate artifact currently retained locally: 536,325 bytes; SHA-256
  `1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921`;
  recovered Git blob `c67c70401dc733a0905e79258cc8169c2e6b5210`. Its origin
  and reproducibility are **not independently established**. Preserve and
  hash-verify a copy through an agreed channel; the blob may be garbage-collected.
- The contract specifies `near-sdk = "5.14"` as a semver range and does not
  track `Cargo.lock`. Its CI toolchain and optimization environment are not
  completely pinned. Obtain an independently controlled toolchain and capture
  exact dependency versions and build commands before drawing conclusions.
- `cd bouncer && npm ci --ignore-scripts --no-audit --no-fund && npm test`
  runs the JavaScript suite; PostgreSQL and optional fixtures need the settings
  shown in CI. Rust tests use `cargo test --lib --features exact-ft-v11` from
  `contracts/bouncer`. Treat all tests as evidence of covered cases, not proof.

## Requested output and engagement conditions

Request a written scope and exact commit/hash, conflicts-of-interest disclosure,
methodology, untested assumptions, prioritized findings with reproducible
examples, recommended fixes and a separate verification of remediations. Ask
for schedule and a **quote only** before agreeing to spend; do not assume an
audit is free or will finish before the hackathon deadline. Ask for a private
channel for findings; do not send credentials, bearer codes, encryption keys,
journal contents or signed transactions.

Potential leads, not endorsements or commitments: the community-maintained
[NEAR audit directory](https://github.com/NEARBuilders/audits) lists firms with
published NEAR work; [Hacken's NEAR Intents assessment](https://www.datocms-assets.com/50156/1738583399-hacken_aurora-labs-limited-sca-aurora-labs-defuse-contracts-dec2024_p-2024-1418_2_20250127-10_50.pdf)
and [BlockApex's NEAR audit service](https://blockapex.io/near-smart-contract-security-audit/)
are concrete leads. Their availability, present pricing, independence from this
project and willingness to review this scope have **not** been verified. No
firm has been contacted.
