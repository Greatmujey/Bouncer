"""Offline tests only; these never access GitHub, NEAR or a seller."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "v11-existing-artifact-bridge.py"
spec = importlib.util.spec_from_file_location("v11_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def example_wasm():
    # A transport fixture only: not the real contract or a functional module.
    return b"\0asm\x01\0\0\0" + bytes(range(256)) * 2


def make_zip(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files:
            zf.writestr(name, data)
    return out.getvalue()


def unpack_fixture(raw, wasm=None):
    wasm = example_wasm() if wasm is None else wasm
    return bridge.extract_verified_wasm(raw, archive_bytes=len(raw), archive_sha256=bridge.sha256(raw),
                                        wasm_bytes=len(wasm), wasm_sha256=bridge.sha256(wasm))


def metadata():
    return {"id": bridge.ARTIFACT_ID, "name": bridge.ARTIFACT_NAME, "expired": False,
            "size_in_bytes": bridge.ARCHIVE_BYTES, "digest": "sha256:" + bridge.ARCHIVE_SHA256,
            "workflow_run": {"id": bridge.RUN_ID}}


def context():
    sha = "a" * 40
    env = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": bridge.REPOSITORY,
           "GITHUB_REF": bridge.BRANCH_REF, "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": sha}
    event = {"repository": {"id": bridge.REPOSITORY_ID, "full_name": bridge.REPOSITORY, "private": False},
             "head_commit": {"id": sha, "message": "Bridge reviewed build " + bridge.MARKER},
             "before": "0" * 40, "created": True, "after": sha, "ref": bridge.BRANCH_REF}
    return env, event


class ContextTests(unittest.TestCase):
    def test_only_exact_push_context_is_allowed(self):
        env, event = context()
        bridge.verify_context(env, event)
        for key, value in [("GITHUB_ACTIONS", "false"), ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_REF", "refs/heads/main"),
                           ("GITHUB_RUN_ATTEMPT", "2"), ("GITHUB_SHA", "bad")]:
            altered = dict(env, **{key: value})
            with self.subTest(key=key), self.assertRaises(bridge.BridgeError):
                bridge.verify_context(altered, event)
        for edit in [lambda x: x["repository"].update(private=True),
                     lambda x: x["repository"].update(id=1),
                     lambda x: x["repository"].update(full_name="fork/Bouncer"),
                     lambda x: x["head_commit"].update(message="ordinary commit"),
                     lambda x: x["head_commit"].update(id="b" * 40),
                     lambda x: x.update(after="b" * 40),
                     lambda x: x.update(before="b" * 40),
                     lambda x: x.update(created=False),
                     lambda x: x.update(ref="refs/heads/main")]:
            _, altered = context()
            edit(altered)
            with self.assertRaises(bridge.BridgeError):
                bridge.verify_context(env, altered)

    def test_artifact_metadata_is_bound_to_id_name_run_and_archive_hash(self):
        bridge.verify_metadata(metadata())
        for key, value in [("id", 7), ("name", "other"), ("expired", True),
                           ("size_in_bytes", 1), ("digest", "sha256:" + "0" * 64),
                           ("workflow_run", {"id": 1})]:
            altered = dict(metadata(), **{key: value})
            with self.subTest(key=key), self.assertRaises(bridge.BridgeError):
                bridge.verify_metadata(altered)


class ArchiveTests(unittest.TestCase):
    def test_valid_single_file_is_read_without_extracting_a_path(self):
        wasm = example_wasm()
        self.assertEqual(unpack_fixture(make_zip([("bouncer.wasm", wasm)])), wasm)

    def test_bad_archives_and_changed_bytes_fail_closed(self):
        wasm = example_wasm()
        good = make_zip([("bouncer.wasm", wasm)])
        with self.assertRaises(bridge.BridgeError):
            bridge.extract_verified_wasm(good, archive_bytes=len(good), archive_sha256="0" * 64,
                                         wasm_bytes=len(wasm), wasm_sha256=bridge.sha256(wasm))
        with self.assertRaises(bridge.BridgeError):
            bridge.extract_verified_wasm(good, archive_bytes=len(good) + 1, archive_sha256=bridge.sha256(good),
                                         wasm_bytes=len(wasm), wasm_sha256=bridge.sha256(wasm))
        with self.assertRaises(bridge.BridgeError):
            bridge.extract_verified_wasm(good, archive_bytes=len(good), archive_sha256=bridge.sha256(good),
                                         wasm_bytes=len(wasm), wasm_sha256="0" * 64)
        for raw in [make_zip([("../bouncer.wasm", wasm)]), make_zip([("bouncer.wasm", wasm), ("extra", b"x")]),
                    make_zip([("bouncer.wasm", b"not wasm")]), b"not a zip"]:
            with self.assertRaises(bridge.BridgeError):
                unpack_fixture(raw)

    def test_git_blob_id_uses_git_object_header_not_only_file_sha1(self):
        wasm = example_wasm()
        expected = hashlib.sha1(b"blob " + str(len(wasm)).encode() + b"\0" + wasm).hexdigest()
        self.assertEqual(bridge.git_blob_sha1(wasm), expected)
        self.assertNotEqual(expected, hashlib.sha1(wasm).hexdigest())


class TransportTests(unittest.TestCase):
    def test_token_cannot_be_sent_to_a_non_github_target(self):
        for url in ["https://example.com/", "https://api.github.com.evil.example/x",
                    "http://api.github.com/x", "https://someone@api.github.com/x", "https://api.github.com:444/x"]:
            with self.subTest(url=url), self.assertRaises(bridge.BridgeError):
                bridge.request(url, token="not-a-real-secret")

    def test_only_exact_signed_storage_redirect_is_allowed(self):
        valid = "https://" + bridge.STORAGE_HOST + "/artifact.zip?signature=synthetic"
        self.assertEqual(bridge.validate_storage_redirect(valid), valid)
        for url in ["http://" + bridge.STORAGE_HOST + "/file?sig=x", "https://elsewhere.example/file?sig=x",
                    "https://" + bridge.STORAGE_HOST + ".evil.example/file?sig=x",
                    "https://name@" + bridge.STORAGE_HOST + "/file?sig=x",
                    "https://" + bridge.STORAGE_HOST + ":444/file?sig=x",
                    "https://" + bridge.STORAGE_HOST + "/file", valid + "#fragment"]:
            with self.subTest(url=url), self.assertRaises(bridge.BridgeError):
                bridge.validate_storage_redirect(url)

    def run_mock_bridge(self, *, altered_meta=None, redirect=None, post_status=201, post_sha=None, bad_archive=False):
        wasm = example_wasm()
        good_archive = make_zip([("bouncer.wasm", wasm)])
        archive = b"tampered" if bad_archive else good_archive
        location = redirect or ("https://" + bridge.STORAGE_HOST + "/file?signature=synthetic")
        calls, output = [], []
        oid = bridge.git_blob_sha1(wasm)

        def requester(url, *, method="GET", token=None, body=None, limit=1024 * 1024):
            calls.append({"url": url, "method": method, "token": token, "body": body, "limit": limit})
            if url.endswith("/actions/artifacts/" + str(bridge.ARTIFACT_ID)):
                return 200, {}, json.dumps(altered_meta or metadata()).encode()
            if url.endswith("/actions/artifacts/" + str(bridge.ARTIFACT_ID) + "/zip"):
                return 302, {"Location": location}, b""
            if url == location:
                return 200, {}, archive
            if url.endswith("/git/blobs"):
                return post_status, {}, json.dumps({"sha": post_sha or oid}).encode()
            raise AssertionError("unexpected request")

        original = bridge.extract_verified_wasm
        def test_extractor(data):
            return original(data, archive_bytes=len(good_archive), archive_sha256=bridge.sha256(good_archive),
                            wasm_bytes=len(wasm), wasm_sha256=bridge.sha256(wasm))
        def emit(text, **kwargs):
            output.append(text)

        with patch.object(bridge, "extract_verified_wasm", test_extractor):
            try:
                result = bridge.bridge("fake-test-token", requester=requester, emit=emit)
                return result, calls, output, None
            except bridge.BridgeError as error:
                return None, calls, output, error

    def test_success_never_forwards_github_token_to_storage_and_post_is_one_blob(self):
        result, calls, output, error = self.run_mock_bridge()
        self.assertIsNone(error)
        self.assertEqual(len(calls), 4)
        self.assertEqual([call["method"] for call in calls], ["GET", "GET", "GET", "POST"])
        self.assertEqual([call["token"] for call in calls], ["fake-test-token", "fake-test-token", None, "fake-test-token"])
        self.assertEqual(calls[2]["limit"], bridge.ARCHIVE_BYTES)
        body = json.loads(calls[3]["body"])
        self.assertEqual(body["encoding"], "base64")
        self.assertEqual(base64.b64decode(body["content"]), example_wasm())
        self.assertEqual(result, bridge.git_blob_sha1(example_wasm()))
        self.assertIn("V11_BLOB_ID_EXPECTED=" + result, output[0])
        self.assertIn("V11_BLOB_ID=" + result, output[1])
        self.assertNotIn("fake-test-token", str(output))
        self.assertNotIn("signature=synthetic", str(output))

    def test_bad_metadata_redirect_and_archive_never_create_a_blob(self):
        cases = [{"altered_meta": dict(metadata(), expired=True)}, {"redirect": "https://evil.example/file?x=1"},
                 {"bad_archive": True}]
        for case in cases:
            with self.subTest(case=case):
                _, calls, output, error = self.run_mock_bridge(**case)
                self.assertIsNotNone(error)
                self.assertFalse(any(call["method"] == "POST" for call in calls))
                self.assertEqual(output, [])

    def test_unknown_or_wrong_post_result_leaves_expected_id_for_recovery(self):
        for case in [{"post_status": 503}, {"post_sha": "b" * 40}]:
            with self.subTest(case=case):
                _, calls, output, error = self.run_mock_bridge(**case)
                self.assertIsNotNone(error)
                self.assertEqual(sum(call["method"] == "POST" for call in calls), 1)
                self.assertEqual(len(output), 1)
                self.assertIn("V11_BLOB_ID_EXPECTED=", output[0])
                self.assertNotIn("V11_BLOB_ID=", output[0])

    def test_unexpected_exceptions_never_leak_credentials_or_signed_urls(self):
        env, event = context()
        output = io.StringIO()
        secret = "synthetic-token-and-signed-url"
        with patch.dict(bridge.os.environ, env, clear=True), \
                patch.object(bridge, "read_event", return_value=event), \
                patch.object(bridge, "bridge", side_effect=RuntimeError(secret)), \
                contextlib.redirect_stdout(output):
            self.assertEqual(bridge.main(), 1)
        self.assertIn("No confirmed blob", output.getvalue())
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())


if __name__ == "__main__":
    unittest.main()
