#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import gzip
import json
import zlib
from itertools import combinations
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
    except (
        UnicodeEncodeError,
        UnicodeDecodeError,
        binascii.Error,
        gzip.BadGzipFile,
        zlib.error,
        EOFError,
        json.JSONDecodeError,
    ):
        return None
    if not isinstance(payload, dict) or set(payload) != EXPECTED_PATHS:
        return None
    if not all(isinstance(path, str) and isinstance(content, str) for path, content in payload.items()):
        return None
    return payload


def remove_positions(value: str, positions: tuple[int, ...]) -> str:
    blocked = set(positions)
    return "".join(char for index, char in enumerate(value) if index not in blocked)


def boundary_groups(parts: list[str], radius: int) -> list[tuple[int, ...]]:
    groups: list[tuple[int, ...]] = []
    offset = 0
    total = sum(len(part) for part in parts)
    for part in parts[:-1]:
        offset += len(part)
        start = max(0, offset - radius)
        end = min(total, offset + radius + 1)
        groups.append(tuple(range(start, end)))
    return groups


def recover_payload(parts: list[str]) -> tuple[dict[str, str], str]:
    encoded = "".join(parts)
    direct = decode_payload(encoded)
    if direct is not None:
        return direct, "direct"

    excess = len(encoded) % 4
    if excess not in {1, 2}:
        raise RuntimeError(
            f"Prompt Compiler payload length is not boundary-recoverable: {len(encoded)}"
        )

    # Manual transport can duplicate one character at one or two chunk joins.
    # Search compact boundary neighborhoods only. A candidate is accepted only
    # when gzip, UTF-8, strict JSON, and the exact expected file set all verify.
    for radius in (2, 4, 8, 16, 32):
        groups = boundary_groups(parts, radius)
        if excess == 1:
            for group_index, group in enumerate(groups):
                for position in group:
                    payload = decode_payload(remove_positions(encoded, (position,)))
                    if payload is not None:
                        return payload, f"removed_duplicate_boundary_{group_index}_at_{position}"
            continue

        for first_group, second_group in combinations(range(len(groups)), 2):
            for first_position in groups[first_group]:
                for second_position in groups[second_group]:
                    positions = tuple(sorted((first_position, second_position)))
                    payload = decode_payload(remove_positions(encoded, positions))
                    if payload is not None:
                        return payload, (
                            "removed_duplicates_"
                            f"boundary_{first_group}_at_{positions[0]}_"
                            f"boundary_{second_group}_at_{positions[1]}"
                        )
    raise RuntimeError(
        "Prompt Compiler payload could not be recovered from validated chunk-boundary candidates"
    )


def main() -> int:
    if not CHUNKS:
        raise RuntimeError("Prompt Compiler payload chunks are missing")
    parts = [path.read_text(encoding="utf-8").strip() for path in CHUNKS]
    if any(not part for part in parts):
        raise RuntimeError("Prompt Compiler payload contains an empty chunk")
    print(json.dumps({"chunk_lengths": [len(part) for part in parts], "total": sum(map(len, parts))}))
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
