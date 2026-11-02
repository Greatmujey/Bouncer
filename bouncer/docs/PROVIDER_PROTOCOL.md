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

### Experimental third-party onchain-proof compatibility

The separate [onchain-proof buyer](ONCHAIN_PROOF.md) targets PipRail-style x402
v2 `onchain-proof` rather than this document's Bouncer seller-v2 wire format.
A synthetic test exercises the independently published PipRail 3.3.0 NEAR
verifier with an explicitly wrapped testnet driver and nested Bouncer receipts.
Its public proof is not authenticated or bound to the purchased URL/order, and
the SDK's default replay store is in memory. Both risks require explicit owner
acceptance. This is not the standard x402 `exact` delegate flow, a live
independent purchase, or evidence that a merchant offers the testnet scheme.

### Independent-provider research: MultiAgency

MultiAgency's public testnet demo historically accepted a seller-generated memo
and Circle testnet USDC into its DAO for asynchronous agent/human work. Its
[deposit scanner](https://github.com/MultiAgency/near-agencies/blob/staging/lib/history.mjs)
looks for the token's transfer event, potentially compatible with an indirect
Bouncer `ft_transfer`. However, the operator's newer
[removal plan](https://github.com/MultiAgency/near-agencies/blob/staging/docs/plans/remove-payments.md)
explicitly says **no client deposits** and states that payout keys have been
removed. The legacy site and API may still display a 3-test-USDC deposit flow;
that is not evidence the operator is accepting or fulfilling paid orders. Do not
submit a quote or send funds to this stale path. No MultiAgency purchase or
independent FT-paid delivery has been demonstrated by Bouncer.

### Independent-provider research: T402 direct payments

[T402's NEAR documentation](https://docs.t402.io/reference/other-mechanisms)
describes an `exact-direct` NEP-141 transfer followed by a transaction-hash
proof. Inspection of the published [`@t402/near` 2.9.0 package](https://registry.npmjs.org/@t402/near/-/near-2.9.0.tgz)
shows that its TypeScript facilitator checks the **root transaction receiver**
is the token contract and looks for a root `ft_transfer` action. A Bouncer
payment instead signs a zero-deposit `execute` action to the Bouncer contract,
which then creates the token transfer in a receipt. Therefore this published
verifier will reject the Bouncer transaction even if the nested transfer paid
the seller. Sending a direct `ft_transfer` with a full-access key would bypass
Bouncer's policy and 1-yocto security boundary; it is not an integration.

A merchant would need to opt into a receipt-aware verification extension, such
as the experimental Bouncer provider SDK below. Do not relabel that custom
extension as stock T402 compatibility or assume an independent merchant accepts
it. T402's documented `usdc.fakes.testnet` example is not Circle's canonical
NEAR testnet USDC; exact token and network IDs must be owner-pinned. No T402
seller was paid or contacted by this research.

### Independent-provider research: x402 `exact-agent` draft

An independent [payment-agent project](https://github.com/mikedotexe/near-payment-agent/tree/666d5efefeec9fb311af231c67dd90b593301933)
reports direct and relayed Circle testnet USDC transfers with a scoped key and
proposes a draft [x402 `exact-agent` scheme](https://github.com/mikedotexe/near-payment-agent/blob/666d5efefeec9fb311af231c67dd90b593301933/docs/x402-exact-agent-scheme.md).
This is a promising shared security idea, not a ready Bouncer integration. Its
draft expects a relayed NEP-366 self-call to `pay(recipient, amount, payment_id)`
on a specifically trusted payment-agent contract. Bouncer's current restricted
key signs a direct `execute` call with policy and memo arguments; the two
transaction envelopes, contract APIs and replay mechanisms are different. The
project describes facilitator/client packaging as future work; its testnet
token-transfer evidence is not evidence of a functioning independent paid
service or a Bouncer-compatible facilitator. No seller was contacted or paid.
Any bridge would need an explicitly reviewed scheme and merchant/facilitator
support without bypassing Bouncer's caps or the 1-yocto owner boundary.

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

The current runner follows no redirects. Quotes and redemption bodies are JSON;
client response bodies are bounded to 64 KiB and storage readback to 4096 bytes.
The reference server accepts request bodies of at most 32 KiB (allowing for JSON
escaping of bounded input). Orders disclose their full inputs to the provider.
The reference server is loopback-only, without TLS, general user identity or
distributed durability. V1/v2 are unauthenticated; the opt-in [seller-v3](SELLER_V3.md)
claim checks the FINAL transaction key, but its signature is still a replayable
bearer credential. It is not a suitable public deployment.

### Optional authenticated seller-v3

The newer [seller-v3 protocol](SELLER_V3.md) adds an owner-reviewed seller
origin and a NEP-413 claim signed by the actual payment transaction key. The
reference buyer, seller, SDK and storage readback implement it behind explicit
opt-in. Do not mix its bearer credentials with public v1/v2 recovery artifacts.
The file-backed reference seller also has a separately gated live testnet proof
with self-hosted delivery; it is not an adopted merchant standard or a production
identity/security system. A separate [shared PostgreSQL seller](SHARED_SELLER.md)
has synthetic-payment integration tests only and has not been exercised live.

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
The v1 memo is deterministic, so identical inputs have identical memos; it is
not a seller-owned unique order challenge or buyer authentication. The quote is
unsigned and has no expiry or delivery guarantee. The agent checks its fields
against owner limits and may requote before paying; it does not implicitly trust
a listing, model or quote as financial authority.

### Optional seller-v2 binding

An owner can explicitly require a seller-issued challenge by adding
`"order_binding":"seller-v2"` to a resource goal or reviewed workflow step,
or to the primary or an alternative in the AI planner's owner catalog. The
buyer adds that field to `/quote` and rejects a v1 response; absent the opt-in,
it requires the legacy v1 memo and rejects unsolicited v2. The seller must
persist a fresh 128-bit challenge, its commitment to the normalized input and
exact product terms before returning each v2 quote. The reference seller stores
the commitment rather than the input; the buyer must retain its original input.
For example:

```json
{"resource":"compute","input":{"text":"same work","rounds":2},"order_binding":"seller-v2"}
```

For the **fixed test challenge** `00112233445566778899aabbccddeeff`, the
response's `quote.memo` is exactly:

```text
bouncer-order-v2:compute:00112233445566778899aabbccddeeff:88425334a4bb614fc54e3425a4d9cb3203fa9b4548ac732e006fd3d53d315fc5
```

See the SDK's [exact byte algorithm, fixed vector and seller responsibilities](../packages/provider-sdk/README.md#opt-in-seller-issued-orders-v2).
The included reference seller uses a cryptographically random challenge and
atomically stores the first verified transaction hash for each challenge before
fulfillment. A different hash for the same challenge is rejected, even if it
also paid; same-hash replay is idempotent or requires manual reconciliation.
The challenge is public, not authentication or a secret. Without separate
authentication an observer with the order and transaction hash can attempt to
redeem first; this interface cannot protect private work. No automatic refund is
provided for an incorrect or second payment.

V2 live execution requires durable signed-hash journaling; retain the same goals,
provider state and journal for recovery. A resource-agent quote dry run and an
AI quote comparison can persist v2 quotes without making any payment. The
reference state holds at most 1,024 v2 quotes per directory, with no automatic
eviction: unpaid quotes cannot safely be expired merely because time elapsed,
since a delayed valid payment may exist. At capacity it fails closed. The
state migrates to version 3 upon first issuance; do not restore older snapshots
or run older software against it. V2 has adversarial offline coverage and a
[live testnet run](https://github.com/Greatmujey/Bouncer/actions/runs/41263055741/job/124720514951)
with three distinct challenges, a seller restart and original-hash recovery.
That run used our own development seller; it does not demonstrate independent
FT seller adoption or real-value transactions. A separate [read-only check](https://github.com/Greatmujey/Bouncer/actions/runs/41263695312/job/124721960599)
installed this SDK in another application, verified the existing v2 source and
three FINAL receipts, and rejected changed payees and challenges; it made no
payments.

## 2. Confirm payment and redeem

After a finalized payment the client sends:

```json
{"tx_hash":"<payment transaction hash>","resource":"compute","input":{"text":"Bouncer protocol test","rounds":3}}
```

The example is v1; a v2 redemption also includes the **exact quoted `memo`**,
which identifies the seller's persisted order. Its terms come from the seller's
state, never from the redemption body. The endpoint is `POST /redeem`. Before
any paid side effect, a provider should fetch the transaction from its trusted
NEAR testnet RPC with `FINAL` execution
and fail closed unless the expected receipts have completed successfully. The
[provider SDK](../packages/provider-sdk/README.md) can be packed and installed
locally by a seller (it is not published) and checks the transaction hash,
pinned owner and contract, zero-deposit signed `execute` and exact order fields.
It also binds the guarded initiation to the actual Bouncer-to-token
`ft_transfer` and settlement callback, verifies their arguments and successful
outcomes, and rejects duplicate receipt IDs. Its supported direct-payment
format currently uses the Bouncer runner's **200 TGas** `execute` action. An
RPC without receipt-inclusive `FINAL` data fails closed. This is neither a
light-client proof nor a generic FT or service-delivery verifier; a malicious
RPC, upgraded contract or token remains a trust risk.

Persist a unique transaction-to-order binding before non-repeatable side
effects; return the same result for the same transaction and order, and reject
a different order. A pending or ambiguous prior fulfillment needs reconciliation,
not an automatic second side effect. The reference provider holds an exclusive
lock for one local data directory, coalesces duplicates, limits concurrent
redemptions to eight and synchronizes each state/object file and directory.
This depends on local filesystem semantics and excludes other writers only if
they share that directory and respect its lock. It does not coordinate separate
directories or machines, and is not distributed replay protection. A real
provider needs its own transactional, replicated system, authentication and TLS.
The SDK is an integration tool, not evidence that an independent seller has
adopted it.

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
resolution. The [dependent workflow runner](DEPENDENT_WORKFLOWS.md) may replay
an already-paid transaction during key-free recovery, without a new quote or
payment; providers must make redemption for that transaction and exact order
idempotent. A workflow may send a prior verified artifact as order input, so do
not put secrets in it. This protocol does not implement the marketplace's
direct-delegated x402 transfer, which would bypass the current restricted-key policy.
