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

The encrypted keyring and its random wrapping key are stored together in the
mode-0700, Git-ignored `.bouncer-private/replacement-owner/` workspace folder;
each file is mode 0600. This prevents ordinary Git staging but **is not an
off-device backup**: the wrapping key is alongside the ciphertext and anyone
with access to the folder can recover the key. Ignored workspace files may
also be lost or accidentally exposed by forced adds, archives or uploads. Never
force-add, publish, log or upload this directory, and never use this testnet
key on mainnet. The user should securely retain their own recovery copy.

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

### Next: restricted resource agent (not live yet)

The funded vault does **not** yet have a resource policy, agent key, seller
allowlist or verified provider delivery. The new testnet-only setup planner and
local encrypted keyring are preparation, not a live provisioning command. Its
proposed policy is Circle test USDC, 3,000 atoms per transaction and 6,907 per
rolling day; the separate agent key would only call `execute` and
`execute_ft_call` on this vault with a limited test-NEAR gas allowance. The
plan does not add a payee. The owner key remains necessary for policy changes.

Before any live setup, the planner still needs durable original-hash journals,
strict receipt/state verification, one-shot fences and read-only reconciliation.
The planned zero-yocto owner call is an expected failure that must be verified
as the exact vault guard failure, not just an arbitrary rejected transaction.
The [isolated nearcore run](https://github.com/Greatmujey/Bouncer/actions/runs/41524192299)
executed the proposed probe, policy and restricted-key actions on a disposable
mock-token chain; this is not testnet proof. The two local ciphertext copies
and their colocated wrapping key are not an off-device backup.
