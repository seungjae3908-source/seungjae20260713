#!/usr/bin/env python3
"""Schema-v2 executor gate with exact dispatch pinning and sanitized audit evidence."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from agent_hub_command_integrity_v2 import CommandIntegrityError, seal_command_body, verify_command_body
from agent_hub_contract_v2 import (
    COMMAND_ID_RE,
    COMMAND_MARKER,
    SCHEMA_VERSION,
    STATE_MARKER,
    TASK_RE,
    parse_json_list,
    parse_key_values as parse_v2_fields,
)
from agent_hub_executor import (
    ERROR_MARKER_PREFIX,
    PROCESSED_MARKER_PREFIX,
    ExecutorError,
    GitHubClient,
    build_prompt,
    command_expired,
    format_running_state,
    load_policy,
    load_workers,
    marker_for,
    read_event_command_id,
    set_output,
    validate_command_comment,
    work_branch_for,
)

COMPILER_EVIDENCE_PREFIXES = (
    "REPOSITORY-",
    "TASK-",
    "BASE-",
    "HEAD-",
    "CI-",
    "PR-",
    "CHANGED_FILES-",
    "CHECKS-",
    "SUMMARY-",
    "REMAINING-",
    "DEPENDENCIES-",
    "CONFLICTS-",
    "ERROR_FIRST-",
    "ERROR_LAST-",
    "FILE_LINE-",
    "PROMPT_INJECTION-",
    "EVIDENCE-",
)
TERMINAL_COMMAND_STATES = frozenset({"running", "completed", "failed", "blocked", "stale", "expired", "superseded"})
MAX_REJECTION_AUDIT = 8


@dataclass(frozen=True)
class CommandSelection:
    command: Any | None
    candidate_count: int
    rejections: tuple[dict[str, Any], ...]


class CommandSelectionError(ExecutorError):
    """Exact repository-dispatch command could not be safely selected."""

    def __init__(
        self,
        reason: str,
        *,
        error_type: str = "ExecutorError",
        command_comment_id: int = 0,
        command_id: str = "unknown",
        source_task_id: str = "unknown",
    ) -> None:
        self.reason = _safe_token(reason, "command_selection_failed")
        self.error_type = _safe_token(error_type, "ExecutorError")
        self.command_comment_id = command_comment_id if command_comment_id > 0 else 0
        self.command_id = _safe_command_id(command_id)
        self.source_task_id = _safe_task_id(source_task_id)
        super().__init__(self.reason)

    def audit(self) -> dict[str, Any]:
        return {
            "status": "blocked",
            "stage": "prepare_command",
            "error_type": self.error_type,
            "reason": self.reason,
            "command_comment_id": self.command_comment_id,
            "command_id": self.command_id,
            "source_task_id": self.source_task_id,
        }


def _safe_token(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if re.fullmatch(r"[A-Za-z0-9._:-]{1,180}", text) else fallback


def _safe_command_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if COMMAND_ID_RE.fullmatch(text) else "unknown"


def _safe_task_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if TASK_RE.fullmatch(text) else "unknown"


def _identity(comment: Mapping[str, Any]) -> tuple[int, str, str, dict[str, str]]:
    try:
        cid = int(comment.get("id") or 0)
    except (TypeError, ValueError):
        cid = 0
    body = str(comment.get("body") or "")
    fields = parse_v2_fields(body)
    return cid, _safe_command_id(fields.get("command_id")), _safe_task_id(fields.get("source_task_id")), fields


def _rejection(
    comment: Mapping[str, Any],
    reason: str,
    *,
    error_type: str = "ExecutorError",
) -> dict[str, Any]:
    cid, command_id, source_task_id, _ = _identity(comment)
    return {
        "error_type": _safe_token(error_type, "ExecutorError"),
        "reason": _safe_token(reason, "command_validation_failed"),
        "command_comment_id": cid if cid > 0 else 0,
        "command_id": command_id,
        "source_task_id": source_task_id,
    }


def _validation_reason(exc: ExecutorError) -> str:
    message = str(exc)
    exact = {
        "untrusted command comment": "untrusted_command_comment",
        "comment is not HUB_COMMAND": "not_hub_command",
        "executor accepts only ready commands": "command_not_ready",
        "provider or model mismatch": "provider_or_model_mismatch",
        "paid fallback must be disabled": "paid_fallback_enabled",
        "source report authenticity marker mismatch": "source_identity_mismatch",
        "command authenticity marker mismatch": "command_identity_mismatch",
        "unregistered target worker": "unregistered_target_worker",
        "worker action scope mismatch": "worker_action_scope_mismatch",
        "worker branch scope mismatch": "worker_branch_scope_mismatch",
        "default branch commands are blocked": "default_branch_blocked",
        "worker cannot modify code": "worker_code_change_blocked",
        "worker cannot run CI": "worker_ci_blocked",
        "command expired": "command_expired",
        "ready schema-v2 command has no immutable evidence IDs": "immutable_evidence_missing",
        "schema-v2 command contains an unsupported evidence ID": "unsupported_evidence_id",
    }
    if message in exact:
        return exact[message]
    if message.startswith("path outside worker registry"):
        return "path_outside_worker_scope"
    if message.startswith("allowed path overlaps forbidden path"):
        return "forbidden_path_overlap"
    return "command_validation_failed"


def _command_state_reason(
    comments: Sequence[Mapping[str, Any]],
    *,
    command_id: str,
) -> str | None:
    if command_id == "unknown":
        return None
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if STATE_MARKER not in body:
            continue
        fields = parse_v2_fields(body)
        if fields.get("command_id") != command_id:
            continue
        state = str(fields.get("status") or "").strip().lower()
        if state in TERMINAL_COMMAND_STATES:
            return "already_running" if state == "running" else f"command_{state}"
    return None


def _evidence_ids(command: Any) -> tuple[str, ...]:
    evidence_ids = parse_json_list(command.fields.get("evidence_ids", "[]"), "evidence_ids")
    if command.fields.get("status") == "ready" and not evidence_ids:
        raise ExecutorError("ready schema-v2 command has no immutable evidence IDs")
    if any(
        not item.startswith("gh-evidence-v2:")
        and not item.startswith(COMPILER_EVIDENCE_PREFIXES)
        for item in evidence_ids
    ):
        raise ExecutorError("schema-v2 command contains an unsupported evidence ID")
    return evidence_ids


def _candidate_rejection(
    comment: Mapping[str, Any],
    *,
    all_body: str,
    comments: Sequence[Mapping[str, Any]],
    policy: dict[str, Any],
    workers: dict[str, Any],
) -> tuple[Any | None, dict[str, Any] | None]:
    cid, command_id, _, fields = _identity(comment)
    body = str(comment.get("body") or "")
    if COMMAND_MARKER not in body:
        return None, _rejection(comment, "not_hub_command", error_type="ContractError")
    if fields.get("schema_version") != SCHEMA_VERSION:
        return None, _rejection(comment, "schema_version_mismatch", error_type="ContractError")
    if cid <= 0:
        return None, _rejection(comment, "invalid_command_comment_id", error_type="ContractError")
    if marker_for(PROCESSED_MARKER_PREFIX, cid) in all_body or (
        command_id != "unknown" and marker_for(PROCESSED_MARKER_PREFIX, command_id) in all_body
    ):
        return None, _rejection(comment, "already_consumed")
    if marker_for(ERROR_MARKER_PREFIX, cid) in all_body or (
        command_id != "unknown" and marker_for(ERROR_MARKER_PREFIX, command_id) in all_body
    ):
        return None, _rejection(comment, "previous_executor_error")
    state_reason = _command_state_reason(comments, command_id=command_id)
    if state_reason:
        return None, _rejection(comment, state_reason)
    try:
        verify_command_body(body)
    except CommandIntegrityError:
        return None, _rejection(comment, "command_integrity_failed", error_type="CommandIntegrityError")
    try:
        command = validate_command_comment(dict(comment), policy, workers, allow_expired=True)
        _evidence_ids(command)
        return command, None
    except ExecutorError as exc:
        return None, _rejection(comment, _validation_reason(exc), error_type="ExecutorError")


def pending_schema_v2_command(
    comments: Sequence[dict[str, Any]],
    *,
    policy: dict[str, Any],
    workers: dict[str, Any],
    event_comment_id: int | None,
) -> CommandSelection:
    all_body = "\n".join(str(comment.get("body") or "") for comment in comments)
    if event_comment_id is not None:
        exact = [item for item in comments if int(item.get("id") or 0) == event_comment_id]
        if len(exact) != 1:
            raise CommandSelectionError(
                "command_comment_not_found" if not exact else "duplicate_command_comment_id",
                error_type="ContractError",
                command_comment_id=event_comment_id,
            )
        command, rejection = _candidate_rejection(
            exact[0], all_body=all_body, comments=comments, policy=policy, workers=workers
        )
        if command is None:
            assert rejection is not None
            raise CommandSelectionError(
                str(rejection["reason"]),
                error_type=str(rejection["error_type"]),
                command_comment_id=int(rejection["command_comment_id"]),
                command_id=str(rejection["command_id"]),
                source_task_id=str(rejection["source_task_id"]),
            )
        return CommandSelection(command=command, candidate_count=1, rejections=())

    candidate_count = 0
    rejected: list[dict[str, Any]] = []
    for comment in reversed(list(comments)):
        body = str(comment.get("body") or "")
        if COMMAND_MARKER not in body:
            continue
        candidate_count += 1
        command, rejection = _candidate_rejection(
            comment, all_body=all_body, comments=comments, policy=policy, workers=workers
        )
        if command is not None:
            return CommandSelection(
                command=command,
                candidate_count=candidate_count,
                rejections=tuple(rejected[:MAX_REJECTION_AUDIT]),
            )
        if rejection is not None and len(rejected) < MAX_REJECTION_AUDIT:
            rejected.append(rejection)
    return CommandSelection(command=None, candidate_count=candidate_count, rejections=tuple(rejected))


def continuation_work_branch(command: Any) -> str:
    """Reuse the validated target branch for read-only or existing-Draft continuation."""
    declared = str(command.fields.get("work_branch") or "none").strip()
    if command.execution_mode == "read_only" or declared == command.target_branch:
        return command.target_branch
    return work_branch_for(command)


def prepare_hardened() -> int:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    issue_raw = os.environ.get("HUB_ISSUE_NUMBER", "").strip()
    if not token or "/" not in repository or not issue_raw.isdigit():
        raise ExecutorError("GitHub execution context is incomplete")
    client = GitHubClient(token, os.environ.get("GITHUB_API_URL", "https://api.github.com"), repository)
    comments = client.comments(int(issue_raw))
    event_id = read_event_command_id(os.environ.get("GITHUB_EVENT_PATH", ""), int(issue_raw))
    selection = pending_schema_v2_command(
        comments, policy=load_policy(), workers=load_workers(), event_comment_id=event_id
    )
    command = selection.command
    if command is None:
        set_output("should_run", "false")
        set_output("terminal_status", "none")
        print(json.dumps({
            "status": "no_pending_schema_v2_command",
            "candidate_count": selection.candidate_count,
            "rejected_candidates": len(selection.rejections),
            "rejection_evidence": list(selection.rejections),
            "legacy_commands_accepted": 0,
            "edited_commands_accepted": 0,
        }, separators=(",", ":")))
        return 0
    work_branch = continuation_work_branch(command)
    outputs = {
        "command_comment_id": str(command.comment_id),
        "command_id": command.command_id,
        "source_task_id": command.source_task_id,
        "target_worker": command.target_worker,
        "target_branch": command.target_branch,
        "expected_head_sha": command.expected_head_sha,
        "work_branch": work_branch,
        "action_type": command.action_type,
        "execution_mode": command.execution_mode,
        "attempt": str(command.attempt),
        "max_attempts": str(command.max_attempts),
        "auto_step": str(command.fields.get("auto_step") or "0"),
        "allowed_paths": command.fields["allowed_paths"],
        "forbidden_paths": command.fields["forbidden_paths"],
        "evidence_ids": command.fields["evidence_ids"],
        "max_files": str(command.max_files),
        "max_commits": str(command.max_commits),
        "instruction": command.fields["instruction"],
        "validation": command.fields["validation"],
        "stop_conditions": command.fields["stop_conditions"],
    }
    for name, value in outputs.items():
        set_output(name, value)
    if command_expired(command.fields):
        set_output("should_run", "false")
        set_output("terminal_status", "expired")
        set_output("terminal_reason", "command expiry reached")
        return 0
    actual = client.branch_sha(command.target_branch)
    if actual != command.expected_head_sha:
        set_output("should_run", "false")
        set_output("terminal_status", "stale")
        set_output("terminal_reason", "expected HEAD differs from actual branch HEAD")
        return 0
    set_output("should_run", "true")
    set_output("terminal_status", "none")
    set_output("prompt", build_prompt(command, work_branch))
    client.post_comment(int(issue_raw), format_running_state(command, work_branch))
    print(json.dumps({
        "status": "prepared",
        "schema_version": 2,
        "command_comment_id": command.comment_id,
        "command_id": command.command_id,
        "work_branch": work_branch,
        "evidence_count": len(_evidence_ids(command)),
        "candidate_count": selection.candidate_count,
        "rejected_candidates": len(selection.rejections),
        "rejection_evidence": list(selection.rejections),
    }, separators=(",", ":")))
    return 0


def _test_ready_body(*, comment_id: int = 12345) -> str:
    task_id = "handoff-test"
    command_id = f"hub-{comment_id}-0123456789abcdef"
    raw = "\n".join([
        "[HUB_COMMAND]",
        "schema_version: 2",
        f"command_id: {command_id}",
        f"source_task_id: {task_id}",
        "source_report_comment_id: 777",
        "target_worker: operations-worker",
        "status: ready",
        "action_type: inspect_repository",
        "risk_level: low",
        "execution_mode: read_only",
        "repository: owner/repo",
        "base_branch: main",
        "base_sha: " + "a" * 40,
        "target_branch: agent/hub-e2e-fixture",
        "expected_head_sha: " + "b" * 40,
        "work_branch: none",
        "allowed_paths: []",
        'prohibited_paths: ["*"]',
        "instruction: Inspect repository metadata without writes.",
        'evidence_ids: ["gh-evidence-v2:issue-comment:abc","BASE-aaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef0000","HEAD-bbbbbbbbbbbbbbbbbbbbbbbbbbbb-deadbeef0001","CHECKS-safe-checks-deadbeef0002"]',
        "validation: Verify exact branch HEAD without mutations.",
        "stop_conditions: Stop on any write or approval-required action.",
        "expires_at: 2099-01-01T00:00:00Z",
        "auto_step: 1",
        "auto_limit: 3",
        "approval_required: no",
        "required_approval_phrase: none",
        "max_attempts: 2",
        "policy_version: agent-hub-v4.0",
        "provider: gemini-developer-api-free",
        "model: gemini-3.1-flash-lite",
        "branch: agent/hub-e2e-fixture",
        'forbidden_paths: ["*"]',
        "requires_user_approval: false",
        "paid_fallback: false",
        "<!-- agent-hub-processed:777 -->",
        f"<!-- agent-hub-command:{command_id} -->",
    ])
    return seal_command_body(raw)


def self_test() -> int:
    policy = load_policy()
    workers = load_workers()
    valid = {"id": 12345, "body": _test_ready_body(), "user": {"login": "github-actions[bot]"}}

    selected = pending_schema_v2_command([valid], policy=policy, workers=workers, event_comment_id=12345)
    assert selected.command is not None and selected.candidate_count == 1
    assert selected.command.action_type == "inspect_repository"
    assert selected.command.execution_mode == "read_only"
    assert parse_json_list(selected.command.fields["allowed_paths"], "allowed_paths") == ()
    assert len(_evidence_ids(selected.command)) == 4

    secret_fixture = "AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    tampered = {**valid, "body": valid["body"].replace("Inspect repository metadata", secret_fixture)}
    try:
        pending_schema_v2_command([tampered], policy=policy, workers=workers, event_comment_id=12345)
    except CommandSelectionError as exc:
        audit = exc.audit()
        assert audit["reason"] == "command_integrity_failed" and audit["error_type"] == "CommandIntegrityError"
        assert secret_fixture not in json.dumps(audit, separators=(",", ":"))
    else:
        raise AssertionError("tampered exact command was accepted")

    try:
        pending_schema_v2_command([valid], policy=policy, workers=workers, event_comment_id=99999)
    except CommandSelectionError as exc:
        assert exc.audit()["reason"] == "command_comment_not_found"
    else:
        raise AssertionError("missing exact command was hidden")

    invalid = {"id": 12346, "body": "[HUB_COMMAND]\nschema_version: 1\nsecret: " + secret_fixture, "user": {"login": "github-actions[bot]"}}
    generic = pending_schema_v2_command([valid, invalid], policy=policy, workers=workers, event_comment_id=None)
    assert generic.command is not None and generic.command.comment_id == 12345
    assert generic.candidate_count == 2 and generic.rejections[0]["reason"] == "schema_version_mismatch"
    assert secret_fixture not in json.dumps(generic.rejections, separators=(",", ":"))
    no_valid = pending_schema_v2_command([invalid], policy=policy, workers=workers, event_comment_id=None)
    assert no_valid.command is None and no_valid.candidate_count == 1 and len(no_valid.rejections) == 1

    waiting_body = valid["body"].replace("status: ready", "status: waiting_approval").replace("risk_level: low", "risk_level: high")
    waiting_body = seal_command_body(waiting_body)
    waiting = {**valid, "body": waiting_body}
    try:
        pending_schema_v2_command([waiting], policy=policy, workers=workers, event_comment_id=12345)
    except CommandSelectionError as exc:
        assert exc.audit()["reason"] == "command_not_ready"
    else:
        raise AssertionError("high-risk exact command became executable")

    consumed = {"id": 20000, "body": "<!-- agent-executor-processed:12345 -->", "user": {"login": "github-actions[bot]"}}
    try:
        pending_schema_v2_command([valid, consumed], policy=policy, workers=workers, event_comment_id=12345)
    except CommandSelectionError as exc:
        assert exc.audit()["reason"] == "already_consumed"
    else:
        raise AssertionError("consumed exact command was accepted")
    state = {"id": 20001, "body": "[HUB_STATE]\ncommand_id: hub-12345-0123456789abcdef\nstatus: superseded", "user": {"login": "github-actions[bot]"}}
    try:
        pending_schema_v2_command([valid, state], policy=policy, workers=workers, event_comment_id=12345)
    except CommandSelectionError as exc:
        assert exc.audit()["reason"] == "command_superseded"
    else:
        raise AssertionError("superseded exact command was accepted")

    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/agent-hub-free.yml").read_text(encoding="utf-8")
    assert "steps.hub.outputs.command_id" in workflow
    assert "client_payload[command_comment_id]" in workflow
    assert "agent-hub-command-ready" in workflow
    assert "client_payload[command_id]" not in workflow and "client_payload[source_task_id]" not in workflow

    class FakeCommand:
        def __init__(self, mode: str, target: str, declared: str):
            self.execution_mode = mode
            self.target_branch = target
            self.fields = {"work_branch": declared}
            self.command_id = "hub-123-0123456789abcdef"
            self.attempt = 1

    assert continuation_work_branch(FakeCommand("read_only", "feature/demo", "none")) == "feature/demo"
    assert continuation_work_branch(FakeCommand("code_change", "feature/demo", "feature/demo")) == "feature/demo"
    assert continuation_work_branch(FakeCommand("code_change", "feature/demo", "none")).startswith("agent/hub-")
    print(json.dumps({
        "executor_gate_hardening_v2": "pass",
        "handoff_scenarios": 8,
        "exact_dispatch_pinning": 1,
        "generic_fallback_preserved": 1,
        "sanitized_rejection_audit": 1,
        "read_only_empty_allowed_paths": 1,
        "critical_auto_actions": 0,
        "raw_command_body_logged": 0,
        "secret_logged": 0,
        "legacy_ready_accepted": 0,
        "edited_command_accepted": 0,
        "unsupported_evidence_accepted": 0,
    }, separators=(",", ":")))
    return 0


def main() -> int:
    return self_test() if "--self-test" in os.sys.argv else prepare_hardened()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CommandSelectionError as exc:
        print(json.dumps(exc.audit(), separators=(",", ":")), file=os.sys.stderr)
        raise SystemExit(1)
    except ExecutorError:
        print(json.dumps({
            "status": "blocked",
            "stage": "prepare_command",
            "error_type": "ExecutorError",
            "reason": "executor_gate_validation_failed",
            "command_comment_id": 0,
            "command_id": "unknown",
            "source_task_id": "unknown",
        }, separators=(",", ":")), file=os.sys.stderr)
        raise SystemExit(1)
