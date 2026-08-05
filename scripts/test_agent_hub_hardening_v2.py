#!/usr/bin/env python3
"""Regression coverage for PR #70 audit blockers without weakening existing tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent_hub_command_integrity_v2 import CommandIntegrityError, seal_command_body, verify_command_body
from agent_hub_coordinator_hardening_v2 import requires_independent_verification
from agent_hub_executor_safety_v2 import normalize_repo_path, ExecutorSafetyError
from agent_hub_github_validation_v2 import (
    GitHubEvidenceError,
    REQUIRED_STATUS_CONTEXTS,
    validate_completed_report,
    validate_draft_pr_reuse,
)
from agent_hub_legacy_migration_v2 import build_migration_comment, issue_body_edit_does_not_trigger, schema_v1_accepted_count
from agent_hub_prompt_compiler_v2 import PROFILE_NAMES
from agent_hub_security_v2 import SensitiveDataError, safe_blocked_comment, sanitize_report_for_model_strict


def expect_block(fn) -> None:
    try:
        fn()
    except (GitHubEvidenceError, ExecutorSafetyError, SensitiveDataError, CommandIntegrityError):
        return
    raise AssertionError("unsafe fixture was accepted")


class FakeGitHub:
    repository = "owner/repo"
    def __init__(self, *, pr_state="open", conclusion="success", run_sha="b"*40, statuses: dict[str,str] | None=None, base_sha="a"*40, head_repo="owner/repo"):
        self.pr_state=pr_state; self.conclusion=conclusion; self.run_sha=run_sha; self.statuses=statuses or {c:"success" for c in REQUIRED_STATUS_CONTEXTS}; self.base_sha=base_sha; self.head_repo=head_repo
    def workflow_run(self, run_id: int):
        return {"status":"completed","conclusion":self.conclusion,"head_sha":self.run_sha,"repository":{"full_name":self.repository}}
    def branch_sha(self, branch: str): return self.base_sha
    def request(self, method: str, path: str, payload=None):
        if "/pulls/" in path:
            return {"number":9,"state":self.pr_state,"draft":True,"body":"agent_hub_command_id: hub-9\nagent_hub_worker: integration-planner\nagent_hub_expected_head_sha: "+"b"*40+"\nagent_hub_work_branch: agent/hub-9","user":{"login":"github-actions[bot]"},"base":{"ref":"feature/base","sha":"c"*40,"repo":{"full_name":self.repository}},"head":{"ref":"feature/demo","sha":"b"*40,"repo":{"full_name":self.head_repo}}}
        return {"statuses":[{"context":context,"state":state} for context,state in self.statuses.items()]}


class Report:
    status="completed"; head_sha="b"*40; author="github-actions[bot]"
    fields={"ci_run_id":"42","pr_number":"9","changed_files":"[\"docs/a.md\"]","repository":"owner/repo","base_branch":"main","target_branch":"feature/base","base_sha":"a"*40,"branch":"feature/demo"}


def test_medium_policy() -> int:
    assert all(requires_independent_verification("medium") for _ in PROFILE_NAMES)
    assert not requires_independent_verification("low")
    assert not requires_independent_verification("high")
    assert not requires_independent_verification("prohibited")
    return len(PROFILE_NAMES) + 3


def test_github_evidence() -> int:
    validate_completed_report(Report(), FakeGitHub())
    failures = [
        FakeGitHub(pr_state="closed"), FakeGitHub(conclusion="neutral"), FakeGitHub(conclusion="skipped"),
        FakeGitHub(run_sha="d"*40), FakeGitHub(base_sha="d"*40), FakeGitHub(head_repo="foreign/repo"),
        FakeGitHub(statuses={**{c:"success" for c in REQUIRED_STATUS_CONTEXTS}, REQUIRED_STATUS_CONTEXTS[0]:"pending"}),
    ]
    for client in failures: expect_block(lambda client=client: validate_completed_report(Report(), client))
    changed_base = type("ChangedBase", (), {"status":"completed","head_sha":"b"*40,"author":"github-actions[bot]","fields":{**Report.fields,"base_sha":"d"*40}})()
    expect_block(lambda: validate_completed_report(changed_base, FakeGitHub()))
    changed_head = type("ChangedHead", (), {"status":"completed","head_sha":"d"*40,"author":"github-actions[bot]","fields":dict(Report.fields)})()
    expect_block(lambda: validate_completed_report(changed_head, FakeGitHub()))
    payload=FakeGitHub().request("GET","/pulls/9"); payload["head"]["ref"]="agent/hub-9"; payload["base"]["ref"]="feature/base"
    validate_draft_pr_reuse(payload,repository="owner/repo",repository_owner="owner",work_branch="agent/hub-9",target_branch="feature/base",command_id="hub-9",worker="integration-planner",expected_head_sha="b"*40)
    payload["body"]="wrong worker"
    expect_block(lambda: validate_draft_pr_reuse(payload,repository="owner/repo",repository_owner="owner",work_branch="agent/hub-9",target_branch="feature/base",command_id="hub-9",worker="integration-planner",expected_head_sha="b"*40))
    return 11


def test_security_and_paths() -> int:
    fixtures=(
        "Authorization : Bearer fixtureabcdefghijklmnopqrstuvwxyz.123",
        "SUPABASE_SERVICE_ROLE_KEY = fixture_service_role_value_123456",
        '"balance": 100000', '"positions": [{"symbol":"BTC","qty":1}]',
        "예수금: 500000원", "주문 ID: FIXTURE_ORDER_12345",
        'POST /orders {"symbol":"AAPL","side":"buy","qty":2}',
    )
    for item in fixtures: expect_block(lambda item=item: sanitize_report_for_model_strict(item))
    blocked=safe_blocked_comment(source_report_comment_id=5)
    assert "100000" not in blocked and "FIXTURE_ORDER" not in blocked and "model_calls: 0" in blocked and "artifact_saved: false" in blocked
    for path in ("../ops/x", "/ops/x", "docs//x", "dоcs/x", "docs/../ops/x"):
        expect_block(lambda path=path: normalize_repo_path(path))
    return len(fixtures)+6


def test_comment_and_legacy() -> int:
    sealed=seal_command_body("[HUB_COMMAND]\nschema_version: 2\nstatus: ready")
    verify_command_body(sealed)
    expect_block(lambda: verify_command_body(sealed.replace("ready","blocked")))
    assert schema_v1_accepted_count([{"body":"[HUB_COMMAND]\nstatus: ready"}]) == 0
    migration=build_migration_comment([{"comment_id":1,"migration_status":"schema-v1 blocked"}],merged_sha="a"*40)
    assert "[WORKER_REPORT]" not in migration and "[HUB_COMMAND]" not in migration
    return 4


def test_workflow_contracts() -> int:
    root=Path(__file__).resolve().parents[1]
    free=(root/".github/workflows/agent-hub-free.yml").read_text(encoding="utf-8")
    executor=(root/".github/workflows/agent-hub-executor.yml").read_text(encoding="utf-8")
    assert "agent_hub_coordinator_hardening_v2.py" in free
    assert "agent_hub_executor_gate_hardening_v2.py" in executor
    assert "agent_hub_executor_safety_v2.py validate-diff" in executor
    assert "agent_hub_executor_report_hardening_v2.py" in executor
    read_settings='["read_file","glob","grep_search","list_directory"]'
    write_settings='["read_file","write_file","replace","glob","grep_search","list_directory"]'
    assert read_settings in executor and write_settings in executor
    assert '"run_shell_command"' not in executor and '"shell"' not in executor
    assert '"sandboxNetworkAccess":false' in executor and '"mcp":{"enabled":false}' in executor
    assert issue_body_edit_does_not_trigger(free)
    assert "|| true" not in free+executor
    return 10


def run() -> int:
    count=sum(test() for test in (test_medium_policy,test_github_evidence,test_security_and_paths,test_comment_and_legacy,test_workflow_contracts))
    print(json.dumps({"agent_hub_hardening_v2":"pass","tests":count,"profiles":len(PROFILE_NAMES),"required_statuses":len(REQUIRED_STATUS_CONTEXTS),"schema_v1_accepted":0,"paid_fallback":0}))
    return 0

if __name__ == "__main__": raise SystemExit(run())
