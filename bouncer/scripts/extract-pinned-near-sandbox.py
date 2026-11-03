#!/usr/bin/env python3
"""Extract ONLY a hash-pinned nearcore sandbox binary, never archive paths.

The upstream release is fetched separately. The expected binary digest is a
third-party-reported pin, not a signed NEAR release or a reproducible build.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tempfile

EXPECTED = "797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13"
MAX_BYTES = 400 * 1024 * 1024


def extract_verified(archive: Path, output: Path, expected: str = EXPECTED) -> None:
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise ValueError("invalid expected SHA-256")
    if not archive.is_file() or archive.stat().st_size > MAX_BYTES:
        raise ValueError("invalid or oversized sandbox archive")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tarfile.open(archive, "r:gz") as tar:
            candidates = []
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if parts and parts[-1] == "near-sandbox":
                    if not member.isfile() or member.size <= 0 or member.size > MAX_BYTES or \
                            PurePosixPath(member.name).is_absolute() or ".." in parts:
                        raise ValueError("unsafe sandbox binary member")
                    candidates.append(member)
            if len(candidates) != 1:
                raise ValueError("archive must contain exactly one sandbox binary")
            source = tar.extractfile(candidates[0])
            if source is None:
                raise ValueError("sandbox binary member is unreadable")
            digest = hashlib.sha256()
            with source, tempfile.NamedTemporaryFile(dir=output.parent, prefix=".sandbox-", delete=False) as temp:
                temp_path = Path(temp.name)
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    temp.write(chunk)
                temp.flush()
                os.fsync(temp.fileno())
            if digest.hexdigest() != expected:
                raise ValueError("sandbox binary SHA-256 mismatch")
            os.chmod(temp_path, 0o700)
            os.replace(temp_path, output)
            temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-pinned-near-sandbox.py RELEASE.tar.gz OUTPUT")
    extract_verified(Path(sys.argv[1]), Path(sys.argv[2]))
    print("nearcore sandbox executable verified against the documented SHA-256 pin")


if __name__ == "__main__":
    main()
