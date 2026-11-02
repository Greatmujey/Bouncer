# Circle testnet owner registration — one fixed action

This optional owner-setup path registers the **new Bouncer testnet owner** with
Circle's pinned NEP-141 test-USDC contract. It does not fund USDC, deploy a
vault, authorize an agent, buy a resource, or use real money. It is separate
from the keyless vault's later registration. The local backup file must be kept
private; a local duplicate is not proof of an owner-exported backup.

## Limits and custody

A public FINAL-block preflight checks testnet identity, a plain owner with the
exact one full-access key, a safe nonce, the Circle account's observed code
hash, USDC symbol/decimals, storage bounds, an unregistered owner and a 1 test
NEAR reserve. It caps registration deposit at **0.01 test NEAR** and fixes
`storage_deposit` to 50 Tgas with `account_id` equal to the owner and
`registration_only: true`. The private key signs locally and is never sent to
GitHub. Public views are trusted-RPC observations, not consensus proofs or
source-code attestations; the Circle contract and owner state can change.

The offline signer fsyncs a mode-0600 **original signed transaction journal**
before exporting its public envelope. An existing journal blocks a new
signature; an interrupted export can restore only the same original bytes.
The transaction hash and bytes must never be replaced after an uncertain send.
The optional CI broadcaster checks the signature and fixed action, rereads
fresh owner/nonce/token registration state, verifies a public attempt fence,
sends once, then checks the original receipt graph and a new registration view.
Failures or lost acknowledgements require read-only reconciliation of the
original hash, never a blind resend.

**Important bearer limitation:** if the signed envelope is committed publicly,
any observer can relay those exact bytes before the CI preflight. The signature
cannot be changed to another receiver, token method, beneficiary or deposit,
and NEAR nonce rules prevent a second execution of the same signed action.
Preflight is therefore an additional check by our own broadcaster, not a
promise that a publicly exposed transaction cannot be relayed earlier. The
signature does not reveal the private key. The result can establish a matching
registration transaction and point-in-time storage view, not Circle-USDC
funding or independent provider delivery.
