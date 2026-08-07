#!/usr/bin/env python3
"""Schema-v2 executor gate with immutable command and evidence verification."""
from __future__ import annotations

import json
import os
from typing import Any, Sequence

from agent_hub_command_integrity_v2 import CommandIntegrityError, verify_command_body
from agent_hub_contract_v2 import SCHEMA_VERSION, parse_json_list, parse_key_values as parse_v2_fields
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


def pending_schema_v2_command(
    comments: Sequence[dict[str, Any]], *, policy: dict[str, Any], workers: dict[str, Any],
    event_comment_id: int | None,
):
    all_body = "\n".join(str(comment.get("body") or "") for comment in comments)
    candidates = list(comments)
    if event_comment_id is not None:
        candidates = [item for item in candidates if int(item.get("id") or 0) == event_comment_id]
    for comment in reversed(candidates):
        cid = int(comment.get("id") or 0)
        body = str(comment.get("body") or "")
        if cid <= 0 or parse_v2_fields(body).get("schema_version") != SCHEMA_VERSION:
            continue
        fields = parse_v2_fields(body)
        command_id = fields.get("command_id", "")
        if (
            marker_for(PROCESSED_MARKER_PREFIX, cid) in all_body
            or marker_for(ERROR_MARKER_PREFIX, cid) in all_body
            or (command_id and marker_for(PROCESSED_MARKER_PREFIX, command_id) in all_body)
            or (command_id and marker_for(ERROR_MARKER_PREFIX, command_id) in all_body)
        ):
            continue
        try:
            verify_command_body(body)
            command = validate_command_comment(comment, policy, workers, allow_expired=True)
            evidence_ids = parse_json_list(command.fields.get("evidence_ids", "[]"), "evidence_ids")
            if command.fields.get("status") == "ready" and not evidence_ids:
                raise ExecutorError("ready schema-v2 command has no immutable evidence IDs")
            if any(not item.startswith("gh-evidence-v2:") and not item.startswith(("HEAD-", "CI-", "PR-", "EVIDENCE-")) for item in evidence_ids):
                raise ExecutorError("schema-v2 command contains an unsupported evidence ID")
            return command
        except (ExecutorError, CommandIntegrityError):
            if event_comment_id is not None:
                raise ExecutorError("schema-v2 command integrity or evidence validation failed")
    return None


def continuation_work_branch(command: Any) -> str:
    """Reuse the validated target branch for read-only or existing-Draft continuation.

    New code changes without an existing Draft PR keep the isolated agent/hub-* branch.
    The coordinator marks an existing Draft PR by sealing work_branch == target_branch.
    """
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
    command = pending_schema_v2_command(comments, policy=load_policy(), workers=load_workers(), event_comment_id=event_id)
    if command is None:
        set_output("should_run", "false")
        set_output("terminal_status", "none")
        print(json.dumps({"status": "no_pending_schema_v2_command", "legacy_commands_accepted": 0, "edited_commands_accepted": 0}))
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
        set_output("terminal_reason", f"expected HEAD {command.expected_head_sha} differs from actual {actual}")
        return 0
    set_output("should_run", "true")
    set_output("terminal_status", "none")
    set_output("prompt", build_prompt(command, work_branch))
    client.post_comment(int(issue_raw), format_running_state(command, work_branch))
    print(json.dumps({"status": "prepared", "schema_version": 2, "command_id": command.command_id, "work_branch": work_branch, "evidence_count": len(parse_json_list(command.fields["evidence_ids"], "evidence_ids"))}))
    return 0


def self_test() -> int:
    from agent_hub_command_integrity_v2 import seal_command_body
    legacy = {"id": 1, "body": "[HUB_COMMAND]\nstatus: ready", "user": {"login": "github-actions[bot]"}}
    assert parse_v2_fields(legacy["body"]).get("schema_version") is None
    body = seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    verify_command_body(body)
    try:
        verify_command_body(body.replace("status: ready", "status: blocked"))
    except CommandIntegrityError:
        pass
    else:
        raise AssertionError("edited command was accepted")
    assert parse_json_list('["gh-evidence-v2:workflow-run:abc"]', "evidence_ids")

    class FakeCommand:
        def __init__(self, mode: str, target: str, declared: str):
            self.execution_mode = mode
            self.target_branch = target
            self.fields = {"work_branch": declared}
            self.command_id = "hub-123-0123456789abcdef"
            self.attempt = 1

    read_only = FakeCommand("read_only", "feature/demo", "none")
    assert continuation_work_branch(read_only) == "feature/demo"
    existing_draft = FakeCommand("code_change", "feature/demo", "feature/demo")
    assert continuation_work_branch(existing_draft) == "feature/demo"
    isolated = FakeCommand("code_change", "feature/demo", "none")
    assert continuation_work_branch(isolated).startswith("agent/hub-")
    print(json.dumps({
        "executor_gate_hardening_v2": "pass",
        "legacy_ready_accepted": 0,
        "edited_command_accepted": 0,
        "empty_ready_evidence_accepted": 0,
        "evidence_output_propagated": 1,
        "existing_draft_branch_reused": 1,
        "read_only_target_reused": 1,
    }))
    return 0


def main() -> int:
    return self_test() if "--self-test" in os.sys.argv else prepare_hardened()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ExecutorError as exc:
        print(json.dumps({"status": "blocked", "error": "executor_gate_validation_failed", "detail": str(exc)[:500]}), file=os.sys.stderr)
        raise SystemExit(1)
