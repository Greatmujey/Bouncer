# Experimental shared seller-v3 order book

This is a **separate, self-hosted, testnet-only reference seller**, not an
independent merchant or production service. Multiple Node workers can coordinate
seller-v3 quotes and redemptions through **one PostgreSQL primary**. The older
file-backed seller is unchanged and still only protects one locked directory.
The shared seller has **not** been exercised with a live NEAR payment: its tests
use real PostgreSQL and separate OS processes but synthetic FINAL receipts.
The earlier live v3 proof used the file-backed seller, not this one.

The existing multi-resource buyer can use this seller's `/quote`, `/redeem` and
`/storage-read` endpoints with an owner-reviewed `seller-v3` goal. It supports
the bounded compute, storage and API examples; it does not support v1 or v2.
Payment verification and claim authorization still trust the configured RPC,
Bouncer deployment and FT contract. No secret buyer key is sent to the seller.

## Safety properties and limits

- The seller persists a random challenge and exact product terms before issuing
  a quote. A single conditional database update commits a globally unique
  transaction hash and marks that quote `pending` **before** work starts.
  Across workers using the same healthy primary, at most one can win the claim;
  the same hash cannot be attached to another quote in that database.
- The winning worker receives a random execution token; only its SHA-256 hash
  is stored in the pending database row. It prevents accidental completion by
  an ordinary losing code path, **not** a malicious worker with direct database
  write privileges. A completed result is returned only to the original valid
  NEP-413 claimant. For storage, content
  and result are committed together in the database; authenticated reads can
  land on another worker. Claim signatures are not stored by the seller.
- **No timeout, lease stealing or automatic re-execution exists.** A crash,
  failed fulfillment or lost commit acknowledgment can leave an order pending
  indefinitely. On a completion-commit acknowledgment loss, the same signed
  claim can retrieve a completed result if it actually committed; otherwise it
  remains pending. The service never automatically repeats the external work.
- PostgreSQL transactions explicitly use `synchronous_commit=on`; workers refuse
  a read replica, `fsync=off`, read-only primary, mismatched seller configuration
  or schema missing critical replay indexes. Schema indexes are checked at
  initialization/worker startup, not continuously; never modify them while
  workers are running. These checks do **not** prove that storage hardware is durable or a high-availability cluster is correctly
  configured. Asynchronous failover, split brain, restoring an older backup, or
  another database serving the same seller can lose/reintroduce claims and
  cause duplicate work. Use properly configured synchronous replication, primary
  fencing, durable WAL/backups and a reviewed disaster-recovery procedure.
- This coordinates **seller-side claims**, not the buyer's on-chain broadcasts.
  The buyer's journal is still local, and two buyers/journals can independently
  pay the same quote. A database cannot reverse an FT transfer, guarantee a
  refund or establish exactly-once effects at an arbitrary external provider.
  Keep the original buyer journal and never resend an uncertain payment.
- All workers must be trusted, use identical pinned configuration and the same
  authoritative database. An attacker with a worker's database credentials can
  modify seller state. Do not mix this seller with file-backed instances, a
  second database, old backups, or another implementation serving the same
  seller identity. There is **no automatic migration** of existing file-backed
  quotes or in-flight payments; migrating a live seller needs a separate reviewed
  procedure that preserves every outstanding quote and claim.
- `max_quotes` is a persistent capacity (default 10,000, maximum 1,000,000),
  counting even abandoned or apparently unpaid quotes. It is pinned with prices
  and identity. No quote expiry, eviction, resizing, price-change or migration
  tooling exists. An `issued` quote with no recorded hash may already have been
  paid. An unauthenticated quote flood can exhaust capacity; add authentication,
  admission control and rate limits at a trusted proxy.

## Configuration and isolation

The worker reads a JSON file like `bouncer/examples/shared-seller.example.json`.
Its account IDs, origin, token, payee and prices are **illustrative** and must
be replaced with explicitly reviewed testnet configuration. `seller_origin`
is the canonical buyer-facing HTTPS origin, not the request's Host header.
Every worker for that seller must use the same seller ID, origin, Bouncer/owner,
products and capacity; `port` may vary. The listener binds `127.0.0.1` only.
A trusted HTTPS reverse proxy must terminate TLS, protect request bodies and
route to workers. Never expose the HTTP listener directly to the public.

Supply `BOUNCER_SELLER_DATABASE_URL` through the deployment's secret manager;
do not commit it, paste it into chat or put it in config files/logs. The worker
accepts plaintext PostgreSQL only on loopback; remote URLs must specify
`sslmode=verify-full` and use a trusted CA (or `sslrootcert`). Restrict network
access, rotate database credentials, and authenticate workers. The database and
backups contain **plaintext order results and storage contents**; use protected,
encrypted storage and disable sensitive query/body logging. A stolen v3 claim
signature is a replayable bearer credential with no expiry or revocation. TLS,
separate access controls, and careful handling of buyer journals are essential.

### One-time schema setup and restricted worker role

Run schema initialization only against the intended testnet database, with an
administrator's secret URL already supplied in the environment. It creates a
versioned schema and tables if absent and does not contact NEAR, issue a quote,
delete orders or make a payment. The worker subsequently needs no DDL or DELETE
privileges. For example, a database administrator can create a dedicated login
and grant only the following (provision credentials separately):

```sql
GRANT USAGE ON SCHEMA bouncer_seller_v3 TO bouncer_worker;
GRANT SELECT ON bouncer_seller_v3.meta TO bouncer_worker;
GRANT SELECT, INSERT, UPDATE ON bouncer_seller_v3.sellers,
  bouncer_seller_v3.orders TO bouncer_worker;
```

That role can still update **all** rows in those tables; it is trusted, not
strong tenant isolation. Further restrict roles/network/row access as needed.
Do not grant the initialization role to worker processes. A read-only inspector
role needs only schema `USAGE` and `SELECT` on `sellers` and `orders`.

With the respective admin, worker or read-only URL supplied securely for each
command, the operations are:

```sh
cd bouncer
npm run init-shared-seller-db -- --confirm-testnet-schema
npm run shared-provider -- --config examples/shared-seller.example.json
npm run inspect-shared-seller -- --seller example-shared-v3 --include-issued
```

These are operator examples, not a ready-to-use public deployment. The worker
checks that its RPC reports testnet before starting. `NEAR_TESTNET_RPC` may be
configured separately. Initialization and inspection never send transactions.

## Recovery and inspection

The inspector runs a **read-only, repeatable-read transaction** on the current
primary. It reports recent challenge/resource/status/hash/timestamps and quote
capacity, never signatures, execution tokens or object content. `--limit` is
1–1000, default 100; `has_more: true` means the result is incomplete and there
is no pagination yet. By default `issued` rows are omitted; `--include-issued`
shows them. Even a complete database snapshot cannot determine whether an
unrecorded external side effect occurred or an issued quote has been paid.

If a row is pending, preserve the database and buyer journal, stop conflicting
operations, inspect the same transaction and the downstream system, and
reconcile with the seller/operator. There is intentionally **no CLI to clear,
reassign or replay pending work**. If the effect cannot be established, do not
repeat it or repay. Restoring a stale database without reconciling already
performed work is unsafe.

## Tests

`tests/shared-resource-provider.test.mjs` uses a disposable PostgreSQL 17
instance, real SQL constraints/transactions and separate Node processes. It
covers concurrent same-claim and two-payment races, global hash uniqueness,
worker `SIGKILL`, lost claim/completion COMMIT acknowledgments, forged claims,
authenticated storage across restarts, schema tampering, capacity, least-
privilege roles, read-only inspection and a synthetic multi-resource buyer
recovery. The acknowledgments are fault-injected after a real commit; there is
no actual NEAR payment, physical power-loss test, network partition, multi-host
load test, replication/failover exercise or independent seller adoption.

CI supplies an ephemeral PostgreSQL service and requires these tests. For local
runs set `BOUNCER_TEST_POSTGRES_URL` to a **disposable superuser-owned test
database** and `BOUNCER_REQUIRE_POSTGRES_TESTS=1`; the tests create roles and an
additional temporary database. Do not point them at a real seller database.
