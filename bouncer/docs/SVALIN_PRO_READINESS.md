# Independent Svalin Pro: read-only testnet discovery

**Status: public offer and free-route observations only. No checkout has been
reserved, no Svalin bearer code created, no token transferred, and no paid
service or useful FT-paid fulfillment verified. This is not a live adapter.**

On 1 November 2026 at about 19:25 UTC, the independent Svalin service's
[public offer](https://svalin-api.noobshole.workers.dev/v1/pro) advertised a
monthly pass for **5 testnet USDC** plus a small exact-amount suffix, 30 days,
and 100 paid-route calls per day. Its NEAR offer named `near:testnet`, Circle's
[testnet USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses)
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7b23cc04ea7eb7a6c3c32520d03d4afcb8af`,
and `svalin-agent.testnet`. Testnet USDC has no real value. The free
`/v1/demo/risk/root.near` returned a JSON report; this is neither paid delivery
nor a validation of the report's accuracy. The published offer may change.

## Why this may close part of the FT gap

In Svalin's [source at commit `7ebfb14`](https://github.com/noobshole/svalin-agent/tree/7ebfb14f35630dfc1665b04993e684b5444133fb),
`POST /v1/pro/near` reserves a **unique exact USDC amount** against a secret
Pro code, and `POST /v1/pro/activate` looks up the token's transfer events via
FastNEAR. The [reader](https://github.com/noobshole/svalin-agent/blob/7ebfb14f35630dfc1665b04993e684b5444133fb/apps/api/src/payments/pro-payments.ts)
counts NEP-141 events in successful token receipts, net of transfers from the
seller in the same transaction; it does not require the outer transaction to
call the token directly. This *suggests* compatibility with Bouncer's nested
`ft_transfer`, without requiring canonical x402's incompatible direct delegated
transfer. A previous **self-hosted vendor** transaction was independently shown
to be FINAL and discoverable by the same testnet FastNEAR account/transaction
endpoints ([historical evidence](../evidence/multiagency-read-20261101/readiness-corrected.json)).
It was **not** a Svalin payment. Source code is not an attestation of the
running service, and the different payee, scan window, paging and timing still
need a real end-to-end test.

The pinned source matches an exact amount, network and reservation time, **not
the payer**. It uses a bearer code: anyone who gets the code can use the pass.
Amounts are reserved for two days and are held against reassignment longer;
activation waits at least 15 seconds before inspecting new NEAR transactions,
and scans a bounded history. Another sender could pay the same reserved amount;
misattribution, duplicate payments, late transactions, incomplete indexing,
merchant downtime and refunds remain risks. A successful transfer alone is not
proof that the seller activated the right code or delivered useful data.

## What Bouncer can do today

- `agent/svalin-pro-readiness.mjs` makes a bounded anonymous offer GET and
  validates a later checkout **offline** against the reviewed monthly
  testnet profile. Drift, mainnet, wrong token/payee, malformed amounts and
  unusable expiry fail closed. It does not create a checkout, keep a bearer
  code, prepare an intent, authorize or sign a payment.
- `agent/svalin-liquidity-readiness.mjs` inspects seller token registration
  and a few testnet Ref pool views. These are stale-able indications, **not**
  a balance, funding transaction or executable swap quote.
- `scripts/probe-svalin-pro.mjs` runs those anonymous GET/RPC reads; use a
  network environment that can reach the provider and NEAR testnet. It does
  not create a reservation, pay, activate, or call a paid endpoint.
- V11 is a separate experimental fresh-state contract; it has **not** been
  deployed or tested on chain. Its current purchase runner is specific to
  MultiAgency and cannot buy this Svalin pass. A secure Svalin-specific buyer,
  encrypted bearer-code backup, durable reservation/transaction recovery,
  paid-response validation and reviewed owner deployment/setup remain to build.

## Required before a consequential test

1. Verify the current testnet offer, seller registration, test-token funding,
   provider terms and independently reviewed V11 deployment. Do not reuse or
   resend any prior ambiguous funding/payment operation.
2. Get explicit owner approval for the provider, monthly testnet amount range,
   desired public-account data, timing, side effects and risks **before** a
   two-day checkout reservation. Persist and independently back up the bearer
   code securely before requesting the reservation; never put it in GitHub
   logs, comments, unencrypted artifacts or a URL.
3. Review the exact returned amount, expiry, payee, token, policy and recovery
   plan; obtain separate explicit approval before paying. Reserve the journal
   before any signature/broadcast and never auto-resend an ambiguous hash.
4. Verify the one original transaction and token event FINAL; separately
   verify that the secret code is active and that a paid API returns bounded,
   relevant data. Treat the seller's results as untrusted and unaudited.

No step above authorizes a purchase, establishes merchant consent, demonstrates
capacity or claims production security. No mainnet or real-value payment is
permitted by this readiness module.
