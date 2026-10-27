#!/usr/bin/env node
// The old cross-chain solver generated pretend fill hashes and targeted methods
// absent from the current contract. It is intentionally disabled until real,
// independently verifiable settlement is implemented.
console.error('[solver] Disabled: NEAR Intents settlement is not implemented. No bids or fills were submitted.');
process.exitCode = 1;
