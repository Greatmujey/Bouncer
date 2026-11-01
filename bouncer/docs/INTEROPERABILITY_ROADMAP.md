# Independent-provider interoperability: evidence and next work

This is a design and validation roadmap, **not** a claim of production
readiness or an announcement that an independent seller supports Bouncer. The
product goal is an agent that buys useful compute, storage and API/data, not
just a transfer firewall. The contract's restricted key, token-specific caps,
allowlisted payees and 1-yocto owner guard are the spending kernel underneath
that agent.

## What actually works

| Path | Evidence | Boundary |
| --- | --- | --- |
| Native NEAR to independently operated OutLayer | The [dependent workflow](DEPENDENT_WORKFLOWS.md) used a single-source price result in later compute, storage and API orders. | Native payment, not Circle USDC. The oracle is not a guarantee of market truth or authenticated freshness. |
| Circle testnet USDC to Bouncer's development seller | A [seller-v2 run](DEPENDENT_WORKFLOWS.md) verified three FINAL guarded transfers and one key-free lost-response recovery. | Seller and resources were self-hosted; storage readback is not a future-availability guarantee. |
| Circle testnet USDC to a PipRail SDK gate | A [fresh testnet run](ONCHAIN_PROOF.md#evidence-and-limitations) obtained a quote, sent one guarded payment, recovered it, and obtained a response verified by the published SDK. | The gate was local and self-hosted; testnet support used our wrapper. It is custom `onchain-proof`, not x402 `exact`. |
| x402 source → three dependent resources | [Synthetic tests](DEPENDENT_WORKFLOWS.md#paid-x402-data-as-a-workflow-source-experimental) compose the published PipRail verifier with seller-v3 compute, storage, API and recovery. | No live combined workflow or independent FT seller; x402 content and public proof remain untrusted. |
| Authenticated Bouncer seller-v3 | A [fresh testnet proof](SELLER_V3.md#separate-fresh-seller-v3-testnet-proof) ran native OutLayer → authenticated compute, storage and API with key-free FT recovery. | This is a custom testnet protocol with a self-hosted seller, not independent adoption. Claim signatures remain bearer credentials. |
| Shared seller-v3 replay coordination | [Real PostgreSQL tests](SHARED_SELLER.md) exercise multiple worker processes, crashes and uncertain commits. | Synthetic payments only; one trusted, durable primary, with no automatic pending-work takeover. |
| Shared direct-v3 buyer coordination | [Real PostgreSQL/process tests](SHARED_BUYER.md) reserve the signed hash and encrypted claim before a simulated send and recover the same hash; new owners can opt into stable intent IDs across journals. | Synthetic receipts only; one fenced primary, stable owner-assigned IDs and trusted workers. FT-call, x402, OutLayer and workflows are not covered. |
| Owner-only Ref testnet setup | Owner acquired test tokens and separately funded the vault in the live runs. | This is **not** an agent-guarded swap. Plain outgoing Ref `ft_transfer` does not call Bouncer's deposit hook. |

No independent FT-paid commercial compute, storage or API purchase is
established. Testnet USDC has no real value. A FINAL receipt establishes the
verified on-chain actions under the trusted RPC/token/contract assumptions;
it does not establish seller independence, correctness, availability, or a
right to future service. A successful local SDK gate establishes compatibility
with that SDK/configuration, not adoption by someone else.

## The interoperability gap

1. **Find a consenting seller and a compatible rail.** A catalog entry,
   repository, advertised x402 endpoint or SDK support is not seller acceptance.
   Verify with the operator that a current testnet service is actually willing
   to issue offers and fulfill orders, which token/network and cap it accepts,
   and whether its verifier accepts Bouncer's *nested* token transfer. Do not
   pay an endpoint whose operator has disabled deposits. The [single-URL
   inspector](ONCHAIN_PROOF.md#inspecting-a-possible-independent-seller) makes
   one unauthenticated GET and classifies wire offers without paying. On 1
   November 2026 the independent PipRail demo advertised Base mainnet rather
   than NEAR testnet; it is not a candidate for this buyer. Keep discovery
   read-only; the owner approves the exact endpoint, payee, token, policy,
   maximum price and data to disclose.
2. **Choose the protocol by its real settlement semantics.** PipRail
   `onchain-proof` verifies a token event/memo and can inspect a nested Bouncer
   payment with the documented test wrapper. Its public proof is bearer-like,
   is not bound to the requested URL or an authenticated buyer, and default
   replay memory is process-local. Our seller-v2 adds a seller-issued,
   task-bound challenge and durable local single-use claims, but also lacks
   claimant authentication. Standard NEAR x402 `exact` generally uses a
   signed NEP-366 delegated token transfer; giving an agent the necessary
   unrestricted authority would bypass the current Bouncer policy, so we do
   not silently fall back to it. These protocols are not interchangeable.
3. **Treat delivery and settlement separately.** Preserve the issued offer,
   exact signed transaction hash, FINAL receipt graph, expected token event and
   a bounded service response. The service must define how a paid but uncertain
   request is reconciled. A buyer cannot fix a seller's replay store or prove a
   seller has delivered quality merely by checking an HTTP 200.

### Additional gateway candidate checked on 1 November 2026

[Agent Commerce Gateway](https://github.com/devlab-group/agent-commerce/tree/aced1e629497104ce85e339ad939b97f840c485f)
reports partial NEAR support and its operator [requested testnet facilitator access](https://github.com/fastnear/x402-facilitator/issues/181).
Its [NEAR example](https://github.com/devlab-group/agent-commerce/blob/aced1e629497104ce85e339ad939b97f840c485f/examples/near-testnet/README.md)
uses canonical x402 `exact`, an SDK facilitator and a buyer full-access key;
its [payload inspector](https://github.com/devlab-group/agent-commerce/blob/aced1e629497104ce85e339ad939b97f840c485f/src/payments/x402/near.ts)
requires a signed delegate calling the token's `ft_transfer` with one yoctoNEAR.
That is not Bouncer's zero-deposit `execute` and nested transfer, so it cannot
be used without a reviewed extension and merchant cooperation. The issue is an
access request, not evidence that a public independent merchant is accepting
Bouncer orders. This was source/documentation research only: no quote, proof or
payment was sent.

The opt-in onchain-proof buyer makes at most one payment broadcast and one paid
HTTP request per preserved journal; after an ambiguous result it stops. A different or
lost journal, a different process, an untrusted RPC, an untrusted seller, or
an injected retrying transport can defeat assumptions. Do not use valuable
funds. See [the detailed onchain-proof risks](ONCHAIN_PROOF.md).

### Additional independent candidates checked (1 November 2026)

These are source inspections, not tests of deployed services or merchant
consent, and no offers or payments were requested:

- [Kampouse/near-escrow at `cb125de`](https://github.com/Kampouse/near-escrow/blob/cb125dee372e883cd428db035a8dd4c674daa278/src/lib.rs)
  implements FT-funded task escrow in source, but `create_escrow` identifies
  the agent by the **transaction signer**, whereas `ft_on_transfer` requires the
  **token sender** to equal that agent. In a normal Bouncer payment those are
  the owner and the Bouncer contract respectively, so the escrow rejects it.
  The source also requires an attached native storage deposit; FT refunds use
  plain transfers. We did not establish a current independent testnet
  deployment, worker availability or terms. Do not pay it assuming compatibility.
- [open-crosspost/connectors at `3a5dace`](https://github.com/open-crosspost/connectors/blob/3a5dacee6af5c5b98306e6f95d11925c380e61d2/docs/TESTNET_RUNBOOK.md)
  documents an OutLayer X connector with an HTTPS payment key and OAuth/user
  credentials; its checked-in testnet runbook lists publication checks as
  unfinished. A funded external payment key would bypass Bouncer's on-chain
  limits, and a real X account would require separate consent. This is not a
  verified FT-paid seller path.
- [sealwork at `c248d35`](https://github.com/NSEVEjk0/sealwork/blob/c248d359114f2175b1e3f2e61c5a3c1094448048/contracts/market/src/index.ts)
  documents a testnet escrow and agent builds, but its job budget and compute
  deposits are native NEAR, not an FT payment. The existence of deployment
  metadata does not establish current service availability or fulfillment.
- [TabWrit's x402-style demo at `7c294f4`](https://github.com/Lesnak1/tabwrit/blob/7c294f4180aa01ac9aaff7a6d3bd09a0d3df4243/scripts/x402-api.ts)
  checks its own vault's charge event; the inspected localhost demo does not
  establish acceptance of Bouncer's nested FT payment or a hosted independent
  seller. [Kibble at `fa88784`](https://github.com/isaacessuman/kibble/blob/fa8878433939651779cf89dc76522c08ead8a68a/apps/web/app/api/hire/%5Bid%5D/route.ts)
  describes a mainnet native-NEAR `feed` hire flow, not the reviewed testnet FT
  route. Neither was quoted or paid.
- [AgentSpend at `17a567a`](https://github.com/sufianweb3/tridon/blob/17a567a0734082f8877608faa2a699a21d1ce50c/apps/web/src/app/v1/agent/payment-requests/route.ts)
  is another testnet spending-vault project, using its own TESTUSD demo token,
  agent bearer authentication and internal payment request flow. The inspected
  API does not establish acceptance of Bouncer's v3 claim or an independently
  available compute, storage or data service. No request or payment was sent.
- [YouTick V1 at `b53e00e`](https://github.com/4rmus/youtick/blob/b53e00e962b595f0edf4f1283c146d73d1f76b57/contracts/nft-ticket/src/lib.rs)
  and its [current source](https://github.com/4rmus/youtick/blob/410dd180f42d25f77c2317b9659923f6a4149245/contracts/nft-ticket/src/lib.rs)
  is a potentially useful independent **video upload/processing** candidate,
  not a general object store. Its reviewed source accepts Circle testnet USDC
  through `ft_on_transfer`, derives the creator from the token `sender_id`,
  and, for public uploads, requires a short-lived provider-signed quote. Its
  bridge source verifies a separate upload-session key against the finalized
  job. A Bouncer payment would therefore identify the **vault** as creator;
  whether a vault-funded exact-message call and session-key upload work on the
  currently deployed service remains unproven. Exact quote approval, expiry,
  provider capacity, upload/download authorization, delivery, refund and
  independently deployed code must all be reviewed before sending. The
  source's 600,000-micro-USDC minimum for a sponsored upload is much larger
  than the `6926` micro-USDC in the demonstrated swap's vault. A bounded
  `probe-youtick.mjs` reads only public chain views and bridge health; on
  November 1 those views reported an enabled testnet market/bridge and Circle
  testnet USDC. It did not request a quote, reserve, pay or upload. An
  experimental quote-only verifier now pins the observed V1 code hash and
  same-block state layout, extracts the market's quote key, and checks the
  signature, vault/job/request binding, token, fee ceiling and expiry. The
  layout and RPC remain trusted; source/code equivalence is not established.
  On November 1, [a quote-only test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41303152030/job/124838094936)
  verified one signed 600,000-micro-USDC offer for the Bouncer vault and a
  hypothetical 100,000-byte clip. The temporary upload key was discarded;
  there was no payment or upload. A separate [read-only funding estimate](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41303749865/job/124839834431)
  observed pool 1845 quoting 647,955 micro testnet USDC for 1 testnet NEAR,
  with a 5% minimum of 615,557, and approximately 1.37 spendable testnet NEAR
  in the existing owner account. The current proven V1 router is capped at
  0.01 NEAR; achieving that quote would require a new, separately reviewed
  router, owner policy and recoverable one-shot trade. Prices, liquidity,
  account balances and gas can change. No swap or funding was sent in the
  estimate. Even a verified quote is not a purchase or fulfillment. A pure
  planning helper can form the exact ≤2048-byte message
  and match a later job view, but the owner must still approve the exact route
  with 1 yocto and independently verify the original payment receipts and
  delivery. The reviewed V1 source credits an accepted job fee to the platform;
  an immediate unused FT amount may be resolved by NEP-141, but no general
  post-authorization service-failure refund was established. The vault is the
  job creator, yet Bouncer does not expose the market's `replace_upload_key`
  call. Losing the upload session key may therefore strand the job. An
  experimental single-host preparation helper now stores that key in the
  original owner/vault-scoped encrypted journal before returning a quote
  request, reuses it on restart, and fingerprints the source both fully and
  using the provider's separate head/tail algorithm. It refuses plaintext and
  missing original journals; it cannot detect a deleted or stale restored
  journal before a fresh start. A synthetic-tested control preparer requires
  the original fully settled FT receipt graph, an exact matching market job and
  unchanged source, then journals the initial attempt before returning a
  short-lived signed control envelope. It refuses to prepare the initial
  request twice; later reconciliation/resume must be explicit. A separate
  experimental transport implements the fixed-host intent, heartbeat and
  sequential TUS calls with encrypted capabilities and write-ahead chunk
  recovery. It has synthetic and loopback tests, **not a live provider
  upload**, and is not wired into a user-facing workflow or coordinated across
  hosts. Signed envelopes and TUS URLs are bearer capabilities and must not be
  logged or shared. A separate playback prototype and its remaining blockers
  are described in [YouTick playback](YOUTICK_PLAYBACK.md). The existing V9
  vault cannot issue the legacy grant needed by this candidate path. Never
  assume merchant consent, delivery or deployed/source equivalence from this
  research.
- [PatchBond at `a448538`](https://github.com/PatchBond/patchbond/blob/a4485389453818d495e48b7d46a299401833213b/contract/vault/src/deposit.rs)
  documents testnet Circle USDC bonds for GitHub submissions, not a compute,
  storage or API purchase. The source uses the FT `sender_id` as the bond payer;
  a Bouncer transfer would identify the Bouncer contract, not its owner. Its
  later [bond settlement](https://github.com/PatchBond/patchbond/blob/a4485389453818d495e48b7d46a299401833213b/contract/vault/src/settle.rs)
  pays the payer through [plain `ft_transfer`](https://github.com/PatchBond/patchbond/blob/a4485389453818d495e48b7d46a299401833213b/contract/vault/src/payout.rs),
  which does not call Bouncer's `ft_on_transfer` or credit its internal vault.
  That later payout is distinct from the token resolver's immediate unused
  amount in the original transfer-call. We did not establish deployment/source
  correspondence, availability, terms or a safe Bouncer refund route; no bond
  or request was made.
- [Gliana's Saku at `87c9e51`](https://github.com/Gliana-Labs/gliana-near-x402/tree/87c9e518a05d6de9683300cb7a6acc46e23473e9)
  describes using NEAR Chain Signatures to authorize EIP-3009 USDC payments
  for a Base **mainnet** x402 API from a separate allowance contract. That is
  not a NEAR testnet FT transfer through Bouncer's vault or its existing
  spending policies. Bridging the two would require a separately designed and
  audited authority, accounting and recovery model; it is not implemented here.
  No API request, signature or payment was sent.

The right next step is seller cooperation or a compatible deployed protocol,
not weakening the owner guard or claiming a self-hosted adapter is independent.

## Authenticated, order-bound fulfillment

An experimental implementation of the core claim and local seller flow now
exists as [seller-v3](SELLER_V3.md). It is **not** a drop-in security upgrade
for an existing x402 merchant and requires that merchant's adoption. The
following checklist separates what the prototype does from what remains:

- A seller issues and durably records a fresh bounded quote/challenge and its
  exact service terms. The owner approves the normalized task, seller origin,
  token, payee, caps and requested data before the agent signs anything.
- After constructing the exact guarded transaction and before broadcasting,
  the restricted agent signs a **domain-separated**, versioned canonical
  message containing at least the chain, Bouncer contract, transaction hash,
  seller origin, issued challenge, task digest, token, payee and amount. The
  buyer persists the transaction hash and authorization before one send so
  recovery can proceed without the key. V3 has **no expiry**; a safe expiry and
  late-payment/refund protocol remain future work.
- The seller independently checks FINAL transaction and receipts, binds the
  authorization to the *actual transaction signing public key*, checks the
  challenge was issued for those exact terms, and atomically claims both the
  quote and canonical transaction hash before fulfillment. A separate
  [PostgreSQL-backed prototype](SHARED_SELLER.md) now tests shared atomic claims
  across workers with synthetic receipts; it needs operational hardening and
  live/independent validation. A process-local cache or filesystem lock on one
  host remains insufficient for a distributed merchant.
- A copied on-chain memo/hash alone should not authorize a claim. Nevertheless,
  the off-chain signature or response can itself be copied if leaked: use TLS,
  protect logs, authorize access to returned data, and define principal/session
  identity and recovery. A signature alone does not solve malicious sellers,
  compromised agents, denial of service, or exactly-once execution across
  arbitrary external side effects. Never release or repeat an ambiguous claim
  without a protocol-specific, safe reconciliation rule.
- V3 specifies canonical bytes and a fixed vector, and offline tests cover
  changed origin, task, challenge, amount, hash, signer and chain, concurrent
  claims, restarts and key-free recovery. Independent-language implementations,
  expiry/refund semantics, wider crash testing, security review and a consenting
  independent seller remain open. Keep the explicit warnings and risk flags.

## Other blockers for a first-class multi-resource agent

- **Safe swapping and inventory:** design output accounting for the *actual*
  receiver mechanism before spending vault funds. Ref's plain transfer can
  bypass `ft_on_transfer`, so input settlement or a raw balance delta alone
  is not evidence that the internal vault ledger was credited correctly amid
  pending transfers and refunds. A new route needs explicit reservations,
  callback/failure accounting and adversarial interleaving tests, followed by
  audit and a fresh deployment where state changes require it.
- **Service integrity:** independently verifiable invoices/receipts, durable
  storage and retrieval commitments, source provenance and freshness, and
  well-defined refunds are separate from payment authorization.
- **Operations and scale:** the experimental shared seller provides atomic v3
  claims on one PostgreSQL primary, not a complete HA or multi-agent solution.
  Failover/fencing, stale-backup recovery, key and allowance lifecycle,
  monitoring, bounded clients, reconciliation and quota controls remain.
  The default buyer journal and original provider directory are local; the
  opt-in shared direct-v3 buyer serializes one owner's workers but is not a
  distributed nonce allocator or a complete transaction system.
- **Safety and product:** independent audit, model/prompt defenses and real
  wallet testing are needed. Tour and expanded MCP work remain downstream of
  completing the core multi-resource path; the current preview/MCP are not a
  live procurement product.

A useful next independent-provider milestone should record the owner's
approved terms, merchant consent, one bounded testnet payment, the original
FINAL transaction/receipt graph, a service-specific fulfillment check, and a
recovery test without duplicate payment. Explicitly state whether the seller
used the authenticated protocol above; do not infer it from a transaction.
