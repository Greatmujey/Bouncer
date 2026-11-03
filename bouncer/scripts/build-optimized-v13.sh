#!/usr/bin/env bash
# Experimental V13 size-optimized artifact. No chain access or signing.
# Exact locked inputs, Rust toolchain and Binaryen package are required.
set -euo pipefail
if [ "$#" -ne 1 ] || [[ "$1" != /* ]]; then echo 'usage: build-optimized-v13.sh /absolute/output.wasm' >&2; exit 2; fi
out="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/bouncer-v13-opt.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$root/contracts/bouncer"
test "$(rustc --version | cut -d' ' -f2)" = '1.99.1'
test "$(sha256sum Cargo.lock | cut -d' ' -f1)" = '263879a4574d1d5ed97dd0da097cdefff52b4f57017738ad291628a9c63e317f'
CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_OPT_LEVEL=z CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
  RUSTFLAGS='-C link-arg=-s' cargo build --locked --target wasm32-unknown-unknown --release --no-default-features --features tollgate-native-v13
raw='target/wasm32-unknown-unknown/release/bouncer.wasm'
test "$(sha256sum "$raw" | cut -d' ' -f1)" = '425c4e3ea19923ef2c46a41a2e5c59628f093ff1abdb8eb6cdf121d7d0f88c6b'
curl --fail --silent --show-error --location 'https://registry.npmjs.org/binaryen/-/binaryen-119.0.0.tgz' -o "$work/binaryen.tgz"
python3 - "$work/binaryen.tgz" <<'PY'
import base64,hashlib,pathlib,sys
b=pathlib.Path(sys.argv[1]).read_bytes()
if base64.b64encode(hashlib.sha512(b).digest()).decode()!='DTdcs8ijrj2OIEftWVPVkYsgJ8MzlYH+uSsC8156g88E7CNaG8kEfWNGSXxb3tPlzadrm6sD3mgSEKKZJu4Q3g==':
    raise ValueError('Binaryen package integrity mismatch')
PY
tar -xzf "$work/binaryen.tgz" -C "$work"
node "$work/package/bin/wasm-opt" "$raw" -Oz --enable-bulk-memory --enable-reference-types -o "$work/optimized.wasm"
python3 - "$work/optimized.wasm" <<'PY'
import hashlib,pathlib,sys
b=pathlib.Path(sys.argv[1]).read_bytes()
if len(b)!=388570 or hashlib.sha256(b).hexdigest()!='783c7fc06f55868bff8e9f53d41dc896e9d6ac3056c37f6fd18de4f1d270a540' or b[:8]!=b'\0asm\1\0\0\0' or b'bouncer-agent-v13-tollgate-native-testnet' not in b:
    raise ValueError('optimized artifact differs from measured binary')
PY
cp "$work/optimized.wasm" "$out"
printf 'Experimental V13 artifact %s, ' "$out"
sha256sum "$out"
