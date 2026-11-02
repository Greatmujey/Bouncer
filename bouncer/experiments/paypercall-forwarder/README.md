# Experimental PayPerCall forwarder — do not deploy

This is **local research code**, not a production integration or an approval to
spend. It is unaudited, has not run in the new nearcore scenario, has not been
run against PayPerCall or Circle, and has no owner setup or payment runner.
No independent provider delivery has been shown. The last successful
[nearcore run](https://github.com/Greatmujey/Bouncer/actions/runs/41469462871)
exercised the **different** two-vault refund-boundary scenario, not this bridge.

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
   `claim` call targets only the fixed escrow and token. Neither claim behavior
   nor an actual escrow has been validated by these tests.

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
- A new disposable nearcore scenario has been **written but not run**. It uses
  an example mock FT and a tiny hard-coded 40/60 stand-in contract; even if it
  passes, it is **not** PayPerCall, Circle or seller fulfillment. A separate
  authorized branch push/CI run is required to execute it in the available
  environment. Do not report it as passing beforehand.

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
  require further adversarial review and actual runtime validation. A fresh
  public operator and an explicit, separate live-test approval are also needed.
  Nothing here uses real money or contacts a provider.

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
