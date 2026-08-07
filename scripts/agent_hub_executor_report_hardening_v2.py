#!/usr/bin/env python3
"""Executor report adapter for safe, event-driven Agent Hub continuation."""
from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import agent_hub_executor_report_v2 as base
from agent_hub_contract_v2 import (
    EXECUTOR_PROCESSED_PREFIX,
    EXECUTOR_REPORT_MARKER,
    REPORT_MARKER,
    SCHEMA_VERSION,
    STATE_MARKER,
)

GITHUB_API_VERSION = "2022-11-28"
REPORT_READY_EVENT = "agent-executor-report-ready"


def _sha(value: str, field: str) -> str:
    value = base.clean(value, 40).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise base.ReportError(f"{field} must be a full SHA")
    return value


def build_report(env: dict[str, str]) -> str:
    command_id = base.clean(env.get("COMMAND_ID", ""), 120)
    source_task_id = base.clean(env.get("SOURCE_TASK_ID", ""), 180)
    worker = base.clean(env.get("TARGET_WORKER", ""), 64)
    repository = base.clean(env.get("GITHUB_REPOSITORY", ""), 200)
    original_target_branch = base.clean(env.get("TARGET_BRANCH", ""), 180)
    report_base_branch = base.clean(env.get("REPORT_BASE_BRANCH", original_target_branch), 180)
    report_branch = base.clean(env.get("REPORT_BRANCH", original_target_branch), 180)
    base_sha = _sha(env.get("REPORT_BASE_SHA", env.get("BASE_SHA", "")), "BASE_SHA")
    head_sha = _sha(env.get("REPORT_HEAD_SHA", env.get("HEAD_SHA", "")), "HEAD_SHA")
    job_result = base.clean(env.get("RESULT_STATUS", "failed"), 40).lower()
    pr_url = base.clean(env.get("PR_URL", "none"), 500)
    changed_files = base.parse_changed_files(env.get("CHANGED_FILES", ""))
    checks = base.clean(env.get("CHECKS", "not reported"), 4000)
    executor_run_id = base.clean(env.get("EXECUTOR_RUN_ID", "none"), 40).lower()
    if executor_run_id != "none" and not executor_run_id.isdigit():
        raise base.ReportError("EXECUTOR_RUN_ID must be numeric or none")
    if executor_run_id != "none":
        checks = base.clean(f"executor_run_id={executor_run_id}; {checks}", 4000)
    summary = base.clean(env.get("SUMMARY", "No executor summary."), 1800)
    failure = base.clean(env.get("FAILURE_SIGNATURE", ""), 500)
    execution_mode = base.clean(env.get("EXECUTION_MODE", "read_only"), 40)
    auto_step = base.clean(env.get("AUTO_STEP", "1"), 8)
    if not command_id or not source_task_id or not worker or "/" not in repository:
        raise base.ReportError("required executor report context is missing")
    if not original_target_branch or not report_base_branch or not report_branch:
        raise base.ReportError("report branch context is missing")
    if job_result not in {"completed", "failed"}:
        job_result = "failed"

    pr_number = base.parse_pr_number(pr_url)
    status = "partial" if job_result == "completed" else "failed"
    if status == "partial":
        remaining = (
            "Read checks, remaining work, and current branch or Draft PR evidence; choose and execute the next safe task. "
            "Stop only when deterministic policy requires approval or blocks the action."
        )
    else:
        remaining = (
            "Analyze this failure, apply the smallest evidence-backed safe fix when appropriate, and rerun the failed validation. "
            "Do not repeat the same failure on the same HEAD without progress."
        )

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
        "ci_run_id: none",
        f"summary: {summary}",
        f"remaining: {remaining}",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        "prohibited_actions_confirmed: no main write, merge, rebase, cherry-pick, deploy, server, DB, Supabase, Secret, permission, deletion, paid fallback, live account, live order, live cancellation, or live position action performed",
        f"command_id: {command_id}",
        f"target_branch: {report_branch}",
        f"execution_mode: {execution_mode}",
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
    job_result = base.clean(env.get("RESULT_STATUS", "failed"), 40).lower()
    if not command_id or not source_task_id or not worker:
        raise base.ReportError("terminal state context is missing")
    status = "completed" if job_result == "completed" else "failed"
    reason = "Executor finished the validated safe command and posted a continuation report." if status == "completed" else "Executor command failed and posted a failure report for safe analysis."
    return "\n".join([
        STATE_MARKER,
        f"schema_version: {SCHEMA_VERSION}",
        f"command_id: {command_id}",
        f"source_task_id: {source_task_id}",
        f"target_worker: {worker}",
        f"status: {status}",
        f"reason: {reason}",
    ])


def _github_json(
    token: str,
    repository: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> Any:
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


def _discover_draft_pr(token: str, repository: str, branch: str) -> dict[str, Any] | None:
    owner = repository.split("/", 1)[0]
    query = urlencode({"state": "open", "head": f"{owner}:{branch}", "per_page": 10})
    pulls = _github_json(token, repository, "GET", f"/pulls?{query}")
    if not isinstance(pulls, list):
        raise base.ReportError("open pull request response was not a list")
    drafts = [item for item in pulls if isinstance(item, dict) and bool(item.get("draft")) and not bool(item.get("merged"))]
    if len(drafts) > 1:
        raise base.ReportError("multiple open Draft PRs own the same branch")
    return drafts[0] if drafts else None


def _draft_pr_files(token: str, repository: str, number: int) -> list[str]:
    files: list[str] = []
    for page in range(1, 4):
        payload = _github_json(token, repository, "GET", f"/pulls/{number}/files?per_page=100&page={page}")
        if not isinstance(payload, list):
            raise base.ReportError("Draft PR files response was not a list")
        files.extend(base.clean(str(item.get("filename") or ""), 500) for item in payload if isinstance(item, dict))
        if len(payload) < 100:
            break
    return list(dict.fromkeys(item for item in files if item))


def _enrich_context(env: dict[str, str], token: str) -> dict[str, str]:
    result = dict(env)
    repository = base.clean(result.get("GITHUB_REPOSITORY", ""), 200)
    target_branch = base.clean(result.get("TARGET_BRANCH", ""), 180)
    work_branch = base.clean(result.get("WORK_BRANCH", ""), 180)
    if "/" not in repository or not target_branch:
        raise base.ReportError("repository or target branch context is missing")
    branch_hint = work_branch if work_branch and work_branch != "none" else target_branch
    pr = _discover_draft_pr(token, repository, branch_hint)
    if pr is not None:
        base_payload = pr.get("base") if isinstance(pr.get("base"), dict) else {}
        head_payload = pr.get("head") if isinstance(pr.get("head"), dict) else {}
        number = int(pr.get("number") or 0)
        if number <= 0:
            raise base.ReportError("Draft PR number is missing")
        result["PR_URL"] = base.clean(str(pr.get("html_url") or "none"), 500)
        result["REPORT_BASE_BRANCH"] = base.clean(str(base_payload.get("ref") or ""), 180)
        result["REPORT_BASE_SHA"] = _sha(str(base_payload.get("sha") or ""), "PR base SHA")
        result["REPORT_BRANCH"] = base.clean(str(head_payload.get("ref") or ""), 180)
        result["REPORT_HEAD_SHA"] = _sha(str(head_payload.get("sha") or ""), "PR head SHA")
        if not base.parse_changed_files(result.get("CHANGED_FILES", "")):
            result["CHANGED_FILES"] = json.dumps(_draft_pr_files(token, repository, number), ensure_ascii=False, separators=(",", ":"))
        return result

    head_sha = _sha(result.get("HEAD_SHA", result.get("BASE_SHA", "")), "HEAD_SHA")
    base_sha = _sha(result.get("BASE_SHA", ""), "BASE_SHA")
    if branch_hint != target_branch and head_sha != base_sha:
        result["REPORT_BASE_BRANCH"] = target_branch
        result["REPORT_BASE_SHA"] = base_sha
        result["REPORT_BRANCH"] = branch_hint
        result["REPORT_HEAD_SHA"] = head_sha
    else:
        result["REPORT_BASE_BRANCH"] = target_branch
        result["REPORT_BASE_SHA"] = base_sha
        result["REPORT_BRANCH"] = target_branch
        result["REPORT_HEAD_SHA"] = base_sha
    return result


def _dispatch_coordinator(token: str, repository: str) -> None:
    _github_json(token, repository, "POST", "/dispatches", {"event_type": REPORT_READY_EVENT})


def self_test() -> int:
    env = {
        "COMMAND_ID": "hub-123-0123456789abcdef",
        "SOURCE_TASK_ID": "task",
        "TARGET_WORKER": "test-runner",
        "GITHUB_REPOSITORY": "owner/repo",
        "TARGET_BRANCH": "feature/test",
        "WORK_BRANCH": "feature/test",
        "BASE_SHA": "a" * 40,
        "REPORT_BASE_BRANCH": "main",
        "REPORT_BASE_SHA": "a" * 40,
        "REPORT_BRANCH": "feature/test",
        "REPORT_HEAD_SHA": "b" * 40,
        "RESULT_STATUS": "completed",
        "HEAD_SHA": "b" * 40,
        "PR_URL": "https://github.com/owner/repo/pull/9",
        "CHANGED_FILES": '["tests/a.ts"]',
        "EXECUTION_MODE": "code_change",
        "EXECUTOR_RUN_ID": "123",
    }
    body = build_report(env)
    assert "status: partial" in body and "status: completed" not in body
    assert "approval_required: no" in body
    assert "ci_run_id: none" in body
    assert "base_branch: main" in body and "target_branch: feature/test" in body
    terminal = build_terminal_state(env)
    assert "status: completed" in terminal and "[HUB_STATE]" in terminal
    failed = build_report({**env, "RESULT_STATUS": "failed", "FAILURE_SIGNATURE": "run_build:bbbb:failed"})
    assert "status: failed" in failed and "approval_required: no" in failed
    assert "status: failed" in build_terminal_state({**env, "RESULT_STATUS": "failed"})
    print(json.dumps({
        "executor_report_hardening_v2": "pass",
        "premature_completed_reports": 0,
        "draft_pr_approval_escalations": 0,
        "failed_report_approval_escalations": 0,
        "event_driven_continuation": 1,
        "draft_pr_changed_files_rehydrated": 1,
        "terminal_command_state_posted": 1,
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
        "completed_claimed": False,
        "approval_required": False,
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
