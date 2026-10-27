# Bouncer — Deploy Quickstart (5 minutes, all in browser)

The pre-built `bouncer.wasm` is committed to the repo root. Deploy directly from Codespaces — no local installs.

## Step 1: Get free testnet NEAR
1. Open https://testnet.mynearwallet.com and create an account (e.g. `great_mujey.testnet`).
2. Top up via the faucet: https://faucet.testnet.near.org — enter your account name, receive ~200 testnet NEAR.

## Step 2: Open Codespaces (in your browser)
Click: https://codespaces.new/abdullahimujeeb0505-stack/Bouncer?ref=arena/ebb614bb-near-hub&quickstart=1

Wait 60–90 seconds for it to boot. You'll see a browser VS Code with a terminal at the bottom.

## Step 3: Paste these into the terminal (one block at a time)

Replace `great_mujey.testnet` with YOUR account name if different.

```bash
npm install -g near-cli
near login   # opens a browser tab — click "Allow"
```

```bash
export ME=great_mujey.testnet
export ID=bouncer.$ME

# Create sub-account + deploy + init
near create-account $ID --masterAccount $ME --initialBalance 5
near deploy $ID --wasmFile bouncer.wasm --initFunction new --initArgs "{\"owner\":\"$ME\"}"
```

```bash
# Register vault with USDC fake token, fund vault with 100 fake USDC, set policy + allowlist vendor
near call usdc.fakes.testnet storage_deposit '' --accountId $ID --deposit 0.00125
near call usdc.fakes.testnet ft_transfer_call "{\"receiver_id\":\"$ID\",\"amount\":\"100000000\",\"msg\":\"fund\"}" --accountId $ME --depositYocto 1 --gas 100000000000000
near call $ID set_policy '{"policy_id":"usdc-agent","token":"usdc.fakes.testnet","per_tx_cap":"5000000"}' --accountId $ME --depositYocto 1
near call $ID allow_payee '{"policy_id":"usdc-agent","payee":"vendor.testnet"}' --accountId $ME --depositYocto 1
```

## Step 4: Record the 90s demo over the terminal

```bash
# 1. ALLOWED — 3 USDC within cap (succeeds, click the explorer link)
near call $ID execute '{"policy_id":"usdc-agent","payee":"vendor.testnet","amount":"3000000","memo":"thanks"}' --accountId $ME --depositYocto 1 --gas 100000000000000

# 2. BLOCKED — 10 USDC over cap (red panic: "amount out of per-tx range")
near call $ID execute '{"policy_id":"usdc-agent","payee":"vendor.testnet","amount":"10000000","memo":"too much"}' --accountId $ME --depositYocto 1 --gas 100000000000000

# 3. KEY ESCALATION PROOF — try to change policy WITHOUT attaching deposit (NEAR rejects: "Expected a deposit")
near call $ID set_policy '{"policy_id":"usdc-agent","token":"usdc.fakes.testnet","per_tx_cap":"999000000"}' --accountId $ME
```

For shot #3, the error "Expected a deposit" (or `DepositWithFunctionCall` if called from a function-call key) proves the structural guarantee: no policy mutation is possible without 1 yoctoNEAR attached, which function-call keys literally cannot do.
