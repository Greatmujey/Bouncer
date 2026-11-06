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
any later action requires a new fresh check. Bouncer has not created an order or
quote, contacted the seller's paid workflow, or paid or obtained a report. The
contract source below is pinned for investigation; it is not proof that the live
deployment matches that source.

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
pins. The seller code hash and fulfillment signer are separately reviewed pins,
not proof that deployed code matches public source. Buffer's published agent can
be a 64-hex implicit account, which does not encode a network: the receipt
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
fulfillment, report accuracy and deployed-source equivalence remain unproven.
A missing receipt is unknown, not permission to resend. The correlator also
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
