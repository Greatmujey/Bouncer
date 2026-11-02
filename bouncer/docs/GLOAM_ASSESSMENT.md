# Gloam as an optional private-payment rail

Research checked 1 November 2026. This is an assessment, **not an integration**,
a claim of private Bouncer payments, or evidence of independent FT-paid service
delivery. No Gloam endpoint was paid, no seller was contacted, and no keys,
notes, wallets, tokens or transactions were created for this assessment.
Bouncer's priority remains the guarded multi-resource NEAR testnet path and a
verifiable purchase from an independent FT-accepting provider.

## Why it is relevant

[Gloam's hackathon post](https://www.gloam.trade/blog/build-with-gloam-at-the-near-hackathon)
describes private balances, shielded payments, payment proofs and paid API
calls for agents. Its [SDK](https://www.gloam.trade/docs/sdk) and
[agent documentation](https://www.gloam.trade/docs/agents) describe a
`gloam-private` x402 scheme: a compatible seller supplies a receive tag; the
buyer sends a shielded note; and the seller opens and sweeps it before giving
access. This could eventually add a privacy option to an agent marketplace.
Gloam itself is a payment layer, not a compute, storage or data provider, and
advertising x402 does not establish that a given merchant accepts its scheme.

## Compatibility and security boundaries

- **Different chains.** Gloam explicitly says it is not on NEAR itself: its
  pools run on Robinhood Chain, Tempo, Base and Ethereum, with corresponding
  testnets. Its post suggests NEAR Intents as a possible route from NEAR to
  supported *mainnets*. The official [hackathon rules](https://nearhackathon.com/HACKATHON.md)
  say Intents has no testnet (Q-007). Gloam's own testnets can be evaluated
  separately; an end-to-end NEAR-testnet-to-Gloam route is not established.
- **Different seller protocol.** Svalin's advertised Pro offer asks for Circle
  USDC on NEAR testnet. Its [inspected source](https://github.com/noobshole/svalin-agent/tree/7ebfb14f35630dfc1665b04993e684b5444133fb)
  uses NEAR token-event matching; it has not been shown to accept Gloam's
  shielded notes or `gloam-private` 402 scheme. Gloam does not automatically
  fill the independent NEAR FT-provider gap or resolve the Svalin attribution
  issues. See [Svalin readiness](SVALIN_PRO_READINESS.md).
- **Different authority.** Bouncer's NEAR contract cannot automatically enforce
  its 1-yocto owner guard, recipient allowlist or per-payment/daily caps on
  shielded notes spent on another chain. Gloam's MCP limits are enforced by
  its server, not the Gloam vault. Its
  [Tempo access-key option](https://github.com/cryptoduke01/gloam/blob/d7c130672b4aa46b69ec422c375d4acd758cf9b6/mcp/README.md#onchain-limits-with-a-tempo-access-key)
  can restrict and cap certain transfers *into* the pool, but its own README
  says it does not cap spending notes already shielded, network fees or
  pre-existing pool allowances. This is not equivalent to Bouncer's guard.
  A direct funded Gloam signer or exposed note secret would bypass Bouncer's
  on-chain policy. See also the [Gloam agent docs](https://www.gloam.trade/docs/agents).
- **Privacy has edges.** Gloam says deposits and cash-outs are public; small
  anonymity sets and timing can make activity linkable. The private recipient
  sees the payment, and the documented payment proof does not by itself show
  which side of a payment the prover was on. Protect note secrets, recovery
  material and logs. Do not describe a public Svalin payment as private. See
  [privacy model](https://www.gloam.trade/docs/privacy-model) and
  [proof limits](https://www.gloam.trade/docs/proofs).
- **Audit scope and dependencies.** As of the observation, Gloam describes
  mainnet as beta and reports a vault-contract review; the
  [security page](https://www.gloam.trade/security) says the circuits, SDK,
  MCP server and relay were outside its scope, and findings were not yet live
  as fixes. A review is not proof that Bouncer's proposed integration is safe.
  npm listed `@gloamtrade/sdk` 0.4.5 and `@gloamtrade/mcp` 0.6.3; the source
  inspected for this assessment was pinned at
  [`d7c1306`](https://github.com/cryptoduke01/gloam/tree/d7c130672b4aa46b69ec422c375d4acd758cf9b6).
  Matching version strings do not attest the npm packages or deployed code.

## If we investigate further

1. Preserve the primary NEAR FT-provider work. Do not buy a token, move funds,
   configure an unbounded signer, or start a public/private payment just to
   claim a privacy-track fit.
2. First characterize a compatible seller, network, asset, challenge,
   per-order terms and seller's finality/fulfillment rules. A proof that a
   private payment happened is not by itself proof of the intended seller,
   service or delivery.
3. Design and review a real authority boundary: explicit cross-chain funding,
   caps that cover shielded note spending, recipient and resource binding,
   durable encrypted note/change storage, settlement/finality reconciliation,
   replay handling and independent delivery verification. Do not claim NEAR's
   guard governs another chain without demonstrating it end to end.
4. Any later demonstration should first be isolated and testnet-only, clearly
   labeled if simulated or self-hosted. It needs separate user approval before
   deployment, funding, reservation or payment. It would not be an Intents
   testnet bridge. Real-value/mainnet work needs separate explicit approval.

**Track implication:** the official hackathon FAQ permits multiple fitting
tracks in one submission. Privacy & Private AI could be a future candidate if a
real, relevant privacy feature is built and demonstrated; reading these docs or
listing an SDK is not such evidence. No track requires integrating Gloam.
