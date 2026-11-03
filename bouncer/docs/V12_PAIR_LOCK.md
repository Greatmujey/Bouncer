# Experimental V12 prepaid pair-lock hardening

This is a separate, fresh-state **testnet experiment**, not a deployed upgrade,
an audit, a new provider purchase or a complete multi-resource flow. Existing
keyless V11 vaults cannot upgrade themselves, and their behavior is unchanged.
There is no migration, pinned V12 binary, owner setup path, deployment or live
seller execution in this change.

## The actual gap

V11 lets the owner lock a policy to one-shot exact FT intents. When any such
intent reserves a token/payee pair, the normal `execute` and `execute_ft_call`
methods block unrestricted transfers to that pair under **all** policies. The
V11 `execute_outlayer_project` path blocks a locked *policy*, but does not
check the pair lock when spending provider-held prepaid credit under a
**different** policy. A granted key with both required project policies and a
preapproved project route can therefore consume already-prepaid credit even
though the token/OutLayer pair was later reserved by another exact intent. This
is a source-level behavioral limitation, not evidence of a live exploit.

## Narrow V12 change

The new `exact-ft-v12` feature builds separately and includes the V11 exact-FT
features. Its `get_outlayer_project` reports the route inactive when the
project token and the fixed OutLayer payee have been locked by any exact FT
intent. `execute_outlayer_project` rechecks the route on-chain immediately
before reservations and separately checks the pair lock. Thus, a signature or
owner-approved project route prepared **before** a later pair reservation fails
closed, including when another project policy is used. A lock for a different
payee does not block the project. The existing 1-yocto owner-policy guard is
unchanged; the exact pair remains permanently locked under the existing V11
intent semantics, including after cancellation or expiry.

This is deliberately conservative: once a pair is locked, the V12 route cannot
spend prepaid credit held by that payee. Any such credit can remain inaccessible
from this route. The change does **not** recover provider credit, account for a
later plain-FT refund, prove that the provider code matches reviewed source,
authenticate fulfillment, fix NEAR x402 delegate incompatibility, or make a
malicious token trustworthy. The existing V11 artifact and deployed code do
not acquire the new check. Do not deploy over V9, V10 or V11 state; migration and
upgrade authorization have not been designed.

The contract tests include the V11 limitation, a V12 lock-after-route race,
stale/inactive route rejection and an unrelated-payee control. CI builds a
separate V12 WASM for review; source tests and an artifact hash are not an
independent security review or production-readiness evidence.

The opt-in `V12 isolated pair-lock sandbox` workflow builds V12 from the branch
and starts the existing hash-pinned nearcore sandbox with a synthetic example
FT and local receiver stand-in, using ephemeral keys and a fenced loopback RPC.
The [first run](https://github.com/Greatmujey/Bouncer/actions/runs/41631645132)
passed: it created a prepaid route before an exact token/payee reservation,
rejected the stale project without a provider call or debit, and executed a
one-shot exact transfer while rejecting replay. A [second run](https://github.com/Greatmujey/Bouncer/actions/runs/41631892731)
also passed the zero-yocto and non-owner policy-escalation checks. This is not
testnet, real Circle or OutLayer, independent provider delivery, or an audit.
The V12 WASM marker only catches wrong inputs; the build is not yet reproducible.
A durable owner recovery path, independent provider compatibility and genuine
delivery also remain necessary.
