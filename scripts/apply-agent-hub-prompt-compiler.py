#!/usr/bin/env python3
from __future__ import annotations
import base64
import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHUNKS = tuple(sorted((ROOT / "scripts").glob(".prompt-compiler-payload-*")))


def main() -> int:
    if not CHUNKS:
        raise RuntimeError("Prompt Compiler payload chunks are missing")
    encoded = "".join(path.read_text(encoding="utf-8").strip() for path in CHUNKS)
    decoded = gzip.decompress(base64.b64decode(encoded.encode("ascii")))
    files = json.loads(decoded.decode("utf-8"))
    if not isinstance(files, dict) or not files:
        raise RuntimeError("Prompt Compiler payload is empty")
    for relative, content in files.items():
        if not isinstance(relative, str) or not isinstance(content, str):
            raise RuntimeError("Prompt Compiler payload has invalid entries")
        target = (ROOT / relative).resolve()
        if ROOT.resolve() not in target.parents:
            raise RuntimeError(f"Refusing path outside repository: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    print(json.dumps({"status": "applied", "files": sorted(files)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
