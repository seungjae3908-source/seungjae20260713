from __future__ import annotations

import unittest
from typing import Any

from scripts.agent_hub_stale_report_reconciliation_v1 import (
    StaleReportReconciliationError,
    classify_pending_report,
)

REPOSITORY = "owner/repo"
SOURCE_SHA = "a" * 40
REPORT_SHA = "b" * 40
CURRENT_SHA = "c" * 40
REQUIRED_CI_RUN = 34320131625
SOURCE_RUN = 34319699720
INGEST_RUN = 34319793788
INDEPENDENCE_RUN = 34319958579


class FakeGitHub:
    repository = REPOSITORY

    def __init__(self, *, failed_run: int | None = None) -> None:
        self.failed_run = failed_run
        self.requests: list[str] = []

    def request(self, method: str, path: str, payload=None) -> Any:
        if method != "GET":
            raise AssertionError("classification must stay read-only")
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
        if "/actions/runs/" in path:
            run_id = int(path.rsplit("/", 1)[-1])
            if run_id == REQUIRED_CI_RUN:
                head_sha, event = REPORT_SHA, "push"
            elif run_id == SOURCE_RUN:
                head_sha, event = SOURCE_SHA, "schedule"
            elif run_id in {INGEST_RUN, INDEPENDENCE_RUN}:
                head_sha, event = SOURCE_SHA, "workflow_run"
            else:
                raise AssertionError(f"unexpected run {run_id}")
            return {
                "id": run_id,
                "head_sha": head_sha,
                "event": event,
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "failure" if run_id == self.failed_run else "success",
            }
        raise AssertionError(f"unexpected request {path}")


def original_report(*, replay_credit: str = "0", owner: bool = True) -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: PROFITABILITY_CLOSED_LOOP_V3_INDEPENDENCE_N54_20260909_1555_KST",
        "status: VERIFIED_EVIDENCE_INCREASE",
        "canonical_hub: 838",
        "release_control: 23",
        "profile: PROFITABILITY_PROOF",
        "target_branch: main",
        f"exact_current_main: {REPORT_SHA}",
        f"exact_current_main_required_ci_run: {REQUIRED_CI_RUN}",
        "exact_current_main_required_ci: 5/6_SUCCESS_BROWSER_UI_PENDING",
        f"source_run: {SOURCE_RUN}",
        "source_run_event: schedule",
        f"source_exact_main_at_capture: {SOURCE_SHA}",
        "source_slot: 149",
        "source_split: TRAIN",
        "source_capture_status: PRESENT",
        "source_prospective_slot_credit: 1",
        "source_run_attempt: 1",
        "source_manual_credit: 0",
        f"source_replay_credit: {replay_credit}",
        "source_backfill_credit: 0",
        "source_synthetic_credit: 0",
        "source_private_api_used: false",
        "source_live_trading: false",
        "source_real_orders: 0",
        f"ingest_run: {INGEST_RUN}",
        f"independence_run: {INDEPENDENCE_RUN}",
        "independence_artifact_id: 10091473530",
        "independence_artifact_digest: sha256:944986745a2c0941ffcd8273b33ff180fa031e7e5a10a1023f4b3d580da32f0d",
        "previous_trusted_independence_run: 34312134581",
        "previous_trusted_independence_artifact_id: 10088740121",
        "previous_effective_independent_n: 53",
        "current_effective_independent_n: 54",
        "independent_sample_delta: 1",
        "current_independent_buy_n: 26",
        "current_independent_sell_n: 28",
        "train_n: 54",
        "validation_n: 0",
        "oos_n: 0",
        "raw_accepted_n: 698",
        "raw_n_equals_independent_n: false",
        "lineage_comparison: PREVIOUS_53_STABLE_OBSERVATIONS_PRESERVED_PLUS_EXACTLY_ONE_NEW_SLOT149_SELL_TRAIN",
        "removed_prior_independent_observations: 0",
        "changed_prior_slot_event_side_assignments: 0",
        "retrospective_split_selection: false",
        "synthetic_split_assignment: false",
        "oos_outcome_credit: 0",
        "calibration_artifact_produced: false",
        "liquidity_impact_status: BLOCKED_DATA",
        "full_cost_ready: false",
        "evidence_complete: 0",
        "profitability_proven: false",
        "execution_authority: NONE",
        "first_zero: FIRST_GENUINE_VALIDATION",
        "active_same_purpose_new_owner: NONE_CREATED",
        "forbidden_actions_performed: NONE",
    ])
    return {
        "id": 100,
        "body": body,
        "user": {"login": "owner" if owner else "contributor"},
        "author_association": "OWNER" if owner else "CONTRIBUTOR",
    }


def closure_report(*, current_n: str = "54") -> dict[str, Any]:
    body = "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        "task_id: PROFITABILITY_CLOSED_LOOP_V3_INDEPENDENCE_N54_EXACT_MAIN_CI_CLOSE_20260909",
        "status: VERIFIED_EVIDENCE_INCREASE_CI_CLOSED",
        "canonical_hub: 838",
        "release_control: 23",
        "profile: PROFITABILITY_PROOF",
        f"exact_current_main: {REPORT_SHA}",
        f"exact_current_main_required_ci_run: {REQUIRED_CI_RUN}",
        "required_ci_total: 6",
        "required_ci_success: 6",
        "application_ci_verified: SUCCESS",
        "browser_ui_verified: SUCCESS",
        "database_rls_verified: SUCCESS",
        "security_integration_verified: SUCCESS",
        "ai_privacy_verified: SUCCESS",
        "futures_public_network_smoke_verified: SUCCESS",
        f"source_run: {SOURCE_RUN}",
        f"ingest_run: {INGEST_RUN}",
        f"independence_run: {INDEPENDENCE_RUN}",
        "previous_effective_independent_n: 53",
        f"current_effective_independent_n: {current_n}",
        "independent_sample_delta: 1",
        f"train_n: {current_n}",
        "validation_n: 0",
        "oos_n: 0",
        "first_zero: FIRST_GENUINE_VALIDATION",
        "frozen_validation_start_slot: 512",
        "current_credited_slot: 149",
        "remaining_slot_indices_before_first_validation_eligibility: 363",
        "economic_credit_change_beyond_independent_sample: 0",
        "calibration_artifact_produced: false",
        "liquidity_impact_status: BLOCKED_DATA",
        "full_cost_ready: false",
        "profitability_proven: false",
        "execution_authority: NONE",
        "active_same_purpose_new_owner: NONE_CREATED",
        "forbidden_actions_performed: NONE",
    ])
    return {
        "id": 101,
        "body": body,
        "user": {"login": "owner"},
        "author_association": "OWNER",
    }


class LegacyTrainEvidencePairTests(unittest.TestCase):
    def test_original_positive_train_credit_is_reconcilable_only_with_matching_ci_closure(self) -> None:
        original = original_report()
        closure = closure_report()
        github = FakeGitHub()
        result = classify_pending_report(
            original,
            repository=REPOSITORY,
            current_sha=CURRENT_SHA,
            github=github,
            pending_context=(original, closure),
        )
        self.assertEqual(result.reason, "historical_owner_train_evidence_ci_pair")
        self.assertIn("legacy_train_report:100", result.evidence)
        self.assertIn("legacy_train_ci_closure:101", result.evidence)
        self.assertIn("economic_credit_preserved:1_train_only", result.evidence)

    def test_matching_ci_closure_is_itself_reconcilable_as_same_pair(self) -> None:
        original = original_report()
        closure = closure_report()
        result = classify_pending_report(
            closure,
            repository=REPOSITORY,
            current_sha=CURRENT_SHA,
            github=FakeGitHub(),
            pending_context=(original, closure),
        )
        self.assertEqual(result.reason, "historical_owner_train_evidence_ci_pair")

    def test_positive_credit_without_ci_closure_stays_blocking(self) -> None:
        original = original_report()
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                original,
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
                pending_context=(original,),
            )
        self.assertEqual(github.requests, [])

    def test_replay_credit_stays_blocking_even_with_ci_closure(self) -> None:
        original = original_report(replay_credit="1")
        closure = closure_report()
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                original,
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
                pending_context=(original, closure),
            )
        self.assertEqual(github.requests, [])

    def test_mismatched_closure_counter_stays_blocking(self) -> None:
        original = original_report()
        closure = closure_report(current_n="55")
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                original,
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
                pending_context=(original, closure),
            )
        self.assertEqual(github.requests, [])

    def test_failed_independence_run_stays_blocking(self) -> None:
        original = original_report()
        closure = closure_report()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                original,
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=FakeGitHub(failed_run=INDEPENDENCE_RUN),
                pending_context=(original, closure),
            )

    def test_non_owner_positive_credit_stays_blocking(self) -> None:
        original = original_report(owner=False)
        closure = closure_report()
        github = FakeGitHub()
        with self.assertRaisesRegex(StaleReportReconciliationError, "noncanonical but not provably stale"):
            classify_pending_report(
                original,
                repository=REPOSITORY,
                current_sha=CURRENT_SHA,
                github=github,
                pending_context=(original, closure),
            )
        self.assertEqual(github.requests, [])


if __name__ == "__main__":
    unittest.main()
