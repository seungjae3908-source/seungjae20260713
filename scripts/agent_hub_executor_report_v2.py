#!/usr/bin/env python3
"""Post schema-v2 executor reports to Issue #62.

The script consumes only fixed workflow outputs. It never reads secrets beyond the
GitHub token used to post the report and never performs repository writes.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from agent_hub_contract_v2 import EXECUTOR_PROCESSED_PREFIX, EXECUTOR_REPORT_MARKER, REPORT_MARKER, SCHEMA_VERSION

GITHUB_API_VERSION = "2022-11-28"
ALLOWED_STATUSES = {"completed", "partial", "blocked", "failed", "waiting_approval"}


class ReportError(RuntimeError):
    pass


def clean(value: str, limit: int = 1800) -> str:
    value = re.sub(r"[\r\n\t]+", " ", value or "").strip()
    value = re.sub(r"\s{2,}", " ", value)
    return value[:limit]


def parse_pr_number(url: str) -> str:
    match = re.search(r"/pull/(\d+)(?:$|[/?#])", url or "")
    return match.group(1) if match else "none"


def parse_changed_files(raw: str) -> list[str]:
    raw = raw.strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = []
        if isinstance(value, list):
            return [clean(str(item), 500) for item in value if clean(str(item), 500)]
    return [clean(item, 500) for item in re.split(r"[,;|\n]", raw) if clean(item, 500)]


def build_report(env: dict[str, str]) -> str:
    command_id = clean(env.get("COMMAND_ID", ""), 120)
    source_task_id = clean(env.get("SOURCE_TASK_ID", ""), 180)
    worker = clean(env.get("TARGET_WORKER", ""), 64)
    repository = clean(env.get("GITHUB_REPOSITORY", ""), 200)
    target_branch = clean(env.get("TARGET_BRANCH", ""), 180)
    work_branch = clean(env.get("WORK_BRANCH", ""), 180)
    base_sha = clean(env.get("BASE_SHA", "none"), 40).lower()
    result = clean(env.get("RESULT_STATUS", "failed"), 40).lower()
    head_sha = clean(env.get("HEAD_SHA", "none"), 40).lower()
    ci_run_id = clean(env.get("CI_RUN_ID", "none"), 40).lower()
    pr_url = clean(env.get("PR_URL", "none"), 500)
    changed_files = parse_changed_files(env.get("CHANGED_FILES", ""))
    checks = clean(env.get("CHECKS", "not reported"), 4000)
    summary = clean(env.get("SUMMARY", "No executor summary."), 1800)
    failure = clean(env.get("FAILURE_SIGNATURE", ""), 500)
    execution_mode = clean(env.get("EXECUTION_MODE", "read_only"), 40)
    auto_step = clean(env.get("AUTO_STEP", "1"), 8)
    if not command_id or not source_task_id or not worker or "/" not in repository or not target_branch:
        raise ReportError("required executor report context is missing")
    if result not in {"completed", "blocked", "failed", "stale", "expired"}:
        result = "failed"
    status = result
    pr_number = parse_pr_number(pr_url)
    approval_required = "yes" if pr_number != "none" else "no"
    remaining = "User review of the Draft PR is required before any continuation." if pr_number != "none" else "none"
    if result != "completed":
        remaining = "Analyze the recorded failure without repeating the same command automatically."
        approval_required = "yes" if failure else "no"
    if head_sha != "none" and not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise ReportError("HEAD_SHA must be a 40-character SHA or none")
    if base_sha != "none" and not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        raise ReportError("BASE_SHA must be a 40-character SHA or none")
    if ci_run_id != "none" and (not ci_run_id.isdigit() or int(ci_run_id) <= 0):
        raise ReportError("CI_RUN_ID must be numeric or none")
    if result == "completed" and (head_sha == "none" or ci_run_id == "none"):
        raise ReportError("completed executor report requires head_sha and ci_run_id")
    branch = work_branch if work_branch and work_branch != "none" else target_branch
    task_id = f"{source_task_id}-exec-{command_id.split(chr(45))[-1][:12]}"[:180]
    lines = [
        REPORT_MARKER,
        f"schema_version: {SCHEMA_VERSION}",
        f"task_id: {task_id}",
        f"root_task_id: {source_task_id}",
        f"worker: {worker}",
        f"repository: {repository}",
        "base_branch: main",
        f"base_sha: {base_sha}",
        f"branch: {branch}",
        f"status: {status}",
        f"head_sha: {head_sha}",
        f"pr_number: {pr_number}",
        "changed_files: " + json.dumps(changed_files, ensure_ascii=False, separators=(",", ":")),
        f"checks: {checks}",
        f"ci_run_id: {ci_run_id}",
        f"summary: {summary}",
        f"remaining: {remaining}",
        "dependencies: none",
        "conflicts: none",
        f"approval_required: {approval_required}",
        "prohibited_actions_confirmed: no main write, merge, rebase, cherry-pick, deploy, server, DB, Supabase, Secret, permission, deletion, paid fallback, live account, live order, live cancellation, or live position action performed",
        f"command_id: {command_id}",
        f"target_branch: {target_branch}",
        f"execution_mode: {execution_mode}",
        f"auto_step: {auto_step}",
    ]
    if failure:
        lines.append(f"failure_signature: {failure}")
    lines.extend([EXECUTOR_REPORT_MARKER, f"{EXECUTOR_PROCESSED_PREFIX}{command_id} -->"])
    return "\n".join(lines)


def post_comment(token: str, repository: str, issue_number: int, body: str) -> None:
    url = f"https://api.github.com/repos/{repository}/issues/{issue_number}/comments"
    request = Request(
        url,
        data=json.dumps({"body": body}, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "agent-hub-executor-report-v2/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=45) as response:
            if response.status not in {200, 201}:
                raise ReportError(f"unexpected GitHub status {response.status}")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ReportError(f"GitHub HTTP {exc.code}: {detail[:700]}") from exc
    except URLError as exc:
        raise ReportError(f"GitHub request failed: {exc}") from exc


def self_test() -> int:
    env = {
        "COMMAND_ID": "hub-123-0123456789abcdef",
        "SOURCE_TASK_ID": "task-1",
        "TARGET_WORKER": "test-runner",
        "GITHUB_REPOSITORY": "owner/repo",
        "TARGET_BRANCH": "feature/test",
        "WORK_BRANCH": "agent/hub-hub-123-0123456789abcdef-a1",
        "BASE_SHA": "a" * 40,
        "RESULT_STATUS": "completed",
        "HEAD_SHA": "b" * 40,
        "CI_RUN_ID": "12345678",
        "PR_URL": "https://github.com/owner/repo/pull/9",
        "CHANGED_FILES": '["tests/a.ts"]',
        "CHECKS": "typecheck=success",
        "SUMMARY": "done",
        "EXECUTION_MODE": "code_change",
        "AUTO_STEP": "1",
    }
    body = build_report(env)
    assert "schema_version: 2" in body
    assert "pr_number: 9" in body
    assert "approval_required: yes" in body
    assert "actual" not in body.lower()
    print(json.dumps({"executor_report_v2": "pass", "schema_version": 2}))
    return 0


def main() -> int:
    if "--self-test" in os.sys.argv:
        return self_test()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    issue_raw = os.environ.get("HUB_ISSUE_NUMBER", "62").strip()
    if not token or "/" not in repository or not issue_raw.isdigit():
        raise ReportError("GITHUB_TOKEN, GITHUB_REPOSITORY, and numeric HUB_ISSUE_NUMBER are required")
    body = build_report(dict(os.environ))
    post_comment(token, repository, int(issue_raw), body)
    print(json.dumps({"status": "posted", "schema_version": 2, "paid_fallback": 0}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReportError as exc:
        print(json.dumps({"status": "failed", "error": clean(str(exc), 700)}), file=os.sys.stderr)
        raise SystemExit(1)
