# V11 nearcore sandbox validation (opt-in)

**Latest result: the actual restricted buyer and original-hash recovery passed
on a disposable local chain.** On 2 November 2026, [run 41439528831](https://github.com/Greatmujey/Bouncer/actions/runs/41439528831)
at commit `0ceb64ec48ea210f1e1ac42a960a7bdbfa8d0265` passed the existing
contract and owner-runner checks and the new buyer scenario on nearcore 2.14.0 /
protocol 88. With an in-process fake seller and the example mock FT, the test
owner pinned an exact intent; the restricted buyer journaled its original hash
in encrypted storage before one local send. The harness deliberately discarded
the successful acknowledgement, reopened the journal, rejected a second send,
and recovered the same hash with no seller request. It also checked the vault's
on-chain and internal mock-token balances, seller balance, and rolling spend.
The result is **payment evidence only**, not seller attribution or fulfillment.
[Normal CI](https://github.com/Greatmujey/Bouncer/actions/runs/41439528559)
passed for that commit.

**Previous owner-runner result:** [run 41435563441](https://github.com/Greatmujey/Bouncer/actions/runs/41435563441)
at commit `c22757d3e773a8862427c7ea7fd18298f5f5a050` passed both the prior
contract scenario and a fresh five-stage owner-runner scenario on nearcore
2.14.0 / protocol 88. It checked pinned FINAL prerequisites and post-funding
state, the exact restricted-key allowance, original hashes in an encrypted
journal before each one-shot transport call, and receipt/outcome reconciliation.
It deliberately lost a successful local registration response, reopened the
original journal, confirmed the pending attempt could not be sent again, and
recovered the original hash without a second send. The AddKey result is still
outcome-only, not root-receipt-body proof.

Both runs **simulated the testnet chain ID and approval assertions only in
test-only loopback adapters**; the actual state, transactions and receipts came
from the disposable nearcore sandbox, not testnet. The checks do not establish
production's real network identity check, the owner CLI against nearcore,
Circle registration/funding, independent artifact review, user approval,
verified backups, a live deployment, or independent seller fulfillment.

**Earlier passing result:** On 2 November 2026, [run 41430287526](https://github.com/Greatmujey/Bouncer/actions/runs/41430287526)
ran commit `b820ce923ad696655fd4abf338b9d365b0295055` against nearcore 2.14.0,
protocol 88 and the example mock FT. All five original stages reconciled in the
same encrypted setup journal, which was reopened after the agent-key stage. Four
stages matched their relevant receipt evidence; the self-addressed AddKey stage
matched the original transaction and linked outcome **without its omitted root
receipt body**. The harness separately checked the installed key's receiver
and method restrictions, the one-yocto guard, allowlist, caps, mock-FT
execution, replay rejection and failed transfer refund callback. It did not
separately log the installed key's allowance in that run. The successful run did not log whether the
registration gas-refund child was present; its strict verifier accepts either
that specific child or none. This is not a testnet deployment, Circle
registration, independent review or seller fulfillment. That earlier run did
not exercise the setup runner or stage preflight against nearcore.

**Earlier failures:** [run 41424909003](https://github.com/Greatmujey/Bouncer/actions/runs/41424909003)
started the pinned protocol-88 sandbox, deployed the recovered V11, checked its
code hash, owner and keyless account, exercised the one-yocto guard, and matched
the original receipts for the first two setup batches. The same-account agent
key installation then finalized, but the setup verifier rejected its omitted
local root-receipt body and the job failed. No later setup or FT checks ran in
that first attempt.

This is a real compatibility blocker in the setup verifier, not a failed V11
contract guard and not permission to advance a live setup. nearcore 2.14.0
[intentionally omits a same-account transaction's local receipt body](https://github.com/near/nearcore/blob/2.14.0/chain/chain/src/chain.rs#L3294-L3323)
from the receipt list, even though its execution outcome is reported. The
production verifier at that run's commit failed closed on that shape.

A further diagnostic run [41426463533](https://github.com/Greatmujey/Bouncer/actions/runs/41426463533)
confirmed the actual restricted-key state and method rejection. It also found
that the registration verifier rejects a **system gas-refund** child even when
the fresh mock-token registration balance matches. The harness recognized both
specific blockers only for further local diagnostics; neither stage was marked
verified and the overall job failed deliberately. After that, the original
funding receipt graph matched, and the sandbox checked mock-token balances,
allowlist and caps, one successful exact-FT transfer, replay rejection, and a
failed mock transfer whose callback restored the balance and rolling budget.
These are real nearcore checks of the named cases, but not a passing five-stage
setup-verification run. Synthetic JavaScript harness tests do not prove
nearcore behavior.

Commit `b820ce9` changes the verifier to recognize only the reviewed,
self-addressed, single-AddKey outcome when its root body is omitted, with the
separate status `FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH`. It does not fabricate or
claim a matching root receipt. Registration permits only a fully linked,
terminal, single system gas-refund transfer to the original signer/key, or no
child; token-created refunds and unknown/incomplete graphs remain blocked. Both
still require the original trusted transaction hash and a separate fresh state
check. The isolated rerun passed with the omitted AddKey body; it did not log
whether a registration gas-refund child occurred, so that specific child is
covered by synthetic adversarial tests and the earlier failed-run observation,
not separately demonstrated in the successful rerun. Neither run authorizes
testnet setup, funding or seller contact.

The buyer scenario uses the real experimental buyer and payment-evidence
recovery code against nearcore, but its offer and reservation are fixtures and
its owner key, approvals and seller are test-only. The sandbox-only adapter aliases the
network ID and drops the acknowledgement **after** the local transaction has
completed; it does not test every possible timing of a network failure. The
separate synthetic loopback tests check harness wiring and the isolation fence.
Neither kind of test is a testnet purchase, Circle transfer, seller contact,
user approval, or fulfillment proof.

The opt-in job starts a fresh, one-validator nearcore **2.14.0** sandbox on
loopback, with protocol **88**, and destroys its temporary chain afterwards.
It does not use a wallet, connect to testnet or mainnet, contact a provider,
consume real funds, or deploy an internet-facing contract. All signing keys
are generated solely for the disposable chain. The harness accepts no RPC URL,
account ID or private key from its environment, and checks its own chain ID.

## Bounded checks

- Hash-check the recovered V11 WASM, deploy and initialize it in the same
  account-creation batch, and verify its code hash, owner, version and **zero
  vault access keys**.
- Execute all five action batches from `buildUnsignedSvalinTrialSetup` using a
  local owner key. Record each original signed hash in an ephemeral encrypted
  setup journal before sending, then reconcile its FINAL evidence; for the
  omitted local AddKey body, check its separately labeled outcome and fresh key
  state instead. Reopen the journal after that stage. The previously passing
  run did **not** exercise the setup runner or stage preflight against nearcore.
- The latest run exercised the actual setup runner and pinned stage preflight
  on a second sandbox owner/vault, including the exact restricted-key allowance
  and a post-funding profile. It dropped one successful local registration
  acknowledgement, reopened the original encrypted journal, and checked that
  original-hash recovery and the pending-stage fence did not resend. The
  network identity and approvals were simulated as described above.
- Against that same funded local vault, exercise the actual exact-FT buyer with
  a synthetic reservation and an owner-pinned intent. Discard the local payment
  acknowledgement after finality, reopen the encrypted buyer journal, reject
  another send and recover the same hash. Check the mock-token balances and
  rolling spend, with no real seller request or delivery verification.
- Exercise the one-yocto guard with an owner-scoped function-call key that is
  allowed to attempt `set_policy`: zero deposit should reach the contract and
  fail; one yocto should be rejected by the protocol. Separately check a
  non-owner with one yocto and the owner with two yocto are rejected, while
  the owner's reviewed one-yocto configuration succeeds.
- Check the separately installed agent key's receiver/method restriction,
  allowlist and limits; fund the vault via an FT transfer-call; execute one
  exact FT intent and reject replay. Cause a second FT receipt to fail because
  its allowed payee is unregistered, then check the actual callback restores
  the internal balance and rolling budget without reactivating the intent.

The token is **nearcore's example FT**, not Circle. The setup planner hard-codes
the Circle testnet account ID and a Svalin account ID, so the harness inserts a
fake token account with that ID in *only the disposable local genesis* and
creates a same-named local payee. This is an artificial fixture; no Circle or
Svalin contract or service is deployed, contacted or authenticated. It does
not prove that either live account is registered, owns a given key, has the
same code, accepts a payment, or delivers useful work. The initial genesis
modification also means this is not a test of creating Circle's implicit
account by ordinary transactions.

## Inputs and provenance

All three files are checked before the node runs:

| Input | Pinned SHA-256 | Source |
| --- | --- | --- |
| Recovered V11 WASM | `1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921` | [Original public Git blob](https://github.com/Greatmujey/Bouncer); Git object `c67c70401dc733a0905e79258cc8169c2e6b5210` |
| Example FT WASM | `b10ed11ac6d60698c6809ef7e96b578f2e5768354fe4b15d044843c2b6ab8a04` | [nearcore 2.14.0 test FT](https://github.com/near/nearcore/blob/bc4e9e8cfb03d9e82f027883055624e18576993e/runtime/near-test-contracts/res/fungible_token.wasm), Git blob `3ab410d723c8029e70993b0829a17ddd52d8b135` |
| Linux x86-64 sandbox executable | `797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13` | nearcore 2.14.0 S3 release; the digest was reported by [this independently maintained test harness, pinned commit](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/scripts/sandbox_env.sh) |

The executable digest is **not an official signed attestation** and neither
binary has been independently reproduced here. The unreferenced V11 Git blob
may eventually be garbage-collected. If any input is absent, differs, or the
sandbox is not protocol 88, the test fails rather than substituting a build.
The archive extractor streams just one regular member to a temporary file,
checks its digest before making it executable, and never extracts archive
paths. The public runner downloads the pinned release from S3; local networks
that cannot reach S3 need the exact files supplied separately.

## Running and interpreting

`.github/workflows/v11-nearcore-sandbox.yml` is skipped on ordinary branch
pushes. A branch commit containing `[v11-nearcore-sandbox]` requests the job;
after the workflow is on the default branch, it also supports manual dispatch.
It uses the existing Node lockfile and no repository secrets. To gather more
contract diagnostics while the known verifier blocker is being investigated,
the harness may continue **only on this disposable chain** after strictly
recognizing the omitted same-account AddKey receipt, or a fresh mock-token
registration whose only linked child is a verified system gas refund. It records
such stages as blocked, does not invent a receipt, and deliberately fails the
job at the end; any different verification error fails immediately. Checkpoint
messages identify which bounded checks actually ran. No setup success is
claimed unless the real production verifier accepts every original stage. The
repository's normal CI and any configured preview deployment may also run on a
branch push.

A passing result would be real nearcore runtime evidence for these bounded
cases with this example FT, **not** a security audit, V11 source-to-binary
reproduction, live testnet deployment, actual Circle registration/funding,
proof of owner consent, seller settlement, or independent resource delivery.
Any failure must be investigated; it is not a reason to retry a real payment
or weaken a safety check. A live setup and any provider purchase remain
separate, explicitly approved decisions.
