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
and **zero vault access keys**. As of that view, Circle storage for the vault
was not registered and its tracked Circle balance was zero; the 6,907 atoms
were still at the owner. Neither an independent audit nor provider fulfillment
is implied. Its keyless storage stake may remain locked, and recovery-file
export remains unconfirmed. Do not resend the original deployment.

The next two fixed, separately journaled actions register this vault with Circle
and deposit the already acquired test USDC using `ft_transfer_call`. A fresh
pinned preflight verifies the V11 code, owner, zero keys, token code, storage
bounds and both actual/tracked balances. The registration deposit may remain
locked. The [isolated nearcore test](https://github.com/Greatmujey/Bouncer/actions/runs/41521801807)
exercised the registration, full deposit and original-hash recovery after a
simulated lost response using a **mock FT and synthetic Circle metadata**; it is
not testnet Circle funding or independent provider fulfillment. On any uncertain
result, reconcile the recorded original hash without sending a replacement.

The helper workflow is bound to one session-branch push and first run
attempt. It checks a fresh FINAL view that the new name is absent, retains a
public plan-hash fence and makes at most one helper request. It checks the
resulting public account and key via FINAL views. If the request or final view
is ambiguous, preserve its identity and fence and reconcile read-only; do not
repeat it. A successful owner bootstrap is **not** Circle funding, vault
creation, a provider purchase, an audit or proof that a backup was exported.
