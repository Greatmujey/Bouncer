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
retained fence `13231955034` but lost confirmation during an RPC view. A
[read-only reconciliation](https://github.com/Greatmujey/Bouncer/actions/runs/41637799734)
then verified the original FINAL receipt and the 0.01-wNEAR balance; it made no
send. Never resend the original. A wrap is not FT acquisition or provider
delivery.

The locally journaled subsequent swap original is
`9i6AFBKEY2FzDdydnsoTfTxM87shpjvxZYxRyU6JTAGR`. It used a fresh post-wrap
snapshot and a 6,553-atom minimum. Its
[one-shot run](https://github.com/Greatmujey/Bouncer/actions/runs/41637917983)
retained fence `13231466627` but lost confirmation after a view failed.
[Read-only reconciliation](https://github.com/Greatmujey/Bouncer/actions/runs/41638107835)
verified the original FINAL receipt, the linked Ref-to-owner transfer and a
fresh owner balance of **6,898 Circle test-USDC atoms** (0.006898 test USDC).
It did not send or contact a seller. Never resend or replace this original.

The [V3-specific read-only vault preflight](https://github.com/Greatmujey/Bouncer/actions/runs/41638436661)
indicated the existing V11 funding and storage estimates would pass at that
snapshot, but did not select or deploy an artifact. V11 has a known
cross-policy prepaid-route limitation; experimental V12 addresses that narrow
gap but is not independently audited or reproducibly pinned. A dependency-lock
snapshot is being prepared before considering any fresh-state V12 deployment.
A keyless vault can permanently lock its testnet storage stake.

A usable, funded, keyless vault and independent paid resource delivery are
separate steps that require fresh checks and original-hash recovery at each
stage.
