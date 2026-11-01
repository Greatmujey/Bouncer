# Optional encrypted local journals

This is experimental, unaudited **testnet** software, not production key
management. The ordinary local `FileJournal` is private by file permissions but
is **plaintext by default**. A seller-v3 journal can contain a replayable bearer
signature as well as private task data and a payment's original hash. Protect
it and its backups, whether encrypted or not. Never publish recovery artifacts.

An optional AES-256-GCM envelope encrypts and authenticates the entire local
journal using a separate, random 32-byte key. The associated data binds the
ciphertext to the expected contract and owner; each rewrite uses a fresh random
96-bit nonce. No plaintext temporary file is created in encrypted mode. The
existing atomic rename, file and directory fsync, exclusive local lock and
fail-closed write behavior are retained. This covers local file journals used
by the resource agent, direct payment/delivery recovery, procurement,
dependent workflows, mixed/paid missions, FT-call, OutLayer, oracle, project,
and onchain-proof CLIs. The testnet demo runners also check and honor this
setting, but can write other plaintext evidence and seller state. These
integrations have synthetic local tests, not a live encrypted-journal payment.

Encryption is **not** replay prevention or fresh-state proof. An older valid
ciphertext for the same key/owner/contract can be restored or substituted,
including from a different journal for that owner/contract. A missing original
file or different journal path cannot be distinguished from a brand-new
journal. Separate file journals do not coordinate payments. Do not start a new
journal to escape an uncertain payment. The shared PostgreSQL direct-v3 buyer
has a separate key and coordination model; see [SHARED_BUYER.md](SHARED_BUYER.md).

## Create a key safely

Use a dedicated existing owner-only directory outside the repository and a new
path. The key initializer creates a 0600 file without overwriting anything,
then syncs the file and directory; it rejects a symlinked or non-private final
parent directory. For example, from the repository root, with a **new** private
`$HOME/.bouncer-keys` directory:

```sh
mkdir -m 700 "$HOME/.bouncer-keys"
node bouncer/scripts/init-file-journal-key.mjs --key-file "$HOME/.bouncer-keys/file-journal.key"
export BOUNCER_FILE_JOURNAL_KEY_FILE="$HOME/.bouncer-keys/file-journal.key"
```

The key must be an owner-only, single-link regular file containing exactly 32
raw random bytes, not a password or an encoded string. Store a secure backup
separately from the journal, before any payment. If initialization reports an
error, a partial file may remain: stop and inspect the original path rather
than using it, replacing it or assuming it was synced. The initializer never
overwrites an existing file. If the key is lost, the encrypted journal cannot
be recovered. Do not store keys in Git, logs, Actions artifacts or a shared
preview. The environment variable contains a **path**, not the key bytes.

Set `BOUNCER_FILE_JOURNAL_KEY_FILE` for every file-journal execution and
recovery process, including restarts. It opts **new** local journals into
encryption. An existing encrypted file refuses a missing or wrong key; an
existing plaintext file refuses an implicit conversion when the key is set.
Do not create a new file to get around either error. The environment variable
has no effect on PostgreSQL shared journals, which use
`BOUNCER_BUYER_JOURNAL_KEY_FILE` instead. Use independent keys for these roles.
The configured CLI checks that the same key file is still readable and matches
before each journal write; a detected change stops the session. The key can
still be lost or changed after that check, so this is not an atomic key-backup
or availability guarantee. A process using `FileJournal` directly must
explicitly pass its own key (and, optionally, `keyFile` for this recheck) or
use `openConfiguredFileJournal`; the environment alone cannot configure
arbitrary third-party callers.

## Convert an existing original journal

Stop and fence all workers that could use the file. Keep the original location,
contract/owner IDs, pending entries and journal key; make a protected backup
under an appropriate retention policy before proceeding. Backups made from the
old plaintext file remain plaintext. With the key environment variable set:

```sh
node bouncer/scripts/encrypt-file-journal.mjs \
  --state /private/path/to/ORIGINAL-journal.json \
  --contract CONTRACT.testnet --owner OWNER.testnet
```

Replace the paths and account IDs with the **original** values. The tool takes
the same exclusive lock, validates the existing entries and account scope, and
atomically replaces that file with an encrypted copy. It does not sign, contact
NEAR or a seller, send a payment, or create a missing journal. It preserves
pending hashes and claims; an already encrypted file with the same key is a
no-op. It refuses a different account, invalid entries, insecure file
permissions, a symlink, a hard-linked source, or a missing/wrong key.

A failed fsync or crash can leave either the original plaintext or the encrypted
file, and may leave an encrypted temporary file or stale lock. Stop and verify
that all workers are dead/fenced. Carefully inspect the **same original path**
and reconcile its entries before continuing. Only an operator who has fenced
all workers may deal with a stale lock. The in-place conversion command is
idempotent for the original file with the correct key; it does not settle or
resend a payment. Never delete an unresolved journal to unblock a run. Old
plaintext backups, storage snapshots, filesystem remnants and previously
published artifacts are not erased by conversion.

## Recovery and boundaries

Normal same-hash recovery continues to require the original journal and the
file encryption key, but **not** the NEAR transaction-signing key. For example,
`recover-direct` verifies the original payment and `recover-direct-delivery`
reuses its recorded v3 claim with the pinned seller. Both need the same
`BOUNCER_FILE_JOURNAL_KEY_FILE` when the journal is encrypted. Delivery
recovery can contact the seller and requires its idempotent redemption policy;
it cannot prove an arbitrary seller's external side effect was not performed.
A failed or unknown RPC lookup remains unresolved; never repay automatically.

The standalone historical `scripts/reconcile-oracle-journal.mjs` and
`scripts/reconcile-project-journal.mjs` currently read **plaintext** snapshots
only and do not decrypt these envelopes. Use the corresponding normal recovery
CLI with the original key for an encrypted journal; do not create a plaintext
copy on disk simply to run the historical inspector. The existing unresolved
project must not be resent.

The encrypted file is limited to 8 MiB of serialized plaintext and a 12 MiB
input envelope. A size, authentication, write or sync error stops the session;
reopen and reconcile the original state. The file and key readers require
owner-only regular files with one hard link, and the file lock is local, not a
cross-host database fence. A trusted filesystem must honor exclusive creation,
atomic rename and fsync. Ciphertext length, filenames, modification times and
access patterns remain visible.

The key and plaintext necessarily exist in process memory; memory dumps,
malicious same-user processes, compromised hosts, logs, network requests,
sellers and stolen keys can expose them. Buffer clearing is best effort, not
secure erasure. Encryption does not revoke a previously leaked v3 signature,
protect old plaintext copies, guarantee settlement, delivery or distributed
exactly-once execution, or make an untrusted seller trustworthy. Local file
key rotation is not implemented; never replace a key while its journals or
backups still depend on it. Use protected backups, restricted hosts and a
reviewed incident plan; do not use real funds.
