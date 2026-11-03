# Independent data discovery: Tollgate on NEAR testnet

Bouncer's current V12 vault is funded with Circle test-USDC. Tollgate is a
separate, independently operated public testnet data API, but its published
`near-channel` offer is denominated in **native test NEAR**, not Circle USDC.
The read-only V12 discovery checks the public 402 terms and a single FINAL
trusted-RPC block for the keyless vault and channel contract. It makes one
unpaid GET only: no voucher signature, channel, payment or data delivery.

The live offer, source and chain state can change independently. The discovery
is deliberately not an executable quote; an unrecognized value blocks use. The
published contract's apparent source-to-deployment match, API behavior, seller
reliability and security are not independently audited. A provider response or
contract receipt would still need to be tied to the **specific requested
resource** before claiming fulfillment.

## Why V12 must not pay it

- V12 has no owner-configured Tollgate channel-opening method. Opening from an
  unrestricted external owner would bypass the vault and isn't a Bouncer
  policy-enforced purchase.
- Tollgate's published voucher signs the channel, cumulative amount and nonce,
  but not the HTTP resource or response. Consequently an HTTP 200 or an
  unrelated voucher alone would not prove the data requested was delivered.
- The public seller's published Vercel implementation stores voucher state in
  per-instance ephemeral storage. Durability and deployed-source equivalence
  are unverified. The advertised minimum deposit excludes channel storage and
  transaction gas; unused money and refund timing must be established before
  any payment.
- Circle and native NEAR use different token budgets. A native-NEAR channel is
  not a Circle-USDC purchase, nor a substitute for one.

The discovery source is `agent/tollgate-v12-readiness.mjs`; the script and
workflow use read-only interfaces. Tests use synthetic responses and do not
show live fulfillment. Any future implementation needs a separately reviewed,
limited, owner-authorized channel lifecycle with on-chain native caps,
allowlisted seller and contract, bounded voucher authority, durable recovery,
refund handling and resource-bound evidence; it must not silently upgrade or
bypass the existing keyless vault.

References: [Tollgate repository](https://github.com/Mattbusel/tollgate),
[public quakes endpoint](https://near-tollgate.vercel.app/v1/quakes?min_magnitude=5),
[published reference deployment](https://github.com/Mattbusel/tollgate/blob/ab9c13fbd9efea70ac27c6e35623925ecd0b9a6f/deployments/testnet.json).
