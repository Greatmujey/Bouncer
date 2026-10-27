# Bouncer prototype

The project overview, current limitations, and verified testnet instructions are
in the [root README](../README.md). The intended product is a multi-resource
procurement agent using on-chain spending policies; the working check currently
covers one wNEAR policy and an owner-signed payment only.

**Do not use this prototype with real funds.** The current `execute` method is
not authenticated and cannot be called by a restricted function-call key, and
an empty allowlist permits every payee. See [the threat model](docs/THREAT_MODEL.md).

From the repository root:

```sh
npm install --prefix bouncer
npm test --prefix bouncer
node bouncer/demo-all.mjs
```

The last command creates fresh accounts and executes real NEAR testnet
transactions. It requires access to the testnet RPC and account helper; it
saves testnet private keys under `~/.near-credentials/testnet/`.
