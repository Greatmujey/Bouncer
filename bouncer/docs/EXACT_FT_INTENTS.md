# Experimental exact, one-shot FT intents (V11)

**Fresh testnet state only; not deployed, audited, migrated, or an independent
purchase.** This is a separately compiled `exact-ft-v11` feature, not a change
to the pinned V9 `bouncer.wasm` or the separate YouTick V10 variant. V11 adds
state fields and **must not be installed over any V9/V10 vault**: no migration
or source-to-binary reproducibility is established. The two experimental
features must not be enabled together. CI tests and uploads a build for review;
it never deploys or overwrites the pinned artifact. A `.testnet` suffix does
not prove the chain: the operator must independently check the RPC network,
code hash, access keys and reviewed deployment before using a fresh vault.

## The boundary

V9's unrestricted `execute` lets a granted key choose a transfer memo. A
public MultiAgency code is payment-routing information, and its reviewed
watcher matches a memo *containing* that code. V11 adds an owner-approved,
one-shot direct FT intent. Its 1-yocto guard checks the immediate predecessor
and attached deposit; **it does not prove a human approved the call**. A
contract acting as the owner can itself forward a privileged call with one
yocto, and the vault deliberately trusts that owner contract's authorization.
A function-call key restricted to the vault cannot attach that yocto directly,
but this is not a substitute for understanding any owner-contract forwarding
path. Contract wallets can be legitimate; their authorization and code need
separate review. See `owner_contract_forwarding_is_trusted_not_a_proof_of_human_approval`
in the V11 contract tests. The owner explicitly:

1. Configures an FT policy, caps, payee and agent key under the existing
   **exactly 1 yoctoNEAR** owner guard.
2. Irreversibly locks that policy to exact intents, then signs a second
   1-yocto intent that pins a unique ID, token, payee, exact amount, printable
   memo, expiry, agent key and a SHA-256 review commitment. Pinning does not
   pay or authenticate the quote. The public commitment should be to a public
   brief; hashes do not safely hide low-entropy secrets.
3. Separately installs the agent's NEAR function-call key on the owner account
   with receiver equal to the vault and **only** `execute_exact_ft` allowed.
   An empty method list means all methods and is unsafe. Never use a full-access
   agent key. The contract's per-policy key grant is necessary but not a
   substitute for that protocol restriction.

The restricted key supplies only the intent ID and attaches zero NEAR. The
contract verifies the pinned key, policy/payee/key revisions and expiry; the
normal token balance, allowlist, per-transaction cap and rolling daily budget
still apply. It consumes the intent before creating a transfer. The token call
uses the exact pinned memo and 1 yocto from the vault. A successful transfer
remains consumed. On a failed FT receipt the callback restores the tracked
vault balance and, if the policy revision has not changed, the original
budget bucket. **It never reopens the intent**, even after a refund. A missing
or failed callback may leave accounting conservative and requires manual
reconciliation; `consumed` means initiated, not paid or delivered.

Policy edits, payee revoke/re-allow, agent revoke/re-grant, expiry and explicit
cancellation invalidate pending intents. IDs and `(token, payee, memo)`
reservations remain permanently used even when cancelled, expired or failed;
there is no automatic retry. Once any intent is pinned for a token/payee, the
legacy `execute` and `execute_ft_call` routes to that pair are also permanently
blocked **across policies**, even for a different or containing memo. The
locked policy cannot switch to native. This is deliberately irreversible and
uses storage for each owner-approved reservation; do not lock an existing
policy or recipient without understanding the operational impact. Other
policies, other vaults, the owner and a malicious or nonstandard token remain
separate trust boundaries.

The chain guard does not identify all earlier or already-in-flight legacy
transfers, or transfers from another vault/account. Use a new vault and a
restricted key; preserve and reconcile the original durable journal and
transaction hash. A duplicate/missing journal, lost encryption key, stale
backup, changed vault or different RPC/provider can still undermine recovery.
Do not automatically repeat a quote, signed call or ambiguous broadcast.

## MultiAgency operator path

The same experimental `npm run multiagency -- --help` interface now includes
`--prepare-exact`, `--pay-exact`, `--recover-exact` and `--inspect-exact`. The
separate legacy `--pay` route uses V9's broader `execute`; it is not upgraded
or made one-shot by V11. Do not substitute it for an exact intent.

After explicit approval of a meaningful public brief and the provider risks,
the existing quote action reserves one encrypted journal entry before its
single POST. With that *original* quote and journal, `--prepare-exact` accepts
only the public agent key and produces the owner calldata and full review
preimage **offline**. It does not sign, contact the seller or write the
journal. The SHA-256 commitment is the UTF-8 `JSON.stringify` of the ordered
`review` object in its output: protocol tag, validated goal, normalized quote,
canonical Ed25519 public key and execution cutoff. The cutoff is five minutes
before the quote expires; the intent ID contains the first 60 hex digits of
the full commitment. Owners must review the output and separately sign the
1-yocto policy lock and intent on a fresh, reviewed V11 vault. There is no
automated owner setup/deployment in this path yet.

`--pay-exact` requires explicit execution and provider-availability assertions
and the restricted signing-key file. It rechecks the network, keyless reviewed
vault/code hash, owner, exact-only key permission, token registration, policy,
intent and budget at a FINAL block. The selected FINAL header must be no more
than 120 seconds old or 30 seconds in the future relative to the local clock;
its freshness is checked again during review and before broadcast. Raw
contract views must report the requested block hash, including historical intent
views during recovery. This trusts the RPC and clock and cannot prevent state
changes or a dishonest RPC. It checks the seller quote twice, signs only the ID,
and synchronously persists the signed transaction hash to the
original encrypted journal before **one** bounded broadcast. A timeout,
uncertain receipt or failed write stays unresolved. `--recover-exact` uses the
original hash without signing or sending; it verifies the historical vault and
consumed intent, exact transfer, Circle event and successful callback. A
successful receipt proves settlement only. `--inspect-exact` adds seller job
attribution and one public task's handoff, without signing, sending or writing;
the report remains untrusted and may not fulfill the whole brief. All these
paths currently have synthetic tests only.

## What it does not solve

The seller's quote is unsigned and its memo is public. A different sender can
pay a matching code first, and the watcher, deployed code, capacity, terms,
refunds and useful delivery are **not** established by this contract. A token
transfer or callback is not fulfillment. MultiAgency's provider response,
public job and independently checked deliverable need separate verification,
followed by owner assessment. The operator must obtain explicit approval of
the exact public brief, amount, policy and risks before a quote or payment;
this feature does not create consent or authorize a live purchase. Testnet
Circle USDC has no financial value. Never use this unaudited prototype with
real funds.
