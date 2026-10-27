# Bouncer — Deploy Quickstart (5 minutes)

The compiled `bouncer.wasm` is already in the repo root (126 KB, release + wasm-opt). You can deploy it right from Codespaces or your laptop.

## Option A: Codespaces (recommended — no local installs)
1. From the GitHub repo page, click **Code → Codespaces → New codespace** on branch `arena/3419a30c-near-hub`.
2. Wait 90 seconds for the devcontainer (Rust + Node + near-cli preinstalled).
3. In the terminal:
   ```bash
   npm install -g near-cli
   # Create/use a testnet account at https://wallet.testnet.near.org if you don't have one
   near login   # opens browser to authorize
   export ID=bouncer.YOURNAME.testnet
   near create-account $ID --masterAccount YOURNAME.testnet --initialBalance 5
   near deploy $ID --wasmFile bouncer.wasm --initFunction new --initArgs '{"owner":"YOURNAME.testnet"}'
   ```

## Option B: Local (laptop with near-cli)
```bash
# Install near-cli once
npm install -g near-cli
near login

# Clone + deploy
git clone -b arena/3419a30c-near-hub https://github.com/abdullahimujeeb0505-stack/Bouncer.git
cd Bouncer
near create-account bouncer.YOURNAME.testnet --masterAccount YOURNAME.testnet --initialBalance 5
near deploy bouncer.YOURNAME.testnet --wasmFile bouncer.wasm \
  --initFunction new --initArgs '{"owner":"YOURNAME.testnet"}'
```

## After deploy — demo script (show the three headline claims)

1. **Set a policy (requires 1 yoctoNEAR; works from full-access key):**
   ```bash
   near call $ID set_policy \
     '{"policy_id":"usdc-agent","token":"usdc.fakes.testnet","per_tx_cap":"5000000"}' \
     --accountId YOURNAME.testnet --depositYocto 1
   ```

2. **Register the vault with the fake USDC token and fund it:**
   ```bash
   near call usdc.fakes.testnet storage_deposit '' --accountId $ID --deposit 0.00125
   near call usdc.fakes.testnet ft_transfer_call \
     '{"receiver_id":"'$ID'","amount":"100000000","msg":"fund"}' \
     --accountId YOURNAME.testnet --depositYocto 1 --gas 100000000000000
   near view $ID vault_balance '{"token":"usdc.fakes.testnet"}'
   ```

3. **Allow a payee, execute a payment within cap (success), execute over cap (rejected), and try to escalate from an agent key without 1 yocto (rejected at protocol level):**
   ```bash
   near call $ID allow_payee '{"policy_id":"usdc-agent","payee":"vendor.testnet"}' \
     --accountId YOURNAME.testnet --depositYocto 1

   # Within cap — succeeds
   near call $ID execute \
     '{"policy_id":"usdc-agent","payee":"vendor.testnet","amount":"3000000","memo":"thanks"}' \
     --accountId YOURNAME.testnet --depositYocto 1 --gas 100000000000000

   # Over cap — panics with "amount out of per-tx range"
   near call $ID execute \
     '{"policy_id":"usdc-agent","payee":"vendor.testnet","amount":"10000000","memo":"too much"}' \
     --accountId YOURNAME.testnet --depositYocto 1 --gas 100000000000000
   ```

4. **Show the 1-yocto key-escalation proof:**
   Create a function-call key restricted to `execute,check,file_invoice`, then try to call `set_policy` from that key without deposit — NEAR rejects with `DepositWithFunctionCall` BEFORE any contract code runs. That is the structural guarantee.
   ```bash
   near add-key $ID <agent-pub-key> --contract-id $ID \
     --method-names execute,check,vault_balance \
     --allowance 1
   ```

## For the 90s demo video
Show (in order, ~10s each):
1. Terminal: `near view $ID vault_balance` → shows 100 USDC in vault.
2. Terminal: execute within cap → explorer link shows success tx.
3. Terminal: execute over cap → red "Rejected" / panic message.
4. Terminal: set_policy from a function-call key → protocol error DepositWithFunctionCall.
5. Cut to dashboard HTML showing policy card, Allow/Reject/Blocked columns.
6. Close: "This is Bouncer — the on-chain comptroller for AI agents. Every agent needs one."
