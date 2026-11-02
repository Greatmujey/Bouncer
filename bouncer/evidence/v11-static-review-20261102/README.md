# V11 static compatibility indication — 2 November 2026

`compatibility.json` is the output of `scripts/v11-static-compatibility.py`
for the recovered 536,325-byte V11 artifact with SHA-256
`1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921`.
The source comparison uses nearcore **2.14.0**, commit
[`bc4e9e8`](https://github.com/near/nearcore/tree/bc4e9e8cfb03d9e82f027883055624e18576993e),
and the lockfile-pinned WABT 1.0.39. Both artifact and selected nearcore files
are SHA-256 checked before inspection. WABT analyzes a private temporary copy of the checked bytes.

- All 41 `env` function import names and signatures matched that nearcore
  source's host declarations. The selected source config diffs switch the
  global-contract functions on at protocol 78, reference-types/bulk-memory at
  84, gas-key functions at 85, and universal accounts at 88.
- WABT validated this module with SIMD and multi-value disabled. Disabling
  bulk memory too causes validation to fail at a `memory.copy` opcode, as
  expected. These are selected static checks, not nearcore's full validator.
- These checks do **not** run nearcore, check all Wasm/instrumentation/gas or
  storage limits, query a chain, prove the live network has this exact source,
  establish Rust-source-to-binary provenance, or audit security. Never use the
  report as deployment authorization or as evidence of a funded vault.

To reproduce with a separately obtained copy of the exact WASM, run this one
block from the repository root. `gh` reads only pinned public nearcore source;
no GitHub workflow, NEAR transaction or seller request is triggered:

```bash
set -euo pipefail
npm ci --prefix bouncer --ignore-scripts --no-audit --no-fund
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
REF=bc4e9e8cfb03d9e82f027883055624e18576993e
for F in runtime/near-vm-runner/src/imports.rs core/parameters/res/runtime_configs/parameters.yaml core/parameters/res/runtime_configs/parameters_testnet.yaml core/parameters/res/runtime_configs/78.yaml core/parameters/res/runtime_configs/84.yaml core/parameters/res/runtime_configs/85.yaml core/parameters/res/runtime_configs/88.yaml; do
  mkdir -p "$D/$(dirname "$F")"
  gh api "repos/near/nearcore/contents/$F?ref=$REF" --jq .content | base64 -d > "$D/$F" || exit 1
done
python3 bouncer/scripts/v11-static-compatibility.py --wasm /absolute/path/to/recovered-v11.wasm --nearcore-dir "$D"
```

The generated report is only as trustworthy as the local Node/WABT installation
and the checked source snapshots; it is not a signature or an independent
review. The WASM is not committed to this repository, and the unreferenced Git
blob used for transfer may be garbage-collected.
