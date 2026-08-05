#!/usr/bin/env python3
"""Executor report adapter that never claims completed before immutable PR CI exists."""
from __future__ import annotations

import json
import os
import re

import agent_hub_executor_report_v2 as base
from agent_hub_contract_v2 import EXECUTOR_PROCESSED_PREFIX, EXECUTOR_REPORT_MARKER, REPORT_MARKER, SCHEMA_VERSION


def build_report(env: dict[str, str]) -> str:
    command_id = base.clean(env.get("COMMAND_ID", ""), 120)
    source_task_id = base.clean(env.get("SOURCE_TASK_ID", ""), 180)
    worker = base.clean(env.get("TARGET_WORKER", ""), 64)
    repository = base.clean(env.get("GITHUB_REPOSITORY", ""), 200)
    target_branch = base.clean(env.get("TARGET_BRANCH", ""), 180)
    work_branch = base.clean(env.get("WORK_BRANCH", ""), 180)
    base_sha = base.clean(env.get("BASE_SHA", "none"), 40).lower()
    job_result = base.clean(env.get("RESULT_STATUS", "failed"), 40).lower()
    head_sha = base.clean(env.get("HEAD_SHA", "none"), 40).lower()
    ci_run_id = base.clean(env.get("CI_RUN_ID", "none"), 40).lower()
    pr_url = base.clean(env.get("PR_URL", "none"), 500)
    changed_files = base.parse_changed_files(env.get("CHANGED_FILES", ""))
    checks = base.clean(env.get("CHECKS", "not reported"), 4000)
    summary = base.clean(env.get("SUMMARY", "No executor summary."), 1800)
    failure = base.clean(env.get("FAILURE_SIGNATURE", ""), 500)
    execution_mode = base.clean(env.get("EXECUTION_MODE", "read_only"), 40)
    auto_step = base.clean(env.get("AUTO_STEP", "1"), 8)
    if not command_id or not source_task_id or not worker or "/" not in repository or not target_branch:
        raise base.ReportError("required executor report context is missing")
    if head_sha != "none" and not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise base.ReportError("HEAD_SHA must be a full SHA or none")
    if base_sha != "none" and not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        raise base.ReportError("BASE_SHA must be a full SHA or none")
    if ci_run_id != "none" and not ci_run_id.isdigit():
        raise base.ReportError("CI_RUN_ID must be numeric or none")
    pr_number = base.parse_pr_number(pr_url)
    status = "partial" if job_result == "completed" else "failed"
    remaining = "Await exact-head required CI success and then submit a new completed WORKER_REPORT."
    approval_required = "yes" if pr_number != "none" else "no"
    if status == "failed":
        remaining = "Analyze the recorded failure without automatically repeating the same command."
        approval_required = "yes" if failure else "no"
    branch = work_branch if work_branch and work_branch != "none" else target_branch
    task_id = f"{source_task_id}-exec-{command_id.split('-')[-1][:12]}"[:180]
    lines = [
        REPORT_MARKER, f"schema_version: {SCHEMA_VERSION}", f"task_id: {task_id}", f"root_task_id: {source_task_id}",
        f"worker: {worker}", f"repository: {repository}", "base_branch: main", f"base_sha: {base_sha}",
        f"branch: {branch}", f"status: {status}", f"head_sha: {head_sha}", f"pr_number: {pr_number}",
        "changed_files: " + json.dumps(changed_files, ensure_ascii=False, separators=(",", ":")),
        f"checks: {checks}", f"ci_run_id: {ci_run_id}", f"summary: {summary}", f"remaining: {remaining}",
        "dependencies: none", "conflicts: none", f"approval_required: {approval_required}",
        "prohibited_actions_confirmed: no main write, merge, rebase, cherry-pick, deploy, server, DB, Supabase, Secret, permission, deletion, paid fallback, live account, live order, live cancellation, or live position action performed",
        f"command_id: {command_id}", f"target_branch: {target_branch}", f"execution_mode: {execution_mode}", f"auto_step: {auto_step}",
    ]
    if failure: lines.append(f"failure_signature: {failure}")
    lines.extend([EXECUTOR_REPORT_MARKER, f"{EXECUTOR_PROCESSED_PREFIX}{command_id} -->"])
    return "\n".join(lines)


def self_test() -> int:
    env = {"COMMAND_ID":"hub-123-0123456789abcdef","SOURCE_TASK_ID":"task","TARGET_WORKER":"test-runner","GITHUB_REPOSITORY":"owner/repo","TARGET_BRANCH":"feature/test","WORK_BRANCH":"agent/hub-x","BASE_SHA":"a"*40,"RESULT_STATUS":"completed","HEAD_SHA":"b"*40,"CI_RUN_ID":"123","PR_URL":"https://github.com/owner/repo/pull/9","CHANGED_FILES":"[\"tests/a.ts\"]","EXECUTION_MODE":"code_change"}
    body = build_report(env)
    assert "status: partial" in body and "status: completed" not in body
    print(json.dumps({"executor_report_hardening_v2":"pass","premature_completed_reports":0}))
    return 0


def main() -> int:
    if "--self-test" in os.sys.argv: return self_test()
    token = os.environ.get("GITHUB_TOKEN", "").strip(); repository = os.environ.get("GITHUB_REPOSITORY", "").strip(); issue = os.environ.get("HUB_ISSUE_NUMBER", "62")
    if not token or "/" not in repository or not issue.isdigit(): raise base.ReportError("GitHub report context is incomplete")
    body = build_report(dict(os.environ)); base.post_comment(token, repository, int(issue), body)
    print(json.dumps({"status":"posted","schema_version":2,"completed_claimed":False,"paid_fallback":0})); return 0

if __name__ == "__main__":
    try: raise SystemExit(main())
    except base.ReportError:
        print(json.dumps({"status":"failed","error":"executor_report_validation_failed"}), file=os.sys.stderr); raise SystemExit(1)
