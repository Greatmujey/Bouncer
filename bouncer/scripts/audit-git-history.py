#!/usr/bin/env python3
"""Limited, read-only Git-history credential triage; never a publication approval.

Scans locally available objects reachable from local refs, optionally adding all
heads/tags listed by a remote. Only a short list of high-confidence patterns is
checked. The summary never includes content or paths. An optional mode-0600
report, outside the repository, contains candidate paths and counts, not values.
No network verification, artifact inspection, secret deletion or Git writes.
"""
import argparse
import collections
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MAX_BLOB = 3_000_000
MAX_TOTAL = 128_000_000
PATTERNS = {
    "private_key_pem": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----",
    "near_ed25519_secret": rb"ed25519:[1-9A-HJ-NP-Za-km-z]{80,94}(?![1-9A-HJ-NP-Za-km-z])",
    "github_token": rb"\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b",
    "aws_access_key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "slack_token": rb"\bxox[baprs]-[A-Za-z0-9-]{20,255}\b",
    "openai_key": rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}\b",
    "svalin_pro_code": rb"\bsvp_[1-9A-HJ-NP-Za-km-z]{32,44}\b",
    "named_secret_literal": rb"""(?i)[\"']?(?:private[_-]?key|secret[_-]?key|api[_-]?key|access[_-]?token|password)[\"']?\s*[:=]\s*[\"']((?:ed25519:)?[A-Za-z0-9_+\-/=.]{24,})[\"']""",
}
COMPILED = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}
HEX = re.compile(rb"^[0-9a-f]{40}$")


class AuditError(Exception):
    pass


def git(*args, input_bytes=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        result = subprocess.run(["git", *args], input=input_bytes, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False, timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AuditError("Git is unavailable or the read timed out") from exc
    if result.returncode:
        # Do not print stderr: a remote URL or path might contain credentials.
        raise AuditError("Git read failed; check authentication, refs and local objects")
    return result.stdout


def collect(remote):
    root = Path(os.fsdecode(git("rev-parse", "--show-toplevel").strip())).resolve()
    if git("rev-parse", "--is-shallow-repository").strip() != b"false":
        raise AuditError("shallow checkout: obtain full history before scanning")
    refs = set(git("for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags").splitlines())
    refs.add(git("rev-parse", "HEAD").strip())
    if remote:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", remote):
            raise AuditError("remote must be a configured remote name, not a URL or option")
        for line in git("ls-remote", "--heads", "--tags", remote).splitlines():
            oid, _, _ = line.partition(b"\t")
            refs.add(oid)
    if not refs or any(not HEX.fullmatch(oid) for oid in refs):
        raise AuditError("unrecognized Git object ID; only SHA-1 repositories are supported")

    objects = {}
    for line in git("rev-list", "--objects", *(os.fsdecode(ref) for ref in sorted(refs))).splitlines():
        oid, _, path = line.partition(b" ")
        if not HEX.fullmatch(oid):
            raise AuditError("unexpected Git object listing")
        # Same content under multiple names is scanned once; enumerate paths
        # separately with a full manual review if paths themselves are sensitive.
        objects.setdefault(oid, os.fsdecode(path))
    check = git("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                input_bytes=b"\n".join(objects) + b"\n")
    selected = []
    oversize = 0
    total = 0
    for line in check.splitlines():
        parts = line.split()
        if len(parts) != 3:
            raise AuditError("a remote ref/object is missing locally; fetch it before scanning")
        oid, kind, raw_size = parts
        try:
            size = int(raw_size)
        except ValueError as exc:
            raise AuditError("invalid Git object size") from exc
        if kind != b"blob":
            continue
        if size > MAX_BLOB:
            oversize += 1
            continue
        total += size
        if total > MAX_TOTAL:
            raise AuditError("bounded scan exceeds 128 MB; use another reviewed scanner")
        selected.append((oid, size))
    return root, refs, objects, selected, oversize


def scan(objects, selected):
    data = git("cat-file", "--batch", input_bytes=b"\n".join(oid for oid, _ in selected) + b"\n") if selected else b""
    position = 0
    binary = 0
    counts = collections.Counter()
    paths = collections.defaultdict(collections.Counter)
    for expected_oid, expected_size in selected:
        end = data.find(b"\n", position)
        if end < 0:
            raise AuditError("truncated Git object stream")
        header = data[position:end].split()
        position = end + 1
        if header != [expected_oid, b"blob", str(expected_size).encode()]:
            raise AuditError("unexpected Git object stream")
        blob = data[position:position + expected_size]
        position += expected_size
        if len(blob) != expected_size or data[position:position + 1] != b"\n":
            raise AuditError("truncated Git blob")
        position += 1
        if b"\0" in blob[:8192]:
            binary += 1
            continue
        for name, pattern in COMPILED.items():
            n = sum(1 for _ in pattern.finditer(blob))
            if n:
                counts[name] += n
                paths[objects[expected_oid]][name] += n
    if position != len(data):
        raise AuditError("unexpected extra Git object data")
    return binary, counts, paths


def save_report(path, root, paths):
    target = Path(path).expanduser().resolve()
    if target == root or root in target.parents:
        raise AuditError("the local report must be outside the repository")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as f:
            json.dump({"warning": "Sensitive path-only triage; not a clearance", "candidates":
                       [{"path": name, "patterns": dict(patterns)} for name, patterns in sorted(paths.items())]}, f, indent=2)
            f.write("\n")
    except OSError as exc:
        raise AuditError("cannot create private report; choose a new path in an existing private directory") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", metavar="NAME", help="also list all remote heads and tags (read-only network request)")
    parser.add_argument("--report", metavar="PATH", help="create a new mode-0600 path-only report outside the repository")
    args = parser.parse_args()
    try:
        root, refs, objects, selected, oversize = collect(args.remote)
        binary, counts, paths = scan(objects, selected)
        if args.report:
            save_report(args.report, root, paths)
        summary = {
            "status": "PATTERN_MATCHES_REVIEW_REQUIRED" if counts else "NO_PATTERN_MATCHES_MANUAL_REVIEW_REQUIRED",
            "ref_object_ids": len(refs), "remote_refs_requested": bool(args.remote),
            "scanned_text_blobs": len(selected) - binary, "binary_blobs_skipped": binary,
            "oversize_blobs_skipped": oversize, "matches_by_pattern": dict(sorted(counts.items())),
            "candidate_paths": len(paths), "private_report_written": bool(args.report),
            "not_scanned": ["working tree changes", "binary and large blobs", "Git LFS contents",
                            "other inaccessible refs", "Actions artifacts and logs", "issues, PRs, releases, personal data and rights"],
        }
        print(json.dumps(summary, indent=2))
        return 1 if counts else 0
    except AuditError as exc:
        print(f"History scan incomplete: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
