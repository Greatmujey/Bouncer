# Native OutLayer wallet path (testnet, experimental)

This is a **building block**, not a live wallet purchasing feature. It prepares a
bounded owner-reviewed path to one independent OutLayer price lookup, paid in
native testnet NEAR. It is not the independent FT-paid Buffer purchase, and it
does not prove independent compute, storage and API fulfillment as a group.
The historical [OutLayer price execution](https://testnet.nearblocks.io/txns/4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ)
used a different testnet owner; its single-source result is not a price accuracy,
market-freshness, TEE-attestation or SLA guarantee. The three later resource
examples were **self-hosted development services**.

## What is implemented

- `agent/native-oracle-wallet-plan.mjs` constructs four **unsigned** testnet
  wallet batches for a named owner, fresh direct-child vault and separate
  Ed25519 agent public key. It pins the repository V9 WASM (452,675 bytes,
  SHA-256 `835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee`,
  NEAR code hash `9qpU6d6MHZZXC2ivtQt3k3scGkiHLkkMnaTAiZWbaL6y`). It pins
  `outlayer.testnet`, the reviewed project version and one Coinbase input.
  The trial's per-call, rolling-day and tracked-deposit amounts are each
  bounded to at most 0.1 test NEAR. Only PUBLIC keys go into the review.
- The stages create and initialize a **keyless** vault; configure its native
  policy, allowed provider, fixed project and agent grant using four separate
  **1-yocto** owner calls; deposit native funds; and add a finite-allowance
  owner-account function-call key scoped only to
  `execute_outlayer_native_project`. The agent key cannot attach the 1 yocto
  required for owner-only changes. A typed account ID is not wallet control.
- `native-oracle-readiness.mjs` reports approximate owner, storage, gas,
  project-registry and new-vault conditions at one fresh trusted-RPC FINAL
  block. `native-oracle-wallet-preflight.mjs` checks each next stage against a
  separately retained review, owner key, prior original hashes and matching
  receipt graphs, then reads the current vault, policy, key and project state
  at one fresh FINAL block. These results are **not approvals or prompt
  claims**. They trust the RPC and clock and can race changes after the read.
- `native-oracle-wallet-evidence.mjs` checks original transaction actions,
  signer, receiver, linked receipts and bounded protocol gas refunds. It does
  not prove current state, wallet consent or independent delivery. A missing,
  failed or uncertain original must be reconciled; never automatically retry.
- `git-native-oracle-prompt-witness.mjs` adds a separate public, hash-linked
  reservation/claim/original log for the four stages. The Git-backed store
  uses a branch CAS and checks the acknowledged remote head. A lost claim
  acknowledgment blocks another claim. This is an experimental independent
  checkpoint, not a complete authorization service: the owner session,
  PostgreSQL coordinator, prior receipt/preflight gates and independent latest
  head retention/monitoring are not connected. Git administrators or a
  simultaneous rollback can still defeat it. A hash in this log alone does
  **not** establish a valid receipt or allow a later wallet prompt.
- `web-src/native-oracle-device-key.mjs` can generate and retain one local,
  non-extractable Ed25519 WebCrypto key per owner and test its possession
  without exporting the private key. It has no transaction-signing, network or
  wallet API and is not connected to the UI. Synthetic IndexedDB tests and a
  390px Chromium test cover concurrent creation and reload, not real phones or
  durable backups. Storage eviction or device/origin loss can lose this key;
  same-origin scripts/XSS can still use it. Missing local data does not prove
  an on-chain key was never installed. Owner-led on-chain revocation and a
  complete recovery process are still required before funding.
- `native-oracle-wallet-recovery.mjs` prepares an unsigned owner recovery
  review that deletes the exact agent access key, then calls
  `revoke_agent_key` with 1 yocto. If the key is already absent it can prepare
  only the grant removal. `native-oracle-recovery-preflight.mjs` checks a
  fresh testnet FINAL block and, when applicable, the retained original key
  deletion and its receipt graph before the grant stage. This remains offline
  scaffolding: no authenticated UI, durable recovery prompt fence, wallet
  approval or real-phone revocation is implemented. In-flight requests may
  finish, and removing the key does not recover locked storage collateral.
- The native OutLayer runners require a **bounded one-shot** sender. They
  record the original signed hash before the single submission and recover
  using that hash; they do not fall back to a retrying sender. Their existing
  results still require exact provider request, completion and refund evidence.
- The [isolated nearcore test](https://github.com/Greatmujey/Bouncer/actions/runs/42398475213)
  exercised all four stages, the exact receipt verifiers, the zero-yocto guard,
  the restricted-key 1-yocto rejection and an over-cap rejection. The OutLayer
  registry in that test was fabricated, and no provider request or public-chain
  transaction occurred. The NEAR Connect converter is separately checked
  offline; that is **not** a real-wallet or real-phone compatibility test.

## Funding and refunds

The current plan transfers **5.4 test NEAR** to the new keyless vault for
contract storage and operational headroom, plus up to **0.1 test NEAR** as a
tracked vault deposit. Storage collateral can remain locked: a successful
setup is not automatically reversible and there is no claim that the whole
5.4 NEAR can be recovered. The separate 0.5-test-NEAR function-call key
allowance is a *gas spending limit*, not a provider deposit. Readiness uses a
further 1-test-NEAR owner reserve and a pinned gas-price/storage estimate; none
of these estimates guarantees admission, fee levels or future state.

The full authorized execution maximum counts against the rolling budget. For
an accepted execution, unused native funds are expected to go **to the owner**,
not back into the vault or rolling budget; only actual matching receipts can
establish a refund. A rejected request or failed promise may behave differently.
Do not infer a refund or safe retry from a timeout.

A [read-only snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/42397841711)
at FINAL block `9GLMWoW5ubnQVFjsv4RNmWGVUDDrpd7WtPiuns3w32pt` observed about
20.04 test NEAR in `great_mujey.testnet` and passed the then-current
approximate 6.5-NEAR owner-funding check. This is **historical public data**, not
proof of wallet control, a reservation, current balance or permission to spend.
The independently operated OutLayer account had a FullAccess key, so its code
can change. A lookup of global V9 code at one RPC did not return a match; that
is not proof of global absence or a compatible wallet transport.

## Before enabling a real phone flow

1. Complete the independently monitored per-owner prompt fence and
   authenticated owner session for these **four** exact stages. Preserve the
   separately anchored review and every original hash across crashes, lost
   responses, browser changes and database or witness rollback. A local browser
   cache alone is insufficient. An uncertain claim or prompt is a stop, not a
   reason to prompt again.
2. Complete and test device-side agent-key custody, recovery
   and revocation without asking for a wallet seed or private key. Verify the
   wallet can deploy the large artifact and install the restricted key on an
   actual phone; feature flags and converter tests are not enough.
3. Integrate fresh stage preflights, original-hash receipt closure and retained
   claims into the owner interface. The owner must review and approve each
   stage. Check state and original receipts again after each approval and before
   proceeding. Do not expose an enabled funding/deployment button before these
   gates and custody recovery are complete.
4. Only after setup is verified, perform a separately bounded native oracle
   request, preserve its original signed hash before the one broadcast, and
   verify its actual provider receipt, result and refund. Label the outcome
   according to the evidence, not a mock or a screenshot.

The older V3 owner's originals remain unresolved; this plan explicitly excludes
that owner. V12 native-oracle runner compatibility has not been established;
this plan deliberately uses V9 rather than assuming compatibility. No
production spending is enabled by these modules.
