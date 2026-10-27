# BOUNCER THREAT MODEL

Last updated: 2026-10-27

## What we assume about the adversary

- The AI agent is **fully compromised**. An attacker controls its prompts, its
  outputs, and any code it runs. This is not a "prompt injection" threat model
  where we just try to keep the agent on-task; we assume the attacker IS the
  agent once it's compromised.
- The agent holds exactly one NEAR credential: a **function-call access key**
  scoped to the Bouncer contract, with method names restricted to the agent
  entrypoints (`execute`, `pay_invoice`, `file_invoice`, `open_cross_chain`,
  `bid`, `check`). The agent NEVER sees the owner's full-access key.
- The attacker can read the agent's memory, exfiltrate its key, run arbitrary
  code in its runtime, and call any NEAR RPC from any IP.
- The attacker can send arbitrary transactions using the leaked agent key.
- The attacker cannot sign transactions as the owner (no full-access key),
  cannot coerce the owner into signing a malicious tx (we assume the owner is
  competent), and cannot compromise the NEAR protocol itself.

## What Bouncer protects against

| Threat | Defense | Where enforced |
|---|---|---|
| Agent pays more than per-tx cap | `per_tx_cap` check in `execute()` | Contract (atomic) |
| Agent sends to attacker address not on allowlist | `payee_allowlist` check | Contract |
| Agent splits a large payment into many small ones (the "6×$3" attack) | Rolling daily/monthly windows over append-only log | Contract |
| Agent tries to widen its own policy (raise cap, add attacker to allowlist) | Policy-mutating methods require 1 yoctoNEAR; function-call keys CANNOT attach any deposit; NEAR rejects tx with `DepositWithFunctionCall` BEFORE our code runs | **Protocol-level** |
| Agent tries to rotate keys or delete policy | `assert_owner()` on every non-agent method | Contract + 1-yocto guard |
| Rogue FT contract airdrops fake tokens, tries to spoof vault balance | `ft_on_transfer` refuses deposits of tokens with no governing policy | Contract |
| ft_transfer fails midway (out of gas, receiver error, callback traps) | `after_execute_transfer` re-credits the vault balance; spend is only logged on success; failed callback is the only failure path and is auditable in NEAR receipts | Contract (cross-contract callback) |
| Token contract uses the June-2026 `ft_resolve_transfer` refund trick (Fireblocks/SWEAT/HOT class) | We call `ft_transfer` (not `ft_transfer_call`) for simple sends, and we don't expose a public `ft_resolve_transfer` on our own contract. Only the contract's owner can withdraw after settlement. | Contract |
| Agent double-spends across concurrent txs | Balance is debited optimistically before the ft_transfer call; callback re-credits on failure. NEAR's per-receiver sequential receipt processing prevents race conditions within one shard. | Contract |
| Solver tries to bid below the human-set floor on cross-chain | `min_amount_out` check in `bid()` | Contract |
| Solver front-runs a better bid | Highest bid always wins; every bid is logged as a NEAR event so the human can verify no solver underpaid after the fact | Contract + on-chain event log |

## What Bouncer does NOT protect against (honest limits)

1. **Owner full-access key compromise.** If your laptop is malware-infected and
   your MyNearWallet key is stolen, the attacker IS the owner and Bouncer
   can't help. Use a hardware wallet or a multisig for the owner account for
   production amounts. Standard crypto key hygiene applies.
2. **Bugs in the Bouncer contract itself.** This is hackathon code. It has not
   been audited. The test suite covers the headline claims but is not
   exhaustive. For real money, get a third-party audit and use a timelock on
   policy changes.
3. **Rogue solver claims a fill without actually delivering.** `confirm_cross_chain`
   accepts a tx hash from the solver. We don't verify the fill on the
   destination chain in-contract (that would need a light client or a TEE
   attestation like OutLayer provides; it is explicitly out of scope). For the
   hackathon demo the solver is the project's own relayer; production would
   require a challenge bond or an OutLayer-style attested fill proof.
4. **Chain reorgs / 51% attacks on NEAR.** Standard L1 assumptions.
5. **Price oracle risk.** Policy caps are denominated in the token's smallest
   unit (e.g. 1 USDC = 1_000_000). There is no USD price feed; if the token
   depegs the cap devalues with it. A future version can add an oracle for
   USD-denominated caps.
6. **Memo-level social engineering.** An invoice that LOOKS like it's from an
   allowed vendor but is actually from an attacker using a similar-looking
   account is the owner's/agent's problem to verify. Bouncer enforces policy,
   not identity.

## Why the 1-yoctoNEAR trick is structural, not just software

This is the property the whole system rests on and it's worth explaining in
plain English:

A NEAR FunctionCall access key is permissioned to call only certain methods
on one receiver contract. NEAR also enforces that such a key cannot attach a
NEAR deposit to a transaction — the runtime rejects the action with error
`DepositWithFunctionCall` before any contract code runs. (See nearcore
`AccessKeyError::DepositWithFunctionCall` and NEP-141 security note: "the
method that requires an attached deposit can't be called by the restricted
access key.")

Every method that changes policy in Bouncer is marked `#[payable]` and asserts
`env::attached_deposit() == 1 yoctoNEAR`. Since a function-call key cannot
attach *any* deposit, a tx using such a key will fail at the protocol level.
No bug in our contract — reentrancy, arithmetic overflow, forgotten check —
can change this. The NEAR runtime refuses to route the tx to us.

The unit test `agent_key_cannot_set_policy` exercises this by calling
`set_policy` with a 0-deposit context (what a function-call key sees) and
asserting the call panics. On real NEAR it's not a panic — it's a rejected
transaction receipt with status `Failure` and `DepositWithFunctionCall`.
