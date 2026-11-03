# New backed-up testnet owner

This is a separate, testnet-only owner, not a replacement for or a transfer
from either earlier owner. The earlier accounts, their vaults and test-token
balances must remain untouched. The user confirmed saving the recovery ZIP on
3 November 2026; the two local encrypted copies were checked against the public
key immediately before preparing the bootstrap. The backup is unencrypted and
must remain private. This confirmation is the user's statement, not a machine
check of the saved copy. Never paste or publish a private key, and never use it
on mainnet.

The public plan is `config/testnet-owner-v3-plan.json`. The dedicated one-shot
workflow verifies a fresh testnet FINAL view, uploads a public intent fence,
and then makes at most one helper request for that exact name and public key.
The CI runner does not receive a private key. An ambiguous request is never
repeated: preserve the fence and reconcile the same account through public
views. Preparing the plan does not create an account, sign a transaction,
deploy a vault, acquire a token, contact a seller or demonstrate delivery.

A usable, funded, keyless vault and independent paid resource delivery are
separate steps that require fresh checks and original-hash recovery at each
stage. The previous V11 OutLayer pair-lock limitation remains relevant; the
experimental V12 code has not been audited, deployed or migrated.
