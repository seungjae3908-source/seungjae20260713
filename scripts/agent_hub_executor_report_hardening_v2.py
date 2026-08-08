#!/usr/bin/env python3
"""Executor report adapter for safe, event-driven Agent Hub continuation."""
from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import agent_hub_executor_report_v2 as base
from agent_hub_command_integrity_v2 import CommandIntegrityError, verify_command_body
from agent_hub_contract_v2 import (
    EXECUTOR_PROCESSED_PREFIX,
    EXECUTOR_REPORT_MARKER,
    REPORT_MARKER,
    SCHEMA_VERSION,
    STATE_MARKER,
    parse_key_values,
)
from agent_hub_executor import ExecutorError, read_event_command_id
from agent_hub_executor_gate_hardening_v2 import READ_ONLY_COMPLETE_MARKER, READ_ONLY_INCOMPLETE_MARKER
from agent_hub_github_validation_v2 import REQUIRED_STATUS_CONTEXTS

GITHUB_API_VERSION = "2022-11-28"
REPORT_READY_EVENT = "agent-executor-report-ready"


def _sha(value: str, field: str) -> str:
    value = base.clean(value, 40).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise base.ReportError(f"{field} must be a full SHA")
    return value


def _positive_int_or_none(value: str) -> str:
    value = base.clean(value, 40).lower()
    return value if value.isdigit() and int(value) > 0 else "none"


def _effective_status(env: dict[str, str]) -> str:
    result = base.clean(env.get("RESULT_STATUS", "failed"), 40).lower()
    execution_mode = base.clean(env.get("EXECUTION_MODE", "read_only"), 40).lower()
    if result == "completed":
        if execution_mode == "read_only":
            summary = base.clean(env.get("SUMMARY", ""), 4000)
            changed_files = base.parse_changed_files(env.get("CHANGED_FILES", ""))
            pr_url = base.clean(env.get("PR_URL", "none"), 500).lower()
            source_ci_run_id = _positive_int_or_none(env.get("SOURCE_CI_RUN_ID", "none"))
            semantic_complete = READ_ONLY_COMPLETE_MARKER in summary and READ_ONLY_INCOMPLETE_MARKER not in summary
            if changed_files or pr_url != "none":
                return "failed"
            return "completed" if semantic_complete and source_ci_run_id != "none" else "partial"
        return "partial"
    if result in {"partial", "blocked", "waiting_approval", "failed"}:
        return result
    return "failed"


def build_report(env: dict[str, str]) -> str:
    command_id = base.clean(env.get("COMMAND_ID", ""), 120)
    source_task_id = base.clean(env.get("SOURCE_TASK_ID", ""), 180)
    worker = base.clean(env.get("TARGET_WORKER", ""), 64)
    repository = base.clean(env.get("GITHUB_REPOSITORY", ""), 200)
    original_target_branch = base.clean(env.get("TARGET_BRANCH", ""), 180)
    report_base_branch = base.clean(env.get("REPORT_BASE_BRANCH", "main"), 180)
    report_branch = base.clean(env.get("REPORT_BRANCH", original_target_branch), 180)
    base_sha = _sha(env.get("REPORT_BASE_SHA", env.get("CONTROL_PLANE_SHA", "")), "BASE_SHA")
    head_sha = _sha(env.get("REPORT_HEAD_SHA", env.get("HEAD_SHA", "")), "HEAD_SHA")
    execution_mode = base.clean(env.get("EXECUTION_MODE", "read_only"), 40).lower()
    pr_url = base.clean(env.get("PR_URL", "none"), 500)
    changed_files = base.parse_changed_files(env.get("CHANGED_FILES", ""))
    checks = base.clean(env.get("CHECKS", "not reported"), 4000)
    executor_run_id = _positive_int_or_none(env.get("EXECUTOR_RUN_ID", env.get("GITHUB_RUN_ID", "none")))
    source_ci_run_id = _positive_int_or_none(env.get("SOURCE_CI_RUN_ID", "none"))
    summary = base.clean(env.get("SUMMARY", "No executor summary."), 1800)
    failure = base.clean(env.get("FAILURE_SIGNATURE", ""), 500)
    auto_step = base.clean(env.get("AUTO_STEP", "1"), 8)
    if not command_id or not source_task_id or not worker or "/" not in repository:
        raise base.ReportError("required executor report context is missing")
    if report_base_branch != "main":
        raise base.ReportError("executor report base branch must be main")
    if not original_target_branch or not report_branch:
        raise base.ReportError("report branch context is missing")

    status = _effective_status(env)
    pr_number = base.parse_pr_number(pr_url)
    if status == "completed":
        remaining = "none"
        approval_required = "no"
    elif status == "partial":
        remaining = (
            "Read checks, remaining work, and current branch or Draft PR evidence; choose and execute the next safe task. "
            "Stop only when deterministic policy requires approval or blocks the action."
        )
        approval_required = "no"
    elif status == "waiting_approval":
        remaining = "User approval is required before any approval-gated continuation."
        approval_required = "yes"
    else:
        remaining = (
            "Analyze the recorded failure without repeating the same command automatically. "
            "Do not weaken validation or reuse stale evidence."
        )
        approval_required = "no"

    command_comment_id = _positive_int_or_none(env.get("COMMAND_COMMENT_ID", "none"))
    control_plane_sha = _sha(env.get("CONTROL_PLANE_SHA", base_sha), "CONTROL_PLANE_SHA")
    verified_target_sha = _sha(env.get("VERIFIED_TARGET_SHA", env.get("BASE_SHA", head_sha)), "VERIFIED_TARGET_SHA")
    checks = base.clean(
        f"{checks}; command_comment_id={command_comment_id}; control_plane_sha={control_plane_sha}; "
        f"verified_base_sha={base_sha}; verified_target_sha={verified_target_sha}; execution_mode={execution_mode}",
        4000,
    )
    if executor_run_id != "none":
        checks = base.clean(f"executor_run_id={executor_run_id}; {checks}", 4000)

    task_id = f"{source_task_id}-exec-{command_id.split('-')[-1][:12]}"[:180]
    lines = [
        REPORT_MARKER,
        f"schema_version: {SCHEMA_VERSION}",
        f"task_id: {task_id}",
        f"root_task_id: {source_task_id}",
        f"worker: {worker}",
        f"repository: {repository}",
        f"base_branch: {report_base_branch}",
        f"base_sha: {base_sha}",
        f"branch: {report_branch}",
        f"status: {status}",
        f"head_sha: {head_sha}",
        f"pr_number: {pr_number}",
        "changed_files: " + json.dumps(changed_files, ensure_ascii=False, separators=(",", ":")),
        f"checks: {checks}",
        f"ci_run_id: {source_ci_run_id}",
        f"summary: {summary}",
        f"remaining: {remaining}",
        "dependencies: none",
        "conflicts: none",
        f"approval_required: {approval_required}",
        "prohibited_actions_confirmed: no main write, merge, rebase, cherry-pick, deploy, server, DB, Supabase, Secret, permission, deletion, paid fallback, live account, live order, live cancellation, or live position action performed",
        f"target_branch: {report_branch}",
        f"auto_step: {auto_step}",
    ]
    if failure:
        lines.append(f"failure_signature: {failure}")
    lines.extend([EXECUTOR_REPORT_MARKER, f"{EXECUTOR_PROCESSED_PREFIX}{command_id} -->"])
    return "\n".join(lines)


def build_terminal_state(env: dict[str, str]) -> str:
    command_id = base.clean(env.get("COMMAND_ID", ""), 120)
    source_task_id = base.clean(env.get("SOURCE_TASK_ID", ""), 180)
    worker = base.clean(env.get("TARGET_WORKER", ""), 64)
    if not command_id or not source_task_id or not worker:
        raise base.ReportError("terminal state context is missing")
    report_status = _effective_status(env)
    if report_status == "completed":
        status = "completed"
        reason = "Executor completed the validated safe command and posted a completed continuation report."
    elif report_status == "failed":
        status = "failed"
        reason = "Executor command failed and posted a failure report for safe analysis."
    else:
        status = "blocked"
        reason = f"Executor report status is {report_status}; the command lifecycle is closed without claiming completion."
    return "\n".join([
        STATE_MARKER,
        f"schema_version: {SCHEMA_VERSION}",
        f"command_id: {command_id}",
        f"source_task_id: {source_task_id}",
        f"target_worker: {worker}",
        f"status: {status}",
        f"reason: {reason}",
    ])


def _github_json(token: str, repository: str, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"https://api.github.com/repos/{repository}{path}"
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "agent-hub-executor-report-hardening-v2/1.0",
        },
        method=method,
    )
    try:
        with urlopen(request, timeout=45) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise base.ReportError(f"GitHub HTTP {exc.code}: {detail[:700]}") from exc
    except (URLError, json.JSONDecodeError) as exc:
        raise base.ReportError(f"GitHub request failed: {exc}") from exc


def _required_statuses_success(token: str, repository: str, sha: str) -> bool:
    payload = _github_json(token, repository, "GET", f"/commits/{sha}/status")
    statuses = payload.get("statuses") if isinstance(payload, dict) else None
    if not isinstance(statuses, list):
        return False
    latest: dict[str, str] = {}
    for item in statuses:
        if isinstance(item, dict):
            context = str(item.get("context") or "")
            if context and context not in latest:
                latest[context] = str(item.get("state") or "")
    return all(latest.get(context) == "success" for context in REQUIRED_STATUS_CONTEXTS)


def _source_ci_run_id(token: str, repository: str, source_fields: dict[str, str], target_sha: str) -> str:
    ci_run_id = _positive_int_or_none(source_fields.get("ci_run_id", "none"))
    if ci_run_id == "none":
        return "none"
    run = _github_json(token, repository, "GET", f"/actions/runs/{ci_run_id}")
    if not isinstance(run, dict):
        return "none"
    run_repository = run.get("repository") if isinstance(run.get("repository"), dict) else {}
    if (
        str(run.get("status") or "") != "completed"
        or str(run.get("conclusion") or "") != "success"
        or str(run.get("head_sha") or "").lower() != target_sha
        or (str(run_repository.get("full_name") or "") not in {"", repository})
    ):
        return "none"
    return ci_run_id if _required_statuses_success(token, repository, target_sha) else "none"


def _resolve_command_context(env: dict[str, str], token: str, repository: str, control_plane_sha: str, target_sha: str) -> dict[str, str]:
    issue_raw = base.clean(env.get("HUB_ISSUE_NUMBER", "62"), 20)
    if not issue_raw.isdigit():
        raise base.ReportError("HUB_ISSUE_NUMBER must be numeric")
    try:
        command_comment_id = read_event_command_id(env.get("GITHUB_EVENT_PATH", ""), int(issue_raw))
    except ExecutorError as exc:
        raise base.ReportError("executor event command identity is invalid") from exc
    if command_comment_id is None:
        return {"command_comment_id": "none", "source_ci_run_id": "none"}
    command_payload = _github_json(token, repository, "GET", f"/issues/comments/{command_comment_id}")
    if not isinstance(command_payload, dict):
        raise base.ReportError("exact command comment was not found")
    if str((command_payload.get("user") or {}).get("login") or "") != "github-actions[bot]":
        raise base.ReportError("exact command comment author is untrusted")
    command_body = str(command_payload.get("body") or "")
    try:
        verify_command_body(command_body)
    except CommandIntegrityError as exc:
        raise base.ReportError("exact command body integrity validation failed") from exc
    fields = parse_key_values(command_body)
    expected = {
        "command_id": base.clean(env.get("COMMAND_ID", ""), 120),
        "source_task_id": base.clean(env.get("SOURCE_TASK_ID", ""), 180),
        "repository": repository,
        "base_branch": "main",
        "base_sha": control_plane_sha,
        "target_branch": base.clean(env.get("TARGET_BRANCH", ""), 180),
        "expected_head_sha": target_sha,
        "execution_mode": base.clean(env.get("EXECUTION_MODE", "read_only"), 40),
    }
    for key, value in expected.items():
        if fields.get(key, "").strip().lower() != value.strip().lower():
            raise base.ReportError(f"exact command runtime identity mismatch: {key}")
    source_report_id = fields.get("source_report_comment_id", "").strip()
    if not source_report_id.isdigit():
        raise base.ReportError("source report comment identity is invalid")
    source_payload = _github_json(token, repository, "GET", f"/issues/comments/{source_report_id}")
    if not isinstance(source_payload, dict):
        raise base.ReportError("source report comment was not found")
    source_fields = parse_key_values(str(source_payload.get("body") or ""))
    source_expected = {
        "repository": repository,
        "base_branch": "main",
        "base_sha": control_plane_sha,
        "branch": expected["target_branch"],
        "head_sha": target_sha,
    }
    for key, value in source_expected.items():
        if source_fields.get(key, "").strip().lower() != value.strip().lower():
            raise base.ReportError(f"source report runtime identity mismatch: {key}")
    return {
        "command_comment_id": str(command_comment_id),
        "source_ci_run_id": _source_ci_run_id(token, repository, source_fields, target_sha),
    }


def _validate_current_pr(token: str, repository: str, pr_url: str, branch: str, head_sha: str) -> None:
    number = base.parse_pr_number(pr_url)
    if number == "none":
        raise base.ReportError("current PR URL is invalid")
    payload = _github_json(token, repository, "GET", f"/pulls/{number}")
    if not isinstance(payload, dict):
        raise base.ReportError("current execution PR was not found")
    head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
    head_repo = head.get("repo") if isinstance(head.get("repo"), dict) else {}
    if (
        str(payload.get("state") or "") != "open"
        or not bool(payload.get("draft"))
        or bool(payload.get("merged"))
        or str(head.get("ref") or "") != branch
        or str(head.get("sha") or "").lower() != head_sha
        or str(head_repo.get("full_name") or "") != repository
    ):
        raise base.ReportError("current execution PR identity mismatch")


def _enrich_context(env: dict[str, str], token: str) -> dict[str, str]:
    result = dict(env)
    repository = base.clean(result.get("GITHUB_REPOSITORY", ""), 200)
    target_branch = base.clean(result.get("TARGET_BRANCH", ""), 180)
    work_branch = base.clean(result.get("WORK_BRANCH", ""), 180)
    if "/" not in repository or not target_branch:
        raise base.ReportError("repository or target branch context is missing")
    branch_hint = work_branch if work_branch and work_branch != "none" else target_branch
    control_plane_sha = _sha(result.get("CONTROL_PLANE_SHA", ""), "CONTROL_PLANE_SHA")
    target_sha = _sha(result.get("BASE_SHA", ""), "VERIFIED_TARGET_SHA")
    head_sha = _sha(result.get("HEAD_SHA", target_sha), "HEAD_SHA")
    result["REPORT_BASE_BRANCH"] = "main"
    result["REPORT_BASE_SHA"] = control_plane_sha
    result["REPORT_BRANCH"] = branch_hint
    result["REPORT_HEAD_SHA"] = head_sha
    result["VERIFIED_TARGET_SHA"] = target_sha
    context = _resolve_command_context(result, token, repository, control_plane_sha, target_sha)
    result["COMMAND_COMMENT_ID"] = context["command_comment_id"]
    result["SOURCE_CI_RUN_ID"] = context["source_ci_run_id"]

    pr_url = base.clean(result.get("PR_URL", "none"), 500)
    execution_mode = base.clean(result.get("EXECUTION_MODE", "read_only"), 40).lower()
    if pr_url != "none":
        _validate_current_pr(token, repository, pr_url, branch_hint, head_sha)
    if execution_mode == "read_only" and (pr_url != "none" or base.parse_changed_files(result.get("CHANGED_FILES", ""))):
        result["RESULT_STATUS"] = "failed"
        if not base.clean(result.get("FAILURE_SIGNATURE", ""), 500):
            result["FAILURE_SIGNATURE"] = "read_only_runtime_mutation_evidence"
    return result


def _dispatch_coordinator(token: str, repository: str) -> None:
    _github_json(token, repository, "POST", "/dispatches", {"event_type": REPORT_READY_EVENT})


def self_test() -> int:
    read_only = {
        "COMMAND_ID": "hub-123-0123456789abcdef",
        "SOURCE_TASK_ID": "task",
        "TARGET_WORKER": "test-runner",
        "GITHUB_REPOSITORY": "owner/repo",
        "TARGET_BRANCH": "feature/test",
        "WORK_BRANCH": "feature/test",
        "CONTROL_PLANE_SHA": "a" * 40,
        "REPORT_BASE_BRANCH": "main",
        "REPORT_BASE_SHA": "a" * 40,
        "BASE_SHA": "b" * 40,
        "REPORT_BRANCH": "feature/test",
        "REPORT_HEAD_SHA": "b" * 40,
        "HEAD_SHA": "b" * 40,
        "RESULT_STATUS": "completed",
        "EXECUTION_MODE": "read_only",
        "PR_URL": "none",
        "CHANGED_FILES": "[]",
        "SOURCE_CI_RUN_ID": "42",
        "COMMAND_COMMENT_ID": "12345",
        "EXECUTOR_RUN_ID": "123",
        "SUMMARY": "Repository content inspection completed safely. " + READ_ONLY_COMPLETE_MARKER,
        "AUTO_STEP": "1",
    }
    body = build_report(read_only)
    assert "status: completed" in body and "base_sha: " + "a" * 40 in body
    assert "head_sha: " + "b" * 40 in body and "changed_files: []" in body and "pr_number: none" in body
    assert "ci_run_id: 42" in body and "command_comment_id=12345" in body
    assert "status: completed" in build_terminal_state(read_only)

    partial = {**read_only, "SUMMARY": "Repository content inspection incomplete. " + READ_ONLY_INCOMPLETE_MARKER}
    assert "status: partial" in build_report(partial)
    terminal_partial = build_terminal_state(partial)
    assert "status: blocked" in terminal_partial and "status: completed" not in terminal_partial

    failed = {**read_only, "RESULT_STATUS": "failed", "SUMMARY": "validation failed", "FAILURE_SIGNATURE": "inspect_repository:bbbb:failed"}
    assert "status: failed" in build_report(failed) and "status: failed" in build_terminal_state(failed)

    code_change = {
        **read_only,
        "EXECUTION_MODE": "code_change",
        "PR_URL": "https://github.com/owner/repo/pull/9",
        "CHANGED_FILES": '["tests/current.py"]',
        "REPORT_BRANCH": "agent/hub-work",
        "REPORT_HEAD_SHA": "c" * 40,
        "HEAD_SHA": "c" * 40,
    }
    code_body = build_report(code_change)
    assert "status: partial" in code_body and "pr_number: 9" in code_body and 'changed_files: ["tests/current.py"]' in code_body
    assert "base_sha: " + "a" * 40 in code_body and "status: blocked" in build_terminal_state(code_change)

    no_ci = {**read_only, "SOURCE_CI_RUN_ID": "none"}
    assert "status: partial" in build_report(no_ci)

    original_github_json = globals()["_github_json"]
    calls: list[str] = []
    def fake_github_json(token: str, repository: str, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        calls.append(path)
        if path == "/pulls/9":
            return {
                "number": 9, "state": "open", "draft": True, "merged": False,
                "base": {"ref": "feature/test", "sha": "9" * 40, "repo": {"full_name": repository}},
                "head": {"ref": "agent/hub-work", "sha": "c" * 40, "repo": {"full_name": repository}},
            }
        raise AssertionError(f"unexpected GitHub lookup: {path}")
    globals()["_github_json"] = fake_github_json
    try:
        _validate_current_pr("token", "owner/repo", "https://github.com/owner/repo/pull/9", "agent/hub-work", "c" * 40)
        assert calls == ["/pulls/9"]
    finally:
        globals()["_github_json"] = original_github_json

    source = __import__("pathlib").Path(__file__).read_text(encoding="utf-8")
    assert "_discover_draft_pr" not in source and "pulls?state=open&head" not in source
    assert "SOURCE_CI_RUN_ID" in source and "CONTROL_PLANE_SHA" in source
    print(json.dumps({
        "executor_report_hardening_v2": "pass",
        "read_only_completed_lifecycle": 1,
        "partial_completed_mismatch": 0,
        "failed_lifecycle": 1,
        "stale_draft_pr_overwrites": 0,
        "current_pr_exact_reference": 1,
        "runtime_base_sha_priority": 1,
        "runtime_changed_files_priority": 1,
        "event_driven_continuation": 1,
        "terminal_command_state_posted": 1,
        "critical_auto_actions": 0,
        "unsupported_report_fields": 0,
    }))
    return 0


def main() -> int:
    if "--self-test" in os.sys.argv:
        return self_test()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    issue = os.environ.get("HUB_ISSUE_NUMBER", "62").strip()
    if not token or "/" not in repository or not issue.isdigit():
        raise base.ReportError("GitHub report context is incomplete")
    env = _enrich_context(dict(os.environ), token)
    body = build_report(env)
    terminal_state = build_terminal_state(env)
    base.post_comment(token, repository, int(issue), body)
    base.post_comment(token, repository, int(issue), terminal_state)
    _dispatch_coordinator(token, repository)
    print(json.dumps({
        "status": "posted",
        "schema_version": 2,
        "report_status": _effective_status(env),
        "approval_required": "approval_required: yes" in body,
        "terminal_state_posted": True,
        "coordinator_dispatched": True,
        "paid_fallback": 0,
    }))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except base.ReportError as exc:
        print(json.dumps({"status": "failed", "error": base.clean(str(exc), 700)}), file=os.sys.stderr)
        raise SystemExit(1)
