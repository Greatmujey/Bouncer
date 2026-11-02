# Provider-neutral testnet vault bootstrap

Bouncer's planned new keyless vault is the direct child
`vault.bouncer-owner-160217b55c7400c0810c0e49.testnet`. It is not tied to a
particular seller or track. As of this document, **it has not been deployed,
registered for Circle, or funded**. The testnet owner holds 6,917 Circle USDC
atoms (0.006917 test USDC); that is not a provider purchase.

The [read-only preflight](https://github.com/Greatmujey/Bouncer/actions/runs/41481748588)
at FINAL block `2UYfdYLfpAsk4XgjevfWSqmGGtuakyRDANvkQvD7bnjP` observed that
the child did not exist, the owner was a plain account with the expected sole
full-access key, the owner was registered and funded for Circle, and testnet
protocol 88 advertised the selected V11 WASM features. It estimated a minimum
of 5.96325 test NEAR including a 50,000-byte storage margin and 0.1 test NEAR
reserve, compared with the proposed 6 test NEAR initial funding. Estimates are
not guarantees, and the RPC and local clock are trusted.

The offline signer in this branch is limited to one transaction containing
`create_account`, exactly 6 test NEAR, the hash-pinned 536,325-byte V11 WASM,
and `new` with the owner above. It installs **no vault access key** and does
not configure a seller, create an agent key, register Circle storage, transfer
USDC, or send a transaction. A local write-ahead journal checks both testnet
owner key copies and the original verified acquisition before exporting the
signed public bearer. The current code has only fixture/offline tests; there is
no implemented broadcaster for this deployment, and no deployment signature
has been created.

The exact artifact SHA-256 is
`1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921`.
An isolated nearcore test exercised this artifact, but the artifact is not
independently audited or independently reproduced. A keyless V11 vault cannot
upgrade or delete itself with the current contract; native storage stake and
Circle registration may remain locked. Two local testnet owner key copies
were checked, but whether the user exported a backup is unconfirmed. Before any
deployment, build and test a one-shot broadcaster, a durable original-hash
fence, receipt verification and read-only recovery; recheck the state and
nonce at a fresh FINAL block. Publishing signed bytes permits anyone to relay
their exact fixed transaction before the CI guard, so never blindly resend or
replace an unresolved original hash.
