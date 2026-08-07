#!/usr/bin/env python3
"""Regression coverage for Agent Hub schema-v2 hardening without weakening safety tests."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from agent_hub_command_integrity_v2 import CommandIntegrityError, seal_command_body, verify_command_body
from agent_hub_contract_v2 import EXECUTOR_REPORT_MARKER, REPORT_MARKER, parse_key_values
from agent_hub_coordinator_hardening_v2 import NO_PROGRESS_REPEAT_LIMIT, process_once, requires_independent_verification
from agent_hub_executor_report_hardening_v2 import (
    build_report as build_hardened_executor_report,
    build_terminal_state as build_hardened_terminal_state,
)
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
    except (GitHubEvidenceError, ExecutorSafetyError, SensitiveDataError, CommandIntegrityError):
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
    first = compile_hardened_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts", "run_build", "create_draft_pr"), registered_workers=("integration-planner",), policy_version="v4")
    assert "run_build" in first.allowed_action_types and "create_draft_pr" in first.allowed_action_types
    comments = [{"body": format_state_snapshot(first.current_state)}]
    same = compile_hardened_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    changed = compile_hardened_prompt(fields={**fields, "head_sha": "c" * 40, "status": "completed"}, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    assert same.previous_state == first.current_state and same.state_delta == {}
    assert set(changed.state_delta) == {"head_sha", "status"}
    assert changed.previous_state == first.current_state
    assert changed.current_state.head_sha == "c" * 40
    assert '"state_delta"' in changed.prompt
    assert '"previous_state"' not in changed.prompt and '"current_state"' not in changed.prompt
    return 9


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
    continuation = FakeGitHub().request("GET", "/pulls/9")
    continuation["body"] = "manual Draft body without Agent Hub command markers"
    validate_draft_pr_reuse(continuation, repository="owner/repo", repository_owner="owner", work_branch="feature/demo", target_branch="feature/demo", command_id="new-command", worker="integration-planner", expected_head_sha="b" * 40)
    expect_block(lambda: validate_draft_pr_reuse(continuation, repository="owner/repo", repository_owner="owner", work_branch="feature/demo", target_branch="feature/demo", command_id="new-command", worker="integration-planner", expected_head_sha="c" * 40))
    return 16


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


def test_comment_and_legacy() -> int:
    sealed = seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    verify_command_body(sealed)
    expect_block(lambda: verify_command_body(sealed.replace("ready", "blocked")))
    assert schema_v1_accepted_count([{"body": "[HUB_COMMAND]\nstatus: ready"}]) == 0
    migration = build_migration_comment([{"comment_id": 1, "migration_status": "schema-v1 blocked"}], merged_sha="a" * 40)
    assert "[WORKER_REPORT]" not in migration and "[HUB_COMMAND]" not in migration
    return 4


def _report_body(
    *, task_id: str, root_task_id: str, status: str, head_sha: str, remaining: str,
    approval_required: str = "no", failure_signature: str = "", ci_run_id: str = "none",
) -> str:
    lines = [
        REPORT_MARKER,
        "schema_version: 2",
        f"task_id: {task_id}",
        f"root_task_id: {root_task_id}",
        "worker: ai-chart",
        "repository: owner/repo",
        "base_branch: main",
        "base_sha: " + "a" * 40,
        "branch: feature/chart-loop",
        f"status: {status}",
        f"head_sha: {head_sha}",
        "pr_number: 9",
        'changed_files: ["stock-analyzer/src/lib/chart-analysis.ts"]',
        "checks: fixture validation evidence",
        f"ci_run_id: {ci_run_id}",
        "summary: safe continuation fixture",
        f"remaining: {remaining}",
        "dependencies: none",
        "conflicts: none",
        f"approval_required: {approval_required}",
        "prohibited_actions_confirmed: no main write, merge, deploy, DB, Secret, server, or live-order action performed",
        "target_branch: feature/chart-loop",
    ]
    if failure_signature:
        lines.append(f"failure_signature: {failure_signature}")
    return "\n".join(lines)


class LoopGitHub:
    repository = "owner/repo"

    def __init__(self, initial_body: str, *, head_sha: str = "b" * 40):
        self.head_sha = head_sha
        self.base_sha = "a" * 40
        self.files = ["stock-analyzer/src/lib/chart-analysis.ts"]
        self.comments: list[dict[str, Any]] = []
        self.next_id = 100
        self.add_report(initial_body, author="owner", association="OWNER")

    def add_report(self, body: str, *, author: str = "github-actions[bot]", association: str = "NONE") -> int:
        cid = self.next_id
        self.next_id += 1
        self.comments.append({
            "id": cid, "body": body, "author_association": association,
            "user": {"login": author}, "created_at": "2026-08-07T00:00:00Z", "updated_at": "2026-08-07T00:00:00Z",
        })
        return cid

    def list_issue_comments(self, issue_number: int):
        return list(self.comments)

    def post_comment(self, issue_number: int, body: str):
        cid = self.next_id
        self.next_id += 1
        self.comments.append({
            "id": cid, "body": body, "author_association": "NONE",
            "user": {"login": "github-actions[bot]"}, "created_at": "2026-08-07T00:00:00Z", "updated_at": "2026-08-07T00:00:00Z",
        })
        return self.comments[-1]

    def branch_sha(self, branch: str):
        return self.base_sha if branch == "main" else self.head_sha

    def workflow_run(self, run_id: int):
        return {"status": "completed", "conclusion": "success", "head_sha": self.head_sha, "repository": {"full_name": self.repository}}

    def request(self, method: str, path: str, payload=None):
        if "/files" in path:
            return [{"filename": item} for item in self.files]
        if "/pulls/9" in path:
            return {
                "number": 9, "state": "open", "draft": True, "merged": False, "body": "fixture Draft",
                "user": {"login": "owner"},
                "base": {"ref": "main", "sha": self.base_sha, "repo": {"full_name": self.repository}},
                "head": {"ref": "feature/chart-loop", "sha": self.head_sha, "repo": {"full_name": self.repository}},
            }
        if "/commits/" in path and path.endswith("/status"):
            return {"statuses": [{"context": context, "state": "success"} for context in REQUIRED_STATUS_CONTEXTS]}
        raise AssertionError(f"unexpected fake GitHub request: {method} {path}")

    def open_pr_file_owners(self):
        return {9: set(self.files)}

    def latest_command(self) -> dict[str, str]:
        for comment in reversed(self.comments):
            if "[HUB_COMMAND]" in str(comment.get("body") or ""):
                return parse_key_values(str(comment["body"]))
        raise AssertionError("no HUB_COMMAND was posted")


class QueueGemini:
    def __init__(self, actions: list[str]):
        self.actions = list(actions)
        self.calls = 0

    def complete(self, prompt: str, *, purpose: str):
        self.calls += 1
        if not self.actions:
            raise AssertionError("unexpected Gemini call")
        action = self.actions.pop(0)
        evidence_match = re.search(r'\"id\":\"([^\"]+)\"', prompt)
        if not evidence_match:
            raise AssertionError("compiled prompt had no evidence id")
        proposal = {
            "target_worker": "ai-chart",
            "action_type": action,
            "target_branch": "feature/chart-loop",
            "allowed_paths": ["stock-analyzer/src/lib/chart-analysis.ts"],
            "prohibited_paths": ["ops/**"],
            "instruction": f"Execute the next bounded safe action: {action}.",
            "evidence_ids": [evidence_match.group(1)],
            "validation": "Preserve exact HEAD and run the deterministic validation for this action.",
            "stop_conditions": "Stop on policy gate.",
            "reason": "The supplied report evidence requires the next safe continuation step.",
        }
        return json.dumps(proposal, separators=(",", ":"))


def _executor_env_for_command(command: dict[str, str], *, result: str, head_sha: str, failure: str = "") -> dict[str, str]:
    return {
        "COMMAND_ID": command["command_id"],
        "SOURCE_TASK_ID": command["source_task_id"],
        "TARGET_WORKER": command["target_worker"],
        "GITHUB_REPOSITORY": "owner/repo",
        "TARGET_BRANCH": "feature/chart-loop",
        "WORK_BRANCH": "feature/chart-loop",
        "BASE_SHA": "a" * 40,
        "REPORT_BASE_BRANCH": "main",
        "REPORT_BASE_SHA": "a" * 40,
        "REPORT_BRANCH": "feature/chart-loop",
        "REPORT_HEAD_SHA": head_sha,
        "RESULT_STATUS": result,
        "HEAD_SHA": head_sha,
        "PR_URL": "https://github.com/owner/repo/pull/9",
        "CHANGED_FILES": '["stock-analyzer/src/lib/chart-analysis.ts"]',
        "CHECKS": f"action={command['action_type']}; result={result}",
        "EXECUTION_MODE": command["execution_mode"],
        "AUTO_STEP": command.get("auto_step", "0"),
        "FAILURE_SIGNATURE": failure,
    }


def _executor_report_for_command(command: dict[str, str], *, result: str, head_sha: str, failure: str = "") -> str:
    return build_hardened_executor_report(_executor_env_for_command(command, result=result, head_sha=head_sha, failure=failure))


def _terminal_state_for_command(command: dict[str, str], *, result: str, head_sha: str) -> str:
    return build_hardened_terminal_state(_executor_env_for_command(command, result=result, head_sha=head_sha))


def _post_executor_result(gh: LoopGitHub, command: dict[str, str], *, result: str, head_sha: str, failure: str = "") -> str:
    report = _executor_report_for_command(command, result=result, head_sha=head_sha, failure=failure)
    gh.add_report(report)
    gh.post_comment(62, _terminal_state_for_command(command, result=result, head_sha=head_sha))
    return report


def test_auto_continuation_e2e() -> int:
    initial = _report_body(
        task_id="scenario-a-1", root_task_id="scenario-a", status="completed", head_sha="b" * 40,
        remaining="Run the next safe build validation.", ci_run_id="7001",
    )
    gh = LoopGitHub(initial)
    gemini = QueueGemini(["run_build", "run_playwright"])
    first = process_once(github=gh, gemini=gemini, issue_number=62, repository=gh.repository)
    assert first["status"] == "ready" and first["auto_step"] == 1, first
    command1 = gh.latest_command()
    assert command1["approval_required"] == "no" and command1["work_branch"] == "feature/chart-loop"
    report = _post_executor_result(gh, command1, result="completed", head_sha="b" * 40)
    assert EXECUTOR_REPORT_MARKER in report and "approval_required: no" in report
    second = process_once(github=gh, gemini=gemini, issue_number=62, repository=gh.repository)
    assert second["status"] == "ready" and second["auto_step"] == 2, second
    command2 = gh.latest_command()
    assert command2["action_type"] == "run_playwright" and command2["approval_required"] == "no"

    initial_b = _report_body(
        task_id="scenario-b-1", root_task_id="scenario-b", status="failed", head_sha="b" * 40,
        remaining="Analyze CI failure and continue safely.", failure_signature="ci-smoke-failure",
    )
    gh_b = LoopGitHub(initial_b)
    gemini_b = QueueGemini(["analyze_ci_failure", "modify_feature_branch", "run_unit_tests", "run_build"])
    r1 = process_once(github=gh_b, gemini=gemini_b, issue_number=62, repository=gh_b.repository)
    assert r1["status"] == "ready", r1
    c1 = gh_b.latest_command()
    _post_executor_result(gh_b, c1, result="failed", head_sha="b" * 40, failure="analysis-needs-fix")
    r2 = process_once(github=gh_b, gemini=gemini_b, issue_number=62, repository=gh_b.repository)
    assert r2["status"] == "ready" and gh_b.latest_command()["action_type"] == "modify_feature_branch", r2
    c2 = gh_b.latest_command()
    gh_b.head_sha = "c" * 40
    _post_executor_result(gh_b, c2, result="completed", head_sha="c" * 40)
    r3 = process_once(github=gh_b, gemini=gemini_b, issue_number=62, repository=gh_b.repository)
    assert r3["status"] == "ready" and gh_b.latest_command()["action_type"] == "run_unit_tests", r3
    c3 = gh_b.latest_command()
    _post_executor_result(gh_b, c3, result="completed", head_sha="c" * 40)
    r4 = process_once(github=gh_b, gemini=gemini_b, issue_number=62, repository=gh_b.repository)
    assert r4["status"] == "ready" and gh_b.latest_command()["action_type"] == "run_build", r4
    assert all(parse_key_values(str(item.get("body") or "")).get("approval_required") != "yes" for item in gh_b.comments if "[HUB_COMMAND]" in str(item.get("body") or ""))

    high_risk = _report_body(
        task_id="scenario-c-1", root_task_id="scenario-c", status="waiting_approval", head_sha="b" * 40,
        remaining="Merge the Draft PR into main.", approval_required="yes",
    )
    gh_c = LoopGitHub(high_risk)
    gemini_c = QueueGemini([])
    blocked_at_boundary = process_once(github=gh_c, gemini=gemini_c, issue_number=62, repository=gh_c.repository)
    assert blocked_at_boundary["status"] == "waiting_approval" and gemini_c.calls == 0, blocked_at_boundary
    assert gh_c.latest_command()["approval_required"] == "yes"

    latest = _report_body(
        task_id="scenario-d-3", root_task_id="scenario-d", status="failed", head_sha="b" * 40,
        remaining="Retry safe test.", failure_signature="same-error",
    )
    gh_d = LoopGitHub(latest)
    current = gh_d.comments.pop()
    for index in (1, 2):
        body = _report_body(
            task_id=f"scenario-d-{index}", root_task_id="scenario-d", status="failed", head_sha="b" * 40,
            remaining="Retry safe test.", failure_signature="same-error",
        )
        report_id = gh_d.add_report(body, author="owner", association="OWNER")
        gh_d.post_comment(62, f"[HUB_STATE]\nstatus: completed\n<!-- agent-hub-processed:{report_id} -->")
    gh_d.comments.append(current)
    gemini_d = QueueGemini([])
    no_progress = process_once(github=gh_d, gemini=gemini_d, issue_number=62, repository=gh_d.repository)
    assert no_progress["status"] == "blocked" and no_progress["reason"] == "no_progress_repeated_failure", no_progress
    assert gemini_d.calls == 0 and NO_PROGRESS_REPEAT_LIMIT == 3

    return 29


def test_workflow_contracts() -> int:
    root = Path(__file__).resolve().parents[1]
    free = (root / ".github/workflows/agent-hub-free.yml").read_text(encoding="utf-8")
    executor = (root / ".github/workflows/agent-hub-executor.yml").read_text(encoding="utf-8")
    report_adapter = (root / "scripts/agent_hub_executor_report_hardening_v2.py").read_text(encoding="utf-8")
    coordinator = (root / "scripts/agent_hub_coordinator_hardening_v2.py").read_text(encoding="utf-8")
    assert "agent_hub_coordinator_hardening_v2.py" in free
    assert "agent_hub_executor_gate_hardening_v2.py" in executor
    assert "agent_hub_executor_safety_v2.py validate-diff" in executor
    assert "agent_hub_executor_report_hardening_v2.py" in executor
    assert "types: [agent-executor-report-ready]" in free
    assert "event_type='agent-hub-command-ready'" in free
    process_permissions = free.split("  process-report:", 1)[1].split("    runs-on:", 1)[0]
    assert "contents: write" in process_permissions
    assert 'REPORT_READY_EVENT = "agent-executor-report-ready"' in report_adapter
    assert "build_terminal_state" in report_adapter and "terminal_state_posted" in report_adapter
    assert "create_draft_pr|update_draft_pr_description" in executor
    assert "max_auto_steps_reached" not in coordinator and "draft_pr_already_created" not in coordinator
    read_settings = '["read_file","glob","grep_search","list_directory"]'
    write_settings = '["read_file","write_file","replace","glob","grep_search","list_directory"]'
    assert read_settings in executor and write_settings in executor
    assert '"run_shell_command"' not in executor and '"shell"' not in executor
    assert '"sandboxNetworkAccess":false' in executor and '"mcp":{"enabled":false}' in executor
    assert issue_body_edit_does_not_trigger(free)
    assert "|| true" not in free + executor
    for critical in ("merge_pr)", "staging_deploy)", "production_deploy)", "apply_db_migration)", "restart_server)", "submit_live_order)"):
        assert critical not in executor
    assert "GEMINI_API_KEY" in free + executor and "echo $GEMINI_API_KEY" not in free + executor
    return 22


def run() -> int:
    count = sum(test() for test in (
        test_medium_policy, test_prompt_delta_only, test_github_evidence, test_security_and_paths,
        test_comment_and_legacy, test_auto_continuation_e2e, test_workflow_contracts,
    ))
    print(json.dumps({
        "agent_hub_hardening_v2": "pass",
        "tests": count,
        "profiles": len(PROFILE_NAMES),
        "required_statuses": len(REQUIRED_STATUS_CONTEXTS),
        "delta_only_prompt": True,
        "schema_v1_accepted": 0,
        "auto_continuation_scenarios": 4,
        "critical_auto_actions": 0,
        "paid_fallback": 0,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
