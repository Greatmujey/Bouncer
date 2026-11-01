# Experimental authenticated seller-v3 orders

Seller-v3 is an **opt-in, testnet-only Bouncer-specific protocol**, not standard
x402 `exact`, not PipRail `onchain-proof`, and not evidence that an independent
merchant supports Bouncer. It extends the local multi-resource buyer and
reference seller with a transaction-key-signed order claim. The agent still uses
an `execute`-only NEAR function-call key; the on-chain transaction attaches
zero NEAR, and Bouncer's owner-only policy changes still require one yoctoNEAR.
Do not use real funds. Both parties must explicitly support this protocol.

The implementation has synthetic tests with the actual signer, seller, journal
and key-free workflow CLI. Offline tests alone are not live-chain evidence.

## First testnet attempt: stopped before v3 resource payments

The first [one-shot testnet attempt](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41268548592/job/124736728081)
created a fresh deployment and started the native OutLayer oracle, but its RPC
submission timed out. The workflow stopped **before any seller-v3 compute,
storage or API payment**. The original restricted recovery artifact
[13068257781](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41268548592/artifacts/13068257781)
contains the original journal and expires 30 January 2027; preserve it. Do not
rerun the paid job or resend the recorded hash. A public explorer later showed
that [source transaction `CCbbcM73XZc1r8WcmyPMYHaudaR7qfjKKYhihZpHcuZ8`](https://testnet.nearblocks.io/txns/CCbbcM73XZc1r8WcmyPMYHaudaR7qfjKKYhihZpHcuZ8/execution)
completed and returned a single-source price of `4.4301`, with a reported
charge of `1121700000000000000000` yoctoNEAR and owner refund of
`98878300000000000000000` yoctoNEAR. A separate [read-only recovery job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41269062945/job/124738207055)
verified the original journal, FINAL transaction, provider receipts, refund and
completion block against a trusted archival RPC, and confirmed no resource
payment was recorded. It did not change the original journal or send anything.
The observation is stale and not valid for new purchases. No live-v3 delivery
or independent FT-seller adoption is established.

## What is protected—and what is not

A seller-generated challenge commits to a normalized compute, storage or API
input. Before the one payment broadcast, the agent signs a **NEP-413** off-chain
message over the exact transaction hash, chain, Bouncer and owner, seller
origin, resource, policy, token, payee, amount and task-bound memo. The buyer
verifies that signature locally and syncs it together with the signed hash in
the original private journal. The signature cannot itself authorize a NEAR
transaction. Key-free recovery reuses it; it does not pay or sign again.

The seller checks its own stored quote and FINAL Bouncer/token receipts, then
requires the claim signature to verify against the **actual transaction signing
public key** from the trusted RPC. It records that key and atomically claims the
quote/hash in its local durable state before side effects. Completed results
still require a valid claim. A concurrent request with a different key cannot
join another claimant's in-flight result. V3 storage readback also requires the
claim; the legacy public GET route refuses v3 objects.

This blocks a party who only observes the public on-chain memo/hash from
claiming the result. It is **not complete identity or confidentiality**: the
off-chain signature is itself a replayable bearer credential. Anyone who steals
it may replay the same claim or read its stored result. Protect the journal,
request bodies, logs, backups and transport; use HTTPS for a remote seller and
properly authenticated sessions/access control where needed. The reference
server binds to loopback only and supplies no TLS, multi-user identity, expiry,
revocation, secure hosting or distributed replay database. The local test
seller origin `http://127.0.0.1:0` is a **development-only reviewed alias** for
a dynamically assigned loopback port, not a pattern for a remote merchant.

A signature does not make an untrustworthy seller honest or guarantee service,
storage retention, price accuracy, refunds or exactly-once external effects.
The seller trusts its RPC, configured Bouncer deployment and token code; this
is not a light-client proof. Claim signatures remain usable while the seller
retains the corresponding quote; v3 currently has **no automatic quote or
signature expiry**. Expiring a quote without handling late or ambiguous
payments could strand funds. The reference seller fails closed after 1,024
stored quotes, including abandoned ones. It cannot guarantee correctness
across different directories or multiple hosts.

## Request and claim flow

1. The owner pins the seller origin, token, payee, policy, maximum price and
   task. A goal explicitly sets `"order_binding": "seller-v3"` and execution
   requires `--durable`. V1 and v2 remain available only when explicitly
   selected/defaulted; v3 cannot silently downgrade to either.
2. The seller has a separately configured canonical `seller_origin`—never
   derived from an HTTP Host header—and persists a fresh random 16-byte
   challenge, task commitment and product terms before returning a quote:

```json
{"resource":"compute","input":{"text":"same work","rounds":2},"order_binding":"seller-v3"}
```

The response quote contains `resource`, `policy_id`, `token`, `payee`,
`amount`, `memo`, `seller_origin` and `auth_scheme` (which must equal
`bouncer-nep413-claim-v1`). The buyer compares the origin and all financial
terms with owner-approved values and rejects a changed task, scheme, origin,
amount or v2/v1 memo. Issuing a quote itself persists seller state, even in a
dry run or provider comparison.
3. The buyer signs the reviewed Bouncer transaction and claim, synchronizes the
   pending journal, then broadcasts at most once. After FINAL settlement it sends
   `/redeem` with `tx_hash`, `resource`, the original normalized `input`, `memo`
   and `authorization`:

```json
{"scheme":"bouncer-nep413-claim-v1","public_key":"ed25519:...","signature":"<canonical base64, 64 bytes>"}
```

4. The seller verifies the exact task/quote and signature; it checks that the
   FINAL transaction signer matches the claim key and that the nested token
   transfer and callback match the seller-owned financial terms. Only then does
   it durably claim the challenge/hash and perform the work. It must check the
   authorization on **every** request, including cached and concurrent replays.
   The optional `/storage-read` endpoint takes `tx_hash`, `object_id` and the
   same `authorization`; it does not authorize a different order/object.
5. If a payment response is uncertain, preserve the original journal and query
   its original hash. Never resend automatically. The reference seller may
   return a completed result to the same valid claim; a pending or ambiguous
   side effect requires manual reconciliation. Do not assume an arbitrary
   third-party seller implements idempotent fulfillment.

`bouncer/examples/seller-v3-goals.example.json` and
`bouncer/examples/seller-v3-provider.example.json` are **placeholders**, not
funded deployments. Review and configure both accounts, routes and limits
before running; the owner must install and grant a separate `execute`-only
agent key. See [provider protocol](PROVIDER_PROTOCOL.md) for v1/v2 and
[dependent workflows](DEPENDENT_WORKFLOWS.md) for the non-atomic multi-resource
orchestration. The local seller SDK is private and unpublished.

## Exact wire bytes and fixed vector

The v3 challenge is 32 lowercase hexadecimal characters encoding 16 random
bytes. With `normalized = normalizeOrder(resource, input)` and ECMAScript
`JSON.stringify` (no extra whitespace), the task memo is:

```text
digest = hex(SHA256(UTF8("bouncer-order-v3") || 00 || UTF8(resource) || 00 || UTF8(challenge) || 00 || UTF8(JSON.stringify(normalized))))
memo   = "bouncer-order-v3:" + resource + ":" + challenge + ":" + digest
```

The challenge is ASCII hex, not decoded bytes; `00` is one zero byte. Input key
order and Unicode escaping are the same as [v2](PROVIDER_PROTOCOL.md#optional-seller-v2-binding). The authenticated message is
`JSON.stringify` of this exact **array of strings**, in order:

```text
["bouncer:resource-claim:v1", "near:testnet", contract_id, owner_account_id,
 seller_origin, resource, policy_id, token, payee, amount, memo, tx_hash]
```

The seller origin is its canonical URL origin without a slash, path, user info,
query or fragment; HTTPS is required except for loopback HTTP. The NEP-413
recipient is `payee`, the nonce is the 32-byte base58-decoded transaction hash,
and the callback URL is absent. Borsh encoding is `u32le(2^31 + 413)`, then
`borsh_string(message)`, the 32 nonce bytes, `borsh_string(payee)`, and `00`
for `None` callback. SHA-256 of these bytes is signed using the transaction's
ed25519 key. `public_key` is the canonical `ed25519:` key, and `signature` is
canonical standard base64 of exactly 64 bytes.

Fixed **public test seed**, not a credential: 32 bytes of `07`. For compute
input `{ "text": "same work", "rounds": 2 }` and challenge
`00112233445566778899aabbccddeeff`:

```text
network:       near:testnet
contract:      bouncer.testnet
owner:         owner.testnet
seller origin: https://seller.example
policy:        compute
token:         token.testnet
payee:         seller.testnet
amount:        1000
tx_hash:       cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN
memo:          bouncer-order-v3:compute:00112233445566778899aabbccddeeff:0374e3d0589eff883fcdc076409fd5820629697909633ca6d649d4fd97a7cc0e
public_key:    ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
NEP-413 hash:  7ffc9315dacc49e9175d77a223aae26809201ba1bcbf0e78c45184fdffe66b9b
signature:     mrQ2rM2VwjdhVEmMGCOc18FBsOz6UXZQ4KyNnQeGJCKtfkZlrHX6tvT7iPcyGRc+Z53hH4WDx5cr1duBibhzCA==
```

The vector is checked with the independently implemented `near-api-js`
NEP-413 signer. SDK exports include `orderMemoV3`,
`challengeFromOrderMemoV3`, `signClaimAuthorization`,
`verifyClaimAuthorization` and `readAndVerifyAuthenticatedProviderPayment`.
The caller must construct terms from its own reviewed state, not copy untrusted
buyer-supplied terms. The signing key must be anchored to FINAL receipt data;
verifying a signature against a key supplied by the buyer alone is insufficient.

The first v3 quote upgrades the seller store from version 2/3 to version 4.
Older binaries cannot read it. Do not roll back state, erase a quote, or delete
a locked/pending journal to make a retry work. Preserve the original buyer
journal; unlike older public-proof examples it contains bearer signatures and
must **not** be published as a public artifact. The testnet CI job deliberately
keeps recovery data in an artifact only while the repository is private, not a
public evidence bundle. **Changing repository visibility may expose existing
artifacts**; before making it public, first securely retain and reconcile any
needed journal, then remove sensitive artifacts under an appropriate retention
policy. Do not erase unresolved recovery state. Repository-restricted Actions
artifacts are still not a secure secret-storage solution for real systems.
