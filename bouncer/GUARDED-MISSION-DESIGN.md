# Bouncer Guarded Mission Design — V14 Fresh Vault

**Owner:** `great_mujey.testnet`  
**Vault:** `native.great_mujey.testnet` (to be created via CLI when computer access available)  
**Network:** NEAR testnet  
**Status:** Design only — zero transactions sent, nothing deployed

---

## Mission: OutLayer price fetch → compute → public NEAR storage

A bounded, goal-driven autonomous flow where Bouncer's vault enforces caps and the owner (you) controls policy via 1-yocto-signed messages.

### Step 1 — Deploy V14 vault (one-time, computer/CLI)
```bash
near create-account native.great_mujey.testnet --masterAccount great_mujey.testnet --initialBalance 6
near deploy native.great_mujey.testnet bouncer/web/artifacts/v14-research.wasm
```
**Estimated cost:** ~6.008 NEAR upfront (~5.59 storage + ~0.008 gas)

### Step 2 — Create temporary scoped key (bounded bootstrap)
Vault creates a temporary FullAccess or FunctionCall key for bounded operations. Key is deleted after mission review — until deleted it can move funds/change code.

### Step 3 — Owner sets policy (1-yocto guard)
You sign a 1-yocto message defining:
- Per-transaction cap (e.g., 0.1 NEAR max)
- Daily cap (e.g., 1 NEAR max)
- Allowed compute/storage/API actions
- Temporary key expiration

No spending happens without your 1-yocto signature.

### Step 4 — OutLayer price fetch (bounded)
- Vault calls OutLayer oracle for NEAR/USD price
- Deposit capped at per-transaction limit
- OutLayer may refund unused funds to vault

### Step 5 — Compute (bounded)
- Run lightweight compute (e.g., SHA-256 rounds, data transformation)
- Result stored in vault memory, not sent anywhere

### Step 6 — Public NEAR storage (bounded)
- Write result + price reference to public NEAR contract storage
- Storage stake locked by protocol (public state, not secret storage)
- Never put secrets or keys in storage

### Step 7 — Receipt verification (read-only)
After each step, you or I verify:
- Transaction hash exists on testnet
- Receipt shows success (not failure/unknown)
- Gas refund matches expectation
- Storage balance decreased as expected

### Step 8 — Temporary key deletion
After mission review, temporary key is deleted. Vault returns to owner-only control.

---

## Safety rules

| Rule | Why |
|------|-----|
| 1-yocto owner guard on all policy changes | Prevents unauthorized spending |
| Temporary key deleted after review | Limits window of key compromise risk |
| Caps per-transaction and daily | Bounded autonomy, not unlimited |
| No secrets in public storage | NEAR contract state is public |
| Receipt verified before next step | No blind chaining on unknown results |
| No resend if hash unknown | Prevents duplicate sends |

---

## What you do (phone/web, after vault exists)

1. Open your wallet (Meteor or any NEAR testnet wallet)
2. Connect `great_mujey.testnet`
3. Sign 1-yocto policy messages as they appear
4. Paste transaction hashes here — I verify receipts read-only

## What I do (read-only, no wallet needed)

- Verify transaction receipts on testnet
- Check storage balance changes
- Confirm gas refunds
- Confirm temporary key lifecycle
- Document each step

---

## Prerequisites before mission

- [ ] `native.great_mujey.testnet` created (computer/CLI)
- [ ] V14 contract deployed
- [ ] Temporary key created and bounded
- [ ] Owner policy set via 1-yocto signature
- [ ] `great_mujey.testnet` has ~6 NEAR available

**Nothing happens until you create the vault via CLI.** Until then, this is a ready-to-execute design.
