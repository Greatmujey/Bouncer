# Bouncer prototype threat model

This describes the contract source in this branch, not older deployed versions.
It has not been audited and must not hold valuable funds.

## Intended controls in the current source

- `execute` accepts zero deposit and checks both predecessor and transaction
  signer are the owner account. Its signer public key must be explicitly granted
  to the selected policy. The signed request also names its expected token;
  the contract rejects it if the policy's token differs. The owner should create
  a separate NEAR function-call key scoped only to the contract's `execute`.
- The owner and exactly 1 yoctoNEAR are required to change policies, grant or
  revoke agent keys, change payees, and withdraw. Function-call keys cannot
  attach deposits under the NEAR protocol. Grants are contract-level state;
  they do not create or limit a protocol access key.
- Per-transaction caps, a conservative rolling daily budget, the token vault
  balance, and a fail-closed payee allowlist are checked atomically before a
  debit. The current hour plus 24 prior hourly buckets prevent early expiry;
  some spend remains counted for up to one hour beyond 24 hours.
- The contract pays the token transfer's required 1 yoctoNEAR itself. A private
  callback attempts to restore the vault and the **original** hourly bucket if
  the token transfer fails. The demo inspects receipts and exact token balances
  rather than trusting a successful callback status alone.
- V5 additionally tracks native NEAR and pins a bounded OutLayer program to a
  native policy. The owner installs a separate `execute_outlayer`-only key. The
  full maximum deposit is debited and budgeted up front, while any unused
  accepted-execution refund is sent to the owner. A failed promise is never
  treated as proof that the full native deposit returned to the vault.
- V6/V7 add owner-pinned FT transfer-call messages and revisions. The owner
  must trust the token and exact receiver behavior; final settlement alone does
  not establish provider delivery. V7 also tracks conservative OutLayer
  prepaid credit and requires separate native and token policies, grants and
  caps for an owner-pinned priced project.
- V8 adds a separate owner-pinned native program **and exact input** route,
  with policy/payee/route revisions. It only constrains a key installed to call
  `execute_outlayer_pinned` alone; the legacy `execute_outlayer` method still
  allows that method's authorized key to choose its input.
- V9 adds a native-only owner-pinned OutLayer **Project** route and a separate
  `execute_outlayer_native_project`-only key. It pins exact input, version and
  limits without secrets or prepaid FT parameters; registry checks are off-chain
  and non-atomic, and post-payment verification cannot undo a bad execution.

A [v4 testnet run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40558301848)
verified a restricted-key payment, both escalation-guard layers and a failed FT
transfer whose callback restored the vault and daily budget. A separate-owner
[v5 OutLayer check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40682550107/job/122797278579)
verified one independently operated native-NEAR execution and owner refund; it
checked output range, not TEE attestation or randomness. A [v9 mission](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/41073097919/job/124122803916)
also rejected project-route escalation and substitution probes, recovered a
native-paid price request, and gated Circle testnet resource payments on
checked development deliveries. The worker timestamp and single-source value
are not authenticated market freshness or a price-accuracy proof. These runs do
not prove all possible callback, provider or token failure cases.

## Remaining risks

1. **No audit or guaranteed callback recovery.** If the callback itself fails,
   the recorded balance may remain debited even if a transfer failed. The native
   test for a failed transfer and hour-boundary refund is not an adversarial
   test of all live cross-contract failures.
2. **Token trust is not enforced.** `ft_on_transfer` accepts its predecessor as
   a token without an owner-approved registry. Malicious or non-standard FT
   contracts can lie or consume storage. Use trusted FTs only.
3. **Owner full-access key compromise.** A stolen owner key can change policy,
   grant another key, or withdraw. Use a separate secure owner in any future
   real deployment; this testnet script makes the contract account its owner.
4. **Protocol access key must be scoped correctly.** Granting a key in the
   contract does not constrain a full-access key or install an access key.
   Grant only an execute-only function-call key and revoke both the contract
   grant and NEAR access key when removing an agent.
5. **Views are policy previews, not authorization checks.** `check` and
   `try_execute` do not identify a transaction signing key. V4 has no owner
   view, so a preflight cannot verify that the supplied signer account is the
   owner; execution still enforces it on-chain. V5 exposes `get_owner` and the
   OutLayer runner checks it; the older FT preflight still relies on the
   on-chain signer check. The runner requires the RPC to
   report `testnet`, but a malicious RPC can lie. The raw procurement CLI checks
   requests independently. The resource agent (and its MCP preview) makes
   tentative shared-budget and vault reservations and aborts a blocked batch
   before new payments, but views are not atomic and cannot guarantee later
   authorization or prevent partial execution if the chain changes. Each
   newly paid delivery must pass its bounded checks and persist a receipt before
   the resource runner submits another payment. Failure or an execution-time
   policy block halts later unpaid goals, but cannot undo an earlier transfer.
6. **Policies and tokens are shared.** Policy-specific key grants isolate which
   policy a key may use, but policies may share the same token vault. Caps are
   denominated in token units, not USD; the contract does not enforce oracle prices. Rebinding a
   policy to another token retains numeric spend history in the old units. Use
   a new policy for each token rather than changing an existing policy's token.
7. **Untrusted model and development-only provider.** An optional model can
   propose resource inputs but not financial authority. Injection or errors can
   still produce an unwanted task within an authorized budget; review output
   before spending. Objectives go to the configured model. The local provider
   performs SHA-256 work, local-file storage, text statistics and fixed-origin
   unauthenticated GitHub data reads; it is not an independent commercial
   provider or marketplace. GitHub data is untrusted and can be unavailable
   after payment. The older multi-token test uses synthetic testnet FTs; a
   separate Circle testnet USDC mission also pays this self-hosted provider.
   Testnet USDC has no real value. There is no cross-chain settlement. Ref's
   observed instant-swap output arrives by plain `ft_transfer`, not the vault's
   `ft_on_transfer`, and can also remain in Ref's internal balance on withdrawal
   failure. Simply pinning a swap message would not credit the Bouncer vault or
   prove output settlement. Comparing raw balances across asynchronous token
   operations can over-credit; no guarded Ref swap is claimed here. The old
   solver is disabled because it previously used fake fill hashes; the older
   standalone quote comparator does not settle anything. The agent's optional
   curated quote selection is separate: it contacts only owner-configured
   endpoints, compares one token at a time, rejects mismatched or unavailable
   quotes, and requotes the selected price before the guarded runner may pay.
   It may send full order inputs to every candidate, with up to five requests
   in flight. A failed quote stops queued work but cannot recall inputs already
   sent. A dishonest approved provider may underbid and refuse delivery;
   unsigned quotes have no expiry or guarantee.
   A separate fixed-origin Agent Market discovery command reads a bounded public
   catalog only: query terms are disclosed and listing text/metrics are untrusted
   and can contain prompt injection. They never authorize payment or modify the
   planner or allowlist. The marketplace's advertised mainnet x402 delegated FT
   transfer is not controlled by the existing restricted-key policy and is not
   implemented here. New-format entries record the payment request and provider route before
   submission. Completed payments can recover without a fresh quote and reject
   changed routes; legacy entries may lack either safeguard and still require
   the original quote. Provider or independent-source outages can still block
   recovery. Preserve the original goals and journal rather than selecting again.
   The optional [x402 onchain-proof adapter](ONCHAIN_PROOF.md) is a different,
   public transaction-hash/memo rail, not standard `exact`. A claimant can
   copy its public proof, and the seller SDK does not bind it to the requested
   URL or authenticate the buyer. Its default replay set is not durable across
   gate restarts. The adapter requires explicit risk acceptance and stops after
   an ambiguous seller request; it cannot enforce seller-side replay protection
   or guarantee delivery. Its independent-SDK test uses a synthetic testnet
   wrapper, not an independent live merchant.
8. **Local journal and nonce tracker are not distributed coordination.** The
   file journal synchronizes its content and directory before returning, and
   blocks automatic retries of uncertain payments in one local file. Sync
   failures stop execution, but a different/deleted journal, multiple hosts or
   unreliable storage can bypass the protection. The signer keeps its own
   process's nonces monotonic to mitigate stale RPC reads; it does not coordinate
   concurrent processes using the same key or
   retry a failed send. Use one writer per key. For OutLayer and opt-in
   `--durable` direct FT payments, the signed transaction hash is journaled
   before the one broadcast and can be re-queried without a private key. The
   durable direct, FT-call, paid-project, native OutLayer and oracle runners
   check the prepared action, arguments, locally derived hash and signature
   against the reviewed call before journaling. The built-in payment RPC makes
   one HTTP send attempt and bounds receipt reads; injected RPC providers can
   have different retry behavior and must be reviewed separately. A timed-out
   read remains unresolved, never evidence that a transaction did not execute.
   These checks do not protect against a compromised host or owner key. Recovery
   requires trusted FINAL RPC receipts, Bouncer code and token code; it verifies
   payment, not delivery. An unknown or expired hash stays unresolved and is
   never automatically resent. Existing direct-payment entries and runs that
   do not opt into `--durable` may lack a pre-recorded hash and still require
   manual reconciliation. The resource, autonomous, mixed-mission and
   paid-mission CLIs must be explicitly run with `--durable` to use this path
   for direct resource payments; it is not the default. The separate dependent
   workflow runner always uses durable direct FT payments and binds a normalized
   owner manifest into the same journal. Its key-free recovery verifies the
   recorded source and each paid delivery before any new stage. It can still
   fail if the RPC/provider is unavailable, and journal loss, changes or another
   host can enable duplicate spending. Its offline tests are synthetic, not
   evidence of a new live workflow. See [dependent workflows](DEPENDENT_WORKFLOWS.md).
9. **Provider verification and operations are not trustless.** The provider
   trusts its configured RPC, Bouncer deployment/code and token contracts. It
   verifies transaction arguments and receipts, but cannot protect against a
   compromised or upgraded trusted contract, malicious RPC or token. The seller
   verifier requires matching FINAL transaction, transfer and callback receipts.
   Up to eight redemptions can be in flight with same-transaction coalescing.
   An exclusive lock excludes other provider processes using the same local
   directory; state and object files and directories are fsynced, subject to
   filesystem guarantees. A crash may leave a stale lock or pending fulfillment;
   never steal a lock automatically. A write error stops the instance for manual
   reconciliation. Different directories/hosts have no shared replay protection.
   Storage is plaintext and
   publicly retrievable, and there is no authentication or transport security.
   The configured provider checks that its RPC reports testnet, but the RPC can
   lie; an implicit 64-hex token ID does not itself identify a network.
   Orders are sent to the provider; their hashes are on chain.
   Client-side verification occurs only after payment: it recomputes the bounded
   SHA-256/text examples, reads storage back once from the same provider, and
   checks GitHub repository identity only. It cannot guarantee future storage,
   independently verify GitHub's other fields, or force delivery/refund. Local
   receipts include results and hashes and may leak information; they are
   editable, depend on trusted host/RPC, and are not signed invoices or
   independent attestations.
10. **Prior contracts are unsafe to upgrade without migration.** Older contracts
   have different state and authorization; v3 and v4 interpret budget bucket
   keys differently, and v5, both v6 layouts, v7, v8 and v9 add incompatible state.
   Deploy v9 fresh; no migration is supplied. A reported version is not proof
   of code identity. Hourly spend buckets are not pruned and incur ongoing
   state/storage costs; the 25 reads per check also consume gas.
11. **OutLayer is a trusted independent service, not trustless compute.** The
   random-number example uses native NEAR; the separate priced-project path
   also spends an owner-pinned provider-held prepaid FT balance. Provider/RPC
   availability, contract code, program hosting and the owner-pinned hash are
   assumptions; output range alone does not establish randomness or verify TEE
   attestation. The full native maximum stays budgeted even after an owner
   refund. An accepted failure may only partially refund the owner; a rejected
   request may return untracked funds to the contract. A project refund can
   instead return to Bouncer's provider-held prepaid balance, not the vault;
   the conservative ledger may understate funds and strand credit. Views are
   non-atomic. Reconcile uncertain results manually; no generic callback
   restores the full maximum. Inputs are public. OutLayer's separate HTTPS
   payment keys or direct x402 delegation would bypass this per-call policy.

The owner key, NEAR protocol, token implementation, callback availability and
software correctness are trust assumptions. Offline JavaScript mocks are not
live blockchain proof; native unit tests and a live smoke test are useful but
are not a substitute for a security review.
