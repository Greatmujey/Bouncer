#!/usr/bin/env python3
"""One-time bridge for an existing, non-secret public V11 build artifact.

This is deliberately tied to one GitHub run, artifact, repository and push
context. It does not build, sign, deploy, call NEAR or contact a seller. It
checks the archive and WASM against separately retained hashes, then creates
only a content-addressed Git blob; it never updates a branch or tag.

The workflow token stays in process memory and is sent only to api.github.com.
The signed artifact redirect is fetched without that token and never logged.
Hash matching establishes transport integrity, not a source-to-binary audit.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib

REPOSITORY = "Greatmujey/Bouncer"
REPOSITORY_ID = 1434975537
BRANCH_REF = "refs/heads/arena/e03cb47e-near-hub"
MARKER = "[v11-existing-artifact-bridge-20261102]"
ARTIFACT_ID = 13105539480
RUN_ID = 41362684342
ARTIFACT_NAME = "bouncer-exact-ft-v11-wasm"
ARCHIVE_BYTES = 158299
ARCHIVE_SHA256 = "145c2148537f2c4fa29ca6c6b643f4ecf8cc89350c18f48ca0f4e1bf9cf23239"
WASM_BYTES = 536325
WASM_SHA256 = "1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921"
STORAGE_HOST = "productionresultssa10.blob.core.windows.net"
API_ROOT = "https://api.github.com"
HEX40 = re.compile(r"^[0-9a-f]{40}$")


class BridgeError(Exception):
    """A sanitized refusal; never include tokens, signed URLs or responses."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_context(env: dict, event: dict) -> None:
    """Reject the wrong repo, branch, event, attempt, visibility or commit."""
    repo = event.get("repository") if isinstance(event, dict) else None
    head = event.get("head_commit") if isinstance(event, dict) else None
    sha = env.get("GITHUB_SHA", "")
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_EVENT_NAME") != "push" or
            env.get("GITHUB_REPOSITORY") != REPOSITORY or env.get("GITHUB_REF") != BRANCH_REF or
            env.get("GITHUB_RUN_ATTEMPT") != "1" or not isinstance(sha, str) or not HEX40.fullmatch(sha) or
            not isinstance(repo, dict) or repo.get("id") != REPOSITORY_ID or
            repo.get("full_name") != REPOSITORY or repo.get("private") is not False or
            not isinstance(head, dict) or head.get("id") != sha or event.get("after") != sha or
            event.get("created") is not True or event.get("before") != "0" * 40 or
            event.get("ref") != BRANCH_REF or not isinstance(head.get("message"), str) or
            MARKER not in head["message"]):
        raise BridgeError("incorrect or unapproved Actions context")


def verify_metadata(value: dict) -> None:
    """Bind the download to the original recorded Actions artifact."""
    if (not isinstance(value, dict) or value.get("id") != ARTIFACT_ID or
            value.get("name") != ARTIFACT_NAME or value.get("expired") is not False or
            value.get("size_in_bytes") != ARCHIVE_BYTES or
            value.get("digest") != "sha256:" + ARCHIVE_SHA256 or
            not isinstance(value.get("workflow_run"), dict) or
            value["workflow_run"].get("id") != RUN_ID):
        raise BridgeError("artifact identity or recorded archive digest differs")


def validate_storage_redirect(location: str) -> str:
    """Allow only the observed GitHub artifact storage host; no credentials."""
    if not isinstance(location, str) or len(location) > 8192:
        raise BridgeError("invalid artifact redirect")
    try:
        parsed = urllib.parse.urlsplit(location)
        port = parsed.port
    except ValueError:
        raise BridgeError("invalid artifact redirect") from None
    if (parsed.scheme != "https" or parsed.hostname != STORAGE_HOST or
            parsed.username is not None or parsed.password is not None or
            port not in (None, 443) or not parsed.path or not parsed.query or parsed.fragment):
        raise BridgeError("unexpected artifact storage host")
    return location


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_verified_wasm(archive: bytes, *, archive_bytes=ARCHIVE_BYTES,
                          archive_sha256=ARCHIVE_SHA256, wasm_bytes=WASM_BYTES,
                          wasm_sha256=WASM_SHA256) -> bytes:
    """Check both bounded layers; never extract paths to the filesystem."""
    if (not isinstance(archive, bytes) or len(archive) != archive_bytes or
            sha256(archive) != archive_sha256):
        raise BridgeError("archive size or digest mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            entries = zf.infolist()
            if (len(entries) != 1 or entries[0].filename != "bouncer.wasm" or
                    entries[0].is_dir() or entries[0].file_size != wasm_bytes or
                    entries[0].compress_size > archive_bytes or entries[0].flag_bits & 1):
                raise BridgeError("unexpected artifact archive contents")
            with zf.open(entries[0], "r") as source:
                wasm = source.read(wasm_bytes + 1)
                if source.read(1):
                    raise BridgeError("WASM exceeds its bounded size")
    except (zipfile.BadZipFile, OSError, RuntimeError, EOFError, ValueError, NotImplementedError, zlib.error):
        raise BridgeError("invalid artifact archive") from None
    if (len(wasm) != wasm_bytes or sha256(wasm) != wasm_sha256 or
            not wasm.startswith(b"\x00asm\x01\x00\x00\x00")):
        raise BridgeError("WASM size, digest or header mismatch")
    return wasm


def git_blob_sha1(wasm: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(wasm)).encode("ascii") + b"\0" + wasm).hexdigest()


def read_event(path: str) -> dict:
    try:
        with open(path, "rb") as event_file:
            data = event_file.read(1024 * 1024 + 1)
        if not data or len(data) > 1024 * 1024:
            raise ValueError()
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (OSError, ValueError, UnicodeError):
        raise BridgeError("Actions event unavailable or malformed") from None


def request(url: str, *, method="GET", token=None, body=None, limit=1024 * 1024):
    """Make one bounded HTTPS request without automatically following redirects.

    Authentication may only accompany the exact GitHub API origin. Blob
    storage must be requested separately without the repository token.
    """
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None:
        raise BridgeError("invalid request target")
    if token is not None and (parsed.hostname != "api.github.com" or parsed.port not in (None, 443)):
        raise BridgeError("refusing to send a GitHub token outside the API")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "bouncer-existing-artifact-bridge"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=30) as response:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise BridgeError("bounded response exceeded")
            return response.status, response.headers, data
    except urllib.error.HTTPError as error:
        # Only status and response headers are returned; do not print either the
        # URL or an upstream error body, which could contain a signed URL.
        try:
            return error.code, error.headers, b""
        finally:
            error.close()
    except (OSError, ValueError):
        raise BridgeError("network request failed") from None


def json_object(body: bytes) -> dict:
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise BridgeError("invalid bounded GitHub response") from None


def bridge(token: str, *, requester=request, emit=print) -> str:
    """Fetch, verify and create one Git blob; the output hash is public data."""
    if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
        raise BridgeError("workflow authentication unavailable")
    base = f"{API_ROOT}/repos/{REPOSITORY}"
    status, _, body = requester(f"{base}/actions/artifacts/{ARTIFACT_ID}", token=token)
    if status != 200:
        raise BridgeError("cannot read existing artifact metadata")
    verify_metadata(json_object(body))
    status, headers, _ = requester(f"{base}/actions/artifacts/{ARTIFACT_ID}/zip", token=token)
    if status != 302:
        raise BridgeError("artifact download did not return the expected redirect")
    location = validate_storage_redirect(headers.get("Location"))
    status, _, archive = requester(location, limit=ARCHIVE_BYTES)
    if status != 200:
        raise BridgeError("artifact storage download failed")
    wasm = extract_verified_wasm(archive)
    expected_oid = git_blob_sha1(wasm)
    # The content-derived ID is safe to retain even if the POST response is
    # lost; reading that ID later is safer than blindly repeating an operation.
    emit(f"::notice title=Expected V11 Git blob ID::V11_BLOB_ID_EXPECTED={expected_oid}", flush=True)
    payload = json.dumps({"content": base64.b64encode(wasm).decode("ascii"), "encoding": "base64"},
                         separators=(",", ":")).encode("ascii")
    status, _, body = requester(f"{base}/git/blobs", method="POST", token=token, body=payload)
    if status != 201 or json_object(body).get("sha") != expected_oid:
        raise BridgeError("blob creation was not confirmed; check the expected ID before retrying")
    emit(f"::notice title=Existing V11 Git blob ready::V11_BLOB_ID={expected_oid}", flush=True)
    return expected_oid


def main() -> int:
    try:
        verify_context(os.environ, read_event(os.environ.get("GITHUB_EVENT_PATH", "")))
        bridge(os.environ.get("GH_TOKEN"))
        return 0
    except Exception:
        # Catch unexpected transport/library failures too. Exception messages
        # and tracebacks can contain a signed URL or authentication material,
        # neither of which belongs in the now-public Actions log.
        print("::error title=V11 artifact bridge stopped::No confirmed blob; inspect the expected ID if printed. No branch or NEAR transaction was changed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
