// Public, immutable source and WASI checksum for the bounded testnet task.
export const MARKET_SUMMARY_SHA256 = '0016209450769d4a03ee802e4dcbca854f14ca54f9185bed03333924e31b5ef6';
export const MARKET_SUMMARY_PROGRAM = Object.freeze({
  url: 'https://raw.githubusercontent.com/Greatmujey/Bouncer/e26eb30dfc95b4bfdc1ed685c3bb76cf6ec152e7/bouncer/programs/market-summary/market-summary.wasm',
  sha256: MARKET_SUMMARY_SHA256, build_target: 'wasm32-wasip1',
  max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60,
});
