#!/usr/bin/env python3
"""Regression coverage for Agent Hub schema-v2 hardening without weakening safety tests."""
from __future__ import annotations

import json
from pathlib import Path

from agent_hub_command_integrity_v2 import CommandIntegrityError, seal_command_body, verify_command_body
from agent_hub_coordinator_hardening_v2 import requires_independent_verification
from agent_hub_executor import ExecutorError, bounded_int
from agent_hub_executor_safety_v2 import normalize_repo_path, ExecutorSafetyError
from agent_hub_github_validation_v2 import (
    GitHubEvidenceError,
    REQUIRED_STATUS_CONTEXTS,
    validate_completed_report,
    validate_draft_pr_reuse,
)
from agent_hub_legacy_migration_v2 import build_migration_comment, issue_body_edit_does_not_trigger, schema_v1_accepted_count
from agent_hub_prompt_compiler_hardening_v2 import compile_prompt as compile_hardened_prompt
from agent_hub_prompt_compiler_v2 import PROFILE_NAMES
from agent_hub_security_v2 import SensitiveDataError, safe_blocked_comment, sanitize_report_for_model_strict
from agent_hub_state_v2 import format_state_snapshot


def expect_block(fn) -> None:
    try:
        fn()
    except (GitHubEvidenceError, ExecutorSafetyError, ExecutorError, SensitiveDataError, CommandIntegrityError):
        return
    raise AssertionError("unsafe fixture was accepted")


class FakeGitHub:
    repository = "owner/repo"

    def __init__(
        self, *, pr_state="open", conclusion="success", run_sha="b" * 40,
        statuses: dict[str, str] | None = None, base_sha="a" * 40,
        pr_base_sha="a" * 40, head_repo="owner/repo", draft=True,
    ):
        self.pr_state = pr_state
        self.conclusion = conclusion
        self.run_sha = run_sha
        self.statuses = statuses or {c: "success" for c in REQUIRED_STATUS_CONTEXTS}
        self.base_sha = base_sha
        self.pr_base_sha = pr_base_sha
        self.head_repo = head_repo
        self.draft = draft

    def workflow_run(self, run_id: int):
        return {"status": "completed", "conclusion": self.conclusion, "head_sha": self.run_sha, "repository": {"full_name": self.repository}}

    def branch_sha(self, branch: str):
        return self.base_sha if branch == "main" else "b" * 40

    def request(self, method: str, path: str, payload=None):
        if "/files" in path:
            return [{"filename": "docs/a.md"}]
        if "/pulls/" in path:
            return {
                "number": 9, "state": self.pr_state, "draft": self.draft, "merged": False,
                "body": "agent_hub_command_id: hub-9\nagent_hub_worker: integration-planner\nagent_hub_expected_head_sha: " + "b" * 40 + "\nagent_hub_work_branch: agent/hub-9",
                "user": {"login": "github-actions[bot]"},
                "base": {"ref": "main", "sha": self.pr_base_sha, "repo": {"full_name": self.repository}},
                "head": {"ref": "feature/demo", "sha": "b" * 40, "repo": {"full_name": self.head_repo}},
            }
        return {"statuses": [{"context": context, "state": state} for context, state in self.statuses.items()]}


class Report:
    comment_id = 99
    status = "completed"
    head_sha = "b" * 40
    branch = "feature/demo"
    author = "github-actions[bot]"
    fields = {
        "ci_run_id": "42", "pr_number": "9", "changed_files": '["docs/a.md"]',
        "repository": "owner/repo", "base_branch": "main", "target_branch": "feature/demo",
        "base_sha": "a" * 40, "branch": "feature/demo",
    }


def test_medium_policy() -> int:
    assert all(requires_independent_verification("medium") for _ in PROFILE_NAMES)
    assert not requires_independent_verification("low")
    assert not requires_independent_verification("high")
    assert not requires_independent_verification("prohibited")
    return len(PROFILE_NAMES) + 3


def test_prompt_delta_only() -> int:
    fields = {
        "task_id": "delta-only", "worker": "integration-planner", "repository": "owner/repo",
        "base_sha": "a" * 40, "branch": "feature/demo", "head_sha": "b" * 40,
        "pr_number": "9", "changed_files": ["docs/a.md"], "checks": "success",
        "ci_run_id": "42", "status": "partial", "summary": "partial", "remaining": "inspect",
    }
    first = compile_hardened_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4")
    comments = [{"body": format_state_snapshot(first.current_state)}]
    same = compile_hardened_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    changed = compile_hardened_prompt(fields={**fields, "head_sha": "c" * 40, "status": "completed"}, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    assert same.previous_state == first.current_state and same.state_delta == {}
    assert set(changed.state_delta) == {"head_sha", "status"}
    assert changed.previous_state == first.current_state
    assert changed.current_state.head_sha == "c" * 40
    assert '"state_delta"' in changed.prompt
    assert '"previous_state"' not in changed.prompt and '"current_state"' not in changed.prompt
    return 7


def test_github_evidence() -> int:
    validate_completed_report(Report(), FakeGitHub())
    failures = [
        FakeGitHub(pr_state="closed"), FakeGitHub(conclusion="neutral"), FakeGitHub(conclusion="skipped"),
        FakeGitHub(run_sha="d" * 40), FakeGitHub(base_sha="d" * 40), FakeGitHub(pr_base_sha="d" * 40),
        FakeGitHub(head_repo="foreign/repo"), FakeGitHub(draft=False),
        FakeGitHub(statuses={**{c: "success" for c in REQUIRED_STATUS_CONTEXTS}, REQUIRED_STATUS_CONTEXTS[0]: "pending"}),
    ]
    for client in failures:
        expect_block(lambda client=client: validate_completed_report(Report(), client))
    changed_base = type("ChangedBase", (), {"comment_id": 99, "status": "completed", "head_sha": "b" * 40, "branch": "feature/demo", "author": "github-actions[bot]", "fields": {**Report.fields, "base_sha": "d" * 40}})()
    expect_block(lambda: validate_completed_report(changed_base, FakeGitHub()))
    changed_head = type("ChangedHead", (), {"comment_id": 99, "status": "completed", "head_sha": "d" * 40, "branch": "feature/demo", "author": "github-actions[bot]", "fields": dict(Report.fields)})()
    expect_block(lambda: validate_completed_report(changed_head, FakeGitHub()))
    payload = FakeGitHub().request("GET", "/pulls/9")
    payload["head"]["ref"] = "agent/hub-9"
    payload["base"]["ref"] = "feature/base"
    validate_draft_pr_reuse(payload, repository="owner/repo", repository_owner="owner", work_branch="agent/hub-9", target_branch="feature/base", command_id="hub-9", worker="integration-planner", expected_head_sha="b" * 40)
    payload["body"] = "wrong worker"
    expect_block(lambda: validate_draft_pr_reuse(payload, repository="owner/repo", repository_owner="owner", work_branch="agent/hub-9", target_branch="feature/base", command_id="hub-9", worker="integration-planner", expected_head_sha="b" * 40))
    return 14


def test_security_and_paths() -> int:
    fixtures = (
        "Authorization : Bearer fixtureabcdefghijklmnopqrstuvwxyz.123",
        "SUPABASE_SERVICE_ROLE_KEY = fixture_service_role_value_123456",
        '"balance": 100000', '"positions": [{"symbol":"BTC","qty":1}]',
        "예수금: 500000원", "주문 ID: FIXTURE_ORDER_12345",
        'POST /orders {"symbol":"AAPL","side":"buy","qty":2}',
    )
    for item in fixtures:
        expect_block(lambda item=item: sanitize_report_for_model_strict(item))
    blocked = safe_blocked_comment(source_report_comment_id=5)
    assert "100000" not in blocked and "FIXTURE_ORDER" not in blocked and "model_calls: 0" in blocked and "artifact_saved: false" in blocked
    for path in ("../ops/x", "/ops/x", "docs//x", "dоcs/x", "docs/../ops/x"):
        expect_block(lambda path=path: normalize_repo_path(path))
    return len(fixtures) + 6


def test_retry_limit() -> int:
    assert bounded_int("1", 1, 2, "max_attempts") == 1
    assert bounded_int("2", 1, 2, "max_attempts") == 2
    expect_block(lambda: bounded_int("0", 1, 2, "max_attempts"))
    expect_block(lambda: bounded_int("3", 1, 2, "max_attempts"))
    expect_block(lambda: bounded_int("not-a-number", 1, 2, "max_attempts"))
    return 5


def test_comment_and_legacy() -> int:
    sealed = seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    verify_command_body(sealed)
    expect_block(lambda: verify_command_body(sealed.replace("ready", "blocked")))
    assert schema_v1_accepted_count([{"body": "[HUB_COMMAND]\nstatus: ready"}]) == 0
    migration = build_migration_comment([{"comment_id": 1, "migration_status": "schema-v1 blocked"}], merged_sha="a" * 40)
    assert "[WORKER_REPORT]" not in migration and "[HUB_COMMAND]" not in migration
    return 4


def test_workflow_contracts() -> int:
    root = Path(__file__).resolve().parents[1]
    free = (root / ".github/workflows/agent-hub-free.yml").read_text(encoding="utf-8")
    executor = (root / ".github/workflows/agent-hub-executor.yml").read_text(encoding="utf-8")
    assert "agent_hub_coordinator_hardening_v2.py" in free
    assert "agent_hub_executor_gate_hardening_v2.py" in executor
    assert "agent_hub_executor_safety_v2.py validate-diff" in executor
    assert "agent_hub_executor_report_hardening_v2.py" in executor
    read_settings = '["read_file","glob","grep_search","list_directory"]'
    write_settings = '["read_file","write_file","replace","glob","grep_search","list_directory"]'
    assert read_settings in executor and write_settings in executor
    assert '"run_shell_command"' not in executor and '"shell"' not in executor
    assert '"sandboxNetworkAccess":false' in executor and '"mcp":{"enabled":false}' in executor
    assert issue_body_edit_does_not_trigger(free)
    assert "|| true" not in free + executor

    assert "\npermissions:\n  contents: read\n" in free
    assert "\npermissions:\n  contents: read\n" in executor
    assert free.count("\n      contents: write\n") == 1
    assert executor.count("\n      contents: write\n") == 1

    process_report = free.split("\n  process-report:\n", 1)[1]
    process_report_permissions = process_report.split("\n    runs-on:", 1)[0]
    assert process_report_permissions.count("\n      ") == 4
    assert "\n      actions: read\n" in process_report_permissions
    assert "\n      contents: write\n" in process_report_permissions
    assert "\n      issues: write\n" in process_report_permissions
    assert "\n      pull-requests: read\n" in process_report_permissions
    assert "github.event_name == 'pull_request'" not in process_report.split("\n    permissions:", 1)[0]
    process_checkout = process_report.split("- uses: actions/checkout@v6", 1)[1].split("- name: Coordinate", 1)[0]
    assert "ref: main" in process_checkout and "persist-credentials: false" in process_checkout
    wake_step = process_report.split("- name: Wake controlled executor only for validated ready command", 1)[1]
    assert 'gh api --method POST "repos/${GITHUB_REPOSITORY}/dispatches" -f event_type=\'agent-hub-command-ready\'' in wake_step
    assert "client_payload" not in wake_step

    execute = executor.split("\n  execute:\n", 1)[1]
    execute_permissions = execute.split("\n    runs-on:", 1)[0]
    assert execute_permissions.count("\n      ") == 4
    assert "\n      actions: read\n" in execute_permissions
    assert "\n      contents: write\n" in execute_permissions
    assert "\n      issues: write\n" in execute_permissions
    assert "\n      pull-requests: write\n" in execute_permissions
    assert "github.event_name == 'pull_request'" not in execute.split("\n    permissions:", 1)[0]
    execute_checkout = execute.split("- uses: actions/checkout@v6", 1)[1].split("- name: Reject tracked Gemini configuration", 1)[0]
    assert "ref: main" in execute_checkout and "persist-credentials: false" in execute_checkout
    commit_step = execute.split("- name: Commit and push one isolated commit", 1)[1].split("- name: Open or validate owned Draft PR only", 1)[0]
    assert "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}" in commit_step
    assert "http.https://github.com/.extraheader" in commit_step
    assert "git push --set-upstream origin \"$WORK_BRANCH\"" not in commit_step

    forbidden_patterns = (
        "permissions: write-all",
        "actions: write",
        "checks: write",
        "workflows: write",
        "run: ${{ github.event.issue.body }}",
        "run: ${{ github.event.comment.body }}",
        "eval ",
        "bash -c",
        "python -c",
        "gh api --input",
        "gh pr merge",
        "git push origin main",
        "git push origin master",
    )
    for pattern in forbidden_patterns:
        assert pattern not in free + executor, pattern
    assert "types: [agent-hub-command-ready]" in executor
    return 38


def run() -> int:
    count = sum(test() for test in (test_medium_policy, test_prompt_delta_only, test_github_evidence, test_security_and_paths, test_retry_limit, test_comment_and_legacy, test_workflow_contracts))
    print(json.dumps({"agent_hub_hardening_v2": "pass", "tests": count, "profiles": len(PROFILE_NAMES), "required_statuses": len(REQUIRED_STATUS_CONTEXTS), "delta_only_prompt": True, "schema_v1_accepted": 0, "paid_fallback": 0}))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
