#!/usr/bin/env python3
"""Integration tests for schema-v2 transport against the real PR #70 executor."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from agent_hub_contract_v2 import command_id, format_command
from agent_hub_executor import (
    EXPECTED_AUTHOR,
    ExecutorError,
    validate_command_comment,
    validate_diff,
    work_branch_for,
)
from agent_hub_executor_gate_v2 import pending_schema_v2_command
from agent_hub_policy import load_policy, load_workers


def ready_body() -> str:
    policy = load_policy()
    expires = (datetime.now(timezone.utc) + timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    fields = {
        "schema_version": "2",
        "command_id": command_id(321, "integration-task", "integration-planner", "modify_feature_branch", policy["policy_version"]),
        "source_task_id": "integration-task",
        "source_report_comment_id": "321",
        "target_worker": "integration-planner",
        "status": "ready",
        "action_type": "modify_feature_branch",
        "risk_level": "low",
        "execution_mode": "code_change",
        "repository": "owner/repo",
        "base_branch": "main",
        "base_sha": "a" * 40,
        "target_branch": "feature/integration-demo",
        "expected_head_sha": "b" * 40,
        "work_branch": "agent/hub-placeholder-a1",
        "allowed_paths": '["docs/demo.md"]',
        "prohibited_paths": json.dumps(policy["global_forbidden_path_patterns"], separators=(",", ":")),
        "instruction": "Update only the integration analysis document.",
        "evidence_ids": '["EVIDENCE-1"]',
        "validation": "Validate the documentation diff.",
        "stop_conditions": "Stop before merge, deployment, deletion, DB, Secret, or live-order work.",
        "expires_at": expires,
        "auto_step": "1",
        "auto_limit": "3",
        "approval_required": "no",
        "required_approval_phrase": "none",
        "max_attempts": "2",
        "policy_version": policy["policy_version"],
        "provider": policy["provider"],
        "model": policy["default_model"],
    }
    return format_command(fields, policy_version=policy["policy_version"])


def test_transport() -> int:
    policy = load_policy()
    workers = load_workers()
    body = ready_body()
    comment = {"id": 900, "body": body, "user": {"login": EXPECTED_AUTHOR}}
    command = validate_command_comment(comment, policy, workers, allow_expired=False)
    assert command.target_worker == "integration-planner"
    assert command.execution_mode == "code_change"
    assert command.max_files == workers["integration-planner"].max_files_per_command
    assert work_branch_for(command).startswith("agent/hub-")
    assert pending_schema_v2_command([comment], policy=policy, workers=workers, event_comment_id=900) is not None

    legacy = {"id": 901, "body": body.replace("schema_version: 2\n", ""), "user": {"login": EXPECTED_AUTHOR}}
    assert pending_schema_v2_command([legacy], policy=policy, workers=workers, event_comment_id=None) is None
    bad_author = {"id": 902, "body": body, "user": {"login": "attacker"}}
    try:
        validate_command_comment(bad_author, policy, workers)
    except ExecutorError:
        pass
    else:
        raise AssertionError("untrusted command author accepted")
    bad_worker = {"id": 903, "body": body.replace("target_worker: integration-planner", "target_worker: unknown-worker"), "user": {"login": EXPECTED_AUTHOR}}
    try:
        validate_command_comment(bad_worker, policy, workers)
    except ExecutorError:
        pass
    else:
        raise AssertionError("unregistered worker accepted")
    return 8


def git(*args: str, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def reset(repo: Path) -> None:
    git("reset", "--hard", "HEAD", cwd=repo)
    git("clean", "-fdx", cwd=repo)


def expect_block(callable_, message: str) -> None:
    try:
        callable_()
    except ExecutorError:
        return
    raise AssertionError(message)


def test_diff_gate() -> int:
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="agent-hub-executor-v2-") as raw:
        repo = Path(raw)
        git("init", cwd=repo)
        git("config", "user.email", "agent-hub-test@example.invalid", cwd=repo)
        git("config", "user.name", "Agent Hub Test", cwd=repo)
        (repo / "README.md").write_text("baseline\n", encoding="utf-8")
        git("add", "README.md", cwd=repo)
        git("commit", "-m", "baseline", cwd=repo)
        os.chdir(repo)
        try:
            assert validate_diff(mode="read_only", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2)["has_changes"] is False
            (repo / "docs").mkdir()
            (repo / "docs/demo.md").write_text("safe\n", encoding="utf-8")
            result = validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2)
            assert result["files"] == ["docs/demo.md"] and result["diff_lines"] == 1

            reset(repo)
            (repo / "ops").mkdir()
            (repo / "ops/no.sh").write_text("blocked\n", encoding="utf-8")
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2), "forbidden path accepted")

            reset(repo)
            (repo / "docs").mkdir()
            os.symlink("../README.md", repo / "docs/link.md")
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2), "symlink accepted")

            reset(repo)
            (repo / "docs").mkdir()
            (repo / "docs/bin.dat").write_bytes(b"a\x00b")
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2), "binary accepted")

            reset(repo)
            (repo / "docs").mkdir()
            (repo / "docs/a.md").write_text("a\n", encoding="utf-8")
            (repo / "docs/b.md").write_text("b\n", encoding="utf-8")
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=1), "file limit exceeded without block")

            reset(repo)
            (repo / "docs").mkdir()
            (repo / "docs/large.md").write_text("x\n" * 1201, encoding="utf-8")
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("docs/**",), forbidden_paths=("ops/**",), max_files=2), "line limit exceeded without block")

            reset(repo)
            (repo / "README.md").unlink()
            expect_block(lambda: validate_diff(mode="code_change", base_ref="HEAD", allowed_paths=("**",), forbidden_paths=("ops/**",), max_files=2), "delete accepted")
        finally:
            os.chdir(original)
    return 7


def run() -> int:
    count = test_transport() + test_diff_gate()
    print(json.dumps({"executor_schema_v2": "pass", "tests": count, "legacy_ready_accepted": 0, "diff_line_limit": 1200}))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
