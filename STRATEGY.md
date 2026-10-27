# BOUNCER — DEEP COMPETITIVE ANALYSIS & WIN STRATEGY

> Historical planning notes, not verified current product status. See the [README](README.md). Do not record until the complete intended flow is verified, and do not use fake transactions as proof.
**Date: 26 Oct 2026 · 6 days to hackathon start · Solo builder, Nigeria**

---

## TL;DR — THE BRUTAL TRUTH

1. **Bouncer's core thesis is correct and validated.** The function-call-key `allowance` caps gas, not value — that's a real bug no one has fixed at the protocol level, and every judge who understands NEAR (especially Illia) will recognize it immediately.
2. **We are NOT alone in this track.** I have found **six** repos already building "policy-enforced agent spending on NEAR" for this exact hackathon. One of them (**Spact**) is at 32 commits with 51 Rust tests, a Railway-deployed website, THREAT_MODEL doc, CI/CD, and a Security Lab audit report. That is the team to beat.
3. **Mandate** has a live Vercel demo, a 78-second video, and a "travel agent" narrative that normie judges will love. Their weakness: enforcement is in a Node server, not on-chain. If the server is compromised, the policy dies.
4. **OutLayer** is a listed ecosystem partner (so they're not a competing submission), but every judge will mentally compare us to them. They are the TEE/hardware approach; we are the on-chain approach. Our wedge: *"OutLayer proves code ran correctly. Bouncer proves money moved correctly — and the proof is public, forever, without trusting Intel or Phala."*
5. **Grand prize ($55K) is winnable but only if we do one thing none of the others are doing: turn the "vault" into a primitive the rest of the agent economy composes with**, instead of a standalone guardrail. The vault + intent auction does exactly that. If we ship only a guardrail, we get 1st in Security ($10K). If we ship a composable primitive, we are in the running for grand prize.

---

## THE COMPETITION — EVERY REPO I FOUND

### Tier 1 threats (will fight us for 1st in Security)

#### ⚔️ Spact — `github.com/0xileri/Spact`
- **What:** "Payment-policy firewall for AI agents on NEAR." Near-identical pitch to Bouncer.
- **Maturity:** 32 commits, monorepo (Rust contract + TS web + MCP server + CI). Uses near-sdk 5.29.1. **51 Rust tests, 57 TS tests, 7 e2e tests, 11 MCP sandbox tests, 10 deploy-rehearsal tests.** Website deployed live on Railway with proper security headers (HSTS, CSP, etc.).
- **Architecture:** NEAR vault contract + owner approval flow + NEP-141 ft_transfer. Uses the same **1-yoctoNEAR guard** we use so function-call keys can't change policy. Has a request-hash domain separation, NEP-297 events, transfer memos `spact:<request_id>`.
- **Marketing:** Calls their test output a "Security Lab" report — smart, judges love that. Has a THREAT_MODEL doc, ADRs, AGENTS.md.
- **Weaknesses (our openings):**
  - README says **"Local sandbox only so far. Do not use with real funds."** No testnet deployment I can see. If we ship a **real testnet deployment with real ft_transfer refusals on-chain** while they stay local, we win on "it actually works."
  - No cross-chain / NEAR Intents / 1Click integration. Payments are NEP-141 on NEAR only.
  - No multi-agent solver auction. It's a single-signer vault. **Bouncer's `open_intent` / `bid` mechanism is unique in this field.**
  - No agent SDK / MCP server? Wait — they DO have an MCP server (`@spact/mcp`). That's a real strength; agents can call it as a tool.
- **What to copy from them:** The THREAT_MODEL doc, the ADRs, the "Security Lab" framing of test output, the live deployed demo site with real HTTPS + proper headers.

#### ⚔️ Mandate — `github.com/arults/Mandate`
- **What:** "Policy-protected agent wallet. The agent can ask to pay. It cannot sign."
- **Maturity:** 37 commits, live Vercel site (`mandate-ashy.vercel.app`), 78-second demo video embedded, litepaper at `/docs`, AGENT.md for AI agent integration.
- **Architecture:** TypeScript policy gate in a Node server. PGLite for persistence. **Does 1-Click dry quotes** (reads quotes but never broadcasts). Optionally dry-runs OutLayer withdraw. Enforcement is in server memory/process — **NOT on-chain.**
- **Narrative:** A "travel agent" booking demo that buys things across chains. Relatable, great for the 90-second video.
- **Weaknesses (our openings):**
  - **The fatal flaw:** "This preview keeps the mandate in process memory. A restart forgets the policy." Policy is enforced by a Node server, which means: (a) whoever controls the server bypasses it, (b) there's no public audit trail, (c) there's no cryptographic proof the policy was actually followed. This is exactly the `near-agent-guard` architecture we called out in the handoff — a guard *beside* the key. They are honest about it ("preview gate, not a TEE"), but it means Bouncer's on-chain enforcement is categorically stronger.
  - **Never actually moves money.** `settlement.submitted` stays false. The demo shows quotes and approvals, no real tx.
  - No Rust contract, no on-chain anything.
- **What to copy from them:** The narrative (a concrete agent scenario — not just "here's my API"), the embedded demo video on the homepage, the clean "do X → see Y" judge path, the litepaper, the AGENT.md for AI tool use.

### Tier 2 threats (won't win 1st, could place 2nd/3rd)

#### near-agent-guard — `github.com/hahahahahahahahah6/near-agent-guard`
- Offline/CLI prototype only. Explicitly: "This project does NOT provide TEE attestation, Chain Signatures MPC signing, 1-Click Swap execution, mainnet or testnet broadcast, or movement of real funds." Policy engine is in JS. Functionally an earlier, less polished version of Bouncer's policy.mjs. **Beatable.**

#### AgentSentinel — `github.com/Daveboycyber/agent-sentinel`
- Reactive watcher/anomaly detector. 6 commits, "Day 1 setup in progress." Watches transactions AFTER they happen, tries to freeze after detection. That's fundamentally weaker than Bouncer (which refuses BEFORE the transfer). **Beatable.**

### Adjacent (not same track but mindshare competition)

#### nearbooks — `github.com/IhorMuliar/nearbooks`
- OutLayer TEE oracle for NEAR Intents revenue numbers. Uses TDX attestation. Adjacent to thesis/privacy tracks. Not in our lane but signals OutLayer-centric builds are getting attention.

#### ayushsingh82/sdk — agentic treasury
- OutLayer-reliant DAO treasury. "Output-asset enforcement is local; strict cumulative per-asset enforcement and USD-budget atomicity remain unproven." Half-baked, OutLayer-dependent.

---

## THE JUDGES — WHAT EACH ONE ACTUALLY CARES ABOUT

Don't optimize for an abstract "rubric." Optimize for these seven humans plus two AIs:

| Judge | Day job | What they reward | What they punish |
|---|---|---|---|
| **Illia Polosukhin** | NEAR co-founder, co-authored Transformer, built IronClaw | **Security-by-architecture**, agent primitives, verifiability, privacy, TEEs, NEAR-native primitives (function-call keys used correctly). His pinned repo is IronClaw — a Rust agent OS with WASM sandboxing, credential vaults, allowlisting. He literally wrote "Keep your friends close and your robots closer" and "Payments Rule Everything Around Me." | Solutions where the guardrail is *beside* the agent instead of in the transaction path. Demo theatre. Broken access-key reasoning. |
| **Mert Mumtaz** | CEO Helius; newly on NEAR Foundation Council; Zcash/Solana privacy & liquidity advocate | Cross-chain **connected liquidity** (NEAR Intents, Chain Signatures), privacy, production readiness, candor. "Crypto succeeds only if liquidity isn't gatekept by CEXes." He was an early NEAR Intents adopter. | Single-chain toy projects. Anything that requires a CEX or custodian. |
| **Eddy Lazzarin** | CTO a16z crypto | Technical originality, leverage (small primitive → big surface area), ambition. He funds what looks like the next 10 years of infra. | Me-too projects. Demos that add a UI on top of someone else's primitive. |
| **Avichal Garg** | Managing Partner Electric Capital | Sustainability, team, traction, "is this a company?" Likes products with revenue paths. | Pure infra with no user story. |
| **Kain Warwick** | Founder Synthetix/Infinex | DeFi mechanics, novel primitives, things that could become markets. Founded Synthetix (synthetic assets) and Infinex (perps). | Boring wallets. Static guardrails with no market/mechanics. |
| **Haseeb Qureshi** | Managing Partner Dragonfly; ex-engineer, wrote about smart contract security | Security craftsmanship, code quality, threat models, clarity of thinking. | Hand-wavy security claims, unacknowledged attack surfaces. |
| **Stepan Gershuni** | cyber•Fund; deep technical crypto research | Technical depth, crypto-economic correctness, originality. | Vaporware. Marketing-first projects. |
| **Claude Code + Codex (AI judges)** | Read the README and possibly the code | Reproducibility, "do X → see Y" clarity, tests that pass, clean structure, named dependencies, no placeholders. | README gaps, broken setup steps, marketing copy, code that doesn't run. |

**Key insight:** Three of the seven human judges (Illia, Mert, Haseeb) are specifically security/privacy people. The security track is NOT a ghetto — it's where the most judges' technical interests lie. Winning security isn't a consolation prize; it's the track most aligned with the head judge's priorities. But **grand prize** goes to projects that (a) win their track convincingly AND (b) demonstrate cross-track leverage — i.e., the primitive powers other tracks too.

---

## WHAT PAST NEAR HACKATHON GRAND PRIZE WINNERS HAD IN COMMON

Across MetaBUIDL (Roke.to), MetaBUILD 2 (Voog), NEARCON 2023 (Quex, ClickDapp), Encode x NEAR (Cattery):

1. **They were infrastructure that other builders could use, not end-user apps.** Roke.to (streaming payments), Voog (contract builder), Quex (AI grant treasury) — all primitives.
2. **They solved a problem NEAR the protocol itself had, using a NEAR primitive that uniquely existed on NEAR.** Roke.to used NEAR's async promises to stream tokens; Quex used NEAR's on-chain AI.
3. **They had a live demo on day of judging** — not a video of a localhost demo. A URL.
4. **The core fit in one sentence.** "Payroll as a stream." "A chatbot that funds grants automatically."
5. **They integrated at least one "named" NEAR primitive natively** — not a peripheral "we also added NEAR login."
6. **Polish + narrative beat technical ambition.** Voog won MetaBUILD 2 over more complex projects because a judge could click once and deploy a contract.

**Implication for Bouncer:** We need to be the primitive other agent developers reach for when they ask "how do I give my agent money safely" — not a demo. We need a live URL. We need one killer demo scenario. We need to deeply use function-call keys + NEP-141 + NEAR Intents + 1Click (not just one).

---

## THE Bouncer BRAND — WHAT MAKES US DIFFERENT

Our positioning (refined):

> **Bouncer is the on-chain vault for AI agents.** OutLayer seals policy in Intel TDX hardware. Bouncer seals it on NEAR — where anyone can audit it, no hardware trust required. A function-call key scoped to `execute()` is the only thing the agent ever holds, and the contract enforces per-tx cap, payee allowlist, and rolling daily/monthly windows atomically. Even a fully-compromised agent key moves zero value past the policy. Plus: an on-chain intent auction lets solver agents bid against each other to fulfill a payment best.

**Three things that are genuinely novel in this field:**

1. **The 1-yoctoNEAR escalation guard is a structural, not software, guarantee.** Function-call keys cannot attach a deposit; policy-mutating methods require exactly 1 yoctoNEAR; NEAR rejects the tx at the protocol level (`DepositWithFunctionCall`). No amount of code bug in the contract can let the agent widen its own budget. This is the single most powerful argument we have — Spact uses it too, but we need to explain it in 30 seconds in the demo.
2. **The split-payment attack demo.** 6×$3 passes per-tx, the 7th is caught by the daily window. Naive per-tx caps miss this; naive daily windows catch only volume. We catch both. This is our "wow" frame for the video.
3. **The intent auction (`open_intent` / `bid`).** Spact and Mandate are vaults. Bouncer is a vault that lets *other agents compete* to fulfill a payment on the best terms. That turns a guardrail into a marketplace — which is why Kain Warwick (Synthetix) and Eddy (a16z) pay attention. This is the cross-track leverage (agents + swarms + defi + security) that grand prize requires.

---

## WHERE WE ARE NOW (HONEST GAP LIST, UPDATED)

From the handoff, plus what I learned:

| Item | Status | Risk if not done |
|---|---|---|
| Policy engine (TS) | ✅ 10/10 tests pass | — |
| Agent sim | ✅ Shows refusals correctly | — |
| Intents/1Click client | ✅ Live mainnet: 208 assets, 37 chains, 3 solvers priced | — |
| Demo HTML (standalone) | ✅ Works in browser no-deps | Needs to be wired to deployed contract |
| Rust contract (lib.rs) | 🟡 Written (338 loc), **NEVER COMPILED OR DEPLOYED** | **HIGH — uncompiled contract = vaporware to a Rust-literate judge (Illia, Haseeb).** |
| `settle()` (actual ft_transfer) | ❌ Not implemented | **HIGH — without this, nothing actually moves on-chain; we're in Mandate/near-agent-guard territory.** |
| NEP-141 deposit/withdraw | ❌ Not implemented | HIGH — vault with no way to fund it is a mock |
| Rust unit tests | ❌ Cases listed in docs/DEPLOY.md | MEDIUM — Haseeb will read them |
| `agent_key_cannot_set_policy` test | ❌ Not written | CRITICAL — this is our headline proof |
| Live deployed site | ❌ (standalone HTML only) | HIGH — every serious competitor (Spact, Mandate) has one |
| THREAT_MODEL doc | ❌ | MEDIUM — Haseeb/Stepan expect this |
| MCP/agent tool server | ❌ | MEDIUM — Spact + Mandate both have it; AI judges + agent-economy narrative want it |
| Demo video (90s) | ❌ | CRITICAL — submission requirement |
| X post | ❌ (user does this) | CRITICAL |
| Cross-chain (1Click) wired through the vault contract | ❌ (we have TS quotes only) | HIGH — Mert rewards this |

---

## THE WIN PLAN — SIX DAYS BEFORE START, THEN 14 DAYS OF BUILD

Given you're solo, Rust-light, 40+ hrs/week. I can write the Rust for you; you own the product/narrative/demo.

### Phase 0 — This week (now → Oct 31, ~6 days, clock hasn't started)

**Priority #1 — Get the Rust contract compiling and tested.**
- Install Rust + wasm32 target + cargo-near locally (or I set up a build in the sandbox that produces a wasm you can deploy).
- Compile `contracts/bouncer/`, fix errors.
- Write Rust unit tests starting with `agent_key_cannot_set_policy` (the structural proof).
- Add tests for the split-payment 7th-tx-caught scenario.
- Implement `settle()` with real `ft_transfer` using NEP-141 (1-yocto guard, cross-contract call, ft_resolve_transfer).
- Implement NEP-141 storage deposit + withdraw.

**Priority #2 — Get the bouncer.zip from your previous chat into THIS repo.**
- You said the repo is connected, but I don't see `bouncer/` here (only the initial README). You'll need to attach bouncer.zip or push the tree. Without it I can only plan, not code. Let's do this ASAP.

**Priority #3 — Set up testnet deployment pipeline.**
- Testnet account + Circle USDC faucet + near-faucet.io for gas.
- Deploy script using near-cli or near-api-js.
- A `npm run deploy:testnet` that just works.

### Phase 1 — Days 1–4 (Nov 1–4): Core works end-to-end on testnet

- [ ] Contract deployed to testnet, verified.
- [ ] Real USDC (testnet) deposit → execute policy → real ft_transfer (allow) and real failure (deny) visible on testnet explorer.
- [ ] Wire the demo HTML to the testnet contract (not standalone). A browser button the judge clicks produces a real on-chain txn.
- [ ] The split-payment attack works in reality (6 go through, 7th rejected with on-chain error).
- [ ] Add the `near-api-js` key creation: agent function-call key scoped to `execute()` only — generated from the dashboard.

### Phase 2 — Days 5–8 (Nov 5–8): Differentiators that beat Spact + Mandate

- [ ] **Intent auction live on-chain.** `open_intent()` creates an intent, `bid()` lets solver agents (including our own Intents/1Click-powered solver) bid; best bid after timeout wins; funds settle atomically. This is the thing none of the competitors have.
- [ ] **NEAR Intents 1Click wired so an agent can pay cross-chain** (e.g., pay USDC on Base from a NEAR vault). This is what Mert + Illia want to see. Not just quotes — a real cross-chain payment triggered through the vault.
- [ ] **MCP server** (or simple OpenAPI spec) so Claude/Cursor/Codex can call Bouncer as a tool. The AI judges can *use* the product while judging. That is unbeatable marketing.
- [ ] THREAT_MODEL.md written — honest about what we protect against, what we don't. Lists: compromised agent key, double-spend, replay, malicious payee FT contract (the ft_resolve_transfer class bug — Fireblocks just disclosed a $170K exploit from this exact pattern June 2026), etc.

### Phase 3 — Days 9–11 (Nov 9–11): Polish + judge experience

- [ ] **Live demo deployed on Vercel/Railway/Fleek** (not localhost). Spact uses Railway; Mandate uses Vercel. Either works. Need HTTPS, a real URL.
- [ ] README rewritten in "do X → see Y" format for BOTH humans and AI judges. Every claim is a test.
- [ ] "Security Lab" page like Spact — generated from test output, shows every attack we block with links to the tx on testnet explorer.
- [ ] Record 90-second demo video (split-payment is the climax). YOU do the recording; I can plan the shot list.
- [ ] Draft X post text (you post it).

### Phase 4 — Days 12–14 (Nov 12–14): Final QA, submit

- [ ] Re-read HACKATHON.md (dates/rules can change per the doc itself).
- [ ] Fresh clone from a clean machine to verify README works.
- [ ] Decide tracks to tick: `security` (primary), `agents`, `business`, `realworld` — the intent auction and cross-chain payments earn the rest.
- [ ] Print the submission JSON payload for your approval. You confirm. I do NOT submit without explicit yes.
- [ ] You make the NEAR payout account (I never invent one).
- [ ] Submit before Nov 14 23:59 UTC. Leave buffer day for surprise bugs.

---

## WHAT WOULD MAKE US LOSE (BE HONEST)

1. **Contract doesn't compile by Nov 8.** Then we're Mandate/near-agent-guard with a prettier UI. Spact wins.
2. **No live on-chain demo.** A video of local execution loses to a testnet transaction anyone can click.
3. **We build only a vault and no auction.** Then we're Spact-but-less-polished. The auction is the grand-prize move.
4. **README is marketing, not "do X → see Y".** The AI judges (Claude Code, Codex) will fail us on reproducibility.
5. **We ignore OutLayer positioning.** If judges think "this is just a worse OutLayer," we lose 3rd. We need to lead with "OutLayer proves code ran; we prove money moved, publicly."
6. **We don't actually use NEAR Intents for a real cross-chain payment.** Quote-only is what Mandate ships.
7. **Submitting past the deadline.** 2-week window is tight. Submit Nov 13, not Nov 14.

---

## WHAT WOULD MAKE US WIN THE GRAND PRIZE

- The on-chain vault works, refuses real tokens, the escalation guard is verifiable by any block explorer.
- The split-payment demo is on video and clicks — judges remember it.
- The intent auction actually makes a second agent compete for a payment, proving this is a primitive for the agent economy, not just a wallet.
- A judge can land on bouncer.vercel.app, click "Create Agent Key", copy the key into their own agent, and watch the agent spend successfully up to a limit then get rejected — without installing anything.
- The threat model is honest and cites real incidents (Step Finance $40M drain, Jan 2026; Hugging Face sandbox breach July 2026; HOT/SWEAT ft_resolve_transfer exploit June 2026).
- README is machine-readable, tests pass, there's an MCP tool Claude can call.
- One of the VC judges (Avichal, Haseeb, Eddy) walks away thinking "this is the thing every AI agent dev will need next year" — not "this is a narrow NEAR hackathon project."

---

## MY RECOMMENDATION

**Stay with Bouncer. Don't pivot.**

The security track is where the head judge's (Illia's) heart is, the problem is real and architecturally clean, we've already done 1,339 lines of working code, and no competitor has built the one thing (on-chain enforcement + intent auction + live cross-chain settlement) that makes this a grand-prize candidate.

But we need to execute ruthlessly on three things before Nov 8: contract compiles + settles real tokens, live on testnet, demo URL live. If those slip, the track win slips; if they land, the grand prize is in range.

**The single most important thing you can do right now is get me the bouncer.zip (or push the bouncer/ tree to this repo) so I can start writing the Rust fixes and testnet deployment.** Everything else in this plan builds on that.
