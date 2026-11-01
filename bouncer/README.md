# Bouncer prototype

The project overview, current limitations, and testnet instructions are in the
[root README](../README.md). The goal is a multi-resource procurement agent
using on-chain spending policies. The new contract source supports zero-deposit,
policy-scoped function-call keys. The security check uses one token; a separate
integration check covers three testnet tokens and self-hosted development services.

**Do not use this prototype with real funds.** It is unaudited, and older
deployments do not gain the new authorization checks. See the
[threat model](docs/THREAT_MODEL.md). The [website and wallet notes](docs/WEB.md)
and [read-only MCP setup](docs/MCP.md) describe onboarding, testnet identity and
AI-client integration, including unfinished hosted access and wallet verification.
The optional [natural-language agent](docs/AI_AGENT.md) needs a separately
configured model and operates under an owner-controlled testnet resource catalog.
Local journals are plaintext by default; [optional encrypted file journals](docs/FILE_JOURNALS.md)
require a separate key and careful preservation of original payment state.

From the repository root, once CI has attached the matching wasm:

```sh
npm install --prefix bouncer
npm test --prefix bouncer
node bouncer/demo-all.mjs
```

The last command creates fresh accounts and executes real NEAR testnet
transactions. It requires access to the testnet RPC and account helper; it
saves testnet private keys under `~/.near-credentials/testnet/`.
