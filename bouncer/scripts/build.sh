#!/usr/bin/env bash
# Build the fresh contract wasm from the repository root (or any directory).
# Requires Rust with wasm32-unknown-unknown. wasm-opt is recommended for the
# same optimization used in CI. Override BOUNCER_WASM_OUTPUT only if needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/bouncer/contracts/bouncer"
OUT="${BOUNCER_WASM_OUTPUT:-$ROOT/bouncer.wasm}"
TARGET="${CARGO_TARGET_DIR:-$CRATE/target}"
[[ "$TARGET" = /* ]] || TARGET="$CRATE/$TARGET"

command -v cargo >/dev/null || { echo 'cargo is required' >&2; exit 1; }
if command -v rustup >/dev/null; then rustup target add wasm32-unknown-unknown; fi
cd "$CRATE"
echo '==> Building Bouncer contract...'
RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
SOURCE="$TARGET/wasm32-unknown-unknown/release/bouncer.wasm"
[[ -f "$SOURCE" ]] || { echo "Built wasm not found: $SOURCE" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
TEMP="$(mktemp "$(dirname "$OUT")/.bouncer-wasm.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT
if command -v wasm-opt >/dev/null; then
  wasm-opt -O1 --strip-debug -o "$TEMP" "$SOURCE"
else
  echo 'Warning: wasm-opt is missing; using an unoptimized build (CI uses -O1).' >&2
  cp "$SOURCE" "$TEMP"
fi
mv "$TEMP" "$OUT"
echo "WASM built to $OUT"
