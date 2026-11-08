# Partial native-NEAR missions (experimental)

`agent/native-mission.mjs` sequences the existing **Bouncer-guarded** random
compute and price-oracle runners under one owner-reviewed testnet manifest. It
is **not** the direct wallet-to-OutLayer shortcut. Each payment still goes
through the pinned Bouncer contract method, owner-defined policy, allowlist,
restricted agent key and native vault. FT workflows remain available separately.

This is a **partial, non-atomic agent API**, not a complete multi-resource
product or a browser wallet flow. There is no supported native storage
purchase route yet. A manifest that requires storage returns `BLOCKED` before
provider reads, signatures or new payments. The checked-in
[`native-mission.example.json`](../examples/native-mission.example.json)
intentionally requires storage to demonstrate that fail-closed behavior; its
accounts, revisions and small amounts are illustrative, not proof of a
configured vault, a usable quote, or permission to transact. Deliberately
removing storage from an owner-reviewed manifest permits a **partial**
compute/API sequence only. The public UI is not connected to this API.

## Interface and checks

The programmatic entry point is `runNativeMission({ mission, provider, journal,
signers, execute, recoverOnly })`. Preview is the default (`execute: false`);
new payments require explicit `execute: true` and the original exclusive
journal. `recoverOnly: true` cannot be combined with execution or supplied
signers, and reconciles existing original hashes without creating new payments.
The `signers` map is keyed by goal ID: random compute and the oracle need
different, single-method function-call keys. Do not substitute full-access
keys, and never put private keys or seed phrases in a manifest or chat.

The manifest fixes one owner and vault, unique IDs, ordered goals, required
resource types and a maximum total native deposit in yoctoNEAR. The sum of
all goal maximums must fit that total; gas is separate. Before any new
payment the runner:

1. Checks the exact saved manifest and reconciles **all** prior originals.
2. Preflights every remaining pinned program, project, method, scoped key and
   policy, then conservatively checks the aggregate per-policy rolling budgets
   and native vault balance. A disabled (`0`) rolling cap is blocked here.
3. Durably records the manifest, and rechecks remaining budgets before each
   payment. Existing native runners record each original signed hash before a
   bounded one-shot submission and verify the returned provider/refund evidence.
4. Rechecks earlier oracle freshness and the other journal records immediately
   before each broadcast, including after signing and the journal write. If a
   final guard fails, the newly recorded hash remains pending; do not resend it
   automatically even if a broadcast apparently did not happen.

A prior payment is not rolled back if a later step fails. Refunds verified by
the existing OutLayer path go to the owner; they do not automatically restore
the vault balance or rolling budget. Preflight and the final-block views are
non-atomic snapshots; the on-chain firewall remains authoritative. Receipt
verification trusts the RPC and provider, and an oracle result is not an
attestation of truth or TEE proof.

The operation lock coordinates only cooperating users of the same open journal
object; `FileJournal` adds its local filesystem lock for cooperating processes.
Neither protects another journal, rollback, bypassing clients, a compromised
host or an untrusted injected runner. Preserve the original journal and its
separate encryption key where used; independently retained checkpoints and
cross-device coordination are not provided by this API. The `runners` injection
hook is for offline tests, not an authorization boundary.

The test suite uses synthetic FINAL receipts and ephemeral test keys to cover
preflight, aggregate caps, stale results, concurrency, lost responses and
original-hash recovery. It does **not** establish a live provider purchase,
independent storage delivery, real phone approval or an audit. Do not use real
funds.
