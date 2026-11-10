# Bouncer Guarded Mission Runbook — V14 Fresh Vault

**Owner:** `great_mujey.testnet`  
**Vault:** `native.great_mujey.testnet` (not yet created — needs computer/CLI once)  
**Network:** NEAR testnet  
**Status:** Ready to execute — zero transactions sent, nothing deployed

---

## Prerequisites (one-time, needs computer)

Before any mission step, the vault must exist:

```bash
near create-account native.great_mujey.testnet --masterAccount great_mujey.testnet --initialBalance 6
near deploy native.great_mujey.testnet bouncer/web/artifacts/v14-research.wasm
```

**Estimated cost:** ~6.008 NEAR (~5.59 storage + ~0.008 gas). Owner has ~36.03 NEAR verified available.

After this one-time computer step, **no CLI is ever needed again** — everything runs through your phone wallet.

---

## Mission: OutLayer price → compute → public storage

Three goals, executed in order, each capped and owner-approved:

| Goal | Kind | What it does | Cap |
|------|------|--------------|-----|
| 1 | `oracle` | Fetch NEAR/USD price from Coinbase via OutLayer | 1 NEAR |
| 2 | `compute` | Run bounded WASM (random number or market summary) | 1 NEAR |
| 3 | `storage` | Write price + compute result to public NEAR storage | 1 NEAR |

**Total mission cap:** 3 NEAR (3 × 1 NEAR goals)

---

## Step-by-step execution (phone/web after vault exists)

### Step 0 — Open the mission site
Open `https://bouncer-near.vercel.app/` (or the live Railway URL when available) in your phone browser. Connect `great_mujey.testnet` in Meteor (or your NEAR testnet wallet).

> The identity message does NOT approve spending. Nothing happens until you explicitly sign a mission approval.

### Step 1 — Get the mission review
The site loads a mission review from the backend:
- Format: `bouncer-native-mission-review-v1`
- Network: testnet
- Contract: `native.great_mujey.testnet`
- Owner: `great_mujey.testnet`
- Max: 3 NEAR
- SHA-256 hash of the full mission

**Verify:** The hash matches what's shown. If it doesn't, stop.

### Step 2 — Preview the mission
The backend simulates the mission and returns:
- Which compute task was chosen (market or random)
- The next goal to execute
- Readiness status: READY or NOT_READY

**Verify:** The preview matches the review hash exactly. If anything differs, stop.

### Step 3 — Approve goal 1 (Oracle price fetch)
Your wallet shows a signing message:

```
Bouncer TESTNET mission approval
Account: great_mujey.testnet
Vault: native.great_mujey.testnet
Mission: native-resources-example
Mission SHA-256: <hash>
Maximum: 3000000000000000000000 yoctoNEAR plus gas
Site: <your-site>
Expires: <timestamp>
I approve this one Bouncer testnet mission.
Steps are non-atomic; storage is public; uncertain transactions must not be resent.
```

**Sign** this in your wallet. This is an **off-chain authorization** — no transaction is sent yet.

### Step 4 — Execute goal 1
The backend executes the oracle call:
- Calls OutLayer price oracle (`zavodil2.testnet/price-oracle`)
- Fetches NEAR/USD from Coinbase
- Returns a receipt with transaction hash

**Verify:** Paste the receipt hash here (or check in your wallet history). Confirm:
- Transaction succeeded (not failed/unknown)
- Gas refund matches expectation
- Storage balance decreased as expected

### Step 5 — Approve goal 2 (Compute)
Same flow as Step 3, but for the compute goal:
- Task type chosen by model: `market` (NEAR/USD value calculation) or `random` (random integer)
- Bounded inputs (quantity 1-1000, or min/max range)
- WASM program with SHA-256 verified hash

### Step 6 — Execute goal 2
The backend runs the WASM compute task within bounds:
- Max 10 million instructions
- Max 128 MB memory
- Max 60 seconds execution

### Step 7 — Approve goal 3 (Storage)
Same authorization flow for writing results to public NEAR storage.

### Step 8 — Execute goal 3
Writes price + compute result to public storage with prefix `mission-`:
- Object ID: `mission-results`
- References both earlier goal IDs
- Max 4096 bytes

### Step 9 — Mission checkpoint
After all three goals complete, the backend returns a checkpoint with:
- All delivery transaction hashes
- Remaining goal IDs (empty when complete)
- Confirmation the mission is finished

**Verify:** All three delivery hashes exist on testnet. Check them in NEARBlocks.

---

## Safety rules (never break these)

| Rule | Why |
|------|-----|
| 1-yocto owner signature on every goal | Prevents unauthorized spending |
| Temp key deleted after mission | Limits key compromise window |
| Per-goal cap (1 NEAR) + mission cap (3 NEAR) | Bounded autonomy |
| Receipt verified before next goal | No blind chaining on unknown results |
| No resend if hash unknown | Prevents duplicate sends |
| No secrets in public storage | NEAR contract state is public |
| Storage is public, not private | Results and references are visible on-chain |

---

## What to paste back to me after each step

After each transaction, paste:
1. The **transaction hash** from your wallet
2. Whether it succeeded or failed

I'll verify receipts read-only — I never sign or send anything.

---

## If something goes wrong

| Situation | Action |
|-----------|--------|
| No hash returned | Don't resend. Paste whatever you have. |
| Transaction failed | Stop. Check receipts before retrying. |
| Unknown result | Stop. Verify on NEARBlocks. |
| Wallet asks for seed phrase | **Stop immediately.** Never share it. |
| Amount doesn't match | **Stop.** Don't sign. |

---

## After the mission

- Temporary key is deleted
- Vault returns to owner-only control
- Results are in public NEAR storage (visible to anyone)
- Mission can be re-run with a new review and new approvals

**Nothing happens until you create the vault via CLI.** Until then, this runbook is ready and waiting.
