# One-shot testnet owner bootstrap

This is a narrowly scoped experiment to create a **new testnet-only** plain
owner account. It does not touch an existing wallet, mainnet, Circle USDC, a
vault, a seller, or real money. The owner's full-access Ed25519 key was
created locally outside the repository; only its public key and account name
appear in the committed plan. Never reuse this testnet key for mainnet.

The local recovery file contains the full-access private key. Keep it private,
store an offline copy, and never paste it into chat, source control or a
website. Local duplicate files were checked against the public key and the
recovery file was opened for the user, but that is **not** proof that the owner
has exported or safely retained a backup. A keyless vault must not be considered
safely recoverable merely because these local files existed.

[One-shot run 41477680991](https://github.com/Greatmujey/Bouncer/actions/runs/41477680991)
at commit `9870549982c2cfa47013a9d3212d7ffbdecaa501` succeeded. At FINAL block
`9ujjZF3N1sU9cc9Xgi7e9agNAbRBbjxyjgVejqnpPFB6` it observed
`bouncer-owner-160217b55c7400c0810c0e49.testnet` with exactly the expected one
full-access key and 10 test NEAR. The public attempt fence is artifact
`13157938135`. The helper acknowledged the request; no owner transaction was
signed, Circle registration or funding was checked, or vault deployed by that
run. Do not repeat the helper request.

## One-shot fence

`bootstrap-testnet-owner-once.yml` is hard-wired to one branch push, its exact
parent and `run_attempt == 1`; it has no manual-dispatch trigger. Re-runs or
later commits do not request another account. Before any helper request, the
job saves the public plan and original run/commit identity as a GitHub artifact;
the runner verifies that artifact's identity and plan-hash-based name. It then
checks a fresh FINAL testnet view that the proposed name is absent, makes **at
most one** HTTPS POST to NEAR's public testnet helper, and only performs views
afterward. An acknowledged HTTP response is not treated as proof of creation.

The program requires a fresh FINAL view of the exact new account, no local or
global contract, a positive native balance, zero locked balance, and exactly
one full-access key equal to the locally generated public key. An RPC is still
a trust assumption, and this view is not a cryptographic receipt proof. A
lost response, timeout, account mismatch or unavailable view is **unknown**:
retain the original public artifact and identity, reconcile read-only, and
never automatically repeat the helper request. No owner-signed transaction is
created or broadcast by this workflow.

## Boundaries

- Testnet helper behavior, funding amount and availability are outside Bouncer's
  control. A public full-access key does not establish private-key custody.
- A successful account view establishes neither Circle registration/funding
  nor any vault or independent provider fulfillment.
- Future owner-signed actions require a separate reviewed, one-shot,
  original-hash-journaled path. They must never expose the private key through
  GitHub, CI logs, the browser preview, or MCP.
- Keyless contracts and storage deposits can be irreversible. Do not deploy or
  fund one without verified key backup, explicit testnet risk scope, correct
  artifact/code/key checks, and safe original-hash recovery. This remains
  unaudited experimental code.
