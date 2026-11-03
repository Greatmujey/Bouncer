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
The discovery now requests the provider's explicit rewritten URL. In a [fresh
read-only run](https://github.com/Greatmujey/Bouncer/actions/runs/41648461093),
the advertised and requested URLs matched exactly at the observed instant;
the [snapshot](../evidence/testnet-owner-v3/tollgate-exact-resource-20261103.json)
is not an executable quote and the voucher still does not cryptographically
bind the resource. Unrecognized values block use. The code-hash
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
as native NEAR, or solve resource-unbound voucher risk. The earlier [unit/build run](https://github.com/Greatmujey/Bouncer/actions/runs/41648346175)
passed for a previous experimental contract, including conservative failed
promise handling and owner-only recovery. The hardened binary then passed the
[isolated runtime exercise](https://github.com/Greatmujey/Bouncer/actions/runs/41649077636):
a locally simulated channel opening, voucher settlement, close, refund and
failed-open conservative accounting. This used a local seller and is neither
live fulfillment nor an audit. The original binary was 602,587 bytes. A
size-optimized 388,570-byte build was reproduced on two GitHub runners and
[passed the same isolated lifecycle](https://github.com/Greatmujey/Bouncer/actions/runs/41652177986);
its SHA-256 is `783c7fc06f55868bff8e9f53d41dc896e9d6ac3056c37f6fd18de4f1d270a540`.
The code alone requires approximately 3.8857 test NEAR at the last observed
storage price; state, native reserves, channel budget and fees are additional.
Matching builds and sandbox results are not independent security review or a
live deployment. Any future deployment needs a fresh balance and safety preflight.

## Voucher-aware candidate and one-shot data client

The subsequent candidate adds `is_tollgate_voucher_authorized`, a read-only
check for an owner-verified channel and the original, still-current policy,
allowlist and agent revisions. It is only an **advisory check for a cooperative
client**: a policy can change after the view, and a stolen key or previously
signed voucher cannot be revoked by that view. The off-chain key can sign up
to the channel deposit, not merely the advertised per-call price. The channel
contract still has an observed full-access key and can be upgraded. The seller
voucher itself does not bind the HTTP resource or response. Those limitations
remain even when a review hash includes the exact URL.

Two independently run optimized builds at commit `45a6706` matched at
**389,988 bytes**, SHA-256
`ed1bb4fb01313576f88c719d5c7283d2366a60c580295863a759f5f9ee699231`,
public blob `f3ad44590b1d816bf0d4c6ceb29e6c917c01056c`. The
[contract tests](https://github.com/Greatmujey/Bouncer/actions/runs/41653914337)
and [isolated lifecycle](https://github.com/Greatmujey/Bouncer/actions/runs/41653914001)
passed, including the new advisory view, restricted-agent opening, local voucher
settlement and detached refund. That lifecycle used a local seller; the
candidate is **not deployed, independently audited or evidence of live data**.
At the last observed storage price the code alone needs 3.89988 test NEAR. The
last separately observed owner balance was about 3.969798 test NEAR: code plus
the 0.05-NEAR vault reserve and 0.02-NEAR channel budget already exceed that,
even before state storage, owner storage and gas. A [read-only funding
snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/41656376800) at
FINAL block `CmSXM6eCCjnDRJXYUskrMmU8Hanja2ao6Rfo77CYTF3z` found about
3.967978 test NEAR after estimated owner storage. The conservative plan uses
5 test NEAR for the new vault plus a 0.2 test-NEAR owner fee reserve, leaving
an estimated **1.232022 test-NEAR shortfall**. V12's calculated native surplus
was at most 0.57903 test NEAR at that snapshot; even recovering all of that
hypothetically leaves roughly 0.652992 test NEAR short of the plan. This is an
upper bound, not a withdrawal authorization or a fee guarantee. Circle actual
and tracked balances remained 6,898 atoms. That snapshot itself moved no
funds. Do not assume the V12 balance is liquid or use an earlier owner.

**Update:** a later, separately fenced testnet faucet transfer added 5 test
NEAR to V3; its [FINAL original and cleanup](V3_NATIVE_FAUCET_RECOVERY.md) are
verified, and an indexed view subsequently showed approximately 8.969798 test
NEAR in the owner. The pre-transfer shortfall above is historical, not the
current estimate. The transfer used a temporary faucet signer, not the V3
owner key. A fresh pinned funding estimate is still required; the original V3
owner bearers remain unresolved, and custody has not been restored.

`agent/tollgate-quakes-v13.mjs` prepares a deterministic owner review of one
fixed quakes GET, 0.001 test-NEAR price and 0.02 test-NEAR channel budget. It
checks a single fresh trusted-RPC FINAL snapshot of the keyless vault, policy,
code, intent, current authorization and unused channel. It validates the
seller's 402 offer, signs only with a dedicated voucher key, persists an
exclusive local no-retry fence before the paid request, and treats timeouts,
402s, malformed responses and missing acknowledgements as **unknown**, not
as refunds. A seller acknowledgment or shaped data remains a seller claim,
not independent settlement or provenance proof. The entire channel deposit
and storage fee remain at risk, including if the upstream request fails.
The file fence must be backed up across workspace resets and machines; a lost
fence is not permission to retry. An optional `GithubTollgateVoucherFence` also
reserves the voucher key in a repository-unique GitHub label and reads it back
before signing. Two simulated machines, a lost acknowledgment, permission
failure and a changed read-back all failed closed in local tests. This optional
path requires GitHub label-create permission and trusted administrators who
never delete or rename the reservation; it has **not** been exercised against
GitHub or a live seller. Results explicitly distinguish `LOCAL_ONLY` from
`GITHUB_LABEL_AND_LOCAL`; a local fence alone is not cross-session protection.
An [isolated HTTP lifecycle](https://github.com/Greatmujey/Bouncer/actions/runs/41655193138)
exercised this client against the pinned published seller SDK and a disposable
nearcore: review, one voucher, synthetic returned data, replay refusal, local
settlement, close and refund all passed. Its seller and data were fixtures; it
was not a public-chain payment or independent fulfillment. A turnkey live
runner, verified cross-session fencing, recovered V3 custody and fresh funding
checks are still required. No payment or real provider data has been demonstrated.

References: [Tollgate repository](https://github.com/Mattbusel/tollgate),
[public quakes endpoint](https://near-tollgate.vercel.app/v1/quakes?min_magnitude=5),
[published reference deployment](https://github.com/Mattbusel/tollgate/blob/ab9c13fbd9efea70ac27c6e35623925ecd0b9a6f/deployments/testnet.json).
