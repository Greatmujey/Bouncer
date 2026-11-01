# Experimental independent research-provider adapter

**Not a completed independent FT purchase.** MultiAgency's public testnet demo
advertises research and writing work funded by a Circle testnet USDC deposit.
Its [published source](https://github.com/MultiAgency/near-agencies/tree/b4c550c9fee90688176cd77495fcfeaeeb3c0f36)
describes a wallet flow with a memo and a watcher that reads token transfer
events and confirms FINAL receipts. It is not standard x402 `exact`. The
source is not an attestation of the currently deployed service. Testnet USDC
has **no financial value**.

On 1 November, our [read-only probe](https://github.com/Greatmujey/Bouncer/actions/runs/41330160414/job/124918366939)
observed a 3,000,000-micro-USDC default deposit, Circle's NEAR testnet token,
and treasury `multiagency.sputnikv2.testnet`. It reported a coordinator cycle
completed 19 seconds before the observation. The original `coordinator_recent`
flag incorrectly required a cycle to be running at that exact moment; that
flag was fixed because idle time between cycles is normal. The endpoint may be
stale or cached. One ready task was listed, and the latest listed paid job was
created 3 October. A recent coordinator cycle does not prove a live research
worker or an operator willing to assemble and approve a new job. It reported neither a
service-level commitment nor a general refund for stalled work. **No quote was
created and no funds were sent to MultiAgency.**

The source-reviewed watcher queries FastNear's transaction index. Our probe used
its **read-only** account/transaction APIs to locate a previously completed
nested Bouncer Circle transfer to **our own development seller**, then verified
the original linked Bouncer/token receipts at FINAL. This is evidence that the
index can expose that kind of event and memo; it does not prove MultiAgency's
live watcher will accept our transfer. The historical control was
[`zhqQHD…`](https://testnet.nearblocks.io/txns/zhqQHDfcF12wHQbQSMCWJR5z3fi7FZSsAWEfzXF4Yf9),
not a payment to MultiAgency.

Separately, the published-handoff verifier checked the complete GitHub thread
for the provider's historical [job #32](https://github.com/MultiAgency/kanban-sandbox/issues/32)
and [task #40](https://github.com/MultiAgency/kanban-sandbox/issues/40#issuecomment-5923484271).
It matched the bot-authored job/team, completed task, assignee's handoff and
SHA-256 of the unedited report comment. That historic work was bought by
`agency.testnet`, **not Bouncer**; it does not demonstrate current capacity,
prove the report's accuracy, or satisfy our independent-fulfillment goal.
Public summaries are in `evidence/multiagency-read-20261101/`.

## What is implemented

- `agent/multiagency-research.mjs` validates an owner-reviewed **public** brief,
  fixed 3-test-USDC price, testnet asset, recipient, quote code/expiry and
  explicit risk acknowledgments. It builds an exact direct-payment plan.
  Quote responses are unsigned and do not echo the brief, so only later public
  job evidence can corroborate what the provider recorded.
- `agent/multiagency-runner.mjs` requires the original owner/vault-scoped
  encrypted file journal. It syncs the goal before **one** quote POST; a lost
  response leaves that request unresolved and is not retried. A payment is
  separately requested with explicit `execute: true`: it checks the reviewed
  keyless vault's code hash, owner and recipient registration at a FINAL block,
  rereads the same unexpired quote, then uses the restricted `execute` key and
  durably records the signed transaction hash before one broadcast. A quote
  too close to expiry is refused; a post-journal guard rejection leaves the
  original pending record for review. No module automatically replaces it.
- Key-free recovery reads the original hash and verifies the FINAL transaction,
  linked transfer/callback, exact Circle event/memo, and the reviewed keyless
  vault code and keylessness at both the original transaction and guarded
  execution blocks. A separate verifier requires
  the seller's job to attribute **that** hash, amount and quote to **that**
  vault and the bot-authored GitHub issue to contain the exact public brief.
  A further verifier checks a closed job/task, complete bounded comment thread,
  assignee handoff and report digest for **one task**. That task may be only
  part of the brief. It returns untrusted report text; it does not judge full
  goal fulfillment, truth, adequacy, rights or future availability.
- `agent/procurement.mjs` now prefers `sendTransactionOnce` when available and
  does not fall back to another send after an ambiguous error. Injected legacy
  providers must enforce equivalent no-retry behavior themselves.

The adapter is **experimental and synthetic-tested only**: no MultiAgency quote,
payment, job, Bouncer report or refund has been observed. The public readiness
and historical controls do not change that. It is not wired into the website,
automatic mission orchestration or shared PostgreSQL buyer. Before a live run,
independently establish current worker/operator availability and acceptance,
liquidity, precise service terms and the owner's explicit policy/brief approval.
Do not create test quotes merely to probe readiness: each may cause repeated
scans for up to 72 hours in the published source.

## Security boundaries

The brief and report are public. The quote is unsigned, the code is short and
public in the on-chain memo, and the source-reviewed watcher accepts matching
memos from any sender. Another party could preempt or misattribute a quote;
a last-moment GET cannot close that race. There is no demonstrated refund for
an accepted but stalled job. The contract's payee and per-transaction/daily
caps and 1-yocto owner-policy guard remain in force, **but V9 `execute` does
not pin the memo on chain**: an agent key holder can choose another memo and
amount within the authorized policy. The exact quote is reviewed by this
particular off-chain runner, not made immutable against a compromised key.

The journal and in-process exclusion prevent cooperating calls from paying the
same recorded memo twice **within the same original journal**. They cannot
detect a deleted, stale-restored, copied or separate journal, another process
that ignores its filesystem lock, an injected retrying transport, a dishonest
RPC/provider, or manual use of the key. The quote session itself remains a
`pending` administrative journal entry even after issuance; it is not a
pending on-chain payment. Never put plaintext keys, signed transaction bytes,
or private task data in Git or public logs.
