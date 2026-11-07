# Bouncer: blockers, attempted approaches and track fit

Snapshot: 6 November 2026. This is a working plan, not a claim that a track
is complete or a submission decision. The [official rules and track descriptions](https://nearhackathon.com/HACKATHON.md)
can change; re-read them before any submission. The current deadline is
14 November 2026 at 23:59 UTC (15 November at 00:59 in Lagos). Testnet-only
projects are eligible; integrations named in the track hints are not mandatory.

**Scope update, 7 November:** an independently paid FT purchase is no longer
on the critical path. Preserve FT support, but prioritize a genuine bounded
native-NEAR resource flow and the eventual compute/storage/API mission. Older
FT observations below remain historical research, not a new requirement.

## What exists and what it does not prove

- The owner-only 1-yocto policy guard, restricted keys and spending caps have
  testnet evidence. The experimental contract versions are unaudited.
- An earlier OutLayer call paid native testnet NEAR for independent price
  execution. The three fungible-token resource examples used self-hosted
  development providers. Neither proves independently operated FT-paid
  compute, storage and API fulfillment. Synthetic nearcore tests are not live
  purchases.
- A synthetic WalletConnect session passed against the real relay. The deployed
  Vercel gateway and a real compatible wallet on the user's phone have not yet
  been verified end to end. Account connection alone is not spending access.
- The [independent Buffer source build](https://github.com/Greatmujey/Bouncer/actions/runs/42277687212)
  matched its deployed testnet code hash at one trusted-RPC FINAL block when
  built with the seller-documented cargo-near command. This is a historical
  code match, not an audit, a real order or independently verified delivery.

## What has stopped or limited us

| Attempt | Current blocker or unfinished work | Most relevant track(s) |
| --- | --- | --- |
| Buy useful data, compute or storage from an independent seller with a policy-controlled FT payment | No full independent FT-paid delivery has been verified. A [6 November FINAL snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/42250800169) found Buffer's 5-test-USDC custom minimum against 0.006898 test USDC in the vault; 7 test NEAR indicated only ~3.267 test USDC in the best of two sampled direct Ref pools. A [later bounded scan](https://github.com/Greatmujey/Bouncer/actions/runs/42252402265) enumerated 2,908 pools and found the best pre-ranked two-hop path below that direct sample. These are not executable quotes, split-route checks or an exhaustive search. The [later PayPerCall catalog snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/42250799913) again found only native-NEAR services and no Circle offer. An HTTPS-shaped listing is not proof that an operator is reachable. | **Agent Economy**, Autonomous Business; Real-World Money if a convincing stablecoin use case is built |
| Use PayPerCall's escrow without losing vault refund accounting | Its published route uses `ft_transfer_call`, while a later plain FT refund can bypass the vault's ledger. The experimental one-shot forwarder and isolated mock-token refund/fulfillment scenarios are promising, but are not deployed, audited or proven against Circle and the live escrow. The forwarder limits price to a maximum but does not atomically pin provider, operator and exact price at the escrow. A preflight alone cannot remove that race. | **AI Security & Defense**, Agent Economy |
| Prove the seller actually delivered the requested answer and was paid | A seller's answer hash, a payment event and a successful promise are different facts. The read-only verifier correlates the guarded transfer, escrow call, answer commitment and separately linked payout. A separate return check can verify a linked vault callback but does not prove the fungible units originated in that order. HTTP origin, data correctness and independent delivery remain unproven. | **Agent Economy**, AI Security & Defense |
| Use Tollgate for independent data | It accepts native testnet NEAR, not Circle. Its voucher does not bind the HTTP resource; the reviewed seller stores state in per-instance temporary storage and relies on asynchronous settlement. Timely settlement and successful delivery within the channel's short deadline are not established. V13 is experimental, undeployed and unaudited. | **Agent Economy**, AI Security & Defense |
| Complete wallet login on the user's phone | Earlier attempts timed out before showing a QR. Production now contains a same-origin fallback and passed a synthetic deployed-site session, but no real wallet approval on the user's phone has been verified. The public fallback has per-instance limits but no verified global quota or Vercel WAF rule. Account display is not spending authorization. | Cross-cutting product usability; **AI Security & Defense** for session scope and relay abuse |
| Safely resume work with the V3 testnet owner | Two public original signed transactions have no verified receipts. The [latest archival observation](https://github.com/Greatmujey/Bouncer/actions/runs/42250799913) found their references beyond the then-observed validity window; it did not prove what happened historically. The V3 keyring was privately restored and checked against the public owner plan; the user's saved backup remains unverified. Do not resend either original, re-enable retired fences, or sign unrelated V3 owner transactions while their histories remain unresolved. | **AI Security & Defense** and a cross-cutting development dependency |
| Move from guarded procurement to complete business operations | The planner and development examples are not a running autonomous business with real customers, invoicing and dependable operations. | **Autonomous Business** |
| Perform guarded swaps and cross-chain settlement | Previous Ref testnet swaps were owner setup, not a finished agent-guarded swap with reliable output accounting. A cross-chain Intents path is not complete. No real-money Intents transaction is authorized. | **Unstoppable DeFi** |
| Coordinate a genuine agent swarm | One coordinator sequences work; there is no demonstrated independent multi-agent bidding, hiring or secure handoff economy. | **AI Swarms** |
| Verify security at production strength | There is no independent audit of the vault, experimental forwarder or deployed relay. Receipt correlation still trusts the RPC and cannot prove source/build equivalence or isolate every same-block transfer. Seller output remains untrusted. | **AI Security & Defense**; affects every track |

**Storage lead, not a working purchase:** Textile's historical
[NEAR/Filecoin bridge SDK](https://github.com/textileio/near-storage-js) and
[successor](https://github.com/textileio/storage-js) are archived. Their docs
describe a refundable anti-Sybil testnet deposit, not proof of a current paid
storage order. The [bridge account's transaction listing](https://testnet.nearblocks.io/address/filecoin-bridge.testnet)
showed its latest listed incoming `addDeposit` as approximately four years old
when checked on 7 November 2026; the documented broker endpoint could not be
fetched. This does not prove the contract or every possible broker inactive,
but is insufficient to send funds or claim independent storage delivery. No
storage order, provider payment or deposit was made.

**Svalin pay-per-call lead:** An [anonymous x402 offer refresh](https://github.com/Greatmujey/Bouncer/actions/runs/42253070781)
on 6 November advertised an `exact` NEAR testnet route for **2,000 Circle
atoms (0.002 test USDC)** to `svalin-agent.testnet`, within the vault's 6,898
atoms. This is an advertisement, not proof the facilitator will settle or the
seller will deliver. The existing Bouncer buyer speaks `onchain-proof`, not the
advertised NEAR `exact` delegated transfer; a restricted function-call key
cannot attach the token's required 1 yocto to that delegate, and the keyless V12
vault cannot sign it. Do not silently substitute a full-access key or imply the
payee is enforced through an unreviewed intermediary. That offer-check used a
`near.testnet` target, which Svalin's free endpoint reported as nonexistent;
future inspections use `root.near` without assuming the seller's mainnet data is
testnet data. No signed proof, seller order or payment was made.

**Additional independent offer, not currently compatible:** [Leash's live
catalog](https://leash.frankolien.com/api/paid) advertises useful price, search
and page-reading endpoints for 0.01–0.02 Circle test USDC. Its [testnet x402
facilitator](https://leash.frankolien.com/api/x402/supported) requires its own
`leash` transfer method and a policy on `leash.frankolien.testnet`; it does not
accept Bouncer's direct on-chain proof. Its [test-USDC tap](https://leash.frankolien.com/api/test-usdc)
reported unavailable on 6 November. No payment, account or seller request
beyond these public GETs was made.

**Tidepool is a separate test-token sandbox:** its [live token list](https://www.usetidepool.tech/v0/tokens)
uses `usdc.tidepool-sandbox.testnet`, not Circle's testnet USDC. It is not a
source of Circle funds just because its token has the symbol USDC. The Ref
simple-pool inventory did not show a direct Tidepool-token/Circle pair; it did
not rule out other exchanges, non-simple pools or longer routes. No Tidepool
faucet, swap, quote reservation or payment was made.

**Alternative research lead:** [Allowance's published testnet report](https://github.com/Rahat-ch/allowance/blob/f44c27ff84e07d2c29c8937bac12818e421e5320/docs/proof/testnet.md)
describes a Circle test-USDC x402 flow using NEAR Chain Signatures. Its
[proof code](https://github.com/Rahat-ch/allowance/blob/f44c27ff84e07d2c29c8937bac12818e421e5320/packages/proof/src/run.ts)
starts its own seller and facilitator, and the [weather response](https://github.com/Rahat-ch/allowance/blob/f44c27ff84e07d2c29c8937bac12818e421e5320/packages/seller/src/app.ts)
is demo data. This is a useful independently published design to evaluate,
not a verified publicly available seller or a Bouncer payment. No funds were
sent and no source-code licensing, deployed-code equivalence or safety audit is
claimed.

## Recommended focus, not automatic track selection

1. **Agent Economy + AI Security & Defense:** pursue the bounded native-NEAR
   OutLayer path first, with owner approval, original-hash recovery and verified
   provider results. An independent FT seller is optional afterward; do not
   call a synthetic test or historical transaction a new purchase.
2. Fix and verify the real wallet approval flow, without adding transaction or
   AddKey authority to an identity-only connection. Protect the live relay.
3. Expand the same working purchase into compute, storage and API/data, rather
   than building unrelated track-specific features. Business, Real-World
   Money, DeFi and Swarms become stronger candidates only when supported by
   completed evidence; their track names do not themselves require mainnet.

MCP expansion and Gloam/privacy work remain deferred. Neither Gloam nor any
particular partner is mandatory, and track selection should not derail the
core multi-resource product. The entrant chooses tracks before the one allowed
submission; no submission or public post is made without their approval.
