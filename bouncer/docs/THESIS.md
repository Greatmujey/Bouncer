# BOUNCER — the enforcement layer for AI money

> **Historical planning document:** This describes the intended product, not verified functionality. See the [current status](../../README.md) and [threat model](THREAT_MODEL.md). Record only after the complete intended flow is verified.

**NEAR HACKATHON: Build Beyond Boundaries — submission target**
Tracks: `security` (AI Security & Defense) + `agents` (Agent Economy) + `realworld` (Real-World Money)

---

## The one-sentence pitch

> Bouncer aims to let an agent buy resources using a restricted key while a NEAR contract enforces owner-configured spending limits. This is a testnet prototype, not an unbreakable or audited wallet.

---

## The finding this is built on

An agent needs to move money, but a NEAR function-call key's `allowance` is a
**gas** budget, not an application-level token-spending limit. The key can call
only its allowed receiver and methods with zero attached NEAR.

**Correction to the original thesis:** standard
[NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) requires
exactly one yoctoNEAR for `ft_transfer` and `ft_transfer_call`. A function-call
key therefore cannot directly call either standard method successfully. A
zero-deposit method on the receiver can nevertheless move assets controlled by
that receiver, depending on its code. A gas allowance does not constrain the
value of those operations; the receiver must enforce appropriate policy.

Bouncer uses the one-yocto guard, alongside owner-predecessor authorization,
to stop a function-call key from *directly* widening policy. The contract
checks the predecessor and deposit, not whether a human approved. A direct
transaction needs a deposit-capable key, which may be automated or compromised;
an owner contract could also forward a call with its own deposit. Its forwarding
logic must therefore be trusted. See the [current threat model](THREAT_MODEL.md).

---

## How it works

```
    OWNER SIGNER                      AGENT                      CHAIN
          |                              |                          |
   1. deposit USDC -------->  vault (contract) ------------------> custody
   2. set policy:             |
      per-tx cap, daily cap, |
      per-period cap,        |
      allowlist of payees,   |
      allowlist of methods   |
          |                  |
          |           3. agent holds a key scoped to
          |              vault.execute()  <-- the ONLY method it can call
          |                  |
          |           4. agent calls execute(payee, amount, memo)
          |                  |
          |                  +---> contract checks every rule, atomically
          |                        refuses > cap, unknown payee, over-budget
          |                  +---> emits a receipt (the audit trail is the chain)
          |
   5. owner widens/rotates policy with exactly 1 yoctoNEAR
      (a function-call key cannot attach it to a direct transaction)
```

**Intended security property:** a properly scoped agent key is checked by the
contract against owner-configured limits. A call over its budget should fail.
This depends on the deployed code, key configuration, token behavior and
trusted owner signer. The prototype has not been independently audited; do not
assume that a deployment is immutable or that every failure mode is covered.

### The second half: agents compete for the spend

A cap alone is a wall. The original proposal imagined a **market** as well.
The following solver-auction scenario is a future idea, **not an implemented or
verified Bouncer feature**:

- The human posts an **intent**: "swap up to 20 USDC to wNEAR, floor 1.714 wNEAR, deadline 30 min."
- Multiple **solver agents** bid. Each must submit a signed quote.
- The vault accepts the **best bid** and executes it — and the human can prove afterwards that no solver could have paid more, because every losing bid is logged on-chain.
- Every bid is bound by the same `security` checks: a solver cannot bid above the intent budget, cannot pay itself, cannot exceed the daily cap.

This is the NEAR Intents thesis (let solvers compete instead of trusting one router) applied to the **policy** layer rather than just the pricing layer — and the `realworld` pitch is immediate: a company onboards an AI procurement agent, sets a ₦-equivalent monthly budget and a supplier allowlist, and can hand an auditor a complete, tamper-proof spend ledger.

---

## Why this wins (honest read)

| Criterion | Our position |
|---|---|
| **Genuinely on-chain** | The rules are enforced in a Rust contract. Not a wrapper, not a prompt. Judges can read the test that proves a bypass fails. |
| **Concrete security boundary** | A restricted key and an owner-controlled contract limit different things; their combination can enforce caps under the documented assumptions. |
| **Demonstrable behavior** | Historical testnet checks include allowed and rejected calls. Record a submission demo only after the intended multi-resource path works end to end. |
| **Integrations** | Consult the [current status](../../README.md) for the actual historical testnet evidence and the remaining independent-FT-delivery gap. |
| **Track fit** | Security and agent economy are the strongest current fit. Any additional track must be supported by completed evidence and selected by the entrant. |

### Risk: someone shipped this already

Related projects may provide off-chain or on-chain guardrails; no competitor
comparison or prize outcome has been established. A guard that runs only in
agent-side code is not an on-chain restriction on a stolen key. Bouncer's
specific claim is that its documented, correctly configured vault checks run in
the contract; this should be evaluated against its threat model and evidence.

---

## Build plan (Nov 1–14, solo, ~40 h/wk)

| Days | Milestone | State at end |
|---|---|---|
| 1–2 | Contract skeleton + `execute` + policy struct + unit tests | Rules enforced, bypass tests green |
| 3–4 | Deploy to testnet, agent key scoping, scripted agent | Live on testnet, agent spends under budget |
| 5–6 | Intent + sealed bid/auction for solvers | Two solvers compete; best bid wins |
| 7 | 1Click integration: intent → live cross-chain quote | Real quote in UI/CLI |
| 8–9 | Web dashboard: policy editor, spend ledger, audit view | Human-usable |
| 10 | Demo video (90s), README written for a machine reader | Submission-ready |
| 11–14 | Buffer: hardening, over-cap exploit tests, polish | Margin for things going wrong |

**Definition of done:** a public repo, a live testnet contract, a 90s video showing an over-cap spend **failing on-chain**, and a README a judge can follow as "do X, see Y".

---

## Honest open questions

1. **NEAR testnet tooling.** Availability depends on the environment; current CI builds and tests the contract without deploying V11. See the [README](../../README.md) for reproducible commands and the current status.
2. **Payout account.** Submission requires an entrant-controlled NEAR mainnet account ID; an ID does not require sharing its private key. Verify the current rules before submitting.
3. **Scope and tracks.** One submission may select multiple tracks, but each selected track needs a convincing, truthful explanation of implemented work. Selection remains with the entrant.
