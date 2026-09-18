from __future__ import annotations

import unittest
from typing import Any

from scripts.agent_hub_legacy_manual_handoff_reconciliation_v1 import classify_if_supported

REPOSITORY = "owner/repo"
SOURCE_SHA = "a" * 40
MERGE_SHA = "c" * 40
CURRENT_SHA = "b" * 40
SOURCE_COMMENT_ID = 5642356738
BRANCH = "feat/agent-hub-app-control-bridge-v1-20260912"


class FakeGitHub:
    repository = REPOSITORY

    def __init__(self, *, source_owner: bool = True, merged: bool = True, ambiguous: bool = False) -> None:
        self.source_owner = source_owner
        self.merged = merged
        self.ambiguous = ambiguous
        self.requests: list[str] = []

    def request(self, method: str, path: str, payload=None) -> Any:
        if method != "GET":
            raise AssertionError("classification must be read-only")
        self.requests.append(path)
        if "/compare/" in path:
            source, current = path.rsplit("/compare/", 1)[-1].split("...", 1)
            return {
                "status": "ahead",
                "behind_by": 0,
                "base_commit": {"sha": source},
                "merge_base_commit": {"sha": source},
                "head_commit": {"sha": current},
            }
        if f"/issues/comments/{SOURCE_COMMENT_ID}" in path:
            return source_comment(owner=self.source_owner)
        if "/pulls?" in path:
            if not self.merged:
                return [{
                    "number": 1027,
                    "state": "closed",
                    "merged_at": None,
                    "merge_commit_sha": MERGE_SHA,
                    "head": {"ref": BRANCH},
                    "base": {"ref": "main"},
                }]
            result = [merged_pull(1027)]
            if self.ambiguous:
                result.append(merged_pull(2027))
            return result
        raise AssertionError(f"unexpected request {path}")


def adapter_report(*, source_tag: str = "AGENT_HUB_APP_CONTROL_BRIDGE_CONTINUATION") -> dict[str, Any]:
    checks = (
        "manual_adapter_v2=pass; "
        f"source_comment_id={SOURCE_COMMENT_ID}; "
        f"source_tag={source_tag}; actual_main_match=1; read_only_zero_proof=1; "
        "original_report_schema=legacy"
    )
    summary = (
        f"trusted_manual_readonly_handoff=1; source_comment_id={SOURCE_COMMENT_ID}; "
        "source_author=owner; source_tag=AGENT_HUB_APP_CONTROL_BRIDGE_CONTINUATION"
    )
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: manual-5642356738-AGENT_HUB_APP_CONTROL_BRIDGE_CONTINUATION",
        "root_task_id: manual-5642356738-AGENT_HUB_APP_CONTROL_BRIDGE_CONTINUATION",
        "worker: agent-hub-validation",
        f"repository: {REPOSITORY}",
        "base_branch: main",
        f"base_sha: {SOURCE_SHA}",
        "branch: none",
        "status: partial",
        f"head_sha: {SOURCE_SHA}",
        "pr_number: none",
        "changed_files: []",
        f"checks: {checks}",
        "ci_run_id: none",
        f"summary: {summary}",
        "remaining: continue from reported FIRST_ZERO",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        "prohibited_actions_confirmed: no prohibited actions were performed",
    ])
    return {
        "id": 5642358354,
        "body": body,
        "user": {"login": "github-actions[bot]"},
        "author_association": "CONTRIBUTOR",
    }


def source_comment(*, owner: bool = True, branch: str = BRANCH) -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT][AGENT_HUB_APP_CONTROL_BRIDGE_CONTINUATION]",
        f"actual_main: {SOURCE_SHA}",
        f"FIRST_ZERO: Continue existing owner branch {branch}. Existing committed files remain bounded.",
        "code_mutation: 0",
        "workflow_mutation: 0",
        "new_pr: 0",
    ])
    return {
        "id": SOURCE_COMMENT_ID,
        "body": body,
        "user": {"login": "owner" if owner else "contributor"},
        "author_association": "OWNER" if owner else "CONTRIBUTOR",
    }


def merged_pull(number: int) -> dict[str, Any]:
    return {
        "number": number,
        "state": "closed",
        "merged_at": "2026-09-12T04:00:59Z",
        "merge_commit_sha": MERGE_SHA,
        "head": {"ref": BRANCH},
        "base": {"ref": "main"},
    }


class ManualHandoffReconciliationTests(unittest.TestCase):
    def test_exact_owner_branch_with_unique_merged_pr_is_terminal_control_evidence(self) -> None:
        github = FakeGitHub()
        result = classify_if_supported(
            adapter_report(),
            repository=REPOSITORY,
            source_issue=838,
            current_sha=CURRENT_SHA,
            github=github,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.reason, "historical_manual_handoff_owner_pr_merged")
        self.assertIn("pr:1027:merged", result.evidence)
        self.assertIn(f"merge_commit:{MERGE_SHA}:ancestor", result.evidence)
        self.assertIn("economic_or_product_resolution_asserted:false", result.evidence)
        self.assertEqual(sum("/compare/" in path for path in github.requests), 2)

    def test_unmerged_owner_pr_stays_blocking(self) -> None:
        self.assertIsNone(classify_if_supported(
            adapter_report(), repository=REPOSITORY, source_issue=838,
            current_sha=CURRENT_SHA, github=FakeGitHub(merged=False)
        ))

    def test_non_owner_source_comment_stays_blocking(self) -> None:
        self.assertIsNone(classify_if_supported(
            adapter_report(), repository=REPOSITORY, source_issue=838,
            current_sha=CURRENT_SHA, github=FakeGitHub(source_owner=False)
        ))

    def test_ambiguous_branch_pr_history_stays_blocking(self) -> None:
        self.assertIsNone(classify_if_supported(
            adapter_report(), repository=REPOSITORY, source_issue=838,
            current_sha=CURRENT_SHA, github=FakeGitHub(ambiguous=True)
        ))

    def test_source_tag_mismatch_stays_blocking(self) -> None:
        self.assertIsNone(classify_if_supported(
            adapter_report(source_tag="OTHER_TAG"), repository=REPOSITORY, source_issue=838,
            current_sha=CURRENT_SHA, github=FakeGitHub()
        ))


if __name__ == "__main__":
    unittest.main()
