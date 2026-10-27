# Bouncer prototype

The project overview, current limitations, and testnet instructions are in the
[root README](../README.md). The goal is a multi-resource procurement agent
using on-chain spending policies. The new contract source supports zero-deposit,
policy-scoped function-call keys; the testnet check currently uses one token.

**Do not use this prototype with real funds.** It is unaudited, and older
deployments do not gain the new authorization checks. See the
[threat model](docs/THREAT_MODEL.md).

From the repository root, once CI has attached the matching wasm:

```sh
npm install --prefix bouncer
npm test --prefix bouncer
node bouncer/demo-all.mjs
```

The last command creates fresh accounts and executes real NEAR testnet
transactions. It requires access to the testnet RPC and account helper; it
saves testnet private keys under `~/.near-credentials/testnet/`.
