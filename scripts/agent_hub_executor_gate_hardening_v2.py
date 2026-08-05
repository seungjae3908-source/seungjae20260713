#!/usr/bin/env python3
"""Schema-v2 executor gate with immutable command comment verification."""
from __future__ import annotations

import json
import os
from typing import Any, Sequence

import agent_hub_executor_gate_v2 as base_gate
from agent_hub_command_integrity_v2 import CommandIntegrityError, verify_command_body
from agent_hub_contract_v2 import SCHEMA_VERSION, parse_key_values as parse_v2_fields
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
    comments: Sequence[dict[str, Any]],
    *,
    policy: dict[str, Any],
    workers: dict[str, Any],
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
            return validate_command_comment(comment, policy, workers, allow_expired=True)
        except (ExecutorError, CommandIntegrityError):
            if event_comment_id is not None:
                raise ExecutorError("schema-v2 command integrity validation failed")
    return None


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
        set_output("should_run", "false"); set_output("terminal_status", "none")
        print(json.dumps({"status":"no_pending_schema_v2_command","legacy_commands_accepted":0,"edited_commands_accepted":0}))
        return 0
    work_branch = work_branch_for(command)
    outputs = {
        "command_comment_id":str(command.comment_id), "command_id":command.command_id,
        "source_task_id":command.source_task_id, "target_worker":command.target_worker,
        "target_branch":command.target_branch, "expected_head_sha":command.expected_head_sha,
        "work_branch":work_branch, "action_type":command.action_type, "execution_mode":command.execution_mode,
        "attempt":str(command.attempt), "max_attempts":str(command.max_attempts),
        "allowed_paths":command.fields["allowed_paths"], "forbidden_paths":command.fields["forbidden_paths"],
        "max_files":str(command.max_files), "max_commits":str(command.max_commits),
        "instruction":command.fields["instruction"], "validation":command.fields["validation"],
        "stop_conditions":command.fields["stop_conditions"],
    }
    for name, value in outputs.items(): set_output(name, value)
    if command_expired(command.fields):
        set_output("should_run", "false"); set_output("terminal_status", "expired"); set_output("terminal_reason", "command expiry reached")
        return 0
    actual = client.branch_sha(command.target_branch)
    if actual != command.expected_head_sha:
        set_output("should_run", "false"); set_output("terminal_status", "stale"); set_output("terminal_reason", "expected HEAD no longer matches")
        return 0
    set_output("should_run", "true"); set_output("terminal_status", "none"); set_output("prompt", build_prompt(command, work_branch))
    client.post_comment(int(issue_raw), format_running_state(command, work_branch))
    print(json.dumps({"status":"prepared","schema_version":2,"command_id":command.command_id,"work_branch":work_branch}))
    return 0


def self_test() -> int:
    from agent_hub_command_integrity_v2 import seal_command_body
    legacy = {"id":1,"body":"[HUB_COMMAND]\nstatus: ready","user":{"login":"github-actions[bot]"}}
    assert parse_v2_fields(legacy["body"]).get("schema_version") is None
    body = seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    verify_command_body(body)
    try:
        verify_command_body(body.replace("status: ready", "status: blocked"))
    except CommandIntegrityError:
        pass
    else:
        raise AssertionError("edited command was accepted")
    print(json.dumps({"executor_gate_hardening_v2":"pass","legacy_ready_accepted":0,"edited_command_accepted":0}))
    return 0


def main() -> int:
    return self_test() if "--self-test" in os.sys.argv else prepare_hardened()

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ExecutorError:
        print(json.dumps({"status":"blocked","error":"executor_gate_validation_failed"}), file=os.sys.stderr)
        raise SystemExit(1)
