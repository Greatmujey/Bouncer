# V14 Fresh Vault Deployment Plan — `native.great_mujey.testnet`

**Owner:** `great_mujey.testnet`  
**Vault:** `native.great_mujey.testnet` (child account, does not exist yet)  
**Network:** NEAR testnet  
**Status:** Plan locked, zero transactions sent

## Prerequisites
- Computer with NEAR CLI (Meteor and MyNEARWallet do NOT support sub-account creation)
- `great_mujey.testnet` funded (~36 NEAR verified available; ~6.01 needed)

## Exact commands
```bash
near create-account native.great_mujey.testnet \
  --masterAccount great_mujey.testnet \
  --initialBalance 6

near deploy native.great_mujey.testnet \
  bouncer/web/artifacts/v14-research.wasm
```

## Estimated upfront cost
| Component | Approx NEAR |
|-----------|-------------|
| Vault storage + gas | ~5.59 NEAR |
| Create + deploy gas | ~0.0076 NEAR |
| **Total** | **~6.008 NEAR** |

## Safety gates
- Verify balance covers ~6.01 NEAR before creating
- Confirm `native.great_mujey.testnet` doesn't already exist (verified absent)
- Temporary FullAccess key deleted after bootstrap — it can move funds until deleted
- No resend if no hash appears; paste whatever you get for verification

## Post-deployment (I can verify read-only)
- Vault exists at fresh FINAL block
- V14 contract code deployed
- Receipts for create + deploy
- Storage used matches estimate

**After this one-time computer step, no CLI needed again.** All mission execution runs through phone/web.
