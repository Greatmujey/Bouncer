# Natural-language resource agent (testnet prototype)

Bouncer can ask an operator-configured, OpenAI-compatible chat-completions model
to turn a written objective into **compute, storage and API tasks**. It then
binds those tasks to an owner-controlled catalog, obtains quotes and uses the
existing restricted-key runner for testnet policy checks, payments and local
delivery. The model proposes work; it does **not** choose a contract, policy,
FT, payee, price limit, key or endpoint. An optional comparison selects the
lowest valid quote among explicitly owner-approved providers for the same token.
This is not a public marketplace, a commercial cloud integration or audited
software. Do not use real funds.

## What is enforced

- The model sees the objective and the names of available resource types, not
  the catalog, financial settings, journal or signing key. **The objective
  itself is sent to the chosen model endpoint**: do not put passwords, private
  keys, confidential data or other secrets in it. A remote model service can
  log or retain it. The local development resource provider also receives order
  contents; its storage is plaintext and unauthenticated.
- Supported work is a bounded SHA-256 job, a bounded local text object with a
  safe name, a text-statistics request, or public GitHub repository metadata.
  The GitHub API request is an unauthenticated GET to a fixed HTTPS origin;
  a model can supply `owner/repository`, but not an arbitrary URL. No shell
  commands, policy changes, extra fields or model-chosen payment addresses are
  accepted. A malformed, truncated, refused, oversized,
  duplicate or out-of-catalog plan is rejected; there is no fake fallback.
- The trusted owner catalog sets the testnet contract, provider origin, policy,
  token, payee, per-task maximum, maximum task count and per-resource aggregate
  maximum. For each resource Bouncer reserves **the per-task maximum times the
  number of proposed tasks** against that aggregate maximum before fetching a
  quote. This is deliberately conservative. With `--compare-providers`, up to
  four alternatives plus the primary are compared within the resource's one
  pinned token. Every quote must match its owner-approved policy, payee, token,
  order-bound memo and maximum; any invalid or unavailable quote stops the
  comparison. Prices are exact integer smallest units; ties favor owner order.
  The contract then enforces the
  actual token, key grant, allowlist, per-transaction cap, rolling daily cap and
  vault balance at execution. A zero daily cap on chain disables that daily cap.
  Before any new payment, the resource agent also previews the whole batch,
  tentatively reserving shared policy budgets and token vault balances. If a
  request is blocked in that preview, it submits no new payments in the batch.
- After a confirmed payment, the resource agent checks each bounded development
  result before reporting fulfillment: it recomputes SHA-256 and text statistics,
  reads stored content back from the same provider, and independently checks a
  GitHub repository's identity. It records the result, verification scope and
  payment details in the private journal. These checks have important limits
  described below and cannot undo a payment.
- `--execute` is an explicit opt-in to spending **testnet** funds. The runner
  rejects full-access and over-broad keys and uses the same pending-payment
  journal as the deterministic resource agent. Transactions are separate, not
  atomic: one may complete even if a later one is blocked or fails.

These controls restrict *authority*, not model understanding. Prompt injection,
hallucination or a wrong interpretation can still lead the model to spend on an
unwanted but catalog-authorized task. Review generated inputs and quote output;
for higher assurance, plan first and execute separately. Owner config files,
model/provider endpoints, RPC, the host and deployed contract code must be trusted.
A contract version string is not code attestation. Non-atomic previews can go
stale. There is no distributed idempotency; deleting/changing a journal or using
another host can cause duplicate payments. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Use a prepared testnet deployment

Node.js 22 is required. `node bouncer/demo-multi-resource.mjs` creates a fresh
testnet deployment and writes `<account>.owner.json`, `<account>.provider.json`,
plans and journals under `~/.bouncer/testnet/`; it writes a separate execute-only
agent key under `~/.near-credentials/testnet/`. It uses wNEAR and two **synthetic**
credit tokens, and creates real testnet transactions. Never copy or commit the
keys, generated goals, inputs or journals. The original demo has already spent
some of the vault and rolling budget, so later requests may be blocked.

Start a model server **you trust** separately. On Linux x86_64,
`bash bouncer/scripts/local-model.sh` offers the same pinned Qwen2.5 1.5B CPU
model used by the live test. On first use it downloads approximately **1.12 GB**
of model weights and a 23 MB runtime into `~/.cache/bouncer-local-model/`,
verifies their SHA-256 hashes and listens on loopback only. It does not require
an account or paid inference API. Keep it running in a separate terminal, then
set `BOUNCER_LLM_URL=http://127.0.0.1:17890/v1/chat/completions` and
`BOUNCER_LLM_MODEL=bouncer-local-qwen` for the agent command. The local server
is unauthenticated; other processes on the same machine may reach it. The script
and downloads are third-party code and weights, not a security audit.

Alternatively use another compatible server. It must expose the OpenAI-style
`POST /v1/chat/completions` endpoint and support schema-constrained JSON output;
HTTP is allowed only on loopback, HTTPS is required otherwise, and redirects are
not followed. The software does not bundle a model, model server or inference
credits. Models may fail or misunderstand the objective; failure is not a
successful demo. Public GitHub data is live third-party content, may contain
untrusted text, and may be unavailable or rate-limited. If its read fails after
a confirmed payment, the local provider can safely repeat that read using the
same payment; it never automatically sends a second payment. Set these
environment variables for the commands below:

- `BOUNCER_LLM_URL`: full chat-completions URL, for example
  `http://127.0.0.1:17890/v1/chat/completions` for a local server.
- `BOUNCER_LLM_MODEL`: the name the server expects.
- `BOUNCER_LLM_API_KEY`: optional bearer key for the selected server; use an
  environment variable, not a command-line argument. Do not put it in Git.

After the demo has completed locally and the model server is running, this
single block creates a private objective, generates a **new** goals file and
previews quotes and on-chain policy views without paying:

```sh
cd /workspaces/Bouncer
ID=$(cat "$HOME/.bouncer_id")
umask 077
printf '%s\n' 'Hash "near-hub compute job" for 1000 SHA-256 rounds, store "Testnet note" as "my-note", and count the words in "Bouncer resource agent".' > "$HOME/.bouncer/testnet/objective.txt"
node bouncer/agent/autonomous.mjs --config "$HOME/.bouncer/testnet/$ID.owner.json" --objective-file "$HOME/.bouncer/testnet/objective.txt" --output "$HOME/.bouncer/testnet/new-work.bouncer-goals.json" --key "$HOME/.near-credentials/testnet/$ID.agent.json" --local-provider "$HOME/.bouncer/testnet/$ID.provider.json"
```

The file is created with private permissions and is never overwritten. Inspect
it and the printed quote/preflight output. A dry run does not pay or deliver.
Shared-vault and daily-budget reservations are tentative local calculations,
not atomic on-chain reservations; balances and policies can change afterward.
After review, run the existing resource agent with **that exact goals file** and
the same local provider, adding `--execute`:

```sh
cd /workspaces/Bouncer
ID=$(cat "$HOME/.bouncer_id")
node bouncer/agent/resource-agent.mjs --goals "$HOME/.bouncer/testnet/new-work.bouncer-goals.json" --key "$HOME/.near-credentials/testnet/$ID.agent.json" --local-provider "$HOME/.bouncer/testnet/$ID.provider.json" --execute
```

The generated goals file stores its stable matching journal path. Preserve both.
If fulfillment or verification fails after a confirmed payment, the journal
keeps that payment and marks delivery `unverified`; rerunning this second command
can request delivery again without sending another payment. For new journal
entries, the exact request and reviewed provider ID/origin are recorded before
submission; recovery does not need a fresh quote and rejects a changed route.
Older entries without a recorded request still need the original quote and
fingerprint to match; older entries also may not pin the provider route.
Providers or independent data sources may still be
unavailable, and a vendor may refuse to deliver or replay. A pending or ambiguous
payment requires manual chain reconciliation; do not delete the journal or
regenerate the goal to bypass it. As an alternative, adding `--execute` to the
first command opts into **immediate, unreviewed** execution after the model plan;
this can spend on a mistaken but permitted task and should not be used when the
objective or model output is untrusted. Omitting `--key` produces the goal file
only, without quotes, blockchain views, transactions or fulfillment.

## Trusted owner configuration

The demo generates a config using its actual accounts. For another deployment,
create and review one yourself; every field below is operator-controlled, not
model output. Amounts are decimal strings in the token's smallest units, not
USD. `required_resources` is optional; when specified, omission is a failure.
Only configured resources are available to the model. `max_tasks` is at most 10.

```json
{
  "version": 1,
  "contract_id": "bouncer-example.testnet",
  "owner_account_id": "bouncer-example.testnet",
  "provider_url": "http://127.0.0.1:8787",
  "max_tasks": 1,
  "required_resources": ["compute"],
  "resources": {
    "compute": {
      "policy_id": "compute-wnear",
      "token": "wrap.testnet",
      "payee": "compute.bouncer-example.testnet",
      "max_amount": "100000000000000000000000",
      "max_tasks": 1,
      "max_total_amount": "100000000000000000000000"
    }
  }
}
```

The payee, token and policy must also be configured and allowed on the fresh v4
contract, and the quote provider must actually support that product. The model
cannot make these changes. The example is a shape, not a deployed account.

## Compare owner-approved providers

Comparison is opt-in. Add an `alternatives` array to a resource entry in the
trusted owner catalog; the top-level `provider_url` and that resource's original
policy/payee remain the **primary**. For example, the `compute` entry above may
also contain:

```json
"alternatives": [
  {
    "id": "alternative",
    "provider_url": "http://127.0.0.1:8788",
    "policy_id": "compute-wnear",
    "payee": "compute-alt.bouncer-example.testnet",
    "max_amount": "100000000000000000000000"
  }
]
```

These are illustrative accounts, not deployed services. Each alternative must
already be approved in the owner file and on chain: its policy must use the
resource's token, allow the payee, grant the restricted agent key and have
sufficient caps and vault balance. The payee must be registered with the FT.
An alternative may specify a **lower** per-task maximum but not a higher one.
Do not put a `token` field in an alternative: all candidates for one resource
inherit its single pinned FT. There is no exchange-rate lookup or cross-token
price comparison. The full on-chain batch preflight runs *after* selection; if
the chosen quote is not allowed on chain, the batch stops rather than silently
falling back to another provider.

Start all explicitly configured provider endpoints separately, then plan and
compare without a signing key or payment:

```sh
node bouncer/agent/autonomous.mjs --config owner.json --objective-file objective.txt --output reviewed-goals.json --compare-providers
```

Review the saved task inputs, provider IDs, destinations, quote amounts and
comparison summary before invoking `resource-agent.mjs` with that same goals
file and a restricted key. Supplying `--key` to the command above additionally
preflights the selected goals; adding `--execute` also opts into immediate,
unreviewed testnet spending. `--compare-providers` cannot be combined with
`--local-provider`: comparison needs all the providers running beforehand.
Without the flag, the primary is used and alternatives are not contacted.

Comparison can send each task's normalized **full input** to every approved
candidate, which can retain it. No quote is sent to the model. At most five
quotes are in flight concurrently; all candidates must return an authorized,
order-bound quote. One unavailable, over-cap or invalid response stops queued
requests, waits for in-flight requests and aborts with no selection or payment.
Ties still follow owner order, not response timing. The selected origin, policy,
payee and **exact quote amount** are saved privately.
Before a **new** payment, the runner requotes that same provider and refuses
even a lower changed amount. For a confirmed payment with a recorded request,
recovery reuses that request without requoting or paying again. A quote has no
signature, expiry, guarantee of fulfillment or trusted quality rating;
the cheapest provider might not deliver. This is a curated selector, not vendor
discovery or a production marketplace. The contract remains the final spending
authority and prices or chain state can change after a preflight.

Preserve the selected goals file and its matching journal. Confirmed new-format
payments can be recovered without a fresh quote; **legacy** entries without a
recorded request still require the original quote. Either way, the provider can
be unavailable or refuse to redeem the original transaction. Do not delete the
journal or generate a new selection to bypass a problem: a fresh selection can
cause a second payment. Reconcile the existing payment and arrange delivery.

## Delivery checks and local receipts

The checks are deliberately specific to the current bounded development
protocols, not a generic proof of any cloud service:

- **Compute:** recompute the bounded iterated SHA-256 job locally and compare the
  exact result. This costs the agent the same work; it does not verify arbitrary
  remote workloads.
- **Storage:** validate the order/transaction-bound object ID, byte count and
  hash, then fetch up to 4096 bytes from the same pinned provider and compare
  the exact content. This is one readback, not proof of persistence, replication
  or future availability. The development provider has no authentication.
- **Text API:** independently recompute word count and UTF-8 byte count.
- **GitHub data:** make a separate, fixed-origin GitHub API request and compare
  the repository name and ID. **Only identity is checked**; descriptions,
  counters, license and timestamps remain untrusted and may be stale or wrong.
  The extra GitHub request can be rate-limited or unavailable after payment.

After a check succeeds, the same private journal contains a `delivery.receipt`
with the contract, policy, token, payee, amount, order memo, transaction hash,
provider route, checked result, verification scope, local timestamp and a
SHA-256 digest of the canonical result. The result hash is computed over the
UTF-8 bytes of `bouncer-delivery-result-v1`, a NUL byte, and `JSON.stringify`
of the fixed-order result. Results and metadata may be sensitive; the journal
is created with mode 0600. The file journal synchronizes each new file and its
containing directory before returning, including the pending record written
before a payment. A sync error stops the run; after a rename, the journal may
still show a pending entry even if nothing was sent, so reconcile it manually.
This requires a filesystem supporting these sync operations and cannot protect
against faulty hardware, loss of the journal or a compromised host. It is a
local, editable record, **not a signed invoice, independent attestation, or
proof of a provider's future performance**. It trusts the host, configured RPC
and deployed contract. The contract does not verify these results or guarantee
a refund for a bad delivery.

An invalid response or failed readback never receives a verified receipt. The
completed payment remains in the journal as completed, with delivery marked
`unverified`; subsequent attempts reuse that payment. After the whole-batch
preflight passes, each newly paid delivery is verified and its receipt persisted
before the next payment is sent. Failure to fulfill, verify or persist stops
later payments. A policy rejection during execution also stops later unpaid
goals, which are reported as `DEFERRED`. Already-paid deliveries are rechecked
before any new batch payments on a later run. Earlier payments cannot be rolled
back, and the non-atomic preview does not prevent a partial batch if state
changes. If an already verified result later changes, the agent refuses to
overwrite its receipt. Keep the original
goals and journal; if the provider cannot reproduce a correct result,
manual resolution is required. Deleting or altering these files can allow
repeat payments and local records are not tamper-proof.

A [deterministic live test](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40671752050/job/122760598105)
paid self-hosted services on contract `bouncer-8c5de354.testnet`, verified
compute, one storage readback and text statistics, and persisted the matching
local receipts. It then injected a wrong reply **locally after payment** (not a
claim of provider misconduct), observed rejection, and recovered with the same
[compute transaction](https://testnet.nearblocks.io/txns/GewpbPFkGtbBnNzWbuFrwcmWqb6hCHFkqoaBBmN3u7eh)
without a new quote or payment. The separate security/refund job passed in that
run. Its AI-planned job failed before procurement while granting a policy key
because a testnet setup transaction expired; an [isolated retry](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40672397604/job/122762858060)
failed earlier while creating a vendor account for the same reason. Neither is
an AI delivery proof. Fresh testnet demo setup now retries an explicit
pre-admission `Expired` RPC error once; timeouts, receipt outcomes and agent
procurement payments are never retried by that helper.

The [subsequent combined AI/live verification job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40673056154/job/122765249942)
passed after those failures. On `bouncer-3e6fcb2e.testnet`, the pinned local
Qwen model proposed the tasks before account setup; the agent bought compute,
storage, text API and GitHub data and compared the two self-hosted providers.
The locally corrupted comparison result was rejected and recovered without a
requote or second payment using [transaction `5Jnhhr…ayvf`](https://testnet.nearblocks.io/txns/5JnhhrRpWSfuSBVvfw25BSVrtQPQWRoyTnff2dKAayvf).
The GitHub receipt records **repository identity only**. The same workflow's
[deterministic job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40673056154/job/122765249982),
JavaScript tests, Rust tests and wasm build also passed; its security job was
not run. These are testnet payments to development services, not proof of an
independent provider or future storage availability.

## Read-only market discovery

`npm run discover --prefix bouncer -- --query research --limit 5` independently
reads public listings from the fixed NEAR Agent Market catalog. It does not
read owner configuration, call a model, create quotes, change policy or pay.
The listed marketplace advertises mainnet x402 rather than Bouncer-controlled
testnet procurement. Search terms are disclosed to the marketplace, and its
names, descriptions, statistics and availability are untrusted: they can contain
prompt injection or misleading claims. Never treat a listing as an allowlist
entry, provider endorsement or payment authority. Any future integration needs
separate owner approval, a compatible policy-enforced payment flow and real
provider interoperability testing.

## Verification

`npm test --prefix bouncer` includes mock-model/mock-chain tests for malicious
financial fields, input and budget limits, quote tampering, default dry-run,
failures and journal recovery. Mocks do not prove inference or blockchain use.
The opt-in GitHub Actions marker `[ai-multi-resource]` downloads a pinned
Apache-2.0 Qwen2.5 1.5B model and a pinned llama.cpp CPU server to the **ephemeral
runner**, verifies their SHA-256 hashes, runs actual local inference, and, only
if the model correctly extracts the synthetic objectives, creates fresh testnet
accounts and performs the three-token payment and self-hosted delivery check.
It also purchases a public GitHub-data lookup using the API credit policy. The
[AI job in run 40582306741](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40582306741/job/122465464986)
passed that additional step with a real testnet payment and a second independent
GitHub read. The same run's separate [security/refund job](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40582306741/job/122465465014)
also passed after adding a process-local stale-nonce mitigation. This synthetic
demo checks the repository literally and can ask the model once for a correction
before setup; malformed or unauthorized output still fails closed. The provider
comparison has separate mock regression tests and an opt-in
`[provider-compare]` live testnet job. In
[run 40666249071](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40666249071/job/122742140751),
two self-hosted development providers quoted 0.10 and 0.08 wNEAR for one
explicitly supplied compute task; the agent selected the cheaper approved payee,
[paid on testnet](https://testnet.nearblocks.io/txns/3ztdLNn4M91nDtqQNUSZZqgwEg3Fh9CaU3XP7BnD8T3S),
verified the local result and replayed without another payment. That comparison
task was deterministic. A later combined
[AI/provider-comparison run](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40667233621/job/122745427128)
used the local model to propose the comparison task before any accounts were
created, then selected the approved 0.08 wNEAR quote and
[paid it on testnet](https://testnet.nearblocks.io/txns/HbibFp8eUpNgdQUV4azi1jG9PVekEY9teupjHgHrDhki).
It also completed the three-resource and GitHub-data payments and replay checks.
Its separate security job was skipped; the earlier security/refund success is
linked above. All compared providers were self-hosted, not commercial. The
combined optional job uses both markers `[ai-multi-resource]` and
`[ai-provider-compare]`; tests and demos remain testnet only.
[Run 40579499294](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40579499294)
passed with contract `bouncer-ff7d41d8.testnet`: model inference, three real
synthetic/testnet-token payments and all local deliveries. It used text
statistics, not the newer GitHub-data feature. It used no paid inference API or
user model key; model weights and private keys were not committed or uploaded.
The model and runtime are third-party dependencies; future runs can fail due to
downloads, model output, or testnet RPC.
