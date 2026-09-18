from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any

from scripts import agent_hub_contract_v2 as contract
from scripts.agent_hub_stale_report_reconciliation_v1 import (
    POLICY_VERSION,
    StaleReportReconciliationError,
    classify_pending_report,
    terminal_command_body,
)

REPOSITORY = "owner/repo"
OLD_SHA = "a" * 40
CURRENT_SHA = "b" * 40
LEGACY_CI_RUN = 34308483553


class FakeGitHub:
    repository = REPOSITORY

    def __init__(
        self,
        pulls: dict[int, str] | None = None,
        *,
        historical_ancestor: bool = True,
        run_head_sha: str = OLD_SHA,
        run_conclusion: str = "success",
    ) -> None:
        self.pulls = pulls or {}
        self.historical_ancestor = historical_ancestor
        self.run_head_sha = run_head_sha
        self.run_conclusion = run_conclusion
        self.requests: list[str] = []

    def request(self, method: str, path: str, payload=None) -> Any:
        if method != "GET":
            raise AssertionError("classification must be read-only")
        self.requests.append(path)
        if "/compare/" in path:
            source, current = path.rsplit("/compare/", 1)[-1].split("...", 1)
            if self.historical_ancestor:
                return {
                    "status": "ahead",
                    "behind_by": 0,
                    "base_commit": {"sha": source},
                    "merge_base_commit": {"sha": source},
                    "head_commit": {"sha": current},
                }
            return {
                "status": "diverged",
                "behind_by": 1,
                "base_commit": {"sha": source},
                "merge_base_commit": {"sha": "c" * 40},
                "head_commit": {"sha": current},
            }
        if "/actions/runs/" in path:
            run_id = int(path.rsplit("/", 1)[-1])
            return {
                "id": run_id,
                "head_sha": self.run_head_sha,
                "status": "completed",
                "conclusion": self.run_conclusion,
            }
        number = int(path.rsplit("/", 1)[-1])
        if number not in self.pulls:
            raise AssertionError(f"unexpected PR lookup {number}")
        return {"number": number, "state": self.pulls[number]}


def canonical_report(*, comment_id: int = 10, pr_number: str = "123") -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: demo-task",
        "worker: test-runner",
        f"repository: {REPOSITORY}",
        "base_branch: main",
        f"base_sha: {OLD_SHA}",
        "branch: feature/demo",
        "status: partial",
        f"head_sha: {OLD_SHA}",
        f"pr_number: {pr_number}",
        'changed_files: ["tests/demo.test.ts"]',
        "checks: focused checks passed",
        "ci_run_id: none",
        "summary: bounded work",
        "remaining: continue",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        "prohibited_actions_confirmed: yes, no prohibited actions performed",
    ])
    return {
        "id": comment_id,
        "body": body,
        "user": {"login": "owner"},
        "author_association": "OWNER",
    }


def legacy_bare_list_report(
    *,
    comment_id: int = 40,
    pr_number: str = "914",
    changed_files: str = "[stock-analyzer/e2e/full-product-browser-flow.spec.ts, stock-analyzer/e2e/support/full-product-evidence.ts]",
    owner: bool = True,
    extra_line: str | None = None,
) -> dict[str, Any]:
    lines = [
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: legacy-browser-e2e",
        "root_task_id: legacy-browser-root",
        "worker: test-runner",
        f"repository: {REPOSITORY}",
        "base_branch: main",
        f"base_sha: {OLD_SHA}",
        "branch: test/full-product-browser-e2e",
        "status: partial",
        f"head_sha: {OLD_SHA}",
        f"pr_number: {pr_number}",
        f"changed_files: {changed_files}",
        "checks: focused checks passed",
        "ci_run_id: none",
        "summary: bounded historical work",
        "remaining: continue",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        "prohibited_actions_confirmed: yes, no prohibited actions performed",
    ]
    if extra_line:
        lines.append(extra_line)
    return {
        "id": comment_id,
        "body": "\n".join(lines),
        "user": {"login": "owner" if owner else "contributor"},
        "author_association": "OWNER" if owner else "CONTRIBUTOR",
    }


def manual_snapshot(*, head_sha: str = OLD_SHA, comment_id: int = 20) -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: manual-20-demo",
        "root_task_id: manual-20-demo",
        "worker: agent-hub-validation",
        f"repository: {REPOSITORY}",
        "base_branch: main",
        f"base_sha: {head_sha}",
        "branch: main",
        "status: partial",
        f"head_sha: {head_sha}",
        "pr_number: none",
        "changed_files: []",
        "checks: manual_adapter_v2=pass; read_only_zero_proof=1; actual_main_match=1",
        "ci_run_id: none",
        "summary: read-only snapshot",
        "remaining: re-read current evidence",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        "prohibited_actions_confirmed: yes, no prohibited actions performed",
        "<!-- agent-executor-report -->",
    ])
    return {
        "id": comment_id,
        "body": body,
        "user": {"login": "github-actions[bot]"},
        "author_association": "CONTRIBUTOR",
    }


def legacy_evidence_checkpoint(
    *,
    comment_id: int = 50,
    exact_main: str = OLD_SHA,
    owner: bool = True,
    required_ci_run: int = LEGACY_CI_RUN,
    downstream_credit: str = "0",
) -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: PROFITABILITY_CLOSED_LOOP_V3_INDEPENDENCE_N53_20260909_1406_KST",
        "status: VERIFIED_EVIDENCE_INCREASE",
        "canonical_hub: 838",
        "release_control: 23",
        f"exact_main: {exact_main}",
        f"required_ci_run: {required_ci_run}",
        "required_ci: 6/6 SUCCESS",
        "source_contract_family: SUCCESSOR_SCHEDULE_RELIABILITY_V3",
        "source_capture_run_id: 34311951975",
        "ingest_run_id: 34311990346",
        "independence_run_id: 34312134581",
        "effective_independent_n: 53",
        "full_cost_ready: false",
        "net_alpha_ready: false",
        "profitability_proven: false",
        "execution_authority: NONE",
        f"downstream_economic_credit_delta: {downstream_credit}",
        "first_zero: FIRST_GENUINE_VALIDATION",
        "forbidden_actions_performed: 0",
    ])
    return {
        "id": comment_id,
        "body": body,
        "user": {"login": "owner" if owner else "contributor"},
        "author_association": "OWNER" if owner else "CONTRIBUTOR",
    }


def noncanonical_owner_lineage(*, actual_main: str = OLD_SHA, comment_id: int = 30) -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "scope: PRODUCT_QA_CURRENT_MAIN",
        "status: ACTIVE_PROGRESS",
        f"actual_main: {actual_main}",
        "lineage: #201 -> #202",
        "- owner: #203",
    ])
    return {
        "id": comment_id,
        "body": body,
        "user": {"login": "owner"},
        "author_association": "OWNER",
    }


class StaleReportReconciliationTests(unittest.TestCase):
    def test_closed_canonical_pr_lineage_is_reconcilable(self) -> None:
        github = FakeGitHub({123: "closed"})
        result = classify_pending_report(
            canonical_report(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=github
        )
        self.assertEqual(result.reason, "closed_canonical_pr_lineage")
        self.assertIn("pr:123:closed", result.evidence)

    def test_open_canonical_pr_remains_blocking(self) -> None:
        github = FakeGitHub({123: "open"})
        with self.assertRaisesRegex(StaleReportReconciliationError, "still owns open PR"):
            classify_pending_report(
                canonical_report(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=github
            )

    def test_closed_owner_legacy_bare_changed_files_is_reconcilable(self) -> None:
        result = classify_pending_report(
            legacy_bare_list_report(),
            repository=REPOSITORY,
            current_sha=CURRENT_SHA,
            github=FakeGitHub({914: "closed"}),
        )
        self.assertEqual(result.reason, "closed_legacy_bare_list_pr_lineage")
        self.assertIn("pr:914:closed", result.evidence)

    def test_open_owner_legacy_bare_changed_files_remains_blocking(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "still owns open PR #914"):
            classify_pending_report(
                legacy_bare_list_report(),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub({914: "open"}),
            )

    def test_unsafe_legacy_bare_changed_files_stays_blocking(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_bare_list_report(changed_files="[../escape.ts, safe.ts]"),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub({914: "closed"}),
            )

    def test_non_owner_legacy_bare_changed_files_stays_blocking(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_bare_list_report(owner=False),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub({914: "closed"}),
            )

    def test_legacy_adapter_does_not_hide_other_contract_errors(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_bare_list_report(extra_line="unsupported_legacy_field: value"),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub({914: "closed"}),
            )

    def test_old_manual_readonly_snapshot_is_reconcilable_without_claiming_resolution(self) -> None:
        result = classify_pending_report(
            manual_snapshot(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=FakeGitHub()
        )
        self.assertEqual(result.reason, "historical_read_only_snapshot")
        self.assertIn(f"source_head:{OLD_SHA}", result.evidence)

    def test_current_main_manual_snapshot_stays_blocking(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "not provably stale"):
            classify_pending_report(
                manual_snapshot(head_sha=CURRENT_SHA),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub(),
            )

    def test_verified_owner_evidence_checkpoint_is_reconcilable_without_economic_closure(self) -> None:
        github = FakeGitHub()
        result = classify_pending_report(
            legacy_evidence_checkpoint(),
            repository=REPOSITORY,
            current_sha=CURRENT_SHA,
            github=github,
        )
        self.assertEqual(result.reason, "historical_owner_evidence_checkpoint")
        self.assertIn(f"source_main:{OLD_SHA}", result.evidence)
        self.assertIn(f"required_ci_run:{LEGACY_CI_RUN}:success", result.evidence)
        self.assertTrue(any("/compare/" in request for request in github.requests))
        self.assertTrue(any("/actions/runs/" in request for request in github.requests))

    def test_evidence_checkpoint_requires_historical_main_ancestor(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_evidence_checkpoint(),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub(historical_ancestor=False),
            )

    def test_evidence_checkpoint_requires_ci_run_bound_to_source_sha(self) -> None:
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_evidence_checkpoint(),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub(run_head_sha="d" * 40),
            )

    def test_evidence_checkpoint_with_economic_credit_stays_blocking(self) -> None:
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_evidence_checkpoint(downstream_credit="1"),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
            )
        self.assertEqual(github.requests, [])

    def test_non_owner_evidence_checkpoint_stays_blocking_without_remote_proof(self) -> None:
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                legacy_evidence_checkpoint(owner=False),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
            )
        self.assertEqual(github.requests, [])

    def test_noncanonical_owner_lineage_requires_all_prs_closed(self) -> None:
        github = FakeGitHub({201: "closed", 202: "closed", 203: "closed"})
        result = classify_pending_report(
            noncanonical_owner_lineage(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=github
        )
        self.assertEqual(result.reason, "closed_noncanonical_owner_lineage")
        self.assertEqual(
            result.evidence[:3],
            ("pr:201:closed", "pr:202:closed", "pr:203:closed"),
        )

    def test_noncanonical_owner_lineage_with_open_pr_stays_blocking(self) -> None:
        github = FakeGitHub({201: "closed", 202: "open", 203: "closed"})
        with self.assertRaisesRegex(StaleReportReconciliationError, "not provably stale"):
            classify_pending_report(
                noncanonical_owner_lineage(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=github
            )

    def test_noncanonical_current_main_snapshot_stays_blocking_without_pr_checks(self) -> None:
        github = FakeGitHub({201: "closed", 202: "closed", 203: "closed"})
        with self.assertRaisesRegex(StaleReportReconciliationError, "not provably stale"):
            classify_pending_report(
                noncanonical_owner_lineage(actual_main=CURRENT_SHA),
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
            )
        self.assertEqual(github.requests, [])

    def test_terminal_command_is_canonical_and_explicitly_non_resolution(self) -> None:
        item = classify_pending_report(
            canonical_report(), repository=REPOSITORY, current_sha=CURRENT_SHA, github=FakeGitHub({123: "closed"})
        )
        body = terminal_command_body(
            item,
            repository=REPOSITORY,
            current_sha=CURRENT_SHA,
            now=datetime(2026, 9, 17, 9, 0, 0, tzinfo=timezone.utc),
        )
        parsed = contract.parse_command(body, comment_id=999, policy_version=POLICY_VERSION)
        self.assertEqual(parsed.fields["status"], "superseded")
        self.assertEqual(parsed.fields["execution_mode"], "none")
        self.assertEqual(parsed.fields["source_report_comment_id"], "10")
        self.assertIn("Do not infer product, economic, profitability, or runtime resolution", body)


if __name__ == "__main__":
    unittest.main()
