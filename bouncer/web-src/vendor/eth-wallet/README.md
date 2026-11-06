# Ethereum wallets for NEAR: pinned executor

The two files in `src/` and `LICENSE.md` are unmodified from
[gagdiez/eth-wallet](https://github.com/gagdiez/eth-wallet) commit
`d47756b52f2a8bdd4ac24d0fcf2fe4e496a22cd1` (MIT). `npm run build:web`
bundles only that executor; its resulting SHA-256 is pinned in
`web-src/wallet-executor.mjs` and checked before running in the NEAR Connect
sandbox. The separate wallet approval page at `https://evm-on-near.dev/` is
operated by that project and may change; it is not part of Bouncer's bundle.

The adapter targets the Ethereum-style `0x…` NEAR account controlled by the
Ethereum wallet, not an existing named NEAR account. Its connection may ask
the wallet to approve a relayer onboarding transaction, and it supports only
one action per transaction, not atomic deployment bundles. A connection does
not create a Bouncer vault or grant the Bouncer agent spending authority.
