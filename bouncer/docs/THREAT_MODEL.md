# Bouncer prototype threat model

This describes the contract source in this branch, not older deployed versions.
It has not been audited and must not hold valuable funds.

## Intended controls in the current source

- `execute` accepts zero deposit and checks both predecessor and transaction
  signer are the owner account. Its signer public key must be explicitly granted
  to the selected policy. The signed request also names its expected token;
  the contract rejects it if the policy's token differs. The owner should create
  a separate NEAR function-call key scoped only to the contract's `execute`.
- The owner and exactly 1 yoctoNEAR are required to change policies, grant or
  revoke agent keys, change payees, and withdraw. Function-call keys cannot
  attach deposits under the NEAR protocol. Grants are contract-level state;
  they do not create or limit a protocol access key.
- Per-transaction caps, a conservative rolling daily budget, the token vault
  balance, and a fail-closed payee allowlist are checked atomically before a
  debit. The current hour plus 24 prior hourly buckets prevent early expiry;
  some spend remains counted for up to one hour beyond 24 hours.
- The contract pays the token transfer's required 1 yoctoNEAR itself. A private
  callback attempts to restore the vault and the **original** hourly bucket if
  the token transfer fails. The demo inspects receipts and exact token balances
  rather than trusting a successful callback status alone.

The updated testnet check is intended to prove a restricted-key payment and
both the contract and protocol sides of the escalation guard. Confirm its live
Actions or Codespaces result before treating those behaviors as verified.

## Remaining risks

1. **No audit or guaranteed callback recovery.** If the callback itself fails,
   the recorded balance may remain debited even if a transfer failed. The native
   test for a failed transfer and hour-boundary refund is not an adversarial
   test of all live cross-contract failures.
2. **Token trust is not enforced.** `ft_on_transfer` accepts its predecessor as
   a token without an owner-approved registry. Malicious or non-standard FT
   contracts can lie or consume storage. Use trusted FTs only.
3. **Owner full-access key compromise.** A stolen owner key can change policy,
   grant another key, or withdraw. Use a separate secure owner in any future
   real deployment; this testnet script makes the contract account its owner.
4. **Protocol access key must be scoped correctly.** Granting a key in the
   contract does not constrain a full-access key or install an access key.
   Grant only an execute-only function-call key and revoke both the contract
   grant and NEAR access key when removing an agent.
5. **Views are policy previews, not authorization checks.** `check` and
   `try_execute` do not identify a transaction signing key and cannot guarantee
   that a later signed call will be authorized or still within budget.
6. **Policies and tokens are shared.** Policy-specific key grants isolate which
   policy a key may use, but policies may share the same token vault. Caps are
   denominated in token units, not USD; there is no price oracle. Rebinding a
   policy to another token retains numeric spend history in the old units. Use
   a new policy for each token rather than changing an existing policy's token.
7. **Development-only provider and no cross-chain settlement.** The agent can
   fetch fixed quotes and pay pinned test vendors; the local provider performs
   SHA-256 work, local-file storage and text statistics. It is not an independent
   commercial provider or AI marketplace. The multi-token test uses synthetic
   testnet FTs, not USDC. The old solver is disabled because it previously used
   fake fill hashes; the standalone quote comparator does not settle anything.
8. **Local journal is not exactly-once settlement.** It blocks automatic retries
   of uncertain payments in one local journal, but a different or deleted
   journal, multiple hosts, or power loss can bypass that protection. Operators
   must reconcile pending transactions manually.
9. **Provider verification and operations are not trustless.** The provider
   trusts its configured RPC, Bouncer deployment/code and token contracts. It
   verifies transaction arguments and receipts, but cannot protect against a
   compromised or upgraded trusted contract, malicious RPC or token. Its state
   and lock are single-process, storage is plaintext and publicly retrievable,
   and there is no authentication, transport security or multi-host replay
   protection. Orders are sent to the provider; their hashes are on chain.
10. **Prior contracts are unsafe to upgrade without migration.** Older contracts
   have different state and authorization; v3 and v4 also interpret budget bucket
   keys differently. Deploy v4 fresh. Hourly spend buckets are not pruned and
   incur ongoing state/storage costs; the 25 reads per check also consume gas.

The owner key, NEAR protocol, token implementation, callback availability and
software correctness are trust assumptions. Offline JavaScript mocks are not
live blockchain proof; native unit tests and a live smoke test are useful but
are not a substitute for a security review.
