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

The shell used for development could not reach the public NEAR RPC, so no live
catalog observation by this inspector is claimed. A separate operator response
reported no public Circle-test-USDC service at the time it was written.

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
forwarder](../experiments/paypercall-forwarder/README.md) now compiles and has
synthetic-host tests, but is not nearcore-tested or safe for live use. It would
add a new contract, token registration and native storage costs; PayPerCall
would see the forwarder rather than the
vault as payer. The vault's allowlisted payee would be the forwarder, so the
final escrow/request restrictions would depend on the new contract's code and
immutable setup, not V11 alone. Its expiry, one-shot behavior, races, claims,
refunds, receipt attribution, upgrade resistance and recovery would need real
runtime tests before it could be used. Returning tokens must not automatically
release V11's conservative rolling spend. A mutable or unguarded relay is not
an acceptable substitute.
