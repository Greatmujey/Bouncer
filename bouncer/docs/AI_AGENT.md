# Natural-language resource agent (testnet prototype)

Bouncer can ask an operator-configured, OpenAI-compatible chat-completions model
to turn a written objective into **compute, storage and API tasks**. It then
binds those tasks to an owner-controlled catalog, obtains quotes and uses the
existing restricted-key runner for testnet policy checks, payments and local
delivery. The model proposes work; it does **not** choose a contract, policy,
FT, payee, price limit, key or endpoint. This is not a marketplace, a commercial
cloud integration or audited software. Do not use real funds.

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
  quote. This is deliberately conservative. Quote amounts and order-bound memos
  are independently checked against the catalog. The contract then enforces the
  actual token, key grant, allowlist, per-transaction cap, rolling daily cap and
  vault balance at execution. A zero daily cap on chain disables that daily cap.
  Before any new payment, the resource agent also previews the whole batch,
  tentatively reserving shared policy budgets and token vault balances. If a
  request is blocked in that preview, it submits no new payments in the batch.
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
If fulfillment fails after a confirmed payment, rerunning this second command
uses the existing payment rather than automatically paying again. A pending or
ambiguous payment requires manual chain reconciliation; do not delete the journal
or regenerate the goal to bypass it. As an alternative, adding `--execute` to the
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
[AI job in run 40581368718](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40581368718/job/122462232919)
passed that additional step with a real testnet payment and a second independent
GitHub read; the same workflow's separate security job failed on an RPC nonce
error. This synthetic demo checks the repository literally and can ask the model
once for a correction before setup; malformed or unauthorized output still fails
closed.
[Run 40579499294](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40579499294)
passed with contract `bouncer-ff7d41d8.testnet`: model inference, three real
synthetic/testnet-token payments and all local deliveries. It used text
statistics, not the newer GitHub-data feature. It used no paid inference API or
user model key; model weights and private keys were not committed or uploaded.
The model and runtime are third-party dependencies; future runs can fail due to
downloads, model output, or testnet RPC.
