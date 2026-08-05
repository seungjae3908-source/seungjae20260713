#!/usr/bin/env python3
"""Deterministic diff/path/content gate for controlled Agent Hub workspaces."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from agent_hub_security_v2 import secret_patterns_for_diff

MAX_DIFF_LINES = 1200


class ExecutorSafetyError(RuntimeError):
    """Fail-closed executor safety rejection."""


def run_git(*args: str, cwd: Path | None = None, text: bool = True) -> subprocess.CompletedProcess[Any]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        text=text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def set_output(name: str, value: str) -> None:
    output = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not output:
        return
    delimiter = f"AGENT_HARDENED_{name.upper()}_{os.getpid()}"
    with open(output, "a", encoding="utf-8") as handle:
        if "\n" in value:
            handle.write(f"{name}<<{delimiter}\n{value}\n{delimiter}\n")
        else:
            handle.write(f"{name}={value}\n")


def normalize_repo_path(value: str, *, field: str = "path") -> str:
    if not isinstance(value, str) or not value:
        raise ExecutorSafetyError(f"{field} is empty")
    if value != unicodedata.normalize("NFKC", value):
        raise ExecutorSafetyError(f"{field} is not NFKC-stable")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ExecutorSafetyError(f"{field} contains control characters")
    # Agent Hub registry paths are deliberately ASCII. This blocks homoglyph/confusable paths.
    if not value.isascii():
        raise ExecutorSafetyError(f"{field} contains non-ASCII confusable characters")
    if "\\" in value or value.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", value):
        raise ExecutorSafetyError(f"{field} is absolute or uses a non-canonical separator")
    if "//" in value:
        raise ExecutorSafetyError(f"{field} contains duplicate separators")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ExecutorSafetyError(f"{field} contains traversal or dot segments")
    return "/".join(parts)


def normalize_pattern(value: str, *, field: str) -> str:
    path = normalize_repo_path(value, field=field)
    return path.casefold()


def _matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path.casefold(), pattern.casefold())


def _parse_name_status(base_ref: str) -> list[tuple[str, str]]:
    raw = run_git("diff", "--name-status", "-z", "--find-renames", base_ref, text=False).stdout
    tokens = raw.decode("utf-8", errors="strict").split("\0")
    tokens = [item for item in tokens if item]
    entries: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        status = tokens[index]
        index += 1
        if index >= len(tokens):
            raise ExecutorSafetyError("malformed git name-status output")
        if status.startswith(("R", "C")):
            if index + 1 >= len(tokens):
                raise ExecutorSafetyError("malformed rename/copy output")
            old_path, new_path = tokens[index], tokens[index + 1]
            index += 2
            # Validate both before rejecting so path decoding/traversal cannot be hidden in rename metadata.
            normalize_repo_path(old_path, field="rename source")
            normalize_repo_path(new_path, field="rename target")
            raise ExecutorSafetyError("rename/copy changes are blocked")
        path = tokens[index]
        index += 1
        entries.append((status, normalize_repo_path(path)))
    tracked = {path for _, path in entries}
    raw_untracked = run_git("ls-files", "--others", "--exclude-standard", "-z", text=False).stdout
    for item in raw_untracked.decode("utf-8", errors="strict").split("\0"):
        if not item:
            continue
        path = normalize_repo_path(item)
        if path not in tracked:
            entries.append(("A", path))
    return entries


def _read_utf8_regular(path: str) -> str:
    candidate = Path(path)
    if candidate.is_symlink() or not candidate.is_file():
        raise ExecutorSafetyError(f"non-regular file change blocked: {path}")
    data = candidate.read_bytes()
    if b"\x00" in data:
        raise ExecutorSafetyError(f"binary file blocked: {path}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExecutorSafetyError(f"non-UTF-8 file blocked: {path}") from exc


def _parse_json_list(raw: str, field: str) -> tuple[str, ...]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExecutorSafetyError(f"{field} must be valid JSON") from exc
    if not isinstance(value, list) or not value or any(not isinstance(item, str) for item in value):
        raise ExecutorSafetyError(f"{field} must be a non-empty string list")
    return tuple(dict.fromkeys(normalize_pattern(item, field=field) for item in value))


def _added_text(base_ref: str, entries: Iterable[tuple[str, str]]) -> str:
    patch = run_git("diff", "--unified=0", "--no-ext-diff", base_ref).stdout
    added = [line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")]
    tracked = set(run_git("ls-files").stdout.splitlines())
    for _, path in entries:
        if path not in tracked:
            added.append(_read_utf8_regular(path))
    return "\n".join(added)


def validate_diff(
    *,
    mode: str,
    base_ref: str,
    allowed_paths: tuple[str, ...],
    forbidden_paths: tuple[str, ...],
    max_files: int,
) -> dict[str, Any]:
    if not base_ref:
        raise ExecutorSafetyError("base_ref is required")
    allowed = tuple(normalize_pattern(item, field="allowed_paths") for item in allowed_paths)
    forbidden = tuple(normalize_pattern(item, field="forbidden_paths") for item in forbidden_paths)
    entries = _parse_name_status(base_ref)
    if mode == "read_only":
        if entries:
            raise ExecutorSafetyError("read-only command modified repository files")
        return {"files": [], "diff_lines": 0, "has_changes": False}
    if mode != "code_change":
        raise ExecutorSafetyError("invalid execution mode")
    if not entries:
        return {"files": [], "diff_lines": 0, "has_changes": False}
    if max_files < 0 or len(entries) > max_files:
        raise ExecutorSafetyError("changed file count exceeds command limit")

    files: list[str] = []
    for status, path in entries:
        if status.startswith(("D", "R", "C")):
            raise ExecutorSafetyError("delete/rename/copy changes are blocked")
        if not any(_matches(path, pattern) for pattern in allowed):
            raise ExecutorSafetyError(f"changed path outside allowed scope: {path}")
        if any(_matches(path, pattern) for pattern in forbidden):
            raise ExecutorSafetyError(f"changed forbidden path: {path}")
        _read_utf8_regular(path)  # validates tracked and untracked files alike
        files.append(path)

    diff_lines = 0
    numstat = run_git("diff", "--numstat", base_ref).stdout
    for line in numstat.splitlines():
        if not line:
            continue
        added, deleted, _ = line.split("\t", 2)
        if added == "-" or deleted == "-":
            raise ExecutorSafetyError("binary diff blocked")
        diff_lines += int(added) + int(deleted)
    tracked = set(run_git("ls-files").stdout.splitlines())
    for _, path in entries:
        if path not in tracked:
            diff_lines += len(_read_utf8_regular(path).splitlines())
    if diff_lines > MAX_DIFF_LINES:
        raise ExecutorSafetyError("diff exceeds 1200-line hard limit")

    candidate = _added_text(base_ref, entries)
    if any(pattern.search(candidate) for pattern in secret_patterns_for_diff()):
        raise ExecutorSafetyError("sensitive content detected in diff")
    return {"files": files, "diff_lines": diff_lines, "has_changes": True}


def validate_diff_command() -> int:
    allowed = _parse_json_list(os.environ.get("ALLOWED_PATHS", ""), "allowed_paths")
    forbidden = _parse_json_list(os.environ.get("FORBIDDEN_PATHS", ""), "forbidden_paths")
    try:
        max_files = int(os.environ.get("MAX_FILES", "0"))
    except ValueError as exc:
        raise ExecutorSafetyError("MAX_FILES must be numeric") from exc
    result = validate_diff(
        mode=os.environ.get("EXECUTION_MODE", "").strip(),
        base_ref=os.environ.get("BASE_REF", "").strip(),
        allowed_paths=allowed,
        forbidden_paths=forbidden,
        max_files=max_files,
    )
    set_output("has_changes", "true" if result["has_changes"] else "false")
    set_output("changed_files", json.dumps(result["files"], ensure_ascii=False))
    set_output("diff_lines", str(result["diff_lines"]))
    print(json.dumps(result, ensure_ascii=False))
    return 0


def _git(*args: str, cwd: Path) -> None:
    run_git(*args, cwd=cwd)


def _expect_block(fn) -> None:
    try:
        fn()
    except (ExecutorSafetyError, UnicodeDecodeError):
        return
    raise AssertionError("unsafe diff was accepted")


def self_test() -> int:
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="agent-hub-hardening-") as raw:
        repo = Path(raw)
        _git("init", cwd=repo); _git("config", "user.name", "test", cwd=repo); _git("config", "user.email", "test@example.invalid", cwd=repo)
        (repo / "docs").mkdir(); (repo / "docs/base.md").write_text("base\n", encoding="utf-8")
        (repo / "ops").mkdir(); (repo / "ops/base.md").write_text("base\n", encoding="utf-8")
        _git("add", ".", cwd=repo); _git("commit", "-m", "base", cwd=repo)
        os.chdir(repo)
        try:
            (repo / "docs/base.md").write_text("safe\n", encoding="utf-8")
            assert validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2)["has_changes"]
            _git("reset", "--hard", "HEAD", cwd=repo)
            (repo / "docs/base.md").write_bytes(b"\xff\xfe")
            _expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2))
            _git("reset", "--hard", "HEAD", cwd=repo)
            (repo / "docs/token.md").write_text("Authorization : Bearer abcdefghijklmnopqrstuvwxyz.123456\n", encoding="utf-8")
            _expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2))
            (repo / "docs/token.md").unlink()
            (repo / "docs/supa.md").write_text("SUPABASE_SERVICE_ROLE_KEY = fixture_service_role_value_123456\n", encoding="utf-8")
            _expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2))
            (repo / "docs/supa.md").unlink()
            (repo / "OPS").mkdir(); (repo / "OPS/no.md").write_text("no\n", encoding="utf-8")
            _expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("**",), forbidden_paths=("ops/**",), max_files=2))
            _git("clean", "-fd", cwd=repo)
            (repo / "dоcs").mkdir()  # Cyrillic o
            (repo / "dоcs/no.md").write_text("no\n", encoding="utf-8")
            _expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("**",), forbidden_paths=("ops/**",), max_files=2))
            _git("clean", "-fd", cwd=repo)
            _expect_block(lambda: normalize_repo_path("../ops/no.md"))
            _expect_block(lambda: normalize_repo_path("docs//no.md"))
        finally:
            os.chdir(original)
    print(json.dumps({"executor_safety_v2":"pass","tracked_non_utf8_accepted":0,"secret_diff_accepted":0,"unicode_path_accepted":0}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("command", nargs="?", choices=("validate-diff",))
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.command == "validate-diff":
        return validate_diff_command()
    raise ExecutorSafetyError("command is required")

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ExecutorSafetyError as exc:
        print(json.dumps({"status":"blocked","error":str(exc)[:500]}), file=os.sys.stderr)
        raise SystemExit(1)
