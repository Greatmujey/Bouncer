#!/usr/bin/env bash
# Build the Bouncer contract. Run from repo root.
# Requires Rust + wasm32 target + cargo-near (or cargo).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building bouncer contract..."
cd contracts/bouncer

if command -v cargo-near >/dev/null 2>&1; then
  cargo near build --release
else
  echo "cargo-near not found; falling back to cargo build --target wasm32-unknown-unknown --release"
  rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
  cargo build --target wasm32-unknown-unknown --release
  mkdir -p res
  cp ../../target/wasm32-unknown-unknown/release/bouncer.wasm res/bouncer.wasm
  echo "WASM built to $(pwd)/res/bouncer.wasm"
fi
