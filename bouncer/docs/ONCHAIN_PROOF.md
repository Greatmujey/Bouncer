# Experimental x402 onchain-proof buyer (NEAR testnet only)

Bouncer can prepare, and explicitly opt in to pay, a **PipRail-style x402 v2
`onchain-proof`** offer for a GET resource. An `execute`-only function-call key
asks the existing v9 vault to pay; the agent transaction attaches **zero**
NEAR, and the vault's nested NEP-141 transfer attaches the required **one
yoctoNEAR**. The owner still controls policy, per-call/daily caps and payee
allowlisting with the existing one-yocto administrative guard. No contract
state or method was changed for this adapter.

This is **not** the standard x402 `exact` NEAR scheme: that scheme uses a
NEP-366 signed delegate carrying a one-yocto token transfer and requires a
full-access key. This adapter will not use such a key, silently fall back to
`exact`, perform a Ref swap, pay mainnet, or infer that an unfamiliar seller
accepts nested Bouncer transfers.

## Security warning: proof is public and not order-bound

This scheme's nonce is written as a public token memo and the transaction hash
is public. Anyone observing them may be able to present the proof before the
buyer. PipRail 3.3.0's NEAR `onchain-proof` verifier checks the token event,
amount, payee and echoed nonce; it does **not** authenticate the claimant or
cryptographically bind the proof to a URL, request body, seller-issued order or
buyer. Its default HTTP adapter emits an empty `resource.url`. A nonempty URL
that differs from the owner's pinned URL is rejected, but even a matching URL
in the challenge does **not** provide a cryptographic binding. A buyer can
lose access to a paid resource or have its proof used for another request.
Do not use this for secrets, exclusive access, valuable goods or production
funds. The response, price and seller remain untrusted; a successful payment
or HTTP 200 does not prove correctness, seller identity or delivery quality.

In local tests, the SDK's default in-memory replay set rejects a second proof
within one gate instance but accepts the same proof after constructing a new
gate. A real merchant must provide appropriately durable, atomic replay
protection and deal with public-proof theft and fulfillment idempotency; a
buyer cannot enforce those properties. Our own seller-v2 protocol binds a
challenge to an exact order, but is **not** interchangeable with this SDK and
still does not authenticate a claimant. No protection is claimed across
separate buyer journals or processes using different journals.

## Owner-reviewed configuration and operation

The initial adapter only accepts Circle's canonical NEAR **testnet** USDC
contract, six decimals, plus a `.testnet` payee, owner and v9 Bouncer. Testnet
USDC has no real value. It requires exactly one matching `onchain-proof` offer,
a positive amount no greater than the owner-pinned maximum, a memo of at most
256 bytes and a seller timeout of at least 60 seconds. The local quote-age
limit is an additional conservative bound; neither it nor the seller's timeout
is a guarantee that the seller will honor a payment or be reachable. Policy,
key permission, seller token registration and RPC network are checked before
signing; views can change after preflight, so the on-chain policy is decisive.
The token, Bouncer deployment, RPC, seller and local machine are trust assumptions.

Copy and review `bouncer/examples/onchain-proof-goal.example.json`. Replace the
example accounts and URL with a compatible testnet deployment and **independently
vetted seller**. Both risk flags start as `false`; the owner must deliberately
set **both** to `true` after accepting the risks above. The URL must be the
canonical exact HTTPS GET URL (loopback HTTP is supported for development),
without credentials, query parameters or a fragment. Redirects are rejected.
The policy must permit the pinned Circle token/payee, the vault must be funded,
and the agent key must be restricted **only** to `execute`. The 402 endpoint
must actually offer the `onchain-proof` scheme on `near:testnet`; no compatible
independent endpoint is bundled or asserted to exist.

```sh
# Dry run first; it fetches a 402 quote but never signs, broadcasts or redeems.
node bouncer/agent/onchain-proof.mjs --goal reviewed-goal.json --key restricted-agent.json
# Only after owner review: sends one testnet payment and makes one paid GET.
node bouncer/agent/onchain-proof.mjs --goal reviewed-goal.json --key restricted-agent.json --state private.bouncer-proof-journal.json --execute
# If interrupted: read the original signed hash and FINAL receipts, never pay again.
node bouncer/agent/onchain-proof.mjs --goal reviewed-goal.json --state private.bouncer-proof-journal.json --recover
# Only when recovery reports not_started: make the FIRST seller request without a key or payment.
node bouncer/agent/onchain-proof.mjs --goal reviewed-goal.json --state private.bouncer-proof-journal.json --recover --redeem
```

The complete, reviewed offer and signed hash are fsynced before the single
payment broadcast. Recovery rechecks the exact signed transaction, Bouncer
receipt graph, token transfer and matching Circle NEP-297 event through a
receipt-inclusive **FINAL** trusted testnet RPC. The challenge is the exact
`ft_transfer` memo; the proof locator uses the transaction **signer** and hash,
not the Bouncer vault as transaction signer. If the token does not emit the
expected event, settlement remains unresolved even if tokens moved.

Before disclosing a proof or sending the paid GET, Bouncer fsyncs an
`attempted` state. A timeout, error response, oversized result or crash after
that point can mean the seller consumed it. Bouncer never automatically retries
the seller request or pays again; investigate with the seller. `--recover
--redeem` is allowed only for an original payment whose first request has **not
started**; it cannot repeat an attempted request. A successful bounded response
(up to 64 KiB) and SHA-256 are saved in the private journal so recovery can show
it without contacting the seller again. That hash detects accidental change,
not malicious journal editing or seller forgery. Journals contain public
financial data and may contain sensitive responses; keep them private and do
not delete, edit or replace them while resolving an uncertain operation. Locks
and duplicate-challenge checks only coordinate callers sharing one journal.
The injected RPC/HTTP providers must honor the same single-attempt behavior as
the supplied clients.

## Evidence and limitations

- The tests install independently published [`@piprail/sdk@3.3.0`](https://www.npmjs.com/package/@piprail/sdk/v/3.3.0)
  in an isolated, lockfile-pinned application. The SDK's published NEAR driver
  supports **mainnet** as its built-in preset. Our test-only wrapper changes its
  network label to `near:testnet` and points it to a loopback test RPC; it does
  not modify the SDK's token-event verifier. This wrapper is not an upstream
  testnet release or an independent merchant.
- The synthetic end-to-end test feeds a mocked signed Bouncer transaction and
  receipt to that real SDK verifier and exercises quote → guarded call → paid
  GET, negative substitutions, same-instance replay and replay after a fresh
  default gate. It proves SDK wire compatibility under these conditions, not
  blockchain activity.
- An optional read-only check fetches the **previously completed** seller-v2
  [testnet payment](https://testnet.nearblocks.io/txns/HwQB5RTFgascGDjPUmkCkiexF2WEHShHX69d6yGw7JMc)
  at FINAL, checks its Bouncer/token receipts, and passes the actual receipt to
  the installed SDK via a loopback RPC. Its gate deliberately uses the old
  memo as a *retrospective* nonce; block time is omitted from the SDK's
  loopback view, so this is not a fresh quote or evidence of the SDK checking
  recency. It sends no payment or merchant request. The original payment was
  to our own development seller; using its receipt here does not create a new
  purchase or establish an independent seller's acceptance.

The source inspection is pinned to [PipRail's NEAR verifier](https://github.com/piprail/piprail/blob/a8d7c35995f4c0b8b844c2a76110b38eb2228e37/sdk/src/drivers/near/verify.ts)
and [gate implementation](https://github.com/piprail/piprail/blob/a8d7c35995f4c0b8b844c2a76110b38eb2228e37/sdk/src/server.ts).
Software and deployed merchant versions may differ. Independent FT-paid
provider adoption, authenticated/order-bound fulfillment, guarded Ref swaps and
production-grade operations remain open work.
