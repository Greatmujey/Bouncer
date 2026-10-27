# BOUNCER — the enforcement layer for AI money

> **Planning document:** This describes the intended product, not verified current functionality. See the [current status](../../README.md) and [threat model](THREAT_MODEL.md).

**NEAR HACKATHON: Build Beyond Boundaries — submission target**
Tracks: `security` (AI Security & Defense) + `agents` (Agent Economy) + `realworld` (Real-World Money)

---

## The one-sentence pitch

> Every "secure AI agent wallet" today is a prompt and a promise. Bouncer is the contract that makes the promise unbreakable: **the agent holds a key that can only call one method, and that method can only move money the human already signed off on.**

---

## The finding this is built on

An agent needs to move money. On NEAR the natural advice is "give it a scoped function-call key with a spending allowance." **That does not work.** From the NEAR protocol itself:

1. A **function-call access key's `allowance` is a *gas* budget**, not a spending limit. Nearcore's `AccessKeyPermission` docs: *"Allowance is a balance limit to use by this access key to pay for function call gas and transaction fees."*
2. **Function-call keys cannot attach a deposit at all.** Any `FunctionCall` with attached NEAR fails. So the key can't move NEAR directly.
3. But it *can* call `ft_transfer` on a token contract. Gas on NEAR is ~free (a 1000 TGas call is ≤ 0.1 N). So a 0.25 N "allowance" key can `ft_transfer` **your entire USDC balance**, one call after another, and it renews nothing — it just never runs out, because it's never the thing being spent.
4. The `allowance` is also **immutable**: you cannot lower it on an existing key. You must delete and recreate.

**Conclusion: NEAR has no native per-agent spending limit. Anyone claiming otherwise is confusing gas allowance with value allowance.** The limit has to live in a contract that the agent cannot route around. That is the entire product.

(There *is* one native primitive worth using as defense-in-depth: requiring `1 yoctoNEAR` on a method makes it unreachable by function-call keys — `DepositWithFunctionCall`. Bouncer uses this so only a **human full-access signature** can widen a policy.)

---

## How it works

```
        HUMAN                          AGENT                      CHAIN
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
   5. human widens/rotates policy only with a full-access signature
      (1 yoctoNEAR guard = function-call keys are structurally locked out)
```

**The security property:** the agent is not trusted. The key is not trusted. The *contract* is the authority, and the contract is public, immutable and auditable. An agent that asks for more than its budget gets a failed transaction, not a drained vault.

### The second half: agents compete for the spend

A cap alone is a wall. Bouncer makes the wall a **market**:

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
| **Exploits a real, documented gap** | Every competitor in `security` will build "guardrails" in TypeScript around a full-access key. That is theater. We built the thing that makes it unnecessary. |
| **Demo-able in 90s** | Human sets $20/day. Agent tries $25 → **rejected on-chain**. Agent tries allowed payee $20 → **settles**. Agent tries new payee → **rejected**. Screen record it. |
| **Two real integrations** | NEAR function-call keys (the vuln) + NEAR Intents 1Click API (verified live: 208 assets, 25+ chains, real quotes returning `minAmountOut` in ~20s). |
| **Multi-track eligible** | `security` + `agents` + `realworld` — one submission, three shots at a prize. |

### Risk: someone shipped this already

There is a repo (`near-agent-guard`) describing a **TypeScript** "deterministic policy guard" for exactly this track. That is good news, not bad: it confirms the gap is real, and it is the weaker version of the same idea. A TypeScript guard runs *beside* the key and can be bypassed by anyone who gets the key. Bouncer's rules are **in the contract the key can only call.** We win by making that distinction the headline and by having a passing test that the TS approach cannot pass.

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

1. **NEAR testnet tooling.** This sandbox has no Rust/wasm target and no `cargo-near`, so the contract has to be compiled and deployed from **your machine**. Everything else (policy SDK, agent, 1Click client, dashboard, tests that don't need wasm) I can build and run here now.
2. **Prize payout needs a mainnet NEAR account** — e.g. `team.near`. Do not create it for the submission; you need to own the key.
3. **Scope.** `security` alone is a strong entry. Adding `agents` and `realworld` costs almost nothing because it's the same contract, but each track wants a different README emphasis. We write one README with three clearly-labelled sections.
