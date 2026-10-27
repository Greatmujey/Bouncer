# Bouncer — payments firewall for autonomous agents on NEAR

Bouncer aims to let an AI agent buy several resources — such as compute,
storage, and API credits — using different NEAR fungible tokens, subject to
owner-defined spending policies. The current prototype implements the vault and
policy checks. The restricted-key contract and its testnet check are being
validated; a multi-resource procurement runtime remains in progress. This is
unaudited testnet software, not suitable for real funds.

## Target tracks

The planned multi-resource agent targets Autonomous Business, AI Security &
Defense, and Agent Economy first. Real-World Money, Unstoppable DeFi and
AI Swarms are potential extensions, not completed integrations.

## Contract capabilities in this branch

- NEP-141 deposits; token-specific vault balances and per-policy caps.
- A direct `execute` call must come from the owner account, with **zero**
  attached deposit and a signing public key explicitly granted to that policy.
  The owner separately creates a NEAR function-call key limited to `execute`.
- Per-transaction and UTC-aligned 24-hour bucket caps, and fail-closed payee
  allowlists. Revoking the final payee blocks all payments on that policy.
- Policy changes, agent-key grants/revocations, payee changes and withdrawals
  require the owner and exactly **1 yoctoNEAR**.
- A transfer failure callback attempts to refund the vault and the original
  spend bucket. A failed callback can still leave a debit unresolved.

The updated check is designed to use a real restricted key to pay wNEAR, deny
other callers and policies, revoke a payee and a key, and test both layers of
the 1-yocto guard with a separate deliberately limited probe key. A zero-deposit
policy mutation should fail in the contract; a one-yocto attempt should fail at
the NEAR protocol layer. Results must be verified by the live testnet run;
offline mocks are not proof of on-chain behavior.

### Important prototype limitations

- These changes only apply to **newly deployed contracts**. Earlier deployments,
  including `bouncer-a958bd.testnet`, still have the older unauthenticated
  `execute` and a different state layout. Do not upgrade them without a migration
  or use them for valuable funds. The script creates a fresh account.
- The check uses **one token (wNEAR)**. Its compute and storage policy names
  demonstrate key/policy isolation, not purchases of two real resources or
  payments with distinct fungible tokens.
- The older procurement/solver scripts are not integrated with this contract.
  Invoices, stablecoin flows, genuine multi-token purchasing and NEAR Intents
  settlement remain unfinished.
- Token trust is not enforced; configure policies only for trusted FTs. Key
  grants do not themselves create or restrict NEAR access keys. The owner must
  create correctly scoped function-call keys and keep full-access keys private.
- This code has not been audited. Contract callback failure, token behavior,
  owner-key compromise and gas/balance exhaustion remain risks.

## Run the wNEAR testnet check

Requires Node.js 22, npm, network access to NEAR testnet and its account helper,
and the `bouncer.wasm` included in the repository. No wallet or external faucet
website is needed. Each run creates and funds a **new testnet** account; keys
are saved in `~/.near-credentials/testnet/` (keep these files private), and the
latest contract ID is written to `~/.bouncer_id`.

In a Codespaces terminal:

```sh
cd /workspaces/Bouncer
git pull --ff-only
npm install --prefix bouncer
node bouncer/demo-all.mjs
```

The script creates a contract, a depositor and a vendor, wraps 2 NEAR into
wNEAR, funds the vault with 1.5 wNEAR, and tries one allowed payment plus
several disallowed operations using a restricted key. It checks expected rejection
reasons, examines transaction receipts, and verifies exact on-chain balances:

```
user:   0.5 wNEAR
vendor: 0.1 wNEAR
vault:  1.4 wNEAR (matches token contract)
✅ All checks passed. One token; payment signed by a restricted agent key.
```

Every successful operation prints a transaction link. The script exits with a
nonzero status on unexpected rejection, unexpected success, failed downstream
receipt, or a balance mismatch. Testnet RPC/helper outages or faucet limits can
also stop a run; their errors are printed rather than hidden. Set
`NEAR_TESTNET_RPC` to override the default FastNEAR testnet RPC. The daily cap uses
UTC-aligned buckets, so a run crossing a bucket boundary can invalidate that
particular test.

GitHub Actions also has an opt-in testnet smoke job, triggered manually or by a
push whose commit message contains `[testnet-smoke]`. It creates real testnet
accounts with ephemeral keys on the runner; it does not upload those keys.
Ordinary CI runs do not create testnet accounts.

## Local tests

```sh
npm install --prefix bouncer
npm test --prefix bouncer
```

The JavaScript policy simulation uses rolling windows and is not identical to
the contract's fixed daily buckets. Offline demo tests use a mocked NEAR
transport; neither proves live blockchain behavior. CI also runs native Rust
contract tests, and the opt-in Actions job or Codespaces command above exercises
real testnet transactions.

## Main files

- `bouncer/contracts/bouncer/src/lib.rs` — current vault and policy contract.
- `bouncer/demo-all.mjs` — fresh-deployment, single-token testnet check.
- `bouncer/tests/` — offline regression tests for the demo script.
- `bouncer/packages/policy/` — independent JavaScript policy simulation.
- `.github/workflows/ci.yml` — JavaScript tests, contract build, and optional
  manual live testnet smoke job.

All earlier deployments, including `bouncer-2dcd4e.testnet` and
`bouncer-a958bd.testnet`, use older state layouts. Do not upgrade them to this
contract without an explicit migration. The demo deploys a fresh contract.

## Roadmap

1. Validate the new restricted-key and policy isolation flow on testnet,
   including the 1-yocto protection with real restricted keys.
2. Demonstrate multiple resource purchases with distinct NEP-141 tokens and
   vendor accounts, then connect a working procurement agent.
3. Add verifiable receipts/invoices and real, explicitly verified NEAR Intents
   settlement. Add per-agent policies and stronger failure/recovery tests.
4. Record the submission demo only after the complete flow works end to end.

MIT license.
