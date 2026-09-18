from __future__ import annotations

import unittest
from typing import Any

from scripts.agent_hub_legacy_compact_train_reconciliation_v1 import classify_if_supported

REPOSITORY = "owner/repo"
SOURCE_ISSUE = 838
CURRENT = "f" * 40
PRODUCER = "a" * 40


class FakeGitHub:
    repository = REPOSITORY

    def __init__(self, *, runs=None, ancestor: bool = True) -> None:
        self.runs = runs or {}
        self.ancestor = ancestor

    def request(self, method: str, path: str, payload=None) -> Any:
        if method != "GET":
            raise AssertionError("classification must be read-only")
        if "/compare/" in path:
            source, target = path.rsplit("/compare/", 1)[-1].split("...", 1)
            if self.ancestor and source == PRODUCER and target == CURRENT:
                return {
                    "status": "ahead",
                    "behind_by": 0,
                    "base_commit": {"sha": source},
                    "merge_base_commit": {"sha": source},
                    "head_commit": {"sha": target},
                }
            return {
                "status": "diverged",
                "behind_by": 1,
                "base_commit": {"sha": source},
                "merge_base_commit": {"sha": "b" * 40},
                "head_commit": {"sha": target},
            }
        if "/actions/runs/" in path:
            run_id = int(path.rsplit("/", 1)[-1])
            return self.runs.get(run_id, {"id": run_id, "status": "completed", "conclusion": "failure"})
        if "/pulls/" in path:
            raise AssertionError("compact TRAIN reports must not use PR lifecycle proof")
        raise AssertionError(f"unexpected request {path}")


def successful_run(run_id: int, event: str, attempt: int = 1) -> dict[str, Any]:
    return {
        "id": run_id,
        "head_sha": PRODUCER,
        "status": "completed",
        "conclusion": "success",
        "event": event,
        "run_attempt": attempt,
    }


def report(*, economic_credit: int = 0, split: str = "TRAIN", validation_n: int = 0) -> dict[str, Any]:
    body = f"""[WORKER_REPORT]
schema_version: 2
report_id: PROFITABILITY_CLOSED_LOOP_SLOT173_N66_20260910
repository: {REPOSITORY}
canonical_hub: {SOURCE_ISSUE}
release_control: 23
producer_sha: {PRODUCER}
source_run: 101
ingest_run: 102
independence_run: 103
slot_index: 173
aggressive_side: SELL
split: {split}
effective_independent_n: 66
independent_buy_n: 34
independent_sell_n: 32
train_n: 66
validation_n: {validation_n}
oos_n: 0
prospective_slot_credit: 1
manual_credit: 0
replay_credit: 0
backfill_credit: 0
economic_credit_delta: {economic_credit}
first_zero: FIRST_GENUINE_VALIDATION
calibration: BLOCKED_DATA
liquidity_impact: BLOCKED_DATA
full_cost: BLOCKED_DATA
profitability_proven: false
summary: Genuine effective-independent evidence increased N65->N66. FIRST_ZERO and downstream economic-credit boundary remain unchanged.
forbidden_actions_performed: none
"""
    return {
        "id": 5614837599,
        "body": body,
        "user": {"login": "owner"},
        "author_association": "OWNER",
    }


class CompactTrainReconciliationTests(unittest.TestCase):
    def github(self, *, source_attempt: int = 1, ancestor: bool = True) -> FakeGitHub:
        return FakeGitHub(
            ancestor=ancestor,
            runs={
                101: successful_run(101, "schedule", source_attempt),
                102: successful_run(102, "workflow_run"),
                103: successful_run(103, "workflow_run"),
            },
        )

    def test_compact_train_progress_requires_immutable_first_attempt_runs(self) -> None:
        result = classify_if_supported(
            report(),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(),
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.reason, "historical_owner_compact_train_evidence_progress")
        self.assertIn("train_evidence_preserved:true", result.evidence)
        self.assertIn("validation_oos_credit:0", result.evidence)
        self.assertIn("economic_credit:0", result.evidence)

    def test_source_rerun_stays_blocking(self) -> None:
        result = classify_if_supported(
            report(),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(source_attempt=2),
        )
        self.assertIsNone(result)

    def test_positive_economic_credit_stays_blocking(self) -> None:
        result = classify_if_supported(
            report(economic_credit=1),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(),
        )
        self.assertIsNone(result)

    def test_validation_credit_stays_blocking(self) -> None:
        result = classify_if_supported(
            report(validation_n=1),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(),
        )
        self.assertIsNone(result)

    def test_non_train_split_stays_blocking(self) -> None:
        result = classify_if_supported(
            report(split="VALIDATION"),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(),
        )
        self.assertIsNone(result)

    def test_non_ancestor_producer_stays_blocking(self) -> None:
        result = classify_if_supported(
            report(),
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(ancestor=False),
        )
        self.assertIsNone(result)

    def test_wrong_hub_stays_blocking(self) -> None:
        item = report()
        item["body"] = str(item["body"]).replace("canonical_hub: 838", "canonical_hub: 660")
        result = classify_if_supported(
            item,
            repository=REPOSITORY,
            source_issue=SOURCE_ISSUE,
            current_sha=CURRENT,
            github=self.github(),
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
