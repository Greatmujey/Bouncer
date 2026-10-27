# Deploying Bouncer

## Prerequisites

- Rust stable + wasm32 target: `rustup target add wasm32-unknown-unknown`
- `cargo-near` is optional but recommended (`cargo install cargo-near`)
- A NEAR testnet account (https://testnet.mynearwallet.com)
- Testnet NEAR from https://near-faucet.io
- Testnet USDC: Circle faucet gives 20 USDC every 2h on testnet

## Build

```bash
npm run build
# output: contracts/bouncer/res/bouncer.wasm
```

## Deploy

```bash
DEPLOYER_ID=you.testnet \
DEPLOYER_KEY=ed25519:your-secret-key \
CONTRACT_ID=bouncer.you.testnet \
NETWORK=testnet \
  node scripts/deploy.mjs
```

The script:
1. Creates the sub-account `CONTRACT_ID` if it doesn't exist and funds it with 30 N
2. Deploys the wasm
3. Calls `new(owner=DEPLOYER_ID)` to initialize (skipped if already initialized)

## Set up a test policy (USDC)

1. Register the vault with testnet USDC:
   ```bash
   near call usdc.fakes.testnet storage_deposit '{}' \
     --accountId bouncer.you.testnet --deposit 0.00125
   ```
2. Send USDC to the vault:
   ```bash
   near call usdc.fakes.testnet ft_transfer_call '{
     "receiver_id": "bouncer.you.testnet",
     "amount": "50000000",
     "msg": "fund"
   }' --accountId you.testnet --deposit 0.000000000000000000000001 --gas 100000000000000
   ```
3. Create a policy:
   ```bash
   near call bouncer.you.testnet set_policy '{
     "policy_id":"procurement",
     "policy":{
       "label":"procurement agent",
       "token":"usdc.fakes.testnet",
       "per_tx_cap":5000000,
       "windows":[{"period_ns":86400000000000,"limit":20000000}],
       "payee_allowlist":["vendor.near","base"]
     }
   }' --accountId you.testnet --deposit 0.000000000000000000000001
   ```

## Issue an agent function-call key

Generate an ed25519 keypair (the dashboard can do this), then:

```bash
near add-key you.testnet ed25519:<agent-pubkey> \
  --contract-id bouncer.you.testnet \
  --method-names execute,pay_invoice,file_invoice,open_cross_chain,bid,check \
  --allowance 0.25
```

The key can call only those six methods on the contract, cannot attach deposit, and has ~0.25 N gas budget. This is the ONLY credential the agent ever sees.

## Run the procurement agent (auto-pays invoices)

```bash
BOUNCER_CONTRACT=bouncer.you.testnet \
AGENT_ID=agent-key-holder.you.testnet \
AGENT_KEY=ed25519:<agent secret> \
NETWORK=testnet \
  npm run agent
```

## Run the cross-chain solver bot

```bash
BOUNCER_CONTRACT=bouncer.you.testnet \
SOLVER_ID=solver.you.testnet SOLVER_KEY=ed25519:<solver secret> \
NETWORK=testnet ONE_CLICK_JWT=<optional JWT> \
  npm run solver
```

Without ONE_CLICK_JWT the bot uses mock quotes (0.3% fee) and mock fill hashes so the demo completes end-to-end.

## Rust tests to add (work in progress)

- [x] `set_policy_rejects_non_owner`
- [x] `set_policy_works_for_owner`
- [x] `execute_over_cap_rejected`
- [x] `split_payment_seventh_blocked_by_daily_window` (the headline demo frame)
- [x] `unknown_payee_rejected`
- [x] `unknown_token_refunded_on_deposit` (fake airdrop defense)
- [x] `check_happy_path`
- [x] `owner_withdraw_requires_yocto`
- [x] `agent_key_cannot_call_set_policy` (the structural proof)
- [ ] `ft_transfer_failure_recredits_balance` (needs a mock FT harness)
- [ ] `concurrent_execute_no_double_spend`
- [ ] `cross_chain_solver_bid_below_floor_rejected`
- [ ] `file_invoice_then_pay_invoice_under_policy_settles`
- [ ] `malicious_ft_receiver_cannot_pull_without_allowance`

The 9 checked tests are in `contracts/bouncer/src/lib.rs` and run with `cargo test`.
