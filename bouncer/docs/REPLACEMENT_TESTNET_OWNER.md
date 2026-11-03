# Replacement testnet owner

The first owner `bouncer-owner-160217b55c7400c0810c0e49.testnet` acquired
6,917 Circle test-USDC atoms. Its original registration, wrap and swap evidence
remains in this repository. Its two local recovery files were outside the
repository and did not survive the workspace refresh; the user indicated they
did not save one or were unsure. The original account and its funds were not
moved. Never repeat its original transactions or claim custody of that key.

The replacement plan in `config/testnet-owner-v2-plan.json` identifies a
**different**, newly generated testnet-only owner and public key. Before any
helper request, two independently encrypted local keyring copies and the
matching public key were checked, and a recovery file was opened privately for
the user. No key was sent to GitHub or CI, and whether the user downloaded a
backup is unverified.

The encrypted keyring and wrapping key were stored together in the Git-ignored
`.bouncer-private/replacement-owner/` folder, with a second local copy. On
3 November 2026 those folders were **not present in the current workspace**.
Public transaction and workflow artifacts are not private-key backups. Whether
the user saved the previously presented recovery file is unconfirmed. Do not
assume this owner can sign or that its testnet funds can be moved. Never paste,
publish, upload or log its private key, and never use it on mainnet.

The [one-shot helper run](https://github.com/Greatmujey/Bouncer/actions/runs/41519023912)
verified the replacement owner at FINAL with 10 test NEAR and its sole expected
full-access public key. The public fence is artifact `13176866986`; do not
repeat this helper request. Circle registration/funding and vault creation
were not part of that helper run.

Separate one-shot operations subsequently registered the replacement owner with
Circle and acquired **6,907 atoms (0.006907 test USDC)** by swapping 0.01 test
NEAR. Their original hashes, FINAL receipt summaries and artifact fences are
retained in `evidence/testnet-owner-v2/`; do not resend those transactions.
This funds the owner and is not a provider purchase. The old owner and its
balance were not touched.

A separate [one-shot deployment](https://github.com/Greatmujey/Bouncer/actions/runs/41520563526)
created `vault.bouncer-owner-3869c162b193fa1729515442.testnet` with 6 test NEAR.
The original receipt and a fresh FINAL view matched the pinned V11 code, owner,
and **zero vault access keys**. Neither an independent audit nor provider
fulfillment is implied. Its keyless storage stake may remain locked, and
recovery-file export remains unconfirmed. Do not resend the original deployment.

Two subsequent fixed, separately journaled actions registered this vault with
Circle and deposited **6,907 atoms (0.006907 test USDC)** via `ft_transfer_call`.
The [original funding run](https://github.com/Greatmujey/Bouncer/actions/runs/41522848477)
verified the transfer event, vault callback and token resolver; the fresh FINAL
view matched **6,907 actual and 6,907 tracked atoms**. A separate
[read-only reconciliation](https://github.com/Greatmujey/Bouncer/actions/runs/41523321141)
checked the same original hash and balances. This is vault funding, not an
independent provider purchase or delivery. Circle storage registration may remain
locked. An RPC error after the registration attempt was resolved by checking
its original hash, without resending.

The [isolated nearcore test](https://github.com/Greatmujey/Bouncer/actions/runs/41521801807)
previously exercised registration, deposit and lost-ack recovery using a **mock
FT and synthetic Circle metadata**; it is separate from the real testnet
receipt evidence above. On any uncertain result, reconcile the recorded
original hash without sending a replacement.

The helper workflow is bound to one session-branch push and first run
attempt. It checks a fresh FINAL view that the new name is absent, retains a
public plan-hash fence and makes at most one helper request. It checks the
resulting public account and key via FINAL views. If the request or final view
is ambiguous, preserve its identity and fence and reconcile read-only; do not
repeat it. A successful owner bootstrap is **not** Circle funding, vault
creation, a provider purchase, an audit or proof that a backup was exported.

### Restricted resource agent (live testnet; no seller yet)

The Circle policy is now configured at **3,000 atoms per transaction and 6,907
per rolling day**, with a granted agent and no allowed seller. The distinct
[zero-yocto control](https://testnet.nearblocks.io/txns/2oECAQZt97rBUkHWuXuY7wMBqEVAuhH3ekeFxR2BWXyK)
was rejected by the vault's exact owner-policy guard. Its higher owner nonce
prevents future execution of the earlier exposed probe, but does not establish
whether that earlier probe had any past receipt. Do not resend either hash.

The [configuration](https://testnet.nearblocks.io/txns/F4NJaYVwafsLAtmvVe1c7k9LQQswR9cou3JZPicw7knZ)
and [restricted-key installation](https://testnet.nearblocks.io/txns/7B6B8df6ZWP4unPNbv7VkrtLp8SKmXvyEL3cGUuZ4YP8)
were individually journaled and verified at FINAL. The installed agent key is
restricted to `execute` and `execute_ft_call` on this vault with a 0.1 test-NEAR
gas allowance; the owner key remains necessary for policy changes. The vault
still had zero keys and 6,907 actual and tracked Circle atoms in the final
installation snapshot. This is **not** seller fulfillment, an audit, or a backup.
Original-hash fences and verification summaries are in
`evidence/testnet-owner-v2/`; never resend these actions.

The two-method Circle agent is not sufficient for the stricter provider runners,
which require dedicated one-method keys. Its 0.1 test-NEAR gas allowance may
also be too low for a 200–300 Tgas call: a separate [sandbox test](https://github.com/Greatmujey/Bouncer/actions/runs/41534163762)
rejected a 300-Tgas call at admission with that allowance at the sandbox gas
price. That rejection was local, not a live transaction; the exact testnet
admission cost can change. Dedicated keys and seller routes have not been
installed. The [isolated nearcore run](https://github.com/Greatmujey/Bouncer/actions/runs/41525285229)
used a disposable mock-token chain, not live Circle or a seller. The agent's
previous local ciphertext copies and wrapping key are absent from the current
workspace and were never an off-device backup.
