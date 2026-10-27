#!/usr/bin/env bash
# Optional local inference service for Bouncer. No model files go into the repo.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash bouncer/scripts/local-model.sh [--prepare | --help]

Downloads a pinned llama.cpp CPU runtime (~23 MB) and Qwen2.5 1.5B Q4 model
(~1.12 GB), verifies SHA-256, then serves the model on 127.0.0.1:17890.
Linux x86_64 only; requires curl, sha256sum, tar and about 2 GB free disk.
Files are cached under ~/.cache/bouncer-local-model (or BOUNCER_MODEL_CACHE).
Press Ctrl-C to stop. No API key or paid inference service is used.
--prepare downloads and verifies the files without starting a server.
Optional: BOUNCER_MODEL_PORT=17890 and BOUNCER_MODEL_THREADS=2.
HELP
}
if [[ $# -eq 1 && "$1" == '--help' ]]; then usage; exit 0; fi
mode=serve
if [[ $# -eq 1 && "$1" == '--prepare' ]]; then mode=prepare
elif [[ $# -ne 0 ]]; then usage >&2; exit 2; fi
[[ "$(uname -s)" == 'Linux' && "$(uname -m)" == 'x86_64' ]] || { echo 'Linux x86_64 is required; supply a compatible model server separately.' >&2; exit 1; }
for tool in curl sha256sum tar find mktemp; do command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }; done
port=${BOUNCER_MODEL_PORT:-17890}
threads=${BOUNCER_MODEL_THREADS:-2}
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Invalid BOUNCER_MODEL_PORT.' >&2; exit 1; }
[[ "$threads" =~ ^[0-9]{1,2}$ ]] && (( 10#$threads >= 1 && 10#$threads <= 32 )) || { echo 'Invalid BOUNCER_MODEL_THREADS.' >&2; exit 1; }
cache=${BOUNCER_MODEL_CACHE:-"$HOME/.cache/bouncer-local-model"}
umask 077
mkdir -p "$cache"
work=$(mktemp -d "$cache/.runtime.XXXXXXXX")
tmp=''
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$tmp" && -f "$tmp" ]]; then rm -f -- "$tmp"; fi
  if [[ -n "$work" && -d "$work" ]]; then rm -rf -- "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verified_download() {
  local file=$1 url=$2 expected=$3
  if [[ -e "$file" ]]; then
    if ! printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null; then
      echo "Existing cache file failed SHA-256 verification: $file (not modified)." >&2; exit 1
    fi
    return
  fi
  tmp=$(mktemp "$cache/.download.XXXXXXXX")
  echo "Downloading $(basename "$file") to the private cache..." >&2
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 1200 "$url" -o "$tmp"
  printf '%s  %s\n' "$expected" "$tmp" | sha256sum -c - >/dev/null
  # Do not replace a file another process may have created in the meantime.
  if ! ln "$tmp" "$file" 2>/dev/null; then
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null || { echo 'Concurrent cache file failed SHA-256 verification.' >&2; exit 1; }
  fi
  rm -f -- "$tmp"; tmp=''
}

runtime="$cache/llama-b11932-bin-ubuntu-x64.tar.gz"
model="$cache/qwen2.5-1.5b-instruct-q4_k_m.gguf"
verified_download "$runtime" 'https://github.com/ggml-org/llama.cpp/releases/download/b11932/llama-b11932-bin-ubuntu-x64.tar.gz' 'dd5370127e82d15130f76876615dcca7fe80d5c451297c37ad4029df0abc84ba'
verified_download "$model" 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf' '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
if [[ "$mode" == prepare ]]; then echo 'Pinned runtime and model verified in the private cache.'; exit 0; fi
tar -xzf "$runtime" -C "$work"
server=$(find "$work" -type f -name llama-server -print -quit)
[[ -n "$server" ]] || { echo 'Verified runtime did not contain llama-server.' >&2; exit 1; }
export LD_LIBRARY_PATH="$(dirname "$server"):${LD_LIBRARY_PATH:-}"
echo "Local model endpoint: http://127.0.0.1:$port/v1/chat/completions" >&2
echo 'Model name: bouncer-local-qwen. This server is unauthenticated and loopback-only.' >&2
"$server" -m "$model" --host 127.0.0.1 --port "$port" --threads "$threads" --ctx-size 4096 --parallel 1 --alias bouncer-local-qwen &
server_pid=$!
wait "$server_pid"
