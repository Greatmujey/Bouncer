# Experimental Buffer testnet forwarder

This is an **offline, unaudited experiment**, not a live order, purchase,
delivery, or authorization to spend. The independent Buffer service is a
promising candidate for an FT-paid research/data resource, not a substitute
for Bouncer's compute and storage tracks.

At 16:16 UTC on November 6, 2026, a [read-only testnet snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/42250800169)
found Buffer's two fixed briefs active at **20,000,000 atoms (20 test USDC)**
and its custom-brief minimum at **5,000,000 atoms**. The V12 vault held **6,898
atoms**. The same FINAL block indicated 7 test NEAR would return only 3,267,177
atoms from the better of the two sampled Ref pools, below the custom minimum.
That quote was an observation, not a reservation or authority to trade. A web4
quote previously cited was from a stale indexer at block 238,527,181 and must
not be used. Prices, liquidity, quote availability and deployed code can change;
any later action requires a new fresh check. A later [fixed split-route view](https://github.com/Greatmujey/Bouncer/actions/runs/42254486049)
indicated 5,270,212 atoms for 4 test NEAR across three distinct paths. Almost
3.084 USDC of that indication comes from draining all but one atom of a small
public two-hop pool; it is fragile, potentially disruptive to other testnet
users, and neither executed nor a promise of liquidity. The user subsequently
confirmed control of `great_mujey.testnet`; a public index showed it held 20
Circle test USDC and roughly 16 test NEAR. The newly added wallet-owner
preflight checks this alternative without a Ref swap and without using the
previous V3 owner. A [pinned FINAL check](https://github.com/Greatmujey/Bouncer/actions/runs/42255987354)
observed 20,000,000 Circle atoms, enough test NEAR under the estimate, an absent
`vault.great_mujey.testnet` direct child, and the seller's active 20-test-USDC
fixed product. All listed read-only checks passed at that block. They do not
prove the user can sign or that future state, seller availability or delivery
will match. The candidate is not deployed.

`agent/buffer-wallet-setup-plan.mjs` prepares and commits **unsigned** action
reviews for creating the keyless vault with 6 test NEAR, registering it with
Circle, and depositing exactly 20 test USDC via `ft_transfer_call`. Those 20
are the user's entire observed test-USDC balance, not a provider charge. The
keyless vault may permanently lock its native storage stake. Each action needs
separate owner-wallet approval, fresh checks and original-transaction
reconciliation; never resend an ambiguous action. This does not yet configure
policy, create an order, install agent keys or pay Buffer. A public view alone
is not a wallet signature. Bouncer has
not created an order or quote, contacted the seller's paid workflow, or paid or
obtained a report. A later read-only source-build comparison matched the
deployed contract hash at one FINAL block, as described below; it does not
establish seller service, audited code or delivery.

`agent/buffer-wallet-spending-plan.mjs` now prepares an additional **unsigned**
owner review for a locked, exact-intent policy and two distinct, receiver- and
method-scoped agent keys. The trial limits are at most 20 test USDC per
transaction and per rolling day; each owner policy call attaches exactly one
yocto, while each agent key has a bounded test-NEAR gas allowance and cannot
attach a deposit. It grants no full-access key. This plan does not create a
vault or forwarder, install keys, obtain wallet approval, place an order or pay.
It requires fresh on-chain preflights and reconciliation of each original hash.
Its atomic four-action policy setup and the current V12 named-owner check are
not supported by the experimental EVM-on-NEAR adapter; its `0x…` account also
cannot be silently substituted for a named NEAR account. WalletConnect's
current session remains account-only. Neither is spending-enabled by this plan.
The same unsigned batches were exercised with synthetic keys, source-built
Buffer and a mock FT in [isolated nearcore run 42269956792](https://github.com/Greatmujey/Bouncer/actions/runs/42269956792);
that is not a real wallet approval or live sale.

`agent/buffer-wallet-spending-evidence.mjs` adds an **offline** checker for the
three policy/key batches. It rebuilds the exact plan from an independently
retained review and compares a receipt-inclusive FINAL RPC result to the
retained original hash, owner key, actions, receiver, root outcome and any
protocol gas refund. A missing hash, incomplete graph or unexpected action is
not success; a FINAL failure still requires state review and is never an
instruction to retry. The caller must retain those trust anchors independently.
The checker neither journals before a wallet prompt nor accesses RPC, proves
current contract state, or authorizes the next stage. [Run 42272203799](https://github.com/Greatmujey/Bouncer/actions/runs/42272203799)
matched nine originals to actual **isolated** nearcore receipt graphs with
synthetic keys and a mock token. That is not a real wallet approval, a live key
installation, a payment or delivery.

`agent/buffer-forwarder-wallet-plan.mjs` prepares three additional **unsigned**
owner batches for the exact order-specific forwarder: create/deploy with 3 test
NEAR, bounded Circle registration, and pinning a short-lived V12 intent with
exactly 1 yoctoNEAR. It binds the generated bytecode, two agent public keys,
price, payee and order terms to the separately retained capped spending review.
It does not obtain or validate a private order, prove the deployed account is
absent, open a wallet, sign, send or pay the seller. The native account funding
may leave storage locked. Each action still requires fresh checks, owner
approval and independent prompt/receipt recovery.

`agent/buffer-forwarder-wallet-evidence.mjs` can compare only an independently
retained original hash and reviewed batch to receipt-inclusive FINAL RPC data.
It also works after the intent expires, without claiming the intent is fresh.
A match is not proof of wallet approval, current state, deployed code or
independent delivery. A missing or failed original never permits a retry.

`agent/buffer-forwarder-wallet-preflight.mjs` checks the proposed create and
registration stages against a fresh pinned testnet block, including the direct
child's presence, current storage cost, bounded native funding, token and
seller code, vault balances and unused policy. It cannot verify the private
order, approval, prompt fence, provider delivery or future chain state.

`agent/buffer-wallet-spending-preflight.mjs` performs read-only, fresh,
same-FINAL-block checks for the next policy/key stage or the separately retained
exact-intent stage, including both installed method-scoped keys for that final
stage, and the independently
retained V12/forwarder/seller code pins, native reserve estimates, token balances
and registration, exact policy and scoped keys, unconsumed intent and seller
terms. It rebuilds the forwarder from reviewed terms and checks its configuration.
A mismatch or unavailable view blocks; even a matching snapshot never replaces
a pre-prompt durable fence, verification of prior original transactions, owner
approval, a code audit, or a fresh check at execution time. This preflight has
no signer or transaction sender and does not contact the seller's HTTP service.
In [isolated run 42273529625](https://github.com/Greatmujey/Bouncer/actions/runs/42273529625),
the stage checks parsed actual local nearcore views but correctly **blocked**
the mock FT because its code is not the real Circle testnet token.

`web-src/wallet-local-prompt-fence.mjs` is a separate, experimental local
write-ahead primitive: one unresolved owner prompt per browser profile, a
strict IndexedDB commit before the reservation returns, and an immutable
original hash once recorded. It does not call a wallet, and there is no
unlock or expiry operation. Two-tab/reload/corruption tests are synthetic.
Browser storage can be erased, rolled back or isolated on another device, so
this local fence alone is **not** independently durable or safe authorization
for live spending. Missing local state does not establish that an earlier wallet
prompt failed. A separate durable owner-scoped service, authenticated identity,
receipt reconciliation and recovery flow are still required before wiring a
wallet prompt to this primitive.

`agent/postgres-wallet-prompt-fence.mjs` is an additional **server-side
prototype**, tested with a disposable PostgreSQL 17 primary. Cooperating
processes compete for one owner-wide reservation, which stores the complete
canonical Buffer spending review and stage commitment before any possible
prompt. The first recorded original hash is immutable; the database trigger
also rejects ordinary updates or deletion, and the service checks its critical
indexes, trigger, row visibility, primary status, fsync and synchronous commit.
A lost commit acknowledgement is treated as unknown. There is deliberately no
unlock, expiry, payment, endpoint or wallet call. Its authenticator is an
injected trust boundary. A separate experimental
`agent/postgres-wallet-prompt-auth.mjs` implements one-use, origin- and
exact-action-bound NEP-413 challenges, checking an Ed25519 FullAccess key at a
fresh trusted-RPC testnet FINAL block; it signs and sends nothing. Tests connect
the two prototypes using disposable keys and fabricated RPC responses, not a
real phone or wallet. NEP-413 is not available for the EVM adapter. Local
concurrency, corruption and lost-ack tests do not establish backup, rollback
protection, database failover, actual wallet interoperability, genuine
on-chain approval, current chain state or safe live spending. A DB administrator,
stale restore, alternate database or bypassing wallet can still defeat
coordination. The database enforces one **record**, not one invocation of a
wallet: future client code must never reuse a reservation to reopen a prompt.
No Supabase project or production database was created or modified.

[Read-only code comparison 42276988446](https://github.com/Greatmujey/Bouncer/actions/runs/42276988446)
first found that a plain Cargo build did **not** match the deployed code hash.
Using the seller-documented `cargo near build non-reproducible-wasm` command,
[run 42277687212](https://github.com/Greatmujey/Bouncer/actions/runs/42277687212)
built the pinned public source at `Chima30/buffer@9bc5ef0cbdc84074e94995cb50d334fc615f9b96`
with Rust 1.93.0, the pinned lockfile and cargo-near 0.22.0. Its **419,506-byte**
WASM had SHA-256 `f835dd7f6c87dc3b4f3686ce8fa79c978ae721f1748693fc3c38af567be76edd`,
matching the seller's NEAR code hash `HhukNLoRAK77ZL2iqGaH7m4hhk4Wu3owxH5sxkRK5pnG`
at trusted-RPC FINAL block `AdT714jZpAgRCcJnckiTocxBkoV7mxQ6B3UYVPuVAyNw`
(height 276,526,470). An [independent repeat](https://github.com/Greatmujey/Bouncer/actions/runs/42278059489)
produced the same build and code hash at FINAL height 276,526,708. These are
hash matches for those builds and blocks, not a code audit, future code pin,
service availability, payment or delivery.
The contract self-reported its repository but no build information. No order,
transaction or seller HTTP request was made.

## Why a separate forwarder

The Buffer source receives an exact `ft_transfer_call`, records the token
sender as the customer and returns wrong-price payments immediately. Later
refunds may be sent by **plain `ft_transfer`** to the customer. Sending directly
from the V12 vault could leave that late refund outside its tracked ledger.
This order-specific, fixed-code forwarder is intended to receive such a refund
and return tokens to the vault via its FT receiver hook instead. It is not yet
validated against the real Circle token or deployed Buffer contract.

1. After an independently reviewed fixed-price order is created, compare its
   private response with the reviewed request and terms using
   `checkBufferOrderResponse` for fixed products. For `custom-brief`,
   `checkBufferQuoteResponse` additionally compares the private quote, request,
   exact price, expense limit, caller-supplied on-chain quote view and expiration. It
   rejects an already-paid quote and requires a 10-second expiry safety margin;
   the supplied view is not itself proof of RPC provenance or live readiness.
   Both checks return neither the private order bearer nor the brief. Treat both
   as sensitive; a brief hash is not encryption and short briefs may be guessable.
   Buffer's custom-quote endpoint itself spends seller inference and registers an
   on-chain quote; do not create a speculative quote before Bouncer is ready.
2. `buildBufferForwarder` creates deterministic WASM, pinning those public
   terms and a single `ft_transfer_call`. An owner-controlled V12 exact intent
   would have to pin the resulting code review hash, amount, payee, memo,
   expiry and vault agent key. The builder does not create that intent or send
   anything. Its `open` is one-shot even if the downstream call fails.
3. The owner account needs two **different**, receiver-scoped agent keys: one
   for the vault's `execute_exact_ft`, another for the forwarder's `open` and
   `return_tokens`. The fixed forwarder can return a bounded amount only to the
   fixed vault. A privileged native return requires the owner and 1 yocto;
   there is no arbitrary call, deployment, upgrade, claim or storage-withdraw
   interface. A buyer's Google sign-in does not authorize either key.
4. An actual payment still requires fresh price and policy checks, a funded and
   safely recoverable owner, the exact bytecode deployed to a **keyless**
   forwarder, Circle registration and reserve, a durable original-hash journal,
   and verification of the seller's payer/notification behavior. Check the
   live seller code hash and terms independently. Never resend an ambiguous
   original transaction or pretend the original did not execute.
5. A matched payment is not delivery. For a genuine result, independently
   retain the private response, the original seller-fulfillment transaction,
   and a pinned on-chain order. Match the report's exact UTF-8 SHA-256 against
   the seller's on-chain commitment and bind payer/order/price/token. A hash
   proves consistency, not report quality or HTTP provenance. Refunds can be
   partial after vendor costs; even a routed return must be verified separately.

The return and native caps are **per call**, not cumulative. Forwarding tokens
back does not restore the already consumed rolling budget. Refunds that never
arrive, a changed seller, a lost original hash, or insufficient native/token
storage can leave funds inaccessible. Code and account key lists must be
checked at the relevant historical state; a `configuration` view is not proof
of the deployed bytecode. No unrestricted owner or legacy key should be used as
a substitute for the missing recovery and fencing checks.

## Correlating an existing delivery (read-only)

`agent/buffer-delivery-evidence.mjs` and `scripts/inspect-buffer-delivery.mjs`
correlate **already-recorded** original FINAL transaction hashes with historical
vault, adapter, token and seller code/intent/order views, the seller's payment
and fulfillment events, and the SHA-256 of a separately retained report. The
inspector is testnet-only and requires the reviewed V12 and Circle token code
pins. The seller code hash and fulfillment signer are separately reviewed pins;
the inspector itself does not establish source equivalence. The separate build
comparison above establishes a match only for its observed block. Buffer's
published agent can be a 64-hex implicit account, which does not encode a
network: the receipt
lookup explicitly opts in and separately checks the RPC reports testnet. The
pinned seller configuration and fulfillment transaction must still name exactly
that signer. The evidence contains an output hash, **not** the private brief,
report or access token.

For an actual order, privately retain the seller's authorized JSON response and
prepare a public JSON review with exactly these fields:

- `format`: `bouncer-buffer-delivery-evidence-v1`
- `terms`: the exact arguments used to build the reviewed forwarder
- `pins`: `vault_code_hash`, `token_code_hash`, `seller_code_hash`, and
  `fulfillment_signer`
- `funding_hash`, `opening_hash`, `fulfillment_hash`: the three distinct,
  original transaction hashes; never replacement transactions

Then, from `bouncer/`, run:

```sh
node scripts/inspect-buffer-delivery.mjs --rpc https://rpc.testnet.near.org \
  --review PUBLIC_REVIEW.json --private-order PRIVATE_ORDER.json
```

Keep the private response in an ignored, access-controlled location, not in Git,
and never put the access token or keys in the public review. The file reader
refuses symlinks, hardlinks and oversized files. The inspector does not contact
Buffer, create an order, sign, broadcast, notify the seller or retry. The
accompanying API offers a separate, fixed-origin private-order GET; that GET
contacts Buffer and discloses the bearer token to Buffer, so use it only
intentionally and never log the URL. HTTP response provenance, independent seller
fulfillment, report accuracy and source equivalence at a later execution block
remain unproven. A missing receipt is unknown, not permission to resend. The correlator also
passed against actual isolated nearcore receipt graphs in the source-built
sandbox described below; that remains different from real seller delivery.

## Current read-only funding and seller preflight

`node scripts/inspect-buffer-live-readiness.mjs` inspects the V12 vault, Circle
registration, Buffer configuration/products/quote rules, and sample Ref pool
returns at one trusted-RPC FINAL block. It makes no seller HTTP call, quote,
order, signature, or send. Any sample is only a raw indication: the custom
quote can exceed the on-chain minimum; storage, gas, reserves and slippage are
not covered. It does **not** inspect the two uncertain V3 original histories or
authorize trading. An implicit seller agent is accepted only in this explicitly
testnet-pinned inspection. Failures or mixed/stale views remain unknown.

## Tests and status

Local offline tests exercise the fixed interface, strict response matching,
1-yocto guard, replay and a **synthetic** immediate/late refund model with the
hash-pinned V12 WASM. They do not model a real token or actual receipts.

The optional `.github/workflows/buffer-upstream-sandbox.yml` builds Buffer from
[pinned source](https://github.com/Chima30/buffer/tree/9bc5ef0cbdc84074e94995cb50d334fc615f9b96/contract)
and runs it with the pinned V12 and an example mock FT on an isolated nearcore
chain. [Run 42215812897](https://github.com/Greatmujey/Bouncer/actions/runs/42215812897)
passed: its assertions checked a changed-price rejection, an accepted order,
later plain-token refund routed into the tracked vault balance, conservative
rolling budget and a blocked next intent, a fixture report hash, and a synthetic
seller payout. The final mock-token and tracked vault balances were 40,000,000
atoms; each policy's recorded spend stayed at 20,000,000 atoms. This used a
local source build, not proof of the deployed code, and no real Circle, private
project key, seller contact or independent report.

[Run 42217186932](https://github.com/Greatmujey/Bouncer/actions/runs/42217186932)
repeated the scenario and additionally passed the separate Buffer receipt and
fixture-report correlator against the actual isolated nearcore graphs and
block-pinned historical views. It still used the source build and mock token;
HTTP provenance and independent fulfillment remain unverified.

```sh
cd bouncer
node --test tests/buffer-forwarder.test.mjs tests/buffer-delivery-evidence.test.mjs \
  tests/buffer-evidence-cli.test.mjs tests/buffer-upstream-sandbox.test.mjs
# Optionally add BOUNCER_V12_WASM_PATH pointing to the exact 536,651-byte
# artifact with SHA-256 033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12.
```
