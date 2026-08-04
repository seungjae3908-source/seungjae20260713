#!/usr/bin/env python3
"""One-time installer for the Agent Hub v4 coordinator bundle."""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_DIR = ROOT / "scripts" / ".agent-hub-v4-bundle"
INSTALLER = Path(__file__).resolve()
WORKFLOW_PATHS = {
    ".github/workflows/agent-hub-free.yml",
    ".github/workflows/agent-hub-executor.yml",
}
EXPECTED_PATHS = {
    ".github/agent-hub/policy.json",
    ".github/agent-hub/workers.json",
    *WORKFLOW_PATHS,
    "scripts/agent_hub_policy.py",
    "scripts/agent_hub_free.py",
    "scripts/agent_hub_executor.py",
    "scripts/agent_hub_executor_report.py",
    "docs/agent-hub-free.md",
    "docs/agent-hub-executor.md",
}


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def normalize_text(content: str) -> str:
    normalized = "\n".join(line.rstrip() for line in content.splitlines())
    return normalized + ("\n" if content.endswith("\n") else "")


chunks = sorted(BUNDLE_DIR.glob("chunk-*.txt"))
if len(chunks) != 7:
    raise SystemExit(f"expected 7 bundle chunks, found {len(chunks)}")

encoded = "".join(path.read_text(encoding="utf-8").strip() for path in chunks)
try:
    payload = json.loads(zlib.decompress(base64.b64decode(encoded)).decode("utf-8"))
except Exception as exc:
    raise SystemExit(f"bundle decoding failed: {exc}") from exc

if set(payload) != EXPECTED_PATHS:
    missing = sorted(EXPECTED_PATHS - set(payload))
    extra = sorted(set(payload) - EXPECTED_PATHS)
    raise SystemExit(f"bundle path mismatch; missing={missing}; extra={extra}")

for relative, content in payload.items():
    if relative in WORKFLOW_PATHS:
        continue
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(normalize_text(content), encoding="utf-8")

json.loads((ROOT / ".github/agent-hub/policy.json").read_text(encoding="utf-8"))
json.loads((ROOT / ".github/agent-hub/workers.json").read_text(encoding="utf-8"))
run(
    sys.executable,
    "-m",
    "py_compile",
    "scripts/agent_hub_policy.py",
    "scripts/agent_hub_free.py",
    "scripts/agent_hub_executor.py",
    "scripts/agent_hub_executor_report.py",
)
run(sys.executable, "scripts/agent_hub_policy.py", "--self-test")
run(sys.executable, "scripts/agent_hub_free.py", "--self-test")
run(sys.executable, "scripts/agent_hub_executor.py", "--self-test")
run(sys.executable, "scripts/agent_hub_executor_report.py", "--self-test")

for path in chunks:
    path.unlink()
if BUNDLE_DIR.exists():
    BUNDLE_DIR.rmdir()
INSTALLER.unlink()

for cache in ROOT.rglob("__pycache__"):
    shutil.rmtree(cache, ignore_errors=True)

print("Agent Hub v4 non-workflow bundle installed and validated.")
