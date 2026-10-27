# Testnet quickstart

The previous near-cli commands in this file were for an older CLI and contract
API. Use the current [root README](README.md#run-the-wnear-testnet-check)
instead. The supported check uses Node.js and `near-api-js`, creates fresh
funded testnet accounts, and currently tests one wNEAR policy with an owner key.

```sh
cd /workspaces/Bouncer
git pull --ff-only
npm install --prefix bouncer
node bouncer/demo-all.mjs
```

This is an unaudited testnet prototype; see the [limitations](README.md#important-prototype-limitations)
before using it. Do not record a submission demo until the full intended
multi-resource agent flow has been completed and verified.
