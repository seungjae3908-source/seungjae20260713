#!/usr/bin/env python3
"""Seal and verify the immutable Agent Hub Executor control plane.

The executor checks out an immutable workflow source SHA, seals the trusted modules
listed here into a runner-temp directory, and continues to execute those copies
after switching the application workspace to an arbitrary target branch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MANIFEST_NAME = "control-plane-manifest.json"

# Direct and transitive Python modules used by trusted executor gate, safety,
# Draft-PR validation, report/lifecycle closure, and coordinator wake paths.
TRUSTED_CONTROL_PLANE_FILES = (
    "agent_hub_policy.py",
    "agent_hub_contract_v2.py",
    "agent_hub_executor.py",
    "agent_hub_command_integrity_v2.py",
    "agent_hub_executor_gate_hardening_v2.py",
    "agent_hub_security_v2.py",
    "agent_hub_executor_safety_v2.py",
    "agent_hub_github_validation_v2.py",
    "agent_hub_executor_report_v2.py",
    "agent_hub_executor_report_hardening_v2.py",
    "agent_hub_control_plane_v2.py",
)


class ControlPlaneError(RuntimeError):
    """Fail-closed control-plane integrity rejection."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_source_sha(source_sha: str) -> str:
    value = source_sha.strip().lower()
    if not SHA_RE.fullmatch(value):
        raise ControlPlaneError("control-plane source SHA must be a full immutable SHA")
    return value


def seal_control_plane(*, repository_root: Path, destination: Path, source_sha: str) -> dict[str, object]:
    source_sha = _validate_source_sha(source_sha)
    scripts = repository_root / "scripts"
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=False)

    hashes: dict[str, str] = {}
    for name in TRUSTED_CONTROL_PLANE_FILES:
        source = scripts / name
        if not source.is_file() or source.is_symlink():
            raise ControlPlaneError(f"trusted control-plane source missing or non-regular: {name}")
        target = destination / name
        shutil.copyfile(source, target)
        hashes[name] = _sha256(target)

    manifest = {
        "schema_version": 1,
        "source_sha": source_sha,
        "files": hashes,
    }
    (destination / MANIFEST_NAME).write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    verify_control_plane(destination=destination, source_sha=source_sha)
    return manifest


def verify_control_plane(*, destination: Path, source_sha: str) -> dict[str, object]:
    source_sha = _validate_source_sha(source_sha)
    manifest_path = destination / MANIFEST_NAME
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ControlPlaneError("trusted control-plane manifest is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ControlPlaneError("trusted control-plane manifest is invalid") from exc
    if manifest.get("schema_version") != 1 or manifest.get("source_sha") != source_sha:
        raise ControlPlaneError("trusted control-plane source SHA mismatch")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(TRUSTED_CONTROL_PLANE_FILES):
        raise ControlPlaneError("trusted control-plane manifest file set mismatch")
    for name in TRUSTED_CONTROL_PLANE_FILES:
        expected = files.get(name)
        path = destination / name
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ControlPlaneError(f"trusted control-plane hash invalid: {name}")
        if not path.is_file() or path.is_symlink() or _sha256(path) != expected:
            raise ControlPlaneError(f"trusted control-plane hash mismatch: {name}")
    return manifest


def self_test() -> int:
    import tempfile

    source_sha = "a" * 40
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="agent-hub-control-plane-") as raw:
        destination = Path(raw) / "sealed"
        manifest = seal_control_plane(repository_root=root, destination=destination, source_sha=source_sha)
        assert manifest["source_sha"] == source_sha
        assert set(manifest["files"]) == set(TRUSTED_CONTROL_PLANE_FILES)
        verify_control_plane(destination=destination, source_sha=source_sha)
        victim = destination / "agent_hub_executor_safety_v2.py"
        victim.write_text("raise SystemExit(0)\n", encoding="utf-8")
        try:
            verify_control_plane(destination=destination, source_sha=source_sha)
        except ControlPlaneError:
            pass
        else:
            raise AssertionError("tampered control-plane file was accepted")
    print(json.dumps({
        "control_plane_v2": "pass",
        "immutable_source_sha": 1,
        "hash_manifest_verified": 1,
        "tampered_control_plane_accepted": 0,
    }))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    sub = parser.add_subparsers(dest="command")
    seal = sub.add_parser("seal")
    seal.add_argument("--repository-root", required=True)
    seal.add_argument("--destination", required=True)
    seal.add_argument("--source-sha", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--destination", required=True)
    verify.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.command == "seal":
        manifest = seal_control_plane(
            repository_root=Path(args.repository_root).resolve(),
            destination=Path(args.destination).resolve(),
            source_sha=args.source_sha,
        )
        print(json.dumps({"status": "sealed", "source_sha": manifest["source_sha"], "file_count": len(manifest["files"])}))
        return 0
    if args.command == "verify":
        manifest = verify_control_plane(destination=Path(args.destination).resolve(), source_sha=args.source_sha)
        print(json.dumps({"status": "verified", "source_sha": manifest["source_sha"], "file_count": len(manifest["files"])}))
        return 0
    raise ControlPlaneError("seal or verify command is required")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ControlPlaneError as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)[:500]}), file=__import__("sys").stderr)
        raise SystemExit(1)
