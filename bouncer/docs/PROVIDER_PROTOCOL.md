# Experimental provider protocol (testnet)

This document describes the **current bounded prototype**, to help a potential
independent provider evaluate compatibility. It is not an adopted standard,
an audited payment protocol, or evidence that any independent provider has
adopted this **FT** interface. Its live fulfillment tests use Bouncer's
self-hosted development providers. Bouncer's separate
[OutLayer integration](OUTLAYER.md) uses OutLayer's native-NEAR and separate
prepaid-project interfaces, not this protocol. The Circle testnet USDC mission
also uses this self-hosted provider; its tokens have no real value. Do not use
any path with valuable funds.

## Trust and setup

An owner must independently vet a provider and explicitly pin its HTTPS origin,
testnet payee, token, policy and maximum price in the owner catalog. Loopback
HTTP is permitted for local tests only. The provider cannot authorize itself,
choose the owner's signing key or change policy. The owner must configure the
policy's token, key grant, payee allowlist, caps and vault funding on chain. An
execute-only function-call key signs zero-deposit `execute` transactions; owner
policy changes require **1 yoctoNEAR**.

The provider must independently pin a trusted Bouncer deployment, its owner
signer, token, payee, policy, price and RPC. The owner account may differ from
the contract account. Contract-version text is not code attestation; the
provider must trust the deployed code, token and RPC. A 64-hex implicit token
ID does not encode its network. Verify the network independently; a hostile
RPC can lie. Never accept these values from the order itself as authority.

The current runner follows no redirects. Quotes and redemption bodies are JSON
and responses are bounded to 64 KiB; storage readback is bounded to 4096 bytes.
Orders disclose their full inputs to the provider. The reference server is
loopback-only, single-process and unauthenticated, and does not provide TLS or
production durability. It is not a suitable public deployment.

## 1. Quote an exact order

`POST /quote` receives, for example:

```json
{"resource":"compute","input":{"text":"Bouncer protocol test","rounds":3}}
```

A valid response has `ok: true` and a `quote` containing the same `resource`,
the owner-pinned `policy_id`, `token`, `payee`, positive integer `amount` in
smallest token units, and the exact order `memo`. Example values below are
illustrative, not deployed vendors or a price guarantee:

```json
{"ok":true,"quote":{"resource":"compute","policy_id":"compute","token":"wrap.testnet","payee":"vendor.testnet","amount":"100000000000000000000000","memo":"bouncer-order-v1:compute:9a4ee52be36beeb6f4769901d9771c49076dfebf59a1e4b4bb19e09ecc24a516"}}
```

The memo is `bouncer-order-v1:<resource>:<sha256>` where the digest is the
lowercase SHA-256 of the UTF-8 bytes of `JSON.stringify(normalizeOrder(resource,
input))`. Property order and ECMAScript JSON serialization matter; arbitrary
JSON canonicalization is not interchangeable. The reference normalization in
[`resource-provider.mjs`](../services/resource-provider.mjs) validates bounds
and produces the following key orders:

- Compute: `{ "text": string, "rounds": integer }`, at most 1024 UTF-8 bytes
  and 1–20,000 rounds.
- Storage: `{ "name": string, "content": string }`, name matching
  `^[a-z0-9_-]{1,40}$`, content at most 4096 UTF-8 bytes.
- API: `{ "text": string }` up to 4096 UTF-8 bytes, or `{ "repo": string }`
  with a validated public GitHub `owner/repository` identifier.

For the compute example, the normalized JSON is exactly
`{"text":"Bouncer protocol test","rounds":3}` and its memo is the value above.
The quote is unsigned and has no expiry or delivery guarantee. The agent checks
its fields against owner limits and may requote before paying; it does not
implicitly trust a listing, model or quote as financial authority.

## 2. Confirm payment and redeem

After a finalized payment the client sends:

```json
{"tx_hash":"<payment transaction hash>","resource":"compute","input":{"text":"Bouncer protocol test","rounds":3}}
```

The endpoint is `POST /redeem`. Before any paid side effect, a provider should
fetch the transaction from its trusted NEAR testnet RPC with `FINAL` execution
and fail closed unless all expected receipts have completed successfully. The
current verifier checks the transaction hash, pinned owner signer and contract
receiver, a single zero-deposit `execute` action, the pinned policy, token,
payee, exact amount and order memo, plus a successful receipt from the pinned
FT contract. See [`verifyPayment`](../services/resource-provider.mjs) and
[`assertFinalPaymentReceipts`](../shared/final-payment.mjs) for the exact checks
and trust assumptions. This is not a light-client proof or a generic FT payment
verifier. A failed or ambiguous transaction must not be treated as paid.

Persist a unique transaction-to-order binding before non-repeatable side
effects; return the same result for the same transaction and order, and reject
a different order. A pending or ambiguous prior fulfillment needs reconciliation,
not an automatic second side effect. The reference provider coalesces duplicate
requests and caps concurrent redemptions in one process only; it has no
multi-host lock, fsync guarantee or crash-proof distributed idempotency. A real
provider needs an appropriate durable, transactional design of its own.

## 3. Return a verifiable bounded result

A successful compute response for the example is:

```json
{"ok":true,"result":{"type":"compute","algorithm":"sha256-iterated","rounds":3,"result":"0ce2813641f347d5e168547d5b4e598f0962e35d0cbc0b847c1a9bca991da1fe"}}
```

For compute, begin with the UTF-8 input bytes and hash the raw digest bytes for
exactly `rounds` iterations; output lowercase hex. The agent recomputes it.

For storage, return exactly `type`, `object_id`, `sha256` and `bytes`. The
object ID is SHA-256 of UTF-8 `<tx_hash>:<name>`, and `sha256`/`bytes` describe
the UTF-8 content. `GET /storage/<object_id>` must return those bytes; the agent
checks one readback from that same pinned provider, not ongoing retention.

For the text API, return exactly `type: "api"`, `operation: "text-statistics"`,
`words` and `bytes`. Word count uses the JavaScript reference's Unicode-aware
`trim()` and `split(/\s+/u)` behavior; bytes are UTF-8 length. For the GitHub
API example, see [`canonicalDelivery`](../agent/verify-delivery.mjs) for its
exact shape; the independent check verifies **repository identity only**, not
other metadata or freshness. Unknown result fields are rejected.

On a bad or unavailable delivery, the client's journal retains the confirmed
payment and marks the delivery unverified; it stops before later payments and
can retry the same transaction without repaying. The provider may still refuse
or be unable to deliver; there is no automatic refund, signed invoice or
on-chain proof of the resource result. Preserve payment/order state for manual
resolution. This protocol does not implement the marketplace's direct-delegated
x402 transfer, which would bypass the current restricted-key policy.
