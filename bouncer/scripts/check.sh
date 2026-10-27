#!/usr/bin/env bash
# Run all checks: JS tests + (if Rust is installed) cargo fmt/check/clippy/test.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> JavaScript tests"
npm test

if command -v cargo >/dev/null 2>&1; then
  cd contracts/bouncer
  echo "==> cargo fmt --check"
  cargo fmt --check
  echo "==> cargo check --target wasm32-unknown-unknown"
  cargo check --target wasm32-unknown-unknown
  echo "==> cargo clippy"
  cargo clippy --target wasm32-unknown-unknown -- -D warnings
  echo "==> cargo test"
  cargo test --target wasm32-unknown-unknown --lib
  cd ../..
  echo "==> all checks passed"
else
  echo "⚠ cargo not found; skipping Rust checks. Install Rust:"
  echo "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "    rustup target add wasm32-unknown-unknown"
  echo "JS tests only passed."
fi
