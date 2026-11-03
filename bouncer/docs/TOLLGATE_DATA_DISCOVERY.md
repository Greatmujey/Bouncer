# Independent data discovery: Tollgate on NEAR testnet

Bouncer's current V12 vault is funded with Circle test-USDC. Tollgate is a
separate, independently operated public testnet data API, but its published
`near-channel` offer is denominated in **native test NEAR**, not Circle USDC.
The read-only V12 discovery checks the public 402 terms and a single FINAL
trusted-RPC block for the keyless vault and channel contract. It makes one
unpaid GET only: no voucher signature, channel, payment or data delivery.

The live offer, source and chain state can change independently. In the
[3 November read-only run](https://github.com/Greatmujey/Bouncer/actions/runs/41644777424),
the seller advertised 0.001 test NEAR for the quakes endpoint and the observed
channel code hash matched its published deployment record. That request omitted
`path=quakes`, which the offer appended, so its exact-resource check failed.
The discovery now requests the provider's explicit rewritten URL and requires
an exact match; an unpaid web read returned that same URL, but a fresh pinned
runner result still needs verification. The [earlier public snapshot](../evidence/testnet-owner-v3/tollgate-readonly-20261103.json)
is not an executable quote; an unrecognized value blocks use. The code-hash
match does **not** establish source-to-build equivalence, API behavior, seller
reliability or an independent audit. A provider response or contract receipt
would still need to be tied to the **specific requested resource** before
claiming fulfillment.

## Why V12 must not pay it

- V12 has no owner-configured Tollgate channel-opening method. Opening from an
  unrestricted external owner would bypass the vault and isn't a Bouncer
  policy-enforced purchase.
- Tollgate's published voucher signs the channel, cumulative amount and nonce,
  but not the HTTP resource or response. Consequently an HTTP 200 or an
  unrelated voucher alone would not prove the data requested was delivered.
- The public seller's published Vercel implementation stores voucher state in
  per-instance ephemeral storage and accepts the voucher before fetching the
  upstream data, so its source indicates an upstream failure can still cost the
  buyer. Durability and deployed-source equivalence are unverified. The channel
  minimum excludes channel storage and transaction gas; unused money and refund
  timing must be established before any payment.
- Circle and native NEAR use different token budgets. A native-NEAR channel is
  not a Circle-USDC purchase, nor a substitute for one.

The discovery source is `agent/tollgate-v12-readiness.mjs`; the script and
workflow use read-only interfaces. Tests use synthetic responses and do not
show live fulfillment. An experimental **fresh-state-only**, separately built
V13 contract feature (`contracts/bouncer/src/tollgate_v13.rs`) starts a possible
channel path without modifying the deployed V12 vault. It consumes an
owner-pinned intent once, requires both seller and channel allowlists, uses a
separate voucher key and reserves the whole native budget under the existing
cap and rolling spend rules. Its owner-only setup and close methods use the
1-yocto guard. A failed callback can come from a downstream promise after a
provider accepted funds, so **every failed or ambiguous open retains the full
reservation** and never reopens the intent. Before a close, an owner-only
verification checks the channel's reported owner, seller, voucher key, budget
and ID; it can also recover a lost callback. The provider's view can still lie.
A detached channel refund is not automatically credited: the owner must
reconcile the actual transfer and may recover surplus with the existing owner
path. This is an experimental
contract, **not deployed or audited**; it cannot claim delivery, accept Circle
as native NEAR, or solve resource-unbound voucher risk. Tests and a real
isolated runtime exercise must precede any potential testnet deployment.

References: [Tollgate repository](https://github.com/Mattbusel/tollgate),
[public quakes endpoint](https://near-tollgate.vercel.app/v1/quakes?min_magnitude=5),
[published reference deployment](https://github.com/Mattbusel/tollgate/blob/ab9c13fbd9efea70ac27c6e35623925ecd0b9a6f/deployments/testnet.json).
