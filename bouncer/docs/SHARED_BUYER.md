# Experimental shared buyer for direct seller-v3 payments

This is an **opt-in, unaudited, testnet-only** buyer journal for the existing
compute, storage and API resource agent. It coordinates workers that use the
**same authoritative PostgreSQL primary**, the same stable journal ID and the
same encryption key. It has real-PostgreSQL/process tests with **synthetic NEAR
receipts**; it has not been tested with a live PostgreSQL-backed payment. The
previous live seller-v3 proof used a file journal and self-hosted seller.

It does not make a seller independent or establish production exactly-once
payment/delivery. An independent FT-paid seller, live shared-database proof,
secure operations, disaster recovery and an audit remain open work. The on-chain
1-yocto owner-policy guard is unchanged.

## What is coordinated

- A logical journal is identified by the testnet contract, owner and an
  **owner-chosen, permanently stable mission/journal ID**. Within that journal,
  each goal ID is unique. Workers for the same journal hold an exclusive
  PostgreSQL **session** advisory lock; a second worker fails immediately rather
  than waiting or stealing a lease. A new session reads the committed state.
- Across all upgraded workers using this database, an owner-account session
  fence is acquired **before nonce preparation or signing** for a live direct-v3
  batch. It spans different journals, Bouncer contracts and signing keys for the
  same NEAR owner. A competing worker fails immediately, without signing; owners
  can run concurrently with each other. The fence is held for the full direct
  procurement batch, including its delivery callbacks. Seller quotes and some
  previews can occur before this fence and do not constitute payment.
- Before the single signed Bouncer `execute` transaction may be broadcast, the
  buyer commits the original transaction hash, reviewed request and signed v3
  claim. The database atomically enforces unique goal IDs per journal and
  **globally unique seller challenges and transaction hashes** in that database.
  Thus different journal IDs cannot pay the *same issued challenge* twice.
  This global challenge rule is deliberately conservative, even across sellers.
- After a crash or lost response, any `pending` entry for the owner, in any
  journal or Bouncer contract in this database, **quarantines new shared direct
  payments for the entire owner**. This includes a hash persisted before a
  rejected pre-broadcast guard; do not presume it was or was not sent. Recovery
  of the original hash can update a verified successful payment without a NEAR
  key; the owner fence is then released for future payments. If a transaction
  cannot be verified, there is no automatic reset or failure-release mechanism.
- Durable direct settlement uses the reviewed FINAL transaction and receipt
  graph, not a payee balance difference: a seller may receive or spend tokens
  concurrently. This depends on the trusted RPC, deployed Bouncer and token;
  it establishes neither the seller's delivery nor independent adoption.
- Database writes explicitly request `synchronous_commit=on`, check a writable
  primary with `fsync=on`, and check that the same backend still owns the
  session lock. Critical replay indexes are checked when opening. A failed or
  uncertain write poisons the open journal; the caller must stop and reopen the
  original state for reconciliation. A lost reservation COMMIT acknowledgment
  is **not** permission to send. A crash before broadcast can leave a pending
  hash which was never sent; this intentionally favors safety over availability.
- There is **no timeout, automatic lease stealing, delete/reset, or automatic
  transaction retry**. A pending hash remains pending until its original FINAL
  receipts are verified or an operator carefully reconciles it. A timed-out or
  unknown RPC response is not proof of non-payment. The default payment RPC
  client uses one submission attempt; injected RPC providers must not retry.
- The original NEP-413 bearer claim, request and delivery receipt are stored as
  AES-256-GCM ciphertext using a separate random 32-byte journal key. The
  ciphertext is authenticated to its journal identity, goal ID, status,
  fingerprint, seller origin, challenge, transaction hash and revision. The
  database still sees those **metadata**, timing and a request fingerprint; it
  does not see the claim signature, exact memo, task contents or receipt from
  these encrypted fields. The signed NEAR transaction bytes and signing key are
  not stored. A stolen claim is replayable indefinitely: encrypt backups,
  restrict access and never log decrypted entries, request bodies or SQL values.
- Recovery needs the **original journal encryption key**, reviewed goals and a
  trusted receipt-inclusive testnet RPC, but no NEAR signing key. Settlement
  recovery queries only the original hash. Delivery recovery may ask the
  approved seller to replay an already-paid order; that seller must itself
  provide safe idempotent redemption. An ambiguous seller-side external effect
  may still require manual reconciliation.

## Important boundaries

1. The feature covers **only direct authenticated seller-v3 resource payments**
   through `resource-agent.mjs` and the direct recovery helpers/CLIs. V1/v2,
   `ft_transfer_call`, OutLayer/oracle/project, independent x402 `onchain-proof`,
   mixed missions and dependent workflows are **not** distributed-safe through
   this journal and explicitly reject it. Their existing file-journal behavior
   is unchanged. The separate PostgreSQL seller coordinates seller-side work,
   not these other buyer payment paths.
2. Every worker for a logical operation must use the same original database and
   stable journal ID. If two workers choose *different* journal IDs **and get
   different fresh challenges**, the database cannot infer that the owner meant
   the same economic operation. Nor can it stop a worker that pays through a
   file journal, another database, another payment protocol or direct chain call.
   A compromised signer or trusted worker can bypass this coordination. Do not
   change journal IDs to escape a pending entry. The owner fence only covers
   upgraded direct-v3 workers using this exact primary; signing through any
   other path can still race it. The NEAR nonce tracker remains process-local,
   **not a distributed nonce allocator**: after a confirmed payment a stale
   RPC can still yield an unusable nonce, leaving the new hash pending. It does
   not retry it. Different keys for one owner are deliberately serialized, so
   this is safety-first coordination, not per-owner parallel throughput.
3. There is **no file-to-PostgreSQL migration** or automatic import of old
   payments. Do not create an empty shared journal for a mission with any prior
   file journal, outstanding seller quote, unknown transaction, old database or
   historical payment. Stop and reconcile those first with an independently
   reviewed migration procedure. The CLI refuses an explicitly configured or
   default existing file journal, but cannot discover other old files.
4. Direct/session-pooled PostgreSQL is required. Do not use transaction-pooling
   proxies for either session lock. All workers, database administrators and the
   deployment infrastructure are trusted; the restricted role below is not
   tenant isolation. The worker must see **all** entries, including other
   journals for its owner. Row-level security on `entries` is rejected; do not
   grant access through a filtered view. Index checks do not validate every
   column, trigger or hostile live schema change. Never modify schema while
   workers are running.
5. `fsync=on` and synchronous local commits do not prove durable disks, backup
   correctness or a safe high-availability deployment. Asynchronous replica
   promotion, split brain, broken fencing, stale backup restore or a second
   primary can forget reservations and lead to duplicate payments. Use correctly
   configured synchronous replication, primary fencing and reviewed recovery;
   reconcile all external transactions before resuming after any uncertain
   failover/restore. The tests do not simulate real power loss, partitions,
   multi-host failover or production load.
6. A journal currently holds at most **10,000** entries. No eviction, key
   rotation, re-encryption, migration, pending-reset or automatic replacement is
   supplied. Losing its encryption key can permanently lose the ability to
   recover the saved bearer claim; preserve the key and database separately in
   protected backups. Losing, corrupting or rolling back the database is not
   permission to start a fresh journal for the same operation.

## Upgrading existing shared-buyer workers

**Stop and fence every old shared-buyer worker before starting any updated
worker.** Older code can still use this v1 schema but does not acquire the new
owner fence; a rolling mixed-version deployment would silently bypass it. Use
the same primary, existing journal IDs and original encryption keys. Do not
create a replacement database or journal. Examine every existing pending hash
and retain the originals: the updated code blocks new shared direct payments
for that owner until they are reconciled.

No journal-data migration is needed. The privileged schema initializer is
idempotent and, when run with all workers stopped, adds a non-unique partial
index to speed up owner-pending lookups. An existing database without the index
can still run correctly but will scan its entries. Back up and review the normal
DDL impact before applying it; it may lock a busy table. Do not run schema
changes during payment execution. This is not a failover or stale-backup repair.

## Provisioning, roles and secrets

These are operator instructions, not a ready-to-use public deployment. Review
all testnet accounts, policies, tokens, payees, prices, seller origins, inputs
and goals first. Do not put database URLs or keys in repository files, logs,
command arguments, chats or a public preview. The buyer accepts plaintext
PostgreSQL only on loopback; remote connections require `sslmode=verify-full`
and a trusted CA. Provide `BOUNCER_BUYER_DATABASE_URL` via a secret manager.
Use a dedicated database, restrict network access and disable sensitive query
logging. Neither database TLS nor encryption protects a compromised worker.

Generate and securely back up a **random binary 32-byte** key for each logical
journal. Put it in an owner-owned regular file with mode `0600` (or `0400`),
not a symlink. Supply its path via `BOUNCER_BUYER_JOURNAL_KEY_FILE`; never put
its bytes in an environment variable. For example, after separately securing
`$HOME/.bouncer/secrets`, the following creates a key only if it does not
already exist (do not rerun it as a replacement):

```sh
umask 077
mkdir -p "$HOME/.bouncer/secrets"
node -e 'require("fs").writeFileSync(process.env.HOME+"/.bouncer/secrets/buyer.key", require("crypto").randomBytes(32), {mode:0o600,flag:"wx"})'
export BOUNCER_BUYER_JOURNAL_KEY_FILE="$HOME/.bouncer/secrets/buyer.key"
```

With an administrator's URL already supplied securely, initialize the schema
once. This does not create a journal, request a quote or contact NEAR:

```sh
cd bouncer
npm run init-shared-buyer-db -- --confirm-testnet-schema
```

A database administrator can then create distinct restricted roles. Names here
are examples; provision their credentials separately. The **journal registrar**
can create a new empty logical journal, while the normal **worker** cannot create
or delete journals and cannot update the immutable hash/challenge columns:

```sql
GRANT USAGE ON SCHEMA bouncer_buyer_v1 TO buyer_registrar, buyer_worker;
GRANT SELECT ON bouncer_buyer_v1.meta, bouncer_buyer_v1.journals, bouncer_buyer_v1.entries TO buyer_registrar;
GRANT INSERT ON bouncer_buyer_v1.journals TO buyer_registrar;
GRANT SELECT ON bouncer_buyer_v1.meta, bouncer_buyer_v1.journals, bouncer_buyer_v1.entries TO buyer_worker;
GRANT INSERT ON bouncer_buyer_v1.entries TO buyer_worker;
GRANT UPDATE (status, revision, nonce, tag, ciphertext, updated_at) ON bouncer_buyer_v1.entries TO buyer_worker;
```

The worker can still insert rows and rewrite encrypted state columns. It and its
key are trusted; these grants do not prevent a malicious worker from attempting
payments outside the journal. An inspector needs only schema `USAGE` and SELECT
on `contract_id`, `owner_account_id`, `journal_id` from `journals`, plus those
columns and `entry_id`, `status`, `tx_hash`, `seller_origin`, `challenge`,
`created_at`, `updated_at` from `entries`.

Only after confirming this is a genuinely **new** operation, use the registrar's
URL and original journal key to explicitly register its stable ID. This command
fails if it already exists, and does not issue a quote or payment:

```sh
npm run init-shared-buyer-journal -- --contract bouncer.example.testnet --owner owner.example.testnet --journal mission-001 --confirm-new
```

Switch to the worker's secret URL and use the exact same journal ID and key on
every worker. The following is an operator example that **sends real testnet
payments** if the reviewed policy and seller permit them. It is not a dry run:

```sh
node agent/resource-agent.mjs --goals reviewed-v3-goals.json --key execute-only-key.json --shared-journal mission-001 --durable --execute
```

## Inspection and recovery

Using a restricted read-only URL, the metadata inspector requires no encryption
or NEAR key and never changes state or contacts NEAR. Its result is an
unauthenticated metadata snapshot, **not proof** of payment or delivery; it
includes publicly correlatable hashes and challenges. `--limit` is 1–1000 and
`has_more` reports truncation.

```sh
npm run inspect-shared-buyer -- --contract bouncer.example.testnet --owner owner.example.testnet --journal mission-001
```

If the owner fence reports an unresolved payment, inspect pending metadata
across that owner's journals and Bouncer contracts in the **same primary**:

```sh
npm run inspect-shared-buyer -- --owner owner.example.testnet --pending-owner --limit 100
```

This requires read-only `SELECT` on the listed metadata columns across all
entries, not a NEAR or encryption key. `--offset N` pages results when needed;
separate pages can change while recovery is happening, so rescan rather than
assuming a consistent multi-page snapshot. Metadata may expose which seller was
used and is not cryptographic payment proof. A clean report covers only this
one database, not other databases, local files, other protocols or chain calls.
Never delete, reclassify or fabricate a pending row to release the owner fence.

To reconcile the **same** hash, securely supply the worker URL and original
journal key. Settlement recovery verifies FINAL Bouncer/token receipts without
signing or broadcasting. Delivery recovery additionally asks the pinned seller
to replay the already-paid v3 order; use it only when that seller's redemption
is idempotent and safe to replay. Both use the original reviewed goals:

```sh
npm run recover-direct -- --goals reviewed-v3-goals.json --id compute --shared-journal mission-001
npm run recover-direct-delivery -- --goals reviewed-v3-goals.json --id compute --shared-journal mission-001
```

If a hash is pending and its FINAL outcome is unavailable or ambiguous, preserve
all state and stop. Neither command automatically pays again. If a seller cannot
safely replay an ambiguous delivery, reconcile with its operator instead of
calling delivery recovery. Never clear the row or create a fresh mission to
avoid the unresolved outcome.

## Tests

`tests/shared-buyer-journal.test.mjs` uses a disposable PostgreSQL 17 database,
actual signatures, multiple OS worker processes and synthetic NEAR receipts. It
covers owner-wide serialization across journals/keys/contracts, different-owner
concurrency, lost owner locks, quarantine after `SIGKILL`, recovery of the
original hash, row-level-security rejection, challenge/hash races, lost COMMIT
acknowledgments, encryption/tampering, unsafe database state, unsupported
protocol guards, restricted roles, read-only owner inspection and
compute/storage/API delivery through a local seller. No real payment is sent.
CI requires PostgreSQL tests; for local runs set `BOUNCER_TEST_POSTGRES_URL` to a
**disposable superuser-owned database** and `BOUNCER_REQUIRE_POSTGRES_TESTS=1`.
The tests create roles and an additional temporary database; never point them at
an operational buyer or seller database.
