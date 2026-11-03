# Experimental PayPerCall forwarder — do not deploy

This is **experimental code**, not a production integration or an approval to
spend. It is unaudited, has not run against the deployed PayPerCall contract or
Circle, and has no owner setup or payment runner. No independent provider
delivery has been shown. An [isolated nearcore run](https://github.com/Greatmujey/Bouncer/actions/runs/41474554586)
exercised this bridge with an example mock FT and a tiny escrow stand-in. A
[later isolated run](https://github.com/Greatmujey/Bouncer/actions/runs/41476520726)
used the same mock FT with PayPerCall **compiled from pinned published source**;
that local build is not proof of the deployed contract's code identity.

## The hypothesis

V11's exact policy sends one plain FT transfer to a reviewed payee. PayPerCall's
published token flow instead requires `ft_transfer_call`, and its later refund
uses plain `ft_transfer`, which does not credit V11's internal ledger. The
experiment generates one immutable WASM contract for one reviewed order:

1. The owner separately configures a locked V11 exact intent to pay the
   forwarder. The intent commits to the generated review hash, memo, amount,
   token, payee, expiry and **vault** agent key.
2. A **different** owner-account function-call key, restricted to the forwarder
   receiver, may call its one-shot `open`. The generated contract pins the
   Circle testnet token, `devx-paypercall.testnet`, service ID, request,
   maximum token amount and expiry. It then requests a single
   `ft_transfer_call` to the escrow. `open` is consumed before dispatch and
   stays consumed if the downstream call fails.
3. Under the published escrow's expected semantics, an immediate unused amount
   or later plain refund reaches the forwarder, not V11. `return_tokens` asks
   the token to send a bounded amount **only** to the fixed vault via
   `ft_transfer_call`, so V11's receiver hook can credit the balance. A
   `claim` call targets only the fixed escrow and token. Claim behavior has
   been tested against a locally source-built escrow, not the deployed one.

These are separate receiver-scoped keys because one NEAR function-call key
cannot authorize two different receivers. The earlier synthetic design reused
one key and would not have worked with least-privilege NEAR access keys; the
generator now rejects equal keys, and the sandbox scenario checks both
permissions. The owner still controls policy: the agent's ordinary function
call keys cannot attach the 1 yocto required by privileged owner actions.

## Fixed interface and authority

| Method | Caller | Effect |
| --- | --- | --- |
| `configuration`, `opened` | public view | Return public terms and the local one-shot marker. |
| `open` | fixed owner as signer/predecessor, exact forwarder key, zero deposit | Once, before expiry, issue the fixed 200-Tgas token call with 1 yocto and pinned message. |
| `return_tokens` | same agent with zero deposit, or owner with 1 yocto | Fixed token, fixed vault, reviewed amount **per call**. Can be repeated for partial/late returns. |
| `claim` | same agent with zero deposit, or owner with 1 yocto | Fixed escrow and token; it cannot choose another beneficiary. |
| `withdraw_storage` | owner with exactly 1 yocto | Ask fixed escrow to return its native storage credit to the forwarder. |
| `return_native` | owner with exactly 1 yocto | Fixed owner recipient, per-call cap and checked native reserve. |

The generated WASM has no arbitrary-call, deploy, add-key, delete-account or
upgrade imports. **This guarantee is conditional:** the owner must deploy the
exact reviewed bytecode to a truly keyless account and verify its code hash and
key list. V11 only checks the forwarder's *account ID*; it cannot check the
forwarder's code or keys. A malicious or replaceable payee would defeat the
hypothesis. The vault must likewise be keyless with the pinned V11 code and a
correctly configured exact-locked policy. The public `configuration` view is
not proof that the running code is authentic.

The token and native return caps apply **per invocation**, not to an aggregate
lifetime total. Native returns always target the fixed owner, but tokens
accidentally transferred into the forwarder can also be swept to the fixed
vault. `native_reserve` has a 1 test-NEAR minimum in this experiment, but that
is not a proof of future protocol storage requirements. A keyless forwarder
cannot delete itself or unregister its token storage; the reserve and token
registration deposit can remain permanently locked. Repeated calls also spend
small native deposits and gas. The 200-Tgas choice, storage costs, and a viable
recovery budget need actual runtime and token checks.

## What is and is not verified

- Local tests run the generated WASM and the recovered, hash-pinned V11 WASM
  under an incomplete synthetic host. A simulated 100-unit payment, 40-unit
  immediate return and 60-unit later plain refund restore both synthetic token
  and V11 tracked balances to 100; V11's rolling spend remains a conservative
  100. They test replay, 1-yocto guards, fixed recipients, malformed inputs,
  deterministic output and decimal-to-u128 boundary vectors.
- The harness wiring additionally runs through a fake loopback RPC and token
  model and deliberately injects a faulty partial refund to ensure the assertion
  detects it. An optional **2021-era `near-mock-vm`/VMLogic** cross-check
  independently records the generated calls. It does not model current nearcore
  gas, access-key admission, receipt execution, consensus, or token semantics.
- [Nearcore run 41474554586](https://github.com/Greatmujey/Bouncer/actions/runs/41474554586)
  passed at commit `81faeb6dafefb848dd18b03a79656ca416952336`. In a disposable
  protocol-88 chain, it deployed keyless V11 and generated forwarder contracts,
  installed distinct receiver-restricted keys, checked the 1-yocto owner guard
  and replay rejection, and exercised a 40-unit immediate return plus a later
  60-unit plain refund routed through the forwarder to V11. The final mock-token
  balance and tracked ledger were 100, with 100 conservative rolling spend.
  The 40/60 escrow was a hard-coded stand-in and did not test claim behavior.
- [Nearcore run 41476520726](https://github.com/Greatmujey/Bouncer/actions/runs/41476520726)
  at commit `61c1bbb` subsequently built PayPerCall from pinned source and its
  lockfile, then ran the forwarder and V11 with the example mock FT. It checked
  service registration, storage credit, open, partial return, rejection, a
  failed payout recorded as `owed`, `claim`, and native storage-credit return.
  A **temporary sandbox-only key** was injected and deleted to unregister the
  empty mock-FT account and force the payout failure; the forwarder was checked
  keyless again before rejection and claim. The claim returned 60 mock units,
  bringing actual and tracked V11 balances back to 100 with rolling spend still
  100. This artificial fault is not normal testnet behavior. No Circle token,
  deployed escrow or seller delivery was involved. The source-built artifact
  is not an independent reproducible-build or audit claim, and the detailed
  sandbox log was not available in this environment.
- A [later sandbox run](https://github.com/Greatmujey/Bouncer/actions/runs/41676762624)
  used a second keyless forwarder for a locally fulfilled call. A separate
  read-only verifier correlated the exact vault transfer, escrow opening,
  locally supplied answer hash and linked mock-token provider payout, using
  historical code, key and balance views. After the 60-unit payout, the unused
  40 mock units were returned via the vault's FT receiver callback: actual and
  tracked vault balances both became 40, the forwarder became empty and the
  rolling spend remained 100. A distinct owner-pinned 40-unit sandbox intent
  was then blocked by the daily cap despite the returned balance. The return is
  checked by isolated-chain state assertions, not by the public receipt
  verifier. This is a disposable chain, not evidence of a public-chain purchase,
  seller HTTP response, independent fulfillment or a security audit.

## Unresolved risks and prerequisites

- The service's current provider, operator, price, token, endpoint, timeout,
  escrow code hash, access keys and live availability must be independently
  checked at fresh pinned state. Service price can change (the fixed amount
  is only a maximum); the forwarder does **not** enforce provider/operator,
  service immutability, deployed source identity, result correctness or HTTP
  delivery. Seller funds may settle before an answer is actually available.
- The exact Circle and escrow accounts must be registered, the payer must have
  escrow storage credit, and a correct fresh state and adequate native reserve
  and gas must be established. The owner may deposit storage on the forwarder's
  behalf; this is not implemented here. Provider payout registration and
  downstream promises must also be checked.
- Failure or a lost acknowledgement may leave the marker consumed, tokens in
  the forwarder, an open escrow, a failed payout or an `owed` balance. A
  durable original-transaction-hash journal and receipt-based recovery are
  required before any operational runner; **do not blindly resend** `open`,
  claims, returns or payments. The forwarder does not itself call the escrow's
  permissionless `refund_expired`; an appropriately authorized external caller
  would have to do that after verifying the exact call and deadline.
- Before any live use, the new code, promises, storage and keyless recovery
  require further adversarial review and validation against the real contracts.
  A compatible independent operator, a recoverable funded owner and documented
  testnet-only scope are also needed. The existing user authorization covers
  scoped testnet work, not real-money spending. These tests contact no provider.

## Local tests

The ordinary tests require the repository's installed dependencies. The V11
composition test is skipped unless the exact recovered artifact is supplied;
the optional old-VM check additionally needs the locally downloaded,
hash-pinned package. The paths below refer to this workspace, not user secrets.

```sh
cd bouncer
BOUNCER_V11_WASM_PATH=/home/user/bouncer-tools/v11-review/bouncer-v11.wasm \
BOUNCER_LEGACY_MOCK_VM_DIR=/home/user/bouncer-tools/mock-vm-inspect/package/pkg \
node --test tests/paypercall-forwarder-experimental.test.mjs tests/paypercall-forwarder-legacy-vm.test.mjs tests/v11-sandbox-forwarder.test.mjs
```
