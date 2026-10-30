# Bouncer seller verification (experimental, testnet)

This reference SDK helps a seller independently check a **direct** Bouncer
NEP-141 payment. It is included in this repository, not a published package or
a standard. No independent seller is known to have adopted it. The live
resource providers used so far are self-hosted development services, and Circle
**testnet** USDC has no real value.

## Seller integration

Import `readAndVerifyProviderPayment` from `./packages/provider-sdk/index.mjs`
relative to the `bouncer` directory. Provide a `near-api-js` provider and a
seller-created expectation with these exact string fields:

- `tx_hash`: the buyer's finalized transaction hash;
- `contract_id` and `owner_account_id`: the seller's vetted testnet Bouncer
  deployment and its owner account, which can be different;
- `policy_id`, `token`, `payee` and `amount`: the seller's own configured
  policy, testnet token, receiving account and exact smallest-unit price;
- `memo`: the seller's expected order binding, computed from the order received
  by the seller. A seller can use the example [resource protocol](../../docs/PROVIDER_PROTOCOL.md)
  or a different agreed, unique order-binding memo.

The buyer must **not** be the authority for the seller's contract, RPC, price,
token, payee or memo. Persist the seller's order and expected values before
payment. Restrict acceptable deployments to ones the seller independently
vets; a version string does not prove deployed code. Configure the buyer-side
Bouncer owner separately to allowlist the seller, token and caps. Policy
escalation requires the owner-only **1 yoctoNEAR** call.

```js
import nearApi from 'near-api-js';
import { readAndVerifyProviderPayment } from './packages/provider-sdk/index.mjs';

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
proof that the seller delivered a resource. It does not support Bouncer's
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
