# Experimental one-shot Ref testnet adapter

This is an unaudited testnet prototype. The router builds and its contract and
client have synthetic tests, but the combined path has **not** yet been
proven against a live Ref pool. It is not production-ready. Do not use real
funds or assume a successful input transfer is an output.

## Why an adapter

A normal Ref instant swap sends output with plain `ft_transfer`; Bouncer's
`ft_on_transfer` is therefore not called and its internal vault balance is
not credited. A raw token-balance increase is not safe evidence of a vault
credit when other deposits, pending sends and refunds can interleave. An
inspected Ref source fork also describes an optional `client_echo` output via
`ft_transfer_call`, but its sender is subject to exchange-maintained
allowlists. The read-only testnet discovery job found a `wrap.testnet` token
allowlist entry, but not a general Bouncer sender. This view and a source fork
are not proof of deployed code or a swap.

The separate `contracts/ref-router` prototype instead isolates **one** bounded
`wrap.testnet` → Circle **testnet** USDC trade on one of two reviewed Ref
pools. The owner deploys and initializes a fresh router from its own account;
the owner and destination Bouncer vault, exact input, pool and minimum output
are immutable. Bouncer's owner must explicitly allow the router and pin its
exact receiver message under an FT spending policy. The restricted agent still
uses Bouncer's zero-deposit execution and its caps and allowlist.

1. The router accepts the pinned input from only the configured vault, once.
   It passes that exact input to Ref. A known inner NEP-141 result returns only
   the unused amount to the outer token resolver. An unknown result returns no
   claimed refund and the one-shot router never resets.
2. Ref may send output to the router as a plain FT transfer, or leave it at
   Ref if that transfer fails. Neither the inner result nor a router balance
   proves which outcome happened.
3. After independently verifying the original final receipts, a separately
   scoped owner function-call key can ask the router to `sweep_output`. It
   always uses a real Circle-token `ft_transfer_call` **to the immutable
   Bouncer vault**, allowing the vault's normal receiver hook to credit the
   actual transferred amount. Failed or unresolved sweeps must not be retried
   blindly. This transfer is separately journaled and its own receipts must be
   checked; balance deltas are not settlement proof.
4. A manual emergency transfer of either pinned token to the vault, a Ref
   output withdrawal, and native surplus reclaim require the owner and
   **exactly 1 yoctoNEAR**. They cannot select an arbitrary FT destination.
   They are operator recovery tools, not automatic failover.

## Experimental client and recovery

`agent/ref-swap.mjs` defaults to dry-run and accepts an explicit reviewed goal:

```json
{
  "version": 1,
  "id": "unique-trade-id",
  "contract_id": "vault.example.testnet",
  "owner_account_id": "owner.example.testnet",
  "router_id": "router.example.testnet",
  "router_code_hash": "BASE58_SHA256_OF_THE_REVIEWED_ROUTER_WASM",
  "policy_id": "swap-policy",
  "policy_revision": 1,
  "route_revision": 1,
  "pool_id": 1845,
  "input_amount": "10000000000000000000000",
  "min_output": "3000"
}
```

Replace the code-hash placeholder with the base58-encoded SHA-256 hash of the
exact reviewed WASM. The client checks that against the router account at
finality, requires **zero remaining router access keys**, checks the immutable
configuration and FT registrations, and requires two separate function-call
keys on the owner's account: one scoped only to Bouncer `execute_ft_call`,
other scoped only to this router's `sweep_output`. It also requires the
router to have at least 0.1 testnet NEAR for storage and gas. The sample output
minimum is illustrative, not a current quote.

A live invocation requires the original exclusive file journal and an explicit
`--execute`; recovery uses `--recover` with that same journal and **no signing
keys**. `BOUNCER_FILE_JOURNAL_KEY_FILE` enables the existing opt-in encryption;
see [FILE_JOURNALS.md](FILE_JOURNALS.md). Do not create a replacement journal
or restore an old snapshot after a crash. Journaling is local/cooperative; it
is not distributed fencing or protection against rollback.

After an input was already recorded, `--sweep-only --state ORIGINAL_JOURNAL
--sweep-key SWEEP_KEY.json` can preview the separately authorized output
transfer without an input key. With explicit `--execute`, it first verifies the
original FINAL input/output receipts and router state, then journals the sweep
hash before its only broadcast. It never signs or sends an input swap; if a
sweep hash already exists, it recovers that hash instead of resending. Preview
and key-free `--recover` do not authorize a new sweep.

The input and output sweep have separate hashes, each written before its one
broadcast. The client checks the FINAL receipt graph from the exact Bouncer
input through the router and Ref to a successful Circle transfer to that
router. It then signs the exact actual output amount for a second transfer-call
and verifies the Bouncer deposit hook plus full token settlement. This is not a
light-client proof: RPC, token, Ref and pinned Bouncer/router code are trusted.
An unresolved receipt graph, output failure, missing hook, malformed result or
failed/uncertain broadcast stops; it is never silently resent. In particular,
`OUTPUT_RECEIVED` means the router received output, not that the vault was
credited. The only success status, `COMPLETED`, requires both proofs.

The prototype remains **one shot** after failures; a fresh account is not a
license to repeat an ambiguous trade. Preserve the original transaction hash
and reconcile input, Ref output and any sweep independently. A lost callback,
failed Ref transfer, unregistered token account, bad gas estimate or partial
refund may leave funds in the router or at Ref. Only use the owner's recovery
methods after checking the original finalized receipts and provider balances.

### One-shot testnet proof harness

`demo-ref-swap.mjs` is gated by an explicit testnet acknowledgement and a
separate CI marker; it has not yet established a live swap. The first attempt
stopped during account creation because the initial helper grant could not
cover storage and the proposed subaccount funding. It failed before vault
funding, the swap input or any sweep. Its owner-key envelope was retained, but
that first envelope did not contain the Bouncer deploy key; the disposable
account may therefore be unrecoverable. A second attempt used a separate
helper-funded router and sealed both deployment keys, but its router became
visible optimistically before the FINAL account view caught up; it stopped
before initializing or funding the vault, input or sweep. Its encrypted
credentials were retained. The harness now waits through bounded **read-only**
FINAL account/key checks before proceeding.

A third fresh testnet attempt sent one input transaction,
[`DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz`](https://testnet.nearblocks.io/txns/DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz).
A [read-only inspection](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41299603195/job/124827621907)
confirmed full input settlement and saw `6926` micro testnet USDC in the router,
with zero in the Bouncer output vault. The first verifier stopped on the
callback's zero-byte argument encoding; after fixing it, a [second read-only
inspection](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41299832993/job/124828302526)
verified the linked FINAL Ref output receipt
`7KEWv6Ux5EHX6R1F7ipdZmvFZKp7p6iQkpRsynXieSSX` for those same `6926` units.
The original input was not resent and no sweep has yet been sent, so vault
credit and completion are not claimed. Preserve the original journal and
reconcile the same hash before separately considering a sweep.

A narrowly gated recovery job can verify that original output again and accept
**only** the previously scoped `sweep_output` key through a challenge-bound,
RSA-encrypted handoff to an ephemeral GitHub Actions worker. The private repo
and Actions worker must be trusted; the request's public metadata is exposed in
a job annotation, and the ciphertext passes through a private PR comment. The
full-access owner key and input key are not shared. The job requires the original journal, verifies the pinned account/key
and exact receipt, and records a new sweep hash before its sole broadcast. A
missing or uncertain sweep remains pending and must never be resent blindly.
The first handoff attempt failed when GitHub denied its comment-write request;
that attempt emitted no key request and no sweep. Its retained journal is
checked alongside the original before another attempt. This testnet handoff
is not a production key-management or distributed recovery service; it has
synthetic tests but no completed live sweep proof yet.

The harness creates fresh, disposable testnet accounts, obtains a fresh bounded
quote, deploys the exact router and removes its deploy key, funds only the capped
input, and deliberately loses each response to exercise original-hash recovery.
Do not rerun an uncertain transaction. Ordinary CI does **not** run this funded
test.

To make an unsuccessful **testnet-only** run recoverable without publishing its
signing keys, the revised harness encrypts its disposable owner, input, sweep,
Bouncer deployment and router deployment keys to
`config/testnet-ref-demo-recovery-public.pem` using RSA-OAEP-SHA256 and
AES-256-GCM. Only ciphertext, public identities and journal/receipt evidence are
retained in the repository-restricted Action artifact/annotation. The matching
private recovery key is separate and owner-only outside Git, at
`~/.near-credentials/testnet/bouncer-ref-demo-recovery-private.pem` in the
operator workspace. If that private key is lost, the sealed credentials cannot
be recovered. The envelope does not authenticate its creator: after opening it
with `scripts/open-ref-demo-credentials.mjs`, compare every recovered public key,
account, route and code hash against FINAL chain state before use. This one-off
key is not a general key-management service, distributed recovery mechanism or
production credential solution; rotate it for new experiments and never put
mainnet keys into the envelope.

The route, tokens and gas bounds are intentionally narrow and testnet-only.
The owner must review pool liquidity and minimum output before deployment and
provide the router and vault with required storage registrations and a native
NEAR reserve. Trust the router binary, configured Ref contract, both token
contracts and RPC; the source version string is not deployed-bytecode
attestation. Deleting the router's deployment key after initialization is
important to prevent a key holder from replacing its code, but this means
recovery depends on the contract's fixed methods. Do not deploy without a
reviewed operational plan.

There is no general swap protocol, cross-chain settlement, freshness oracle,
independent security audit or guarantee of Ref availability. Output from one
swap is not proven by an unrelated incoming donation. The client must bind the
Ref output receipt and the subsequent real transfer-call to the same reviewed
trade before declaring success.
