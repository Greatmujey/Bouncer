# Bounded market-summary WASI program (testnet prototype)

This tiny WASI Preview 1 executable reads exactly one compact JSON object on
stdin and writes one JSON object to stdout, as OutLayer's pinned random example
does. Input order and canonical decimal integers are part of the format:

```json
{"price_usd_micros":2750000,"quantity":10,"oracle_tx_hash":"11111111111111111111111111111111"}
```

It returns `{"value_usd_micros":27500000}`. Price is a positive integer no
greater than 10^12, quantity is 1–1000, and the source hash is a 32–60
character base58 string. The maximum product (10^15) is exactly representable
by both WASM and JavaScript. Noncanonical or out-of-range input exits with a
failure instead of producing a result. The hash binds the computation request
to an original transaction; this program does not itself fetch or verify it.
Bouncer must verify the oracle evidence and round the positive USD price to
micro-dollars **before** creating the input. The output is a value estimate,
not a transaction quote or investment advice.

This file is a deployable, content-pinned provider artifact, not proof of live
execution. Build reproducibly with Node 22:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
sha256sum market-summary.wasm
```

The project pins AssemblyScript and its transitive dependencies in its own
lockfile. The executable only imports WASI `fd_read`, `fd_write`, and
`proc_exit`. Passing local WASI tests does not prove OutLayer can fetch it or
that its provider actually executed it; the mission verifies receipts and the
arithmetic separately. Never substitute a local or fabricated result for a
live provider result.
