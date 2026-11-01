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
npm install /path/to/output/bouncer-near-testnet-provider-sdk-0.1.0.tgz near-api-js@6.5.1
```

`npm pack` only creates the archive; it does not publish anything. The package
is marked private to prevent accidental publication. Installation resolves
`near-api-js` 6.5.1 and its dependencies; use your application's lockfile,
verify the archive and dependency integrity, and review the code before use.
The package includes its runtime verification modules, with the same canonical
implementation used by the Bouncer buyer. Packing and isolated verification are
covered offline by the repository tests. There is no warranty, independent audit
or production support.

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

For a real multi-customer seller, create and persist a fresh seller-owned order
ID or challenge for every order and bind it to the exact memo and price. Atomically
reserve each transaction for only that order. The reference v1 resource memo
is deterministic from the input and has **no per-order challenge**: identical
inputs produce identical memos, and the current resource agent does not negotiate
a separate challenge. A seller-specific challenge format therefore requires a
compatible buyer integration; the SDK alone does not add that negotiation.
Public memos are not authentication or secrets, and even a unique challenge
cannot force delivery or refund an incorrect payment.

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
