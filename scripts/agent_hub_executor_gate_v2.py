#!/usr/bin/env python3
"""Schema-v2 gate for the PR #70 controlled executor.

The gate selects only authenticated schema-v2 ready commands. It delegates branch/path,
expiry, SHA and prompt construction to the existing deterministic PR #70 executor code.
Legacy HUB_COMMAND comments are invisible to this gate and can never be executed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Sequence

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
        if marker_for(PROCESSED_MARKER_PREFIX, cid) in all_body:
            continue
        if marker_for(ERROR_MARKER_PREFIX, cid) in all_body:
            continue
        try:
            return validate_command_comment(comment, policy, workers, allow_expired=True)
        except ExecutorError:
            if event_comment_id is not None:
                raise
    return None


def prepare_v2() -> int:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com").strip()
    issue_raw = os.environ.get("HUB_ISSUE_NUMBER", "").strip()
    event_path = os.environ.get("GITHUB_EVENT_PATH", "").strip()
    if not token or "/" not in repository:
        raise ExecutorError("GitHub credentials are required")
    if not issue_raw.isdigit():
        raise ExecutorError("HUB_ISSUE_NUMBER must be numeric")
    issue_number = int(issue_raw)
    policy = load_policy()
    workers = load_workers()
    client = GitHubClient(token, api_url, repository)
    comments = client.comments(issue_number)
    event_id = read_event_command_id(event_path, issue_number)
    command = pending_schema_v2_command(
        comments,
        policy=policy,
        workers=workers,
        event_comment_id=event_id,
    )
    if command is None:
        set_output("should_run", "false")
        set_output("terminal_status", "none")
        print(json.dumps({"status": "no_pending_schema_v2_command", "legacy_commands_accepted": 0}))
        return 0

    work_branch = work_branch_for(command)
    common_outputs = {
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
        "allowed_paths": command.fields["allowed_paths"],
        "forbidden_paths": command.fields["forbidden_paths"],
        "max_files": str(command.max_files),
        "max_commits": str(command.max_commits),
        "instruction": command.fields["instruction"],
        "validation": command.fields["validation"],
        "stop_conditions": command.fields["stop_conditions"],
    }
    for name, value in common_outputs.items():
        set_output(name, value)

    if command_expired(command.fields):
        set_output("should_run", "false")
        set_output("terminal_status", "expired")
        set_output("terminal_reason", "command expires_at has passed")
        return 0
    current_sha = client.branch_sha(command.target_branch)
    if current_sha != command.expected_head_sha:
        set_output("should_run", "false")
        set_output("terminal_status", "stale")
        set_output("terminal_reason", f"expected {command.expected_head_sha} but found {current_sha}")
        return 0

    set_output("should_run", "true")
    set_output("terminal_status", "none")
    set_output("prompt", build_prompt(command, work_branch))
    client.post_comment(issue_number, format_running_state(command, work_branch))
    print(
        json.dumps(
            {
                "status": "prepared",
                "schema_version": 2,
                "command_id": command.command_id,
                "worker": command.target_worker,
                "work_branch": work_branch,
            },
            ensure_ascii=False,
        )
    )
    return 0


def self_test() -> int:
    legacy = {
        "id": 1,
        "body": "[HUB_COMMAND]\ncommand_id: hub-1-0123456789abcdef\nstatus: ready",
        "user": {"login": "github-actions[bot]"},
    }
    assert parse_v2_fields(legacy["body"]).get("schema_version") is None
    print(json.dumps({"executor_gate_v2": "pass", "legacy_ready_accepted": 0}))
    return 0


def main() -> int:
    if "--self-test" in os.sys.argv:
        return self_test()
    return prepare_v2()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ExecutorError as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)[:800]}), file=os.sys.stderr)
        raise SystemExit(1)
