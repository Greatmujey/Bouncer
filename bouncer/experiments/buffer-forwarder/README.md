# Experimental Buffer testnet forwarder

This is an **offline, unaudited experiment**, not a live order, purchase,
delivery, or authorization to spend. The independent Buffer service is a
promising candidate for an FT-paid research/data resource, not a substitute
for Bouncer's compute and storage tracks.

On November 6, 2026, Buffer's public catalog listed `weekly-market-brief` and
`crosschain-brief` at **20,000,000 atoms (20 test USDC)**; a custom quote had a
5,000,000-atom minimum. The observed V12 Circle balance was **6,898 atoms**.
Prices, availability and deployed contract code can change. Bouncer has not
created a Buffer order or contacted the seller, and has not paid or obtained a
report from Buffer. The contract source below is pinned for investigation; it
is not proof that the live deployment matches that source.

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
   `checkBufferOrderResponse`. It checks the fixed token, seller, amount,
   order ID, SKU, exact message, payer and brief hash, but returns neither the
   private order bearer nor the brief. Treat both as sensitive; a brief hash is
   not encryption and short briefs may be guessable.
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

## Tests and status

Local offline tests exercise the fixed interface, strict response matching,
1-yocto guard, replay and a **synthetic** immediate/late refund model with the
hash-pinned V12 WASM. They do not model a real token or actual receipts.

The optional `.github/workflows/buffer-upstream-sandbox.yml` builds Buffer from
[pinned source](https://github.com/Chima30/buffer/tree/9bc5ef0cbdc84074e94995cb50d334fc615f9b96/contract)
and runs it with the pinned V12 and an example mock FT on an isolated nearcore
chain. It is designed to check a changed-price rejection, later plain-token
refund, restored vault balance, conservative rolling budget, fixture report hash
and synthetic seller payout. **The workflow has not yet passed for this new
integration**; inspect its actual result rather than inferring success. It has
no network identity, real USDC, private project key or independent report.

```sh
cd bouncer
node --test tests/buffer-forwarder.test.mjs tests/buffer-upstream-sandbox.test.mjs
# Optionally add BOUNCER_V12_WASM_PATH pointing to the exact 536,651-byte
# artifact with SHA-256 033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12.
```
