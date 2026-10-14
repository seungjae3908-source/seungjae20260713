#!/usr/bin/env python3
"""Strict offline extraction of authenticated Telegram dormant GitHub artifact ZIP.
No network, no overwrite, no process launch. The caller verifies the ZIP digest.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile

FILES = (
    "api-server/dist/telegram-isolated-worker.mjs",
    "ops/telegram-legacy-owner-runtime-proof.mjs",
    "ops/run-telegram-isolated-worker.sh",
)
META = (
    ".deploy/telegram-sha256.manifest",
    ".deploy/preparation.json",
    ".deploy/current-sha",
)
EXPECTED = set(FILES + META)
DIRECTORIES = {"api-server/", "api-server/dist/", "ops/", ".deploy/"}
MAX_FILE = dict(zip(FILES + META, (64*1024*1024, 128*1024, 128*1024, 8192, 8192, 128)))


def fail(code):
    raise ValueError(code)


def extract(archive: str, dest: str, sha: str):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        fail("TELEGRAM_ARCHIVE_SHA_INVALID")
    target = pathlib.Path(dest)
    if not target.is_absolute() or target.exists() or target.is_symlink():
        fail("TELEGRAM_ARCHIVE_DESTINATION_UNSAFE")
    if not target.parent.is_dir() or target.parent.is_symlink():
        fail("TELEGRAM_ARCHIVE_PARENT_UNSAFE")
    payload = {}
    with zipfile.ZipFile(archive, "r") as zf:
        infos = zf.infolist()
        names = [v.filename for v in infos]
        if len(infos) > 12 or len(set(names)) != len(names):
            fail("TELEGRAM_ARCHIVE_DUPLICATE_OR_EXCESS")
        if set(names) - DIRECTORIES != EXPECTED:
            fail("TELEGRAM_ARCHIVE_PATHS_INVALID")
        for item in infos:
            if item.filename in DIRECTORIES:
                if not item.is_dir():
                    fail("TELEGRAM_ARCHIVE_DIRECTORY_INVALID")
                continue
            if item.filename not in EXPECTED or item.is_dir():
                fail("TELEGRAM_ARCHIVE_PATHS_INVALID")
            mode = (item.external_attr >> 16) & 0xffff
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                fail("TELEGRAM_ARCHIVE_SPECIAL_FILE")
            if item.flag_bits & 0x1 or item.file_size < 1 or item.file_size > MAX_FILE[item.filename]:
                fail("TELEGRAM_ARCHIVE_SIZE_OR_ENCRYPTION")
            with zf.open(item, "r") as entry:
                data = entry.read(MAX_FILE[item.filename] + 1)
            if len(data) != item.file_size:
                fail("TELEGRAM_ARCHIVE_TRUNCATED")
            payload[item.filename] = data
    manifest = payload[META[0]].decode("utf-8")
    expected_manifest = "".join(hashlib.sha256(payload[name]).hexdigest()
                                + "  " + name + "\n" for name in FILES)
    if manifest != expected_manifest:
        fail("TELEGRAM_ARCHIVE_MANIFEST_MISMATCH")
    if payload[META[2]] != (sha + "\n").encode("ascii"):
        fail("TELEGRAM_ARCHIVE_MARKER_MISMATCH")
    try:
        receipt = json.loads(payload[META[1]])
    except (ValueError, UnicodeDecodeError):
        fail("TELEGRAM_ARCHIVE_RECEIPT_INVALID")
    if (not isinstance(receipt, dict)
        or receipt.get("schemaVersion") != "telegram-isolated-dormant-package-v1"
        or receipt.get("sha") != sha or receipt.get("mode") != "PREPARE_ONLY"
        or receipt.get("workerStarted") is not False
        or receipt.get("productionAppChanged") is not False
        or receipt.get("pm2Restarts") != 0 or receipt.get("telegramMessages") != 0
        or receipt.get("financialMutations") != 0
        or receipt.get("paths") != list(FILES)):
        fail("TELEGRAM_ARCHIVE_RECEIPT_INVALID")
    # Materialize only after every content and path guard has passed.
    target.mkdir(mode=0o700)
    try:
        for name in FILES + META:
            f = target / name
            f.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            mode = 0o700 if name.endswith(".sh") else 0o600
            fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            try:
                with os.fdopen(fd, "wb") as fp:
                    fp.write(payload[name])
                    fp.flush()
                    os.fsync(fp.fileno())
            except Exception:
                raise
        # The recipient does its own independent manifest and source SHA check.
        return {"status": "EXTRACTED_INACTIVE", "sha": sha, "files": len(payload)}
    except Exception:
        try:
            (target / ".deploy/current-sha").unlink(missing_ok=True)
        except OSError:
            pass
        fail("TELEGRAM_ARCHIVE_EXTRACTION_INCOMPLETE")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            fail("TELEGRAM_ARCHIVE_USAGE")
        print(json.dumps(extract(sys.argv[1], sys.argv[2], sys.argv[3])))
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        code = str(error)
        if not code.startswith("TELEGRAM_ARCHIVE_"):
            code = "TELEGRAM_ARCHIVE_INVALID"
        print(code, file=sys.stderr)
        sys.exit(17)
