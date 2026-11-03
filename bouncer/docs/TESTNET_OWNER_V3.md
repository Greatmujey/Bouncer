# New backed-up testnet owner

This is a separate, testnet-only owner, not a replacement for or a transfer
from either earlier owner. The earlier accounts, their vaults and test-token
balances must remain untouched. The user confirmed saving the recovery ZIP on
3 November 2026; the two local encrypted copies were checked against the public
key immediately before preparing the bootstrap. The backup is unencrypted and
must remain private. This confirmation is the user's statement, not a machine
check of the saved copy. Never paste or publish a private key, and never use it
on mainnet.

**Current workspace custody:** after reconstruction removed the local V3
keyring and journals, the original unsent Gmail recovery attachment was
privately staged on 3 November 2026. Its account and derived public key matched
the existing V3 plan; it was imported into two new authenticated encrypted
local copies with an in-workspace wrapping key. The temporary plaintext files
were removed, the draft was **not sent or changed**, and no transaction was
signed or sent during recovery. The user's separate saved backup was not
machine-verified. The draft's pre-bootstrap statement that the account had not
yet been created or funded is historical and outdated. This local keyring is
not an independent backup, missing journals were not recreated, and neither
older owner was used. **The two outstanding public signed originals remain
unresolved; this recovery does not authorize other V3 owner transactions.**
The statements below about old local journals describe what was recorded at
the time, not files restored in this reconstructed workspace.

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
gap but is not independently audited. Two GitHub runners produced matching
locked V12 builds, and the exact artifact passed an isolated synthetic runtime
test. A fresh [V12 preflight](https://github.com/Greatmujey/Bouncer/actions/runs/41640570633)
then preceded one fixed deployment. The original transaction
[`3fc8FjEQpeKDgo7GoVHyUrFxNUyY8zmQFSXyYbx2ZuTq`](https://testnet.nearblocks.io/txns/3fc8FjEQpeKDgo7GoVHyUrFxNUyY8zmQFSXyYbx2ZuTq)
was [verified at FINAL](https://github.com/Greatmujey/Bouncer/actions/runs/41640747753),
with retained fence `13231459562`. A fresh view found
`vault.bouncer-owner-12f343b795633e357ae5560d.testnet` running the pinned V12
code with zero access keys and 6 test NEAR; the original is recorded in the
private journal and must never be resent. A keyless vault can permanently lock
its testnet storage stake. The user-confirmed recovery ZIP copy was not
machine-verified, and V12 remains unaudited.

The vault's subsequent Circle storage registration original
[`Aob1vuBzJ8iMp2JvvzqpJ4dTS2bbbbGp1jUgBqYma5k1`](https://testnet.nearblocks.io/txns/Aob1vuBzJ8iMp2JvvzqpJ4dTS2bbbbGp1jUgBqYma5k1)
was [verified at FINAL](https://github.com/Greatmujey/Bouncer/actions/runs/41642256912)
with fence `13233651211`. Never resend it. The 0.00125 test-NEAR Circle storage
deposit may remain locked.

The subsequent owner-to-vault funding original
[`CUSSFm9M4sdrUvfphkzbyDxzsZXiDYRrmjdRmDn3jGzw`](https://testnet.nearblocks.io/txns/CUSSFm9M4sdrUvfphkzbyDxzsZXiDYRrmjdRmDn3jGzw)
was [verified at FINAL](https://github.com/Greatmujey/Bouncer/actions/runs/41642503448)
with fence `13233363224`; the token transfer event, vault callback and resolver
were verified, and fresh token-contract and Bouncer-ledger views both showed
**6,898 Circle test-USDC atoms** (0.006898 test USDC) in the keyless vault.
The owner held zero Circle atoms at that view. Never resend the original.
This is testnet vault funding, not an independent provider payment or delivery.
Independent paid compute, storage and data remain separate steps.

A [read-only OutLayer snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/41642715718)
confirmed its testnet connector-probe currently accepts `usdc.fakes.testnet`,
**not Circle USDC**. Its fixed diagnostic burn was quoted at 10,000 fake-token
atoms; the V3 owner and vault were not registered for that token. A Ref quote
for 0.0000000001 wrapped test NEAR returned 21,645 fake atoms at that block;
quotes and provider terms can change. The diagnostic is not general-purpose
compute, a Circle-paid order, or evidence of delivery. The V12 diagnostic plan
and read-only preflight are under test. The V3 fake-token registration original
[`9tsgJgUUqJsV9X8hpRABqPwcC7SZJ9uV64xc3bFoamPe`](https://testnet.nearblocks.io/txns/9tsgJgUUqJsV9X8hpRABqPwcC7SZJ9uV64xc3bFoamPe)
was fenced in [run 41644157538](https://github.com/Greatmujey/Bouncer/actions/runs/41644157538),
but that run could not confirm its outcome. Read-only [reconciliation run
41644313388](https://github.com/Greatmujey/Bouncer/actions/runs/41644313388)
could not retrieve and verify its FINAL receipts. A later [diagnostic run
41644776458](https://github.com/Greatmujey/Bouncer/actions/runs/41644776458)
observed the previous owner nonce and registration-stage state, but its
original-hash lookups were unavailable or returned an HTTP error. Those views
are not a receipt or proof that the original can no longer be accepted. Its
status remains **unknown**: retain the fence, reconcile this original only,
never resend or sign a replacement. A [later read-only observation](https://github.com/Greatmujey/Bouncer/actions/runs/41648937501)
found the canonical reference was still within the observed 86,400-block
validity window; that observation is not a receipt. A distinct zero-yocto
owner-guard control was signed and [attempted once](https://github.com/Greatmujey/Bouncer/actions/runs/41649696899),
with fence `13236079690`. Its original hash is
`95vMwEkKJtbqRkPdovcgS7rQtWkav83VsVbB1VJ7Pkor`; the attempt did not confirm a
result, so its outcome is also **unknown**. Review of each pinned job's code
found both used fence prefixes absent from the allowlist. The corresponding
sender requires that check before any send, so those two jobs could not have
submitted their transactions through that path. The signed bytes were public,
however, so that does not prove that nobody else relayed them. Both labels are
now explicitly retired, and a test checks fixed fence labels to catch similar
mismatches. [Read-only diagnosis](https://github.com/Greatmujey/Bouncer/actions/runs/41650165471)
could not retrieve either receipt and observed the old nonce at one RPC; both
references remained within the reported validity window. A [later read-only
observation](https://github.com/Greatmujey/Bouncer/actions/runs/41655189868)
still found neither receipt and reported both reference ages within the
86,400-block validity period. This does not prove their history or authorize
other V3 owner transactions. Never resend either original. Even if the control reaches FINAL,
it cannot prove whether the registration executed first. The earlier original was a storage registration, not a
provider payment or order. OutLayer can change its deployed
contract, its plain-token refunds may not restore Bouncer's tracked allowance,
and unused prepayment may be difficult to recover. The initial V12 diagnostic
plan passed an [isolated nearcore rehearsal](https://github.com/Greatmujey/Bouncer/actions/runs/41643361478)
with a mock token and local receiver; its deliberately failed project request
left the conservative reservations in place. That was not a live provider test.
Two locally encrypted, single-method agent keys were previously prepared but
not installed. Their local copies were not an off-device backup and are absent
from the reconstructed workspace; do not assume these keys are recoverable.

The V12 Circle registration and funding path [passed an isolated nearcore
rehearsal](https://github.com/Greatmujey/Bouncer/actions/runs/41641922746),
including recovery of one simulated lost funding acknowledgment by original
hash without resending. The example FT's Circle-looking code-hash and metadata
views were deliberately aliased in the disposable sandbox. This is not real
Circle, a testnet transaction, independent delivery or an audit.
