#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import gzip
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHUNKS = tuple(sorted((ROOT / "scripts").glob(".prompt-compiler-payload-*")))
EXPECTED_PATHS = {
    "scripts/agent_hub_prompt_types.py",
    "scripts/agent_hub_prompt_report.py",
    "scripts/agent_hub_prompt_compiler.py",
    "scripts/agent_hub_prompt_policy.py",
    "scripts/agent_hub_free.py",
    "scripts/test_agent_hub_prompt_compiler.py",
    ".github/workflows/agent-hub-free.yml",
    "docs/agent-hub-free.md",
    "PROMPT_COMPILER_VALIDATION_REPORT.md",
}


def decode_payload(encoded: str) -> dict[str, str] | None:
    try:
        compressed = base64.b64decode(encoded.encode("ascii"), validate=True)
        decoded = gzip.decompress(compressed)
        payload: Any = json.loads(decoded.decode("utf-8"))
    except (UnicodeEncodeError, UnicodeDecodeError, binascii.Error, gzip.BadGzipFile, EOFError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or set(payload) != EXPECTED_PATHS:
        return None
    if not all(isinstance(path, str) and isinstance(content, str) for path, content in payload.items()):
        return None
    return payload


def recover_payload(parts: list[str]) -> tuple[dict[str, str], str]:
    encoded = "".join(parts)
    direct = decode_payload(encoded)
    if direct is not None:
        return direct, "direct"

    # The publication transport introduced exactly one duplicated base64 character
    # at a manually split chunk boundary. Search only boundary neighborhoods and
    # require a valid gzip stream, strict JSON, and the exact expected file set.
    if len(encoded) % 4 != 1:
        raise RuntimeError(
            f"Prompt Compiler payload length is invalid and not single-character recoverable: {len(encoded)}"
        )
    boundaries: list[int] = []
    offset = 0
    for part in parts[:-1]:
        offset += len(part)
        boundaries.append(offset)
    candidate_positions: set[int] = set()
    for boundary in boundaries:
        start = max(0, boundary - 256)
        end = min(len(encoded), boundary + 256)
        candidate_positions.update(range(start, end))
    candidate_positions.update(range(0, min(64, len(encoded))))
    candidate_positions.update(range(max(0, len(encoded) - 64), len(encoded)))

    for position in sorted(candidate_positions):
        candidate = encoded[:position] + encoded[position + 1 :]
        payload = decode_payload(candidate)
        if payload is not None:
            return payload, f"removed_duplicate_at_{position}"
    raise RuntimeError(
        "Prompt Compiler payload could not be recovered from validated chunk-boundary candidates"
    )


def main() -> int:
    if not CHUNKS:
        raise RuntimeError("Prompt Compiler payload chunks are missing")
    parts = [path.read_text(encoding="utf-8").strip() for path in CHUNKS]
    if any(not part for part in parts):
        raise RuntimeError("Prompt Compiler payload contains an empty chunk")
    files, recovery = recover_payload(parts)
    for relative, content in files.items():
        target = (ROOT / relative).resolve()
        if ROOT.resolve() not in target.parents:
            raise RuntimeError(f"Refusing path outside repository: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    print(
        json.dumps(
            {"status": "applied", "recovery": recovery, "files": sorted(files)},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
