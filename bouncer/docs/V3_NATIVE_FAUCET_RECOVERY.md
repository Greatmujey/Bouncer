# One-shot V3 native testnet faucet

## Verified result — 3 November 2026

The [one-shot run](https://github.com/Greatmujey/Bouncer/actions/runs/41660453785)
verified a **5 test-NEAR** transfer to the existing V3 owner at FINAL:
[`258oxSL3Ckh86mD8ttz3xSBvuKJhiQwstWX8wvKhvwG1`](https://testnet.nearblocks.io/txns/258oxSL3Ckh86mD8ttz3xSBvuKJhiQwstWX8wvKhvwG1).
The temporary faucet account was then deleted and its remainder returned to
the faucet in the separately verified original
[`9Tz7qx9eBqmmXZSq7s44T3HGjGRdGbT6Z7HWs2f4QRYo`](https://testnet.nearblocks.io/txns/9Tz7qx9eBqmmXZSq7s44T3HGjGRdGbT6Z7HWs2f4QRYo).
The linked faucet payout was 4.9996742601375 test NEAR. A separate system gas
refund to the already-deleted temporary account failed and was burned; the
run did not hide that failed receipt. Public original-hash checks were
published before both sends, and encrypted pre-helper recovery artifact
`13241327993` was retained. Never resend these originals or repeat the helper.

At a subsequent public indexed view, the V3 owner held approximately
8.969798252555469399999998 test NEAR. A later [pinned FINAL funding estimate](https://github.com/Greatmujey/Bouncer/actions/runs/41661671133)
found approximately 8.967978252555469399999998 test NEAR liquid and zero
estimated shortfall for the conservative 5-NEAR vault plan plus a 0.2-NEAR
owner reserve. The previous ~1.232022 shortfall was pre-transfer. The estimate
is not an authorization or a guarantee of future storage prices and fees.
The V3 owner key was not accessed, its saved backup was not machine-verified,
and **no owner transaction was signed**. The earlier unresolved owner-signed
bearers remain unresolved; this top-up does not authorize other owner signing.
It did not fund Circle, deploy V13, contact a seller or demonstrate delivery.

## Recovery and safety design

This is **only a testnet-native funding attempt**, not Circle USDC, vault
creation, a provider purchase or delivery. The recipient is the existing V3
owner. The caller never receives or uses its owner private key and does not
sign an owner transaction; the temporary faucet account is not a new Bouncer
owner. The previous owners and the two unresolved V3 public originals are not
used. No real money is involved.

The one-shot workflow requires its exact parent commit, its first run attempt,
a fixed branch and a serialized workflow group. Before the only helper POST it:

1. Observes the V3 testnet profile and funding state at a trusted FINAL block.
2. Prepares the existing one-shot faucet journal **without contacting the
   helper**. Its short-lived temporary testnet signer is held in an AES-GCM
   encrypted journal. A fresh random journal key is sealed to the known V3
   Ed25519 public key using ephemeral X25519, HKDF-SHA256 and AES-256-GCM.
3. Uploads the ciphertext-only **pre-helper** recovery snapshot as a GitHub
   artifact, downloads it again, verifies its bytes, and verifies the artifact
   metadata. The artifact expires; retain it privately if recovery is needed.
4. Publishes and reads back a completed public GitHub check for the helper
   reservation. It makes at most one helper request. A lost response is not a
   reason to make another request.
5. Before each possible transfer or return-to-faucet deletion, the exact public
   transaction hash and nonce must be published and read back in a separate
   GitHub check. The fixed transfer is 5 test NEAR to V3; cleanup returns the
   temporary account's remainder to `v2d.faucet.nonofficial.testnet`. Each
   original is submitted at most once and checked against a trusted-RPC FINAL
   receipt. An unknown result must be reconciled by that hash, never resent.

The artifact can be opened only in a trusted private environment with the V3
owner backup, using `openFaucetRecoveryKey` from
`agent/v3-faucet-sealed-recovery.mjs` and the accompanying encrypted journal.
The claimed saved V3 backup has **not** been machine-verified. Never print or
upload the unsealed journal key, temporary signer, or owner backup.

**Critical: the artifact is deliberately a pre-helper snapshot, not the latest
journal.** It can recover the temporary signer, but it does not contain later
transaction hashes. Do not run the ordinary faucet CLI with `--resume --execute`
on this snapshot. First obtain all three original-check records for the exact
run and reconcile each published hash and nonce against FINAL receipts; absence
of an observation is not proof of non-execution. Restore or reconstruct the
journal only after accounting for those authoritative public fences. A copied
older journal cannot provide distributed idempotency or authorize another send.
If the artifact, check history, owner backup, GitHub, or RPC is unavailable,
stop instead of generating replacement originals. Trusted GitHub Actions,
cryptographic dependencies, the runner and the selected RPC remain assumptions;
this is unaudited prototype code.
