# Bouncer prototype threat model

This describes the current contract in `contracts/bouncer/src/lib.rs`, not the
planned agent/solver architecture. It has not been audited and must not hold
valuable funds.

## Implemented checks

- Policy changes, allowlist changes and withdrawals require the configured
  owner's predecessor account and exactly 1 yoctoNEAR.
- `execute` checks the policy's per-transaction cap, optional fixed 24-hour
  bucket limit, payee allowlist when nonempty, and recorded token balance.
- `execute` debits the recorded balance before sending a token transfer. A
  private callback attempts to restore the recorded balance and daily spend if
  that transfer fails; a successful transaction status alone does not prove the
  downstream transfer succeeded, so the demo inspects receipts and balances.
- A function-call access key cannot attach a NEAR deposit. However, **the current
  demo has not verified this with a real restricted key**: it calls the setter
  without a deposit using the full-access owner key and observes the contract's
  own rejection.

## Critical gaps

1. **Spender is unauthenticated.** Anyone able to attach 1 yoctoNEAR can call
   `execute` and trigger transfers that pass the selected policy. Limits and
   payee restrictions are not caller authorization.
2. **Agent key cannot pay.** `execute` itself requires 1 yoctoNEAR, which a
   function-call access key cannot attach. The restricted-key agent described
   in earlier plans has not been implemented or demonstrated.
3. **An empty allowlist is unrestricted.** Revoking the final payee opens the
   policy to all payees, rather than blocking all payments.
4. **Callback recovery is not guaranteed.** If the callback itself fails, the
   recorded balance may remain debited. A failed transfer crossing a 24-hour
   boundary may also refund spending against the callback's bucket rather than
   the original payment's bucket. Recovery and boundary behavior need tests and
   fixes.
5. **Token trust is not enforced.** `ft_on_transfer` records a balance for its
   predecessor without checking an owner-approved token registry. Policies
   should be configured only for trusted token contracts.
6. **No per-key/per-agent isolation.** Multiple policies are not bound to
   individual agent keys. A future agent authorization design must enforce
   scope, not rely on off-chain prompts or key names.
7. **No complete invoices, on-chain fill verification or live Intents
   settlement.** The old agent/solver examples and their placeholder quotes
   or hashes do not demonstrate a completed settlement.

The owner key, NEAR protocol, token implementation, callback availability and
software correctness are additional trust assumptions. Caps are in token units,
not USD; there is no price oracle. The JavaScript tests are offline simulations
and do not substitute for contract tests, an audit, or an adversarial testnet
run.

## Next security work

Authenticate spenders, support a zero-deposit `execute` for a narrowly scoped
function-call key, make allowlists fail closed, associate policies with the
right agents, and test the guard using a real restricted key. Exercise failed
transfers and bucket-boundary callbacks before describing refunds as reliable.
