"""Offline archive-extraction safety tests; no nearcore process runs here."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "extract-pinned-near-sandbox.py"
spec = importlib.util.spec_from_file_location("extract_sandbox", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtractSandboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "test.tar.gz"
        self.output = self.root / "near-sandbox"
        self.bytes = b"not executable; synthetic test data"
        self.digest = hashlib.sha256(self.bytes).hexdigest()

    def archive_members(self, *members):
        with tarfile.open(self.archive, "w:gz") as tar:
            for name, kind in members:
                info = tarfile.TarInfo(name)
                if kind == "regular":
                    info.size = len(self.bytes)
                    tar.addfile(info, io.BytesIO(self.bytes))
                else:
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../../untrusted"
                    tar.addfile(info)

    def test_extracts_only_the_pinned_member_without_extracting_other_paths(self):
        self.archive_members(("release/near-sandbox", "regular"), ("../../outside", "regular"))
        module.extract_verified(self.archive, self.output, self.digest)
        self.assertEqual(self.output.read_bytes(), self.bytes)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.root.parent / "outside").exists())

    def test_bad_hash_does_not_replace_an_existing_output_or_leave_temps(self):
        self.archive_members(("release/near-sandbox", "regular"))
        self.output.write_bytes(b"previous")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            module.extract_verified(self.archive, self.output, "0" * 64)
        self.assertEqual(self.output.read_bytes(), b"previous")
        self.assertEqual(list(self.root.glob(".sandbox-*")), [])

    def test_duplicate_symlink_and_traversal_candidates_fail_closed(self):
        for members in [
            (("one/near-sandbox", "regular"), ("two/near-sandbox", "regular")),
            (("release/near-sandbox", "symlink"),),
            (("../../near-sandbox", "regular"),),
            (("/absolute/near-sandbox", "regular"),),
            (("release/not-the-binary", "regular"),),
        ]:
            with self.subTest(members=members):
                self.archive_members(*members)
                with self.assertRaises(ValueError):
                    module.extract_verified(self.archive, self.output, self.digest)
                self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
