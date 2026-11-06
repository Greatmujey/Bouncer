# PayPerCall read-only inspection (experimental)

This is discovery and hash checking, **not a purchasing adapter**. It never
contacts a seller/operator endpoint, creates an order, signs, broadcasts,
spends tokens or creates a payment journal. JSON-RPC view calls use HTTP POST
but do not change chain state. The pinned source below is a reference, **not
proof of the currently deployed contract's code**.

## Check the public testnet catalog

From the repository's `bouncer` directory, with dependencies installed and a
reachable testnet RPC:

```sh
node agent/paypercall-inspect.mjs catalog --rpc https://rpc.testnet.near.org --limit 20 --offset 0
```

This command uses `devx-paypercall.testnet` and the Circle testnet USDC
contract by default. `--vault <account.testnet>` also checks the vault's
Circle registration and the escrow's prepaid storage credit for that account;
without it those checks are not made. Use `--offset` to inspect more entries.
At most 20 services are fetched per run. The inspector checks testnet, fetches
a recent FINAL block and pins all views to its hash; it fails on stale or
mismatched snapshots. RPC honesty and local clock accuracy remain assumptions.

An enabled, Circle-priced listing with an HTTPS-shaped hostname is only a
**candidate**. No DNS lookup or operator request is made; hostname syntax is
not evidence that the service is public, reachable, honest or willing to sell.
A scan is complete only for the reported range and `complete_catalog_snapshot`
is false if a service is unreadable or the range does not cover the catalog.
The contract's code hash and access-key counts are observations, not an audit
or proof that the code equals the referenced source. `payment_ready` is always
false.

A [fresh read-only scan](https://github.com/Greatmujey/Bouncer/actions/runs/42210554203)
on 6 November at a FINAL block saw two active listings, both native-NEAR-priced,
zero Circle candidates and no Circle storage registration for the escrow.
One listing contains a localhost endpoint; HTTPS-shaped syntax on the other
is not proof of a reachable compatible operator. The escrow had one full-access
key at that view. No operator was contacted and no payment was attempted.

A [read-only testnet snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/41476638933)
on 2 November 2026 at block `HmhKfsNMEjRYqQ5SBeaqVTWgQ4n2sQsiVJtXaNhLgeeD`
found two readable services, no Circle candidate, and no Circle storage
registration for the escrow. The same RPC view showed one full-access escrow
key and code hash `7idSVVpK69Loc9KhVuCm4KPG33xaQd8mtC6boq5L49q7`; these are
point-in-time observations, not evidence that the deployed code equals the
published source or cannot change. Conditions can change; rerun the inspector
before considering any testnet transaction.

## Check a previously observed call

`node agent/paypercall-inspect.mjs --help` lists the `call` arguments. The
caller must supply the exact call ID, service ID, payer, token, amount,
referrer and original request bytes; the chain view is checked against those
values at one pinned block. An optional `--answer-file` compares the SHA-256 of
its exact bytes, with no normalization or download. A matching hash ties those
bytes to the reported commitment only: it proves neither answer correctness,
availability, a Bouncer payment, provider payout nor independent delivery.
`Refunded` is a reported call state, not proof that the token transfer succeeded
or that the vault credited it. Unresolved operations must not be retried
blindly. Requests may be public in chain events; never put secrets in them.

## Correlating a forwarder-funded call (experimental)

`agent/paypercall-forwarder-evidence.mjs` adds a separate, **read-only**
verification API for the experimental one-shot forwarder. Given its original
public build terms, a separately retained provider/operator/price and code-hash
pin, three original transaction hashes, and the exact answer bytes, it checks:

1. The FINAL restricted-key `execute_exact_ft` transaction, owner-pinned intent,
   keyless reviewed vault, token event and successful callback for the transfer
   to the specific generated forwarder.
2. The forwarder's own FINAL `open` transaction, fixed transfer-call message,
   token resolver and matching PayPerCall `call_requested` event. The generated
   forwarder bytecode and keylessness must match at the relevant historical
   blocks. Earlier and later block-pinned token balances must also be consistent
   with an initially empty forwarder, and funding must precede opening.
3. The operator/provider's FINAL `fulfill` call, exact answer-byte hash and
   matching on-chain call view, followed by the **separately linked successful
   FT payout receipt and token event** to the expected provider. A successful
   `fulfill` status alone is not a payout.

`inspectPayPerCallForwarderEvidence` requests only those original receipts and
historical views, insists that the RPC reports `testnet`, and requires the
reviewed Circle testnet token code hash. It has no signer, seller HTTP client,
transaction-submission or automatic retry. Missing receipts, pruned historical
state, changed code, wrong balances, a failed payout or mismatched terms stop
verification. `verifyPayPerCallForwarderEvidence` and the separate historical
collector can also run on caller-supplied graphs, but those lower-level inputs
are not authenticated and can be synthetic. Neither is a buying runner.

Once an actual order exists, the same inspector can be run with its retained
public review and the exact locally saved answer bytes:

```sh
npm run inspect-paypercall-evidence -- --rpc https://test.rpc.fastnear.com \
  --review ./public-review.json --answer ./answer.bin
```

To additionally inspect **one already-recorded** forwarder-to-vault return,
append `--return-hash <original-hash> --return-amount <atoms>`. Both flags are
required together. The separate return check follows the linked token transfer,
vault `ft_on_transfer` callback and token resolver; checks the callback's promise
data ID, a complete used amount, and pinned historical code/key views; and
rejects changed or unavailable evidence. The token resolver for the opening
must likewise consume the exact escrow callback's promise data. All views still
rely on the caller's archival RPC. Never resend an unresolved return.

A successful return establishes a correlated forwarder-to-vault transfer and
vault callback under these assumptions. It does **not** establish that fungible
units came from that particular order, that a seller delivered anything, that a
rolling budget was restored, or that deployed code matches published source.
The CLI reports the order and return separately and leaves refund origin
unverified. This is read-only evidence, not a purchasing or recovery runner.

The review file contains exactly `format`, `terms`, `offer`, `funding_hash`,
`opening_hash`, `fulfillment_hash` and `fulfillment_signer`. Its `format` is
`bouncer-paypercall-forwarder-evidence-v1`; `terms` are the original public
inputs to `buildExperimentalForwarder`, and `offer` contains `provider`,
`operator`, `price`, `vault_code_hash`, `token_code_hash` and
`escrow_code_hash`. Amounts and hashes must match the original retained review;
`expires_at_ms` is a JSON integer. The CLI accepts regular files only, does not
print or transmit the answer bytes, and does not create a review or order. Do
not place credentials, bearer transactions, secrets or private requests in the
review. The seller's answer may itself contain private or untrusted data: keep
it private and inspect before publishing.

This is **correlation under trust assumptions**, not a proof of independent
delivery. The forwarder review currently fixes the service ID and maximum but
**does not enforce the provider, operator or exact price on-chain**; checking a
separately retained offer after execution cannot prevent a change in flight.
The escrow and token code hashes are pins, not proof that deployed bytecode
matches the reviewed source or cannot change between observations. An RPC can
lie; block-level balances do not attribute fungible token units or exclude
intervening same-block transfers. An answer hash does not authenticate the
HTTP peer or establish correctness. A successful payout and matching bytes
still do not show that the seller returned those bytes to the buyer. A separate
return check can correlate a vault credit but does not establish that its
fungible units originated in this order or fully settle a late-refund claim.
The verifier never resends an original or makes a failed verification a retry
signal.

The receipt checker [passed on disposable nearcore](https://github.com/Greatmujey/Bouncer/actions/runs/41676762624)
with the source-built PayPerCall contract, a mock FT, a locally supplied fixture
answer, historical block views and the detached provider payout. In that same
isolated fulfilled scenario, state checks showed 40 unused mock units returned
to the vault and a new 40-unit intent blocked by the still-full 100-unit rolling
budget. That earlier run checked the return by state, not by the newer receipt
verifier. That simulation is not Circle, a public-chain purchase, independent
provider fulfillment or an audit.

## V11 compatibility boundary

The [reviewed PayPerCall source](https://github.com/devx-agent/near-paypercall/blob/9159811bc6443ce29ae3c32482d0808f094caa87/contract/src/lib.rs)
opens token escrow using `ft_transfer_call` and requires prepaid native-NEAR
storage credit for the vault sender. V11's exact-intent-locked policy only
permits the one-shot **plain** `ft_transfer`; its generic FT-call route requires
an unlocked policy and is not one-shot. In the reviewed source, later
reject/expiry refunds and claims use plain `ft_transfer`; that transfer does
not invoke the vault's `ft_on_transfer` hook, and failed payouts can require a
claim by the keyless vault itself. Do not assume the deployed contract has the
same code or that any of these steps are usable by the current vault.

`tests/paypercall-v11-bytecode.test.mjs` runs the recovered, hash-verified V11
WASM on a deliberately incomplete synthetic host. It exercises the lock,
repeated unlocked route, immediate unused-amount callback and ledger behavior;
it does not run a token, PayPerCall or nearcore. A separate sandbox scenario is
prepared to compare plain and callback-based returns using **another V11 vault
as a stand-in receiver and the example mock FT**. Its local model tests are
synthetic. The [separate isolated nearcore run](https://github.com/Greatmujey/Bouncer/actions/runs/41469462871)
passed the added scenario: a 100-unit plain return changed the mock-token
balance but not the vault ledger; a separate transfer-call return credited the
receiver hook. The locked policy rejected the generic FT call, while an unlocked
route repeated within its cap. Neither scenario proves PayPerCall, Circle or
independent-provider compatibility.

One possible path that does not require the provider to change its refund
method is a **new, immutable one-shot forwarder**: the locked vault would pay
that forwarder by its existing exact `ft_transfer`; the forwarder would open
one fixed escrow request, claim any owed payout as the payer, then return
leftover tokens to the vault with `ft_transfer_call`. An [offline experimental
forwarder](../experiments/paypercall-forwarder/README.md) has passed disposable
nearcore tests using a mock token, first with a tiny stand-in and then with
[PayPerCall built from pinned published source](https://github.com/Greatmujey/Bouncer/actions/runs/41476520726).
The latter included an artificially failed refund and subsequent `claim`. It
has not been tested against the deployed PayPerCall contract or Circle and is
not safe for live use. It would add a new contract, token registration and
native storage costs; PayPerCall would see the forwarder rather than the
vault as payer. The vault's allowlisted payee would be the forwarder, so the
final escrow/request restrictions would depend on the new contract's code and
immutable setup, not V11 alone. Its expiry, one-shot behavior, races, claims,
refunds, receipt attribution, upgrade resistance and recovery would need real
runtime tests before it could be used. Returning tokens must not automatically
release V11's conservative rolling spend. A mutable or unguarded relay is not
an acceptable substitute.
