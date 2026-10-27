# Bouncer MCP server (testnet, read-only)

Bouncer can expose its prototype to an MCP-compatible AI client. MCP is a tool
connection, **not** an LLM: you still need an assistant/model and whatever
access it requires. This server has no wallet integration and does not read a
private key, sign, send transactions, redeem services or alter policies. The
existing CLI is the only implemented payment path, and remains testnet-only.

## What the tools do

- `bouncer_about`: prototype capabilities and clearly labelled historical proof.
- `bouncer_inspect_policy`: live final-state views of a v4 testnet policy,
  rolling spend and vault balance. The server checks the RPC-reported chain ID;
  a contract's self-reported version is not an audit or code attestation.
- `bouncer_preview_goals`: send resource inputs to the **operator-configured**
  quote provider, validate its quotes and preflight a public execute-only agent
  key and the on-chain policy. It returns a dry run; it neither pays nor
  delivers. The assistant's supplied token, payee and max price are **not**
  owner approval, and the snapshot could change before any later CLI execution.

Goals sent to a quote tool are disclosed to the configured provider and the MCP
client. Chain data and quotes are untrusted data, not instructions. Do not put
private data, wallet keys, access tokens or seed phrases into tool arguments.
The provider is currently a self-hosted development example, not a commercial
marketplace. A quote tool cannot select its own provider URL or RPC.

## Local clients (stdio)

On the machine **where the client runs**, install Node 22 and dependencies in
this checkout, then configure the client to start the server:

```sh
npm ci --prefix bouncer
node bouncer/mcp/server.mjs --help
```

A typical stdio `mcpServers` entry (merge it into your client's existing
configuration; replace the path with the absolute path on that machine):

```json
{
  "mcpServers": {
    "bouncer": {
      "command": "node",
      "args": ["/absolute/path/to/Bouncer/bouncer/mcp/server.mjs"]
    }
  }
}
```

This repository already includes project-scoped configuration for **Gemini
CLI** (`.gemini/settings.json`) and **Claude Code** (`.mcp.json`). Launch the
client from the repository root after installing dependencies. Trust the folder
or approve the project server only if you trust this checkout; Claude Code
requires explicit project-server approval. Do not enable automatic tool
approval merely to make the server work.

Gemini CLI 0.65.0 connected using the checked-in configuration. Claude Code
2.1.311 correctly showed the project server as pending approval and connected
to the same server via a separate local configuration in a disposable home.
These tests verified local MCP connection/health, **not** an AI model
conversation, Claude Desktop, the Gemini web app, or a user's account. The
official MCP SDK client additionally tested tool discovery and calls over stdio
and loopback HTTP. Client configuration locations, features, and permission
dialogs vary.

For a configured provider, the operator may set
`BOUNCER_MCP_PROVIDER_URL` in the server process environment to a trusted bare
HTTPS origin, or a local HTTP loopback origin such as `http://127.0.0.1:8787`.
The client cannot change that origin. `NEAR_TESTNET_RPC` optionally selects an
operator-trusted testnet RPC; HTTPS or loopback HTTP only. Do not put credentials
in either URL. The server checks the RPC's reported `chain_id` before views.

The default configuration can inspect policies without a provider. For example,
ask a client to inspect policy `compute-wnear` on
`bouncer-42dcdfb7.testnet`. This is the historical demo deployment, not a
user's wallet or vault. The optional quote tool additionally requires your own
configured provider, prepared resource inputs, owner/contract testnet account
IDs, and the **public** restricted agent key. No private key belongs in MCP.

## Remote HTTP and web assistants

`node bouncer/mcp/server.mjs --http` provides stateless Streamable HTTP at
`127.0.0.1:8765/mcp`, requiring a bearer secret supplied in
`BOUNCER_MCP_HTTP_TOKEN`. For a local test, generate a random token without
printing or committing it:

```sh
export BOUNCER_MCP_HTTP_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
node bouncer/mcp/server.mjs --http
```

This binds **only to loopback**. Remote use requires an operator-managed HTTPS
reverse proxy or supported secure tunnel, authentication accepted by the
specific client, and proper access controls. The reverse proxy must forward
`Authorization` and set the upstream `Host` header to `127.0.0.1` (or
`localhost`). The server rejects browser `Origin` requests, validates the Host,
limits body size and rate, and requires its bearer token. Never expose the
unencrypted upstream port or put the bearer token into URLs, browser code,
logs, or a public repository. This single static bearer token is a development
mechanism, not per-user OAuth, credential rotation, a multi-tenant deployment,
or a production security review.

ChatGPT web custom MCP connections require a reachable HTTPS endpoint or a
supported tunnel, client/account permissions and compatible authentication.
Claude's Messages API similarly requires a reachable HTTPS MCP endpoint. A
hosted deployment, OAuth discovery/authorization, account-specific access and
end-to-end testing with those web products **are not implemented**. See the
[ChatGPT custom MCP documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
and [Claude MCP connector documentation](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).
Availability may differ between products and plans. Do not treat a local stdio
configuration as an already-connected ChatGPT, Claude API or Gemini web app.

## Tests and risks

`npm test --prefix bouncer` exercises a real SDK handshake, stdio and HTTP
transports, authentication failures, dry-run preflight, malicious quotes, wrong
network/version/key, and the absence of payment tools. The opt-in
`[mcp-clients]` CI marker checks actual Gemini CLI and Claude Code local
connection health with a disposable home and no AI credentials. The
`[mcp-testnet]` marker queries the existing v4 testnet contract through an MCP
client without a key or transaction. The [live read-only check](https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40569317234)
passed against the recorded v4 deployment. Mock tests are not live-chain
evidence.

Unaudited software. RPC, quote provider, client, reverse proxy, dependencies and
host are trust boundaries. Static bearer auth and basic rate limits are not a
production deployment. `near-api-js` 6.5.1 is retained because the existing
transaction flow was verified with it; `npm audit` reports a low-severity
transitive elliptic/secp256k1 advisory with no non-breaking fix as of this
change. The MCP tool accepts Ed25519 public keys only.
