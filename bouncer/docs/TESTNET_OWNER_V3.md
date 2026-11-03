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
[bootstrap run](https://github.com/Greatmujey/Bouncer/actions/runs/41636581624)
retained public fence `13230412708`, made one helper request and observed the
new account at a fresh testnet FINAL block with **10 test NEAR** and exactly
the expected full-access public key. The CI runner did not receive the private
key and did not verify the user's saved copy. This is trusted-RPC state, not
proof of the original creation receipt. Do not repeat the helper request.
No Circle token, vault, seller payment or fulfillment was part of this step.

A fresh [read-only Circle preflight](https://github.com/Greatmujey/Bouncer/actions/runs/41636791850)
observed the owner unregistered and the pinned six-decimal Circle testnet token.
The fixed self-registration transaction
[`HZXhekhXYfqnxuDGMabWbJ9YBApm3c4dZjKtQSm62oWV`](https://testnet.nearblocks.io/txns/HZXhekhXYfqnxuDGMabWbJ9YBApm3c4dZjKtQSm62oWV)
was [verified at FINAL](https://github.com/Greatmujey/Bouncer/actions/runs/41636915967)
against its original receipt and a fresh registration view; public fence
`13231365981` was retained. The owner held zero Circle atoms at that view.
Never resend the original. This is owner setup, not FT acquisition or an
independent provider purchase.

A [fresh read-only acquisition view](https://github.com/Greatmujey/Bouncer/actions/runs/41637252051)
indicated 6,898 Circle test-USDC atoms for 0.01 test NEAR through the reviewed
Ref pool, with a 6,553-atom minimum if a later swap is signed. The owner has
journaled a distinct wrap original `7ofgU7H6KzB525FFYYcEaqNjTfsRzZYL2nfAPqBk3fB2`.
Its [one-shot run](https://github.com/Greatmujey/Bouncer/actions/runs/41637379448)
retained fence `13231955034` but could not confirm the result after an RPC view
failed. The original is **unresolved** until read-only reconciliation verifies
its actual receipt and balances; never resend it. A quote or wrap is not FT
acquisition or provider delivery.

A usable, funded, keyless vault and independent paid resource delivery are
separate steps that require fresh checks and original-hash recovery at each
stage. The previous V11 OutLayer pair-lock limitation remains relevant; the
experimental V12 code has not been audited, deployed or migrated.
