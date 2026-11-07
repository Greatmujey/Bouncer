# Phone testnet FT path: current preview and safety boundaries

This is an experimental testnet path, **not a completed autonomous purchase**.
The phone preview can connect a supported NEAR wallet, request an off-chain
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
not a payment or a real-device wallet test. A separate attempt to download a
GitHub Actions encrypted artifact from the sandbox failed because the artifact
host is not reachable; it did not submit a transaction.

A public archival/readiness run on November 7 observed 40 Circle test USDC in
`great_mujey.testnet`, the reviewed Buffer fixed product at 20 test USDC, and a
planned **6 test NEAR** keyless vault deposit. The actual state can change; a
keyless vault can leave its storage stake locked. A live setup must recheck
state and show these terms before the owner's wallet approval.

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
The authenticated setup service and browser challenge verifier have been
exercised together with disposable owner keys, PostgreSQL, synthetic chain
views and a separate local Git remote. They only sign off-chain messages and
return no wallet transaction. The disposable preview PostgreSQL is **not** a
durable hosted production database; the witness and wallet invocation are not
wired into the phone preview. Do not open a real setup prompt on this prototype until the hosted
authenticated backend, independent restore procedures, wallet transport and
original-hash recovery have been integrated and verified.

A live GitHub transport check used the deliberately synthetic, unowned name
`synthetic-witness-2bd2741a.testnet`: reservation and a claimed marker were
fast-forwarded to this session branch and read back at commit
`0b5b1df7f268da320f7ced6e3db064370a0d2b3b`. It is test-only public evidence,
not an actual account, on-chain result, wallet prompt or payment.
