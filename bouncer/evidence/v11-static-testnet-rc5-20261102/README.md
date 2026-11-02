# V11 static comparison with one reported testnet node's source

This is a **read-only, partial static indication**, not a live deployment,
nearcore runtime execution, security audit or source-to-WASM provenance proof.
At approximately `2026-11-02T08:51Z`, the public testnet status endpoint
reported protocol 88 and node version `2.14.0-rc.5`, commit
[`b7b4737`](https://github.com/near/nearcore/tree/b7b4737cab46f17a6daa2ed694d7aebbd204363a).
The mainnet endpoint reported protocol 86 and 2.14.0 release commit
[`bc4e9e8`](https://github.com/near/nearcore/tree/bc4e9e8cfb03d9e82f027883055624e18576993e).
The [status observation](rpc-status-observation.json) is self-reported by two
RPC endpoints; their head is not a FINAL proof, and neither node's binary,
other validators nor the chain's runtime configuration was independently
attested. A later [cache-busted status recheck](rpc-status-recheck-0903.json)
at approximately 09:03 UTC reported the same protocols and commits; the
unparameterized fetch had returned the earlier cached response. Node software
and network protocol can change.

The separate offline [compatibility report](compatibility.json) checks the
same hash-pinned 536,325-byte V11 artifact against selected source files from
the reported testnet rc.5 commit, using WABT 1.0.39:

- All 41 imported `env` function names and signatures match the pinned rc.5
  host declarations; WABT validates the module with SIMD and multi-value
  disabled, while disabling bulk memory also rejects its `memory.copy`.
- The selected rc.5 source enables global-contract host functions at 78,
  bulk-memory/reference-types at 84, gas-key host functions at 85 and
  **universal accounts at 87**. The pinned `version.rs` independently names
  `UniversalAccounts => 87`, and the selected 88 diff does not override that
  flag. These are source observations, not a query of deployed runtime config.
- This differs from the separately reviewed [2.14.0 release source](../v11-static-review-20261102/README.md),
  whose selected universal-accounts gate is at 88; the 87 and 88 config files
  are not byte-identical between the two commits. Bouncer retains a conservative
  88 preflight floor across both selected profiles. In both, protocol 86 is
  below the gate. The pinned rc.5 `RuntimeConfigView` source declares and
  populates the four selected boolean fields; the preflight requires the RPC's
  pinned configuration to report each as enabled. This source check does not
  demonstrate a live endpoint's behavior. A floor and reported flags do not
  prove actual feature availability, binary validity, gas sufficiency,
  consensus or compatibility with a future binary.
- The static script checks selected files only. It does not run nearcore, check
  all protocol and gas limits, prove that the RPC's reported software is truly
  running, verify owner funds or Circle state, or authorize a transaction.

Reproduce this **offline** comparison with an independently obtained copy of
the exact V11 WASM; the public GitHub calls below fetch source only, not a
workflow, transaction or seller request:

```bash
set -euo pipefail
npm ci --prefix bouncer --ignore-scripts --no-audit --no-fund
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
REF=b7b4737cab46f17a6daa2ed694d7aebbd204363a
for F in runtime/near-vm-runner/src/imports.rs core/parameters/res/runtime_configs/parameters.yaml core/parameters/res/runtime_configs/parameters_testnet.yaml core/parameters/res/runtime_configs/78.yaml core/parameters/res/runtime_configs/84.yaml core/parameters/res/runtime_configs/85.yaml core/parameters/res/runtime_configs/87.yaml core/parameters/res/runtime_configs/88.yaml core/parameters/src/view.rs core/primitives-core/src/version.rs; do
  mkdir -p "$D/$(dirname "$F")"
  gh api "repos/near/nearcore/contents/$F?ref=$REF" --jq .content | base64 -d > "$D/$F"
done
python3 bouncer/scripts/v11-static-compatibility.py --wasm /absolute/path/to/recovered-v11.wasm --nearcore-dir "$D" --source-profile testnet-rc5-20261102
```

Both source snapshots and the exact artifact are digest-pinned; this does not
attest the WABT install, local operating system, compiler, running nodes or
security properties. Independently review the artifact and execution path and
obtain explicit owner approval before any future deployment attempt.
