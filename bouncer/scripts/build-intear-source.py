#!/usr/bin/env python3
"""Create a deterministic corresponding-source archive for the Intear adapter."""
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent.parent
source = root / "web-src/vendor/intear"
files = [
    "README.txt", "LICENSE", "web/src/js/near-selector.js",
    "intearwallet-connect/src/index.ts", "web/public/hot-wallet-connector-iframe.html",
]
# Store, rather than deflate, so bytes are independent of the local zlib version.
with ZipFile(root / "web/intear-wallet-source.zip", "w", compression=ZIP_STORED) as archive:
    for name in files:
        entry = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.compress_type = ZIP_STORED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, (source / name).read_bytes())
