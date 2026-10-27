# Deployment and testnet check

The previously documented CLI, USDC, agent-key, invoice, and solver commands do
not match the current contract and should not be used as a working demo. Follow
[the root quickstart](../../README.md#run-the-wnear-testnet-check) for the
supported fresh-deployment testnet script.

The security check exercises a restricted-key wNEAR payment, policy isolation
and a deliberately failed FT transfer/refund. The separate
[multi-token check](../../README.md#multi-token-procurement-check-testnet-only)
uses wNEAR and two synthetic credits; the resource provider is self-hosted and
not a commercial vendor. The quote-to-delivery check and real cross-chain
settlement remain work in progress. See the [threat model](THREAT_MODEL.md)
before experimenting. No real funds should be used.
