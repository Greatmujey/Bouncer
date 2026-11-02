# V11 nearcore sandbox validation (opt-in)

**Status: partial nearcore run; setup verification blocked.** On 2 November
2026, [run 41424909003](https://github.com/Greatmujey/Bouncer/actions/runs/41424909003)
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
production verifier currently fails closed on that shape; a correction requires
separate review and approval. Synthetic JavaScript harness tests do not prove
nearcore behavior.

The opt-in job starts a fresh, one-validator nearcore **2.14.0** sandbox on
loopback, with protocol **88**, and destroys its temporary chain afterwards.
It does not use a wallet, connect to testnet or mainnet, contact a provider,
consume real funds, or deploy an internet-facing contract. All signing keys
are generated solely for the disposable chain. The harness accepts no RPC URL,
account ID or private key from its environment, and checks its own chain ID.

## Planned checks

- Hash-check the recovered V11 WASM, deploy and initialize it in the same
  account-creation batch, and verify its code hash, owner, version and **zero
  vault access keys**.
- Execute all five action batches from `buildUnsignedSvalinTrialSetup` using a
  local owner key. Verify each signed transaction against its review, then
  check its original FINAL receipt graph with `inspectSvalinSetupAttempt`.
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
recognizing the omitted same-account AddKey receipt. It records that stage as
blocked, does not invent a receipt, and deliberately fails the job at the end;
any different verification error fails immediately. Checkpoint messages identify
which bounded checks actually ran. No setup success is claimed unless the real
production verifier accepts every original stage. The repository's normal CI
and any configured preview deployment may also run on a branch push.

A passing result would be real nearcore runtime evidence for these bounded
cases with this example FT, **not** a security audit, V11 source-to-binary
reproduction, live testnet deployment, actual Circle registration/funding,
proof of owner consent, seller settlement, or independent resource delivery.
Any failure must be investigated; it is not a reason to retry a real payment
or weaken a safety check. A live setup and any provider purchase remain
separate, explicitly approved decisions.
