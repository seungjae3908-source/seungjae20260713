#!/usr/bin/env python3
"""One-time, PR-only installer for the reviewed Agent Hub v2 integration bundle."""
from __future__ import annotations

import base64
import io
import os
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PARTS = tuple(sorted((ROOT / "scripts").glob(".agent-hub-v2-integration.part*")))
SELF = ROOT / "scripts/apply_agent_hub_v2_integration.py"
WORKFLOWS = (
    ROOT / ".github/workflows/agent-hub-free.yml",
    ROOT / ".github/workflows/agent-hub-executor.yml",
)
ALLOWED = {
    ".github/agent-hub/workers.json",
    ".github/workflows/agent-hub-free.yml",
    ".github/workflows/agent-hub-executor.yml",
    "scripts/agent_hub_contract_v2.py",
    "scripts/agent_hub_prompt_compiler_v2.py",
    "scripts/agent_hub_coordinator_v2.py",
    "scripts/agent_hub_executor_gate_v2.py",
    "scripts/agent_hub_executor_report_v2.py",
    "scripts/test_agent_hub_v2.py",
    "scripts/test_agent_hub_executor_v2.py",
    "docs/agent-hub-v2-integration.md",
}


def run(*args: str, env: dict[str, str] | None = None) -> None:
    merged = dict(os.environ)
    if env:
        merged.update(env)
    subprocess.run(args, cwd=ROOT, env=merged, check=True)


def safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    names = {member.name for member in members}
    if names != ALLOWED:
        raise RuntimeError(f"bundle paths mismatch: missing={sorted(ALLOWED - names)} extra={sorted(names - ALLOWED)}")
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not member.isfile() or member.issym() or member.islnk():
            raise RuntimeError(f"unsafe bundle member: {member.name}")
    return members


def main() -> int:
    if not PARTS or [path.name for path in PARTS] != [f".agent-hub-v2-integration.part{i:02d}" for i in range(9)]:
        raise RuntimeError("integration bundle parts missing")
    workflow_backups = {path: path.read_bytes() for path in WORKFLOWS}
    encoded = "".join("".join(path.read_text(encoding="ascii").split()) for path in PARTS)
    payload = base64.b64decode(encoded, validate=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        members = safe_members(archive)
        archive.extractall(ROOT, members=members, filter="data")

    run("python3", "-m", "json.tool", ".github/agent-hub/policy.json")
    run("python3", "-m", "json.tool", ".github/agent-hub/workers.json")
    run(
        "python3", "-m", "py_compile",
        "scripts/agent_hub_policy.py",
        "scripts/agent_hub_free.py",
        "scripts/agent_hub_contract_v2.py",
        "scripts/agent_hub_prompt_compiler_v2.py",
        "scripts/agent_hub_coordinator_v2.py",
        "scripts/agent_hub_executor.py",
        "scripts/agent_hub_executor_gate_v2.py",
        "scripts/agent_hub_executor_report.py",
        "scripts/agent_hub_executor_report_v2.py",
        "scripts/test_agent_hub_v2.py",
        "scripts/test_agent_hub_executor_v2.py",
    )
    test_env = {"PYTHONPATH": "scripts"}
    for command in (
        ("python3", "scripts/agent_hub_contract_v2.py"),
        ("python3", "scripts/agent_hub_prompt_compiler_v2.py"),
        ("python3", "scripts/agent_hub_coordinator_v2.py", "--self-test"),
        ("python3", "scripts/agent_hub_executor_gate_v2.py", "--self-test"),
        ("python3", "scripts/agent_hub_executor_report_v2.py", "--self-test"),
        ("python3", "scripts/test_agent_hub_v2.py"),
        ("python3", "scripts/test_agent_hub_executor_v2.py"),
    ):
        run(*command, env=test_env)
    run("git", "diff", "--check")

    # GITHUB_TOKEN cannot safely update workflow files. Restore them for this commit;
    # the authenticated GitHub connector applies the two already-tested workflows next.
    for path, content in workflow_backups.items():
        path.write_bytes(content)
    for cache in ROOT.rglob("__pycache__"):
        if cache.is_dir():
            shutil.rmtree(cache)
    for part in PARTS:
        part.unlink()
    SELF.unlink()
    run("git", "diff", "--check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
