# Bouncer seller verification (experimental, testnet)

This reference SDK helps a seller independently check a **direct** Bouncer
NEP-141 payment. It is a self-contained local npm package, not a published
package or a standard. No independent seller is known to have adopted it. The
live resource providers used so far are self-hosted development services, and
Circle **testnet** USDC has no real value.

## Package for a seller

Requires Node.js 22 or newer. From a trusted checkout, create an archive and
install that local file in the seller's application:

```sh
npm pack ./bouncer/packages/provider-sdk --pack-destination /path/to/output
npm install /path/to/output/bouncer-near-testnet-provider-sdk-0.3.0.tgz near-api-js@6.5.1
```

`npm pack` only creates the archive; it does not publish anything. The package
is marked private to prevent accidental publication. Installation resolves
`near-api-js` 6.5.1 and its dependencies; use your application's lockfile,
verify the archive and dependency integrity, and review the code before use.
The package includes its runtime verification modules, with the same canonical
implementation used by the Bouncer buyer. Packing and isolated verification are
covered offline by the repository tests. A [read-only CI check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41259817473/job/124710584367)
also installed the archive in a separate application, verified three existing
Circle testnet payment receipts and rejected substituted sellers without making
new payments. The seller was still self-hosted development software. There is
no warranty, independent audit or production support.

## Seller integration

Import `readAndVerifyProviderPayment` from the installed package, or from
`./packages/provider-sdk/index.mjs` relative to the `bouncer` directory in a
checkout. Provide a `near-api-js` provider and a seller-created expectation with
these exact string fields:

- `tx_hash`: the buyer's finalized transaction hash;
- `contract_id` and `owner_account_id`: the seller's vetted testnet Bouncer
  deployment and its owner account, which can be different;
- `policy_id`, `token`, `payee` and `amount`: the seller's own configured
  policy, testnet token, receiving account and exact smallest-unit price;
- `memo`: the seller's expected order binding, computed from the order received
  by the seller. A seller can use the example protocol in the corresponding
  checkout's `bouncer/docs/PROVIDER_PROTOCOL.md`, or a different agreed, unique
  order-binding memo.

The reference v1 memo is deterministic and has **no per-order challenge**.
The resource buyer and reference seller now also support the opt-in v2 protocol
below. The SDK's receipt verifier alone does not allocate orders, claim
transactions, fulfill or refund them. Public challenges are not authentication
or secrets, and cannot force delivery or refund an incorrect payment.

The buyer must **not** be the authority for the seller's contract, RPC, price,
token, payee or memo. Persist the seller's order and expected values before
payment. Restrict acceptable deployments to ones the seller independently
vets; a version string does not prove deployed code. Configure the buyer-side
Bouncer owner separately to allowlist the seller, token and caps. Policy
escalation requires the owner-only **1 yoctoNEAR** call.

```js
import nearApi from 'near-api-js';
import { readAndVerifyProviderPayment } from 'bouncer-near-testnet-provider-sdk';

// Stored by the seller when it accepted the order, not supplied as authority
// in a buyer's later redemption request. All fields are exact strings.
const expectation = await sellerStore.loadReviewedExpectation(orderId, txHash);
const provider = new nearApi.providers.JsonRpcProvider({ url: sellerPinnedRpc });
const proof = await readAndVerifyProviderPayment({ provider, expectation });
// Atomically reserve proof.tx_hash for this order in the seller's own durable,
// shared database BEFORE any side effect. A different order must not reuse it.
```

The SDK asks the RPC for `chain_id: testnet` and receipt-inclusive transaction
status with `FINAL` execution. It checks a canonical hash, owner and contract;
the signed zero-deposit `execute` action with **200 TGas**; exact policy, token,
payee, amount and memo; the unique guarded initiation; the actual successful
Bouncer-to-token `ft_transfer` and callback; and their receipt-graph bindings.
Missing, failed, ambiguous, substituted or duplicated evidence is rejected.
It does not verify which agent key was granted: that is enforced by the trusted
Bouncer deployment. `verifyProviderPayment(result, expectation)` is also
available for an already-fetched receipt-inclusive response; its caller must
independently check the network before calling it.

This depends on the seller's RPC, Bouncer deployment and token code being
honest and correctly configured. An implicit 64-hex token address does not
identify its network; even an RPC reporting testnet can lie. This is **not a
light-client proof**, a replay database, a generic x402 implementation, or
proof that the seller delivered a resource. The three reconstructed historical
memo vectors can be compared with the public [compute](https://testnet.nearblocks.io/txns/7XxeU466RVYvVN3wBrWqXHu2zeHHyFPcs4WhNuFX2GbJ/execution),
[storage](https://testnet.nearblocks.io/txns/GJkJMWBF2CCh1H5uh9uAKJJciTsqcvcgKvNXvnJrEvjL/execution)
and [API](https://testnet.nearblocks.io/txns/7RxBwG4G6FRqG1o2shYRN2ES2WsxVFdEMd8NWp7zA5vy/execution)
receipts. In a [read-only historical RPC check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41101505909/job/124219376411),
the SDK accepted all three existing payments with receipt-inclusive `FINAL`
data and rejected a substituted seller. These were still payments to our own
development provider; no independent integration or new transaction is claimed.
A separate regression test uses a **partial reconstruction** of the compute
payment from FastNEAR testnet blocks 275463446–449; its final status was
synthesized and unrelated receipts were omitted, so that fixture alone is not a
complete RPC response. The SDK does not support Bouncer's
`execute_ft_call`, OutLayer prepaid projects or arbitrary `execute` gas values.
A buyer and seller must agree on the exact order/memo and handling of failures.

## Opt-in authenticated orders (v3)

V3 adds a NEP-413 claim signed by the **actual FINAL transaction key**, with the
seller origin and the seller-issued exact task, chain, contract, owner, payment
terms and transaction hash in the signed message. It remains a custom testnet
protocol: no independent seller adoption or production security is established.
The signature is a replayable bearer credential, so use TLS and protect journals,
logs and responses. It does not provide general user identity or solve a
malicious seller, retention, expiry, refunds or distributed replay protection.
V1/v2 do not gain authentication merely by installing this SDK.

The seller must create and durably save a random 16-byte challenge and its own
reviewed product/order terms, then return `orderMemoV3(resource, input,
challenge)` and the configured canonical origin with auth scheme
`bouncer-nep413-claim-v1`. Match the buyer request to that stored quote, not
untrusted client-supplied financial terms. With a trusted testnet RPC, seller's
own `expectation`, seller-created `claimTerms` and the buyer's `authorization`:

```js
import { readAndVerifyAuthenticatedProviderPayment } from 'bouncer-near-testnet-provider-sdk';
const payment = await readAndVerifyAuthenticatedProviderPayment({
  provider: trustedTestnetRpc,
  expectation: storedPaymentExpectation,
  claimTerms: storedClaimTerms,
  authorization: request.authorization,
});
// payment.agent_public_key came from the FINAL transaction and must be stored
// with an atomic claim of both quote and hash BEFORE doing work. Require the
// signature again for cached results and storage reads, not just the first call.
```

The `expectation` has `tx_hash`, `contract_id`, `owner_account_id`, `policy_id`,
`token`, `payee`, `amount` and `memo`. `claimTerms` has those same fields plus
`network: 'near:testnet'`, `seller_origin` and `resource`. The SDK checks the
FINAL receipt graph, compares terms, and verifies the NEP-413 signature against
its actual signer key. It does not operate the seller's quote/replay database or
make side effects transactional. `orderMemoV3`, `challengeFromOrderMemoV3`,
`signClaimAuthorization` and `verifyClaimAuthorization` are also exported.
See the checkout's `bouncer/docs/SELLER_V3.md` for exact canonical bytes, a fixed
vector, HTTP flow, state migration, bearer-credential handling and limitations.
The Node package test independently imports the packed archive and exercises
v3; it does not prove real merchant compatibility.

## Opt-in seller-issued orders (v2)

The SDK exports `normalizeOrder`, `orderMemo`, `orderMemoV2` and
`challengeFromOrderMemo`. The last two implement an **optional**, explicitly
owner-approved Bouncer buyer/seller protocol. V1 remains the default; never
silently downgrade an owner-approved v2 order to v1. For a v2 quote, a seller:

1. Normalizes the resource input as below and generates a fresh, unpredictable
   16-byte challenge using a cryptographically secure random generator. Encode
   it as exactly 32 lowercase hexadecimal characters. Persist the challenge,
   resource, memo (which commits to the normalized input) and exact
   policy/token/payee/amount **before** returning the quote. Persist the input
   as well if your seller must reconstruct it independently; the reference
   seller stores its commitment, not the input itself. Handle collisions by
   generating a new challenge.
2. Returns the pinned terms and the memo below. The buyer verifies the memo,
   pins all financial terms separately, and includes this exact memo in Bouncer's
   guarded `execute` call. The memo is also supplied to `/redeem`.
3. Checks FINAL transaction and actual FT receipts against that original quote
   using `readAndVerifyProviderPayment` (plus delivery-specific checks).
   Atomically and durably claim at most one transaction hash for the challenge
   **before** any side effect. Replays of that same hash must return the existing
   result or reconcile pending work; a different hash must not repeat the work.
   Coordinate the claim across every process/host sharing the seller account.

Wire example (the challenge here is a fixed **test vector**, not randomness):

```http
POST /quote

{"resource":"compute","input":{"text":"same work","rounds":2},"order_binding":"seller-v2"}
```

```json
{"ok":true,"quote":{"resource":"compute","policy_id":"resource","token":"wrap.testnet","payee":"vendor.testnet","amount":"1000","memo":"bouncer-order-v2:compute:00112233445566778899aabbccddeeff:88425334a4bb614fc54e3425a4d9cb3203fa9b4548ac732e006fd3d53d315fc5"}}
```

The quote fields shown are illustrative; terms must match the actual owner
approval and deployment. Redeem with `POST /redeem` containing `resource`, the
same normalized `input`, the **exact** `memo`, and `tx_hash`. Terms are looked up
from seller state, not accepted from the caller. Use the same quote and hash for
recovery. Do not pay twice for one challenge: a later payment to an already
claimed quote cannot be redeemed by the reference seller.

### Exact memo algorithm

Let `normalized` be `normalizeOrder(resource, input)`. Compute:

```text
body   = UTF8(ECMAScript JSON.stringify(normalized))
digest = lowercase_hex(SHA256(UTF8("bouncer-order-v2") || 00 || UTF8(resource) || 00 || UTF8(challenge) || 00 || body))
memo   = "bouncer-order-v2:" + resource + ":" + challenge + ":" + digest
```

Each `00` is a single zero byte; `||` concatenates bytes. The challenge is its
32 ASCII hexadecimal characters, not the decoded 16 bytes. JSON serialization
adds no whitespace or trailing newline (string contents are preserved). Normalized
inputs have these exact key orders: compute
`{text,rounds}` (both required); storage `{name,content}`; API `{text}` or
`{repo}`. Repository IDs are validated and preserve case. Strings and
serialization must match well-formed ECMAScript `JSON.stringify` followed by
UTF-8, including JSON escaping and Unicode behavior. Sizes and allowed inputs
are enforced by `normalizeOrder`. The SDK exports these helpers to avoid
cross-language canonicalization differences; the fixed vector above is
regression-tested. A second vector, including a newline and non-ASCII text:

```text
resource:  compute
input:     {"text":"A\nπ😀","rounds":3}
challenge: ffeeddccbbaa99887766554433221100
memo:      bouncer-order-v2:compute:ffeeddccbbaa99887766554433221100:e014b592b4181aa13caeb34013188ae2dff73c4c7d75379de2ad0c1c1ccb5417
```

Here `\n` is a JSON escape for one newline. The v1 memo remains
`bouncer-order-v1:<resource>:<sha256>` over JSON of the normalized input alone.

The challenge is public in the quote and on chain: it is **not authentication,
a secret or confidentiality**. A party with the order details and transaction
hash may attempt redemption before the intended buyer; build a separate
buyer-authentication and delivery-authorization scheme before selling private
work. Unpaid quotes cannot safely expire solely because time has passed: a
valid transfer could have been submitted or delayed. A different transaction
paying an already-claimed challenge requires separate manual refund/dispute
handling. RPC, contract, token and seller remain trust assumptions.

## Reference provider state and recovery

`services/resource-provider.mjs` uses this verifier for its local demo products.
It refuses providers without receipt-inclusive RPC support. One process holds
an exclusive `provider.lock` for its data directory; in that process, up to
eight different redemptions can progress, and identical requests coalesce.
Before a non-repeatable side effect it syncs pending state, then syncs any
storage object and completed state. Each step synchronizes both the file and
its directory; a write or sync failure stops the instance. These guarantees
assume a local filesystem that implements exclusive creation, atomic rename
and `fsync` correctly. They do not survive arbitrary filesystem corruption,
compromised hosts, deleted state, or use of **different** data directories.
This is not a replicated/distributed idempotency system and is not production
hosting. Store contents and results are plaintext, and the server has no auth
or TLS.

Close with `await provider.close()`; it stops new work, drains in-flight
redemptions and releases the lock. A process killed or a machine crash may
leave `provider.lock` and pending entries. **Never remove a lock just because
it is old or a PID is absent.** First confirm every writer on every host using
the directory is stopped, preserve the files, and manually reconcile pending
payments/side effects. Only then may an operator remove the stale lock and
restart; a pending order still blocks automatic re-fulfillment.

New `redemptions.json` files bind the testnet, Bouncer contract and owner. The
older version 1 lacked this binding. A nonempty legacy file fails closed by
default. To adopt it, first stop all old writers and independently review that
it belongs to the configured contract/owner; then explicitly set
`"adopt_legacy_state": true` in the local provider config (or pass
`adoptLegacyState: true` to `createResourceProvider`). The locked provider
writes version 2 before starting; pending entries remain pending. Remove the
flag afterward. Do not adopt a file of uncertain origin.

The first v3 quote upgrades the local store to version 4 with the configured
seller origin and transaction-key claims. Older binaries cannot read version
4; never roll state back, and protect buyer journals containing v3 bearer
signatures. The first v2 quote upgrades a version-2 state file to version 3. Version 3
persists each quote and its claimed hash along with legacy redemptions; older
provider binaries cannot read it. Do not roll back the software or restore an
older snapshot over newer claims: doing so can lose replay protection. A v2
quote is only returned after the state and containing directory have been synced.
The reference provider keeps at most 1,024 v2 quotes per directory, including
claimed and abandoned quotes, and fails closed at capacity. It does not
silently evict or auto-expire unpaid quotes. Comparison and dry runs that request
v2 quotes can fill that capacity without paying; operate a carefully reviewed
manual reconciliation/archival process or use a properly designed shared seller
database instead. Do not delete quotes or state just to regain capacity.

These are reference-implementation properties, not guarantees supplied by the
SDK's verifier. Offline tests cover v2 issuance, conflicting claims, crashes,
restarts and buyer recovery. A [separate live testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41263055741/job/124720514951)
paid three v2 orders to our self-hosted reference seller and recovered the
original compute hash after a seller restart. The previous installed-SDK
historical receipt check used v1. A subsequent [read-only installed-SDK check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41263695312/job/124721960599)
verified the v2 source and three existing FINAL receipts and rejected substituted
sellers and challenges without new payments. These checks do not prove independent
seller adoption or real-value payment.
