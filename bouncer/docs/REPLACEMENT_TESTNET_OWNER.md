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

The one-shot helper workflow is bound to one session-branch push and first run
attempt. It checks a fresh FINAL view that the new name is absent, retains a
public plan-hash fence and makes at most one helper request. It checks the
resulting public account and key via FINAL views. If the request or final view
is ambiguous, preserve its identity and fence and reconcile read-only; do not
repeat it. A successful owner bootstrap is **not** Circle funding, vault
creation, a provider purchase, an audit or proof that a backup was exported.
