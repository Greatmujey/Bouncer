# Phone testnet FT path: current preview and safety boundaries

This is an experimental testnet path, **not a completed autonomous purchase**.
The phone preview offers a supported NEAR wallet connection, requests an off-chain
NEP-413 identity message and prepare an unsigned Buffer vault review. It does
not yet request setup transactions, configure an agent, create a Buffer order,
transfer test USDC to Buffer or prove delivery. Name-only viewing and an
Ethereum `0x` wallet are not substitutes for a named NEAR signing wallet.

## Read-only transport

For the Arena phone preview, the local backend cannot reach testnet RPC directly
and the private preview endpoint is inaccessible to Vercel. The browser moves
short-lived, backend-signed read requests to a separate Vercel function and
returns an encrypted result. Only the backend can decrypt the short-lived OIDC
token; it verifies the pinned Vercel issuer, keys, project, deployment,
audience, request digest, result digest and one-use job before accepting it.
The relay permits only bounded testnet reads and cannot broadcast. This trusts
the chosen RPC and does not prove chain consensus. It is a temporary preview,
with session keys outside the repository and pinned public keys in the relay;
a new session requires fresh keys and a pinned deployment. Key rotation, lost
keys, stale jobs, broken CORS or an unavailable relay fail closed.

The Vercel relay live status smoke [42322073524](https://github.com/Greatmujey/Bouncer/actions/runs/42322073524)
returned encrypted bytes; the local backend decrypted them and verified the
pinned deployment's OIDC signature and `testnet` chain ID. This was a read,
not a payment or a real-device wallet test. The full unsigned review later
passed [run 42324777068](https://github.com/Greatmujey/Bouncer/actions/runs/42324777068):
phone-sized Chromium fetched 18 live encrypted relay results with actual CORS,
while the preview origin was routed to a local backend in the runner. Its
snapshot reported 40 test USDC and no readiness blockers. This exercised the
real browser job-pump module, not the complete app UI, a real phone or a wallet.
A prior artifact download failed because the sandbox cannot reach the artifact
host; the successful run did not download an artifact or submit a transaction.

The opt-in Arena preview now has a read-only fallback for a phone browser that
cannot directly reach the public key RPC. After a wallet supplies an off-chain
signature, the backend checks the exact public testnet key at a fresh pinned
FINAL block through the encrypted relay; the signature is still verified in
the browser. The route is same-origin and bounded, accepts no transaction or
private key, and a missing/limited key fails closed. The fallback is exercised
with a synthetic phone-sized browser and synthetic RPC; it has not yet been
verified on a real phone. It is not enabled on the production site.

A public archival/readiness run on November 7 observed 40 Circle test USDC in
`great_mujey.testnet`, the reviewed Buffer fixed product at 20 test USDC, and a
planned **6 test NEAR** keyless vault deposit. The actual state can change; a
keyless vault can leave its storage stake locked. A live setup must recheck
state and show these terms before the owner's wallet approval.

## Private Buffer order capsule (offline only)

A fixed-order response can now be checked against the exact reviewed token,
price, seller, order and brief, then sealed with an owner-unlockable public-key
capsule. The brief and single-use private bearer are not included in its public
record or commitment. Key enrollment uses two identical off-chain Ed25519
signatures to reject a wallet that cannot reproduce its unlock key; decryption
requires the same wallet key and site origin. The signature is sensitive key
material, never a login or spending approval, and must not be logged or sent.
The encrypted key record, ciphertext **and independently witnessed capsule
commitment** must all be retained; losing them, changing origin or losing the
wallet key can make the order permanently inaccessible. Public-key encryption
alone cannot authenticate who created a capsule, so a hash returned by the
same untrusted database is not an independent commitment. A compromised browser,
wallet or order-executing backend can still see private material. These modules
are not audited, connected to a seller, database, witness, or UI, and do not
provide durable retention, authenticated key enrollment, unknown-POST recovery,
order creation, payment or delivery. Synthetic Node and 320/390px Chromium
round trips passed; no real wallet or phone was used.

An encrypted pre-order draft and a salted HMAC request commitment now allow a
witness to identify the exact private brief without publishing a guessable
plain SHA-256 of it. A separate Git witness prototype retains one reservation,
one claim and one sealed capsule commitment per owner, and shares the existing
branch lock. A PostgreSQL journal and distinct one-use NEP-413 owner challenges
now bind the encrypted draft, key-record commitment, claim and final capsule;
a combined synthetic test exercised the browser signer, disposable PostgreSQL
and a separately pushed local Git witness. Concurrent claims, altered key
records and lost database/witness acknowledgements fail closed. This is still
an opt-in prototype, not wired to a seller, HTTP route or UI; the disposable
database is not durable hosting, and the Git head must be independently
retained. There is no order executor, and an uncertain POST must not be retried.

## Independent prompt witness

`git-wallet-prompt-witness.mjs` models one ordered setup reservation, claims
and immutable original hashes. `git-branch-witness-store.mjs` can append public
hashes to the configured session branch using Git's fast-forward compare and
swap, a clean worktree and a confirmed remote push. The coordinator in
`witnessed-wallet-setup.mjs` does not return a claim until PostgreSQL and the
separate witness have both retained it, and it rejects a stale preflight after
the witness is written. Unknown acknowledgements, conflicts and restored
PostgreSQL without a matching witness stop the flow. Original transaction hashes
can be recorded idempotently; an unknown original is never retried.

This is still a prototype. A GitHub administrator can edit, delete or force-push
the witness; a newly initialized witness cannot prove there was no earlier
prompt elsewhere. A simultaneous rollback of database and witness is not
protected, and a dirty or stale checkout deliberately blocks writes. Operators
must separately retain and monitor the latest acknowledged remote Git head.
The opt-in setup service now connects the browser adapter, same-origin HTTP
routes, PostgreSQL, read-only relay and independent Git witness. An end-to-end
harness used throwaway keys, fabricated chain views and receipts, a disposable
database, a local bare Git remote and a synthetic wallet for all three setup
stages. It also checked a lost claim acknowledgement and recovery of an unknown
wallet result by verifying the original hash before recording it. **Those were
not real wallet transactions.** The phone recovery panel can inspect a witnessed
claim and, after a read-only FINAL receipt match, record the original hash; it
never resends a transaction. It requires explicit off-chain wallet messages.
The recovery interface was also exercised at 320 px and 390 px widths in
Chromium with a synthetic wallet and synthetic backend; this is not a real
phone or wallet test.

The setup endpoints are **disabled by default** and the visible app does not
initiate setup transactions. The opt-in backend requires a separate PostgreSQL
URL and independently retained Git head; the temporary PostgreSQL here is
**not** durable hosted storage. This is not production-ready: independent
restore/monitoring, rate limiting, a real wallet and phone, mobile deployment
size, policy/agent execution, provider order/payment and verified delivery all
remain unproven. Fresh preflight cannot prevent state changes while a wallet
prompt is open. Do not ask a user to lock funds for this incomplete path.

A live GitHub transport check used the deliberately synthetic, unowned name
`synthetic-witness-2bd2741a.testnet`: reservation and a claimed marker were
fast-forwarded to this session branch and read back at commit
`0b5b1df7f268da320f7ced6e3db064370a0d2b3b`. It is test-only public evidence,
not an actual account, on-chain result, wallet prompt or payment.
