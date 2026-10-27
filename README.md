# Bouncer — payments firewall for autonomous agents on NEAR

Bouncer aims to let an AI agent buy several resources — such as compute,
storage, and API credits — using different NEAR fungible tokens, subject to
owner-defined spending policies. The current prototype implements the vault and
policy checks; the multi-resource agent and restricted-key flow are **still in
progress**. It is unaudited testnet software, not suitable for real funds.

## What works in the current contract

- Accepts NEP-141 token deposits through `ft_transfer_call`.
- Stores a token, per-transaction cap, optional fixed 24-hour bucket cap, and
  payee allowlist for each policy.
- Debits the vault before calling the token's `ft_transfer`, with a callback
  intended to restore the balance and daily spend if the transfer fails.
- Requires both the owner account and exactly 1 yoctoNEAR for policy changes,
  allowlist changes and withdrawals.

The 1-yocto guard is significant because NEAR function-call keys cannot attach
a deposit. The demo tests the **contract's zero-deposit rejection** using the
owner's full-access key; it does **not yet** demonstrate a restricted key or a
protocol-level `DepositWithFunctionCall` rejection.

### Important prototype limitations

- `execute` currently requires 1 yoctoNEAR, so a restricted function-call key
  cannot use it. The demo pays with the owner's full-access key. The agent
  runtime and key authorization must be completed before the autonomous-agent
  claim is demonstrated.
- `execute` does not currently authenticate the caller. Anyone able to attach
  1 yoctoNEAR can attempt payments allowed by the policy; limits and payees
  constrain them, but this is not an authorization mechanism.
- An empty allowlist permits any payee. Revoking the last allowlisted payee
  therefore opens the policy to all payees. Set an allowlist and do not use
  the current contract for valuable funds.
- The one-command check below uses only **wNEAR**, one policy, and one vendor.
  Although policy records can reference different NEP-141 tokens, distinct
  tokens and resource purchases have not yet been demonstrated end to end.
- Receipt logs, invoices, stablecoin flows, NEAR Intents settlement, and the
  old example agent/solver scripts are not complete integrations with the
  current contract. The JavaScript policy simulation is not an on-chain test.

## Run the wNEAR testnet check

Requires Node.js 22, npm, network access to NEAR testnet and its account helper,
and the `bouncer.wasm` included in the repository. No wallet or external faucet
website is needed. Each run creates and funds a **new testnet** account; keys
are saved in `~/.near-credentials/testnet/` (keep these files private), and the
latest contract ID is written to `~/.bouncer_id`.

In a Codespaces terminal:

```sh
cd /workspaces/Bouncer
git pull --ff-only
npm install --prefix bouncer
node bouncer/demo-all.mjs
```

The script creates a contract, a depositor and a vendor, wraps 2 NEAR into
wNEAR, funds the vault with 1.5 wNEAR, and tries one allowed payment plus
several disallowed operations. It checks the reasons for each expected rejection,
examines transaction receipts, and verifies exact on-chain balances:

```
user:   0.5 wNEAR
vendor: 0.1 wNEAR
vault:  1.4 wNEAR (matches token contract)
✅ All checks passed. This run uses one token and an owner key.
```

Every successful operation prints a transaction link. The script exits with a
nonzero status on unexpected rejection, unexpected success, failed downstream
receipt, or a balance mismatch. Testnet RPC/helper outages or faucet limits can
also stop a run; their errors are printed rather than hidden. The daily cap uses
UTC-aligned buckets, so a run crossing a bucket boundary can invalidate that
particular test.

GitHub Actions also has an opt-in testnet smoke job, triggered manually or by a
push whose commit message contains `[testnet-smoke]`. It creates real testnet
accounts with ephemeral keys on the runner; it does not upload those keys.
Ordinary CI runs do not create testnet accounts.

## Local tests

```sh
npm install --prefix bouncer
npm test --prefix bouncer
```

The policy simulation has unit tests. Separate offline demo tests use a mocked
NEAR transport to check gas units, logging, rejection handling and balance
verification; they do **not** prove live blockchain behavior. The manual
Actions job or the Codespaces command above performs the real testnet check.

## Main files

- `bouncer/contracts/bouncer/src/lib.rs` — current vault and policy contract.
- `bouncer/demo-all.mjs` — fresh-deployment, single-token testnet check.
- `bouncer/tests/` — offline regression tests for the demo script.
- `bouncer/packages/policy/` — independent JavaScript policy simulation.
- `.github/workflows/ci.yml` — JavaScript tests, contract build, and optional
  manual live testnet smoke job.

The original contract at [`bouncer-2dcd4e.testnet`](https://testnet.nearblocks.io/address/bouncer-2dcd4e.testnet?tab=receipts)
uses an older state layout; do not upgrade it to the current contract without
an explicit state migration. The demo deploys a fresh contract instead.

## Roadmap

1. Make `execute` usable by a properly scoped function-call key, authenticate
   spenders, and prove the 1-yocto protection using real restricted keys.
2. Demonstrate multiple resource purchases with distinct NEP-141 tokens and
   vendor accounts, then connect a working procurement agent.
3. Add verifiable receipts/invoices and real, explicitly verified NEAR Intents
   settlement. Add per-agent policies and stronger failure/recovery tests.
4. Record the submission demo only after the complete flow works end to end.

MIT license.
