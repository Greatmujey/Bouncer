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
   pay an endpoint whose operator has disabled deposits. Keep discovery
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

The opt-in buyer makes at most one payment broadcast and one paid HTTP request
per preserved journal; after an ambiguous result it stops. A different or
lost journal, a different process, an untrusted RPC, an untrusted seller, or
an injected retrying transport can defeat assumptions. Do not use valuable
funds. See [the detailed onchain-proof risks](ONCHAIN_PROOF.md).

## Proposed next protocol: authenticated, order-bound fulfillment

The following is **unimplemented design work** and requires seller adoption.
It is not a drop-in security upgrade for an existing x402 merchant:

- A seller issues and durably records a fresh bounded quote/challenge and its
  exact service terms. The owner approves the normalized task, seller origin,
  token, payee, caps and requested data before the agent signs anything.
- After constructing the exact guarded transaction and before broadcasting,
  the restricted agent signs a **domain-separated**, versioned canonical
  message containing at least the chain, Bouncer contract, transaction hash,
  seller origin, issued challenge, task digest, token, payee, amount and quote
  expiry/terms. Persist the transaction hash and off-chain authorization
  before one send so recovery can proceed without the key.
- The seller independently checks FINAL transaction and receipts, binds the
  authorization to the *actual transaction signing public key*, checks the
  challenge was issued for those exact terms, and atomically claims both the
  quote and canonical transaction hash before fulfillment. Concurrent workers
  need a shared transactional store; a process-local cache or filesystem lock
  on one host is insufficient for a distributed merchant.
- A copied on-chain memo/hash alone should not authorize a claim. Nevertheless,
  the off-chain signature or response can itself be copied if leaked: use TLS,
  protect logs, authorize access to returned data, and define principal/session
  identity and recovery. A signature alone does not solve malicious sellers,
  compromised agents, denial of service, or exactly-once execution across
  arbitrary external side effects. Never release or repeat an ambiguous claim
  without a protocol-specific, safe reconciliation rule.
- Specify canonical bytes and cross-language vectors first, then test changed
  origin, task, challenge, amount, hash, signer, expiry and chain; replay,
  simultaneous claims, restarts, disk failures and crash points; and finally a
  consenting independent seller. Until that happens, keep the present explicit
  warnings and risk flags. Do not describe this design as implemented.

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
- **Operations and scale:** resilient shared state with atomic claims, key and
  allowance lifecycle, monitoring, bounded RPC/HTTP clients, incident
  reconciliation, quota controls and multi-agent coordination are still needed.
  Local journals and a single reference-provider directory are not a
  distributed transaction system.
- **Safety and product:** independent audit, model/prompt defenses and real
  wallet testing are needed. Tour and expanded MCP work remain downstream of
  completing the core multi-resource path; the current preview/MCP are not a
  live procurement product.

A useful next independent-provider milestone should record the owner's
approved terms, merchant consent, one bounded testnet payment, the original
FINAL transaction/receipt graph, a service-specific fulfillment check, and a
recovery test without duplicate payment. Explicitly state whether the seller
used the authenticated protocol above; do not infer it from a transaction.
