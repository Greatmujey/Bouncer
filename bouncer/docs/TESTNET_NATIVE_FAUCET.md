# Experimental native-NEAR testnet faucet

**Status: isolated nearcore sandbox passed; live testnet untried. No Bouncer
faucet request, transfer or cleanup has been made on testnet.** The helper and
receipt shapes may change; a safe stop is possible even after a real transaction
succeeds. This path supplies native **test NEAR**, not Circle test USDC. It does
not prove owner-key control, deploy the V11 vault, buy a resource or verify
independent delivery.

## What this does

The separate `agent/native-testnet-faucet.mjs` follows the design of the
[NEAR Docs browser faucet source at commit `e2d2ea1`](https://github.com/near/docs/blob/e2d2ea173cf462bcf518ecae5650984a221d5183/snippets/faucet.jsx):
create a random named testnet account with a temporary Ed25519 key, request
helper funding, transfer exactly 5 test NEAR to an **existing** named testnet
recipient, then delete the temporary account and return its remaining balance
to `v2d.faucet.nonofficial.testnet`. The [older hosted docs-service faucet was
retired](https://github.com/near/docs/pull/3162); this implementation does not
call that retired API. Helper availability, rate limits and current funding are
not guaranteed.

The owner wallet's private key is neither needed nor requested. The temporary
key stays in a dedicated local AES-GCM encrypted file journal while recovery
may be needed. The helper receives only the random temporary account ID and
public key. A local preview requires a reachable testnet RPC but does not call
the helper, sign or create a journal entry. `--execute` is a consequential
network action, not a preview.

## Safety and recovery

- The operator chooses a trusted HTTPS testnet RPC. The program checks its
  reported `chain_id`, uses fresh pinned FINAL account/key/storage views and
  requires the temporary account to be code-free with exactly its expected
  full-access key. A reported RPC result is not a consensus proof. Views can
  change; these checks are not an audit or a guarantee of available gas.
- Before the one helper POST, the original encrypted journal durably records the
  temporary secret, public key, recipient and helper-attempt fence. No private
  key is placed in the helper request, logs, URLs or output. If the helper
  times out or its response is lost, **never send another helper request for
  this operation**. The helper may still have created the account.
- Each exact transaction hash is recorded before at most one broadcast. If
  the process, RPC or disk fails after recording, the original hash remains
  fenced even if the transaction was never actually sent. Resume looks up
  that hash only; it does not resend it or prepare a replacement. Keep the
  original journal and its separate key, including after failures. Loss,
  rollback, copying to another journal, bypassing the locks, an untrusted RPC
  or a compromised machine defeats these protections.
- Cleanup is not attempted until a matching original transfer and its bounded
  receipt graph are FINAL according to the selected RPC. A cleanup is marked
  complete only after a matching DeleteAccount outcome, a linked successful
  system refund to the pinned faucet beneficiary and temporary-account absence
  at a fresh FINAL block. If nearcore returns a recognized failed gas refund to
  the already-deleted account, the output explicitly marks it as burned. Other
  unknown graphs remain unresolved. A successful balance refund is not a claim
  that every gas refund succeeded.
- Confirmed cleanup removes the temporary key from the current encrypted
  journal; older backups may still contain it. JavaScript cannot guarantee
  erasure from memory or storage media. Retain the current journal and key
  securely and do not upload them, the wallet key or backup copies to Git,
  Actions logs or chat. The program cannot verify that backups exist.

`--resume` inspects an existing original operation. `--resume --execute` may
continue an original helper-created account or record verified recovery and
proceed to its **not-yet-attempted** cleanup. It never retries the helper or an
already recorded transaction. For an unresolved transfer or cleanup, retain
the exact original hash and stop; do not create a fresh journal to work around
it. Read-only inspection does not update the journal. `FUNDED_AND_CLEANED`
means only that the selected RPC reported the native transfer, beneficiary
refund and account absence with the expected evidence; it is not live proof in
the synthetic tests.

## CLI outline

Use `node bouncer/agent/native-testnet-faucet.mjs --help` for the complete
options. An operator first creates and securely backs up a separate owner-only
file-journal key with `bouncer/scripts/init-file-journal-key.mjs`, sets
`BOUNCER_FILE_JOURNAL_KEY_FILE`, and selects a **new dedicated** journal path,
the existing recipient and a trusted testnet RPC. The tool has no default
recipient, RPC, journal or key. For example, these are argument patterns, not
instructions to run a live transaction:

```text
--owner ACCOUNT.testnet --state ORIGINAL-FAUCET-JOURNAL --rpc TRUSTED-TESTNET-RPC
--owner ACCOUNT.testnet --state ORIGINAL-FAUCET-JOURNAL --rpc TRUSTED-TESTNET-RPC --execute
--owner ACCOUNT.testnet --state ORIGINAL-FAUCET-JOURNAL --rpc TRUSTED-TESTNET-RPC --resume
--owner ACCOUNT.testnet --state ORIGINAL-FAUCET-JOURNAL --rpc TRUSTED-TESTNET-RPC --resume --execute
```

The first pattern is a read-only preflight; the second may contact the helper
and submit two transactions; the third inspects; the fourth may continue the
original operation. Each `--execute` requires the operator's actual approval.
Neither an API flag nor a passing test establishes human consent. The separate
[V11 owner setup](SVALIN_PRO_READINESS.md) still requires its own exact-stage
approval and test-USDC funding; obtaining test NEAR does not satisfy either.

The local regression tests use synthetic helper responses, RPC views and
receipts, including timeouts, forged graphs, disk failure, drift and recovery.
The [isolated nearcore run for `c6c646a`](https://github.com/Greatmujey/Bouncer/actions/runs/41459488001)
passed the faucet scenario using an in-process fake helper and sandbox-only
accounts. It reconciled a 5-NEAR local transfer and beneficiary refund using
the original encrypted journal after two simulated lost acknowledgements. It
contacted neither the public helper nor testnet. These tests do not establish
compatibility with a current live helper or testnet.
