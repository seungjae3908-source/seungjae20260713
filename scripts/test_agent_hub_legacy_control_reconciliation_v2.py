from __future__ import annotations

import unittest
from typing import Any

from scripts.agent_hub_legacy_control_reconciliation_v2 import classify_if_supported

REPOSITORY = "owner/repo"
CURRENT = "f" * 40
OLD = "a" * 40
PRODUCER = "b" * 40


class FakeGitHub:
    repository = REPOSITORY

    def __init__(self, *, pulls=None, runs=None, ancestors=None) -> None:
        self.pulls = pulls or {}
        self.runs = runs or {}
        self.ancestors = ancestors if ancestors is not None else {(OLD, CURRENT), (PRODUCER, OLD)}
        self.requests: list[str] = []

    def request(self, method: str, path: str, payload=None) -> Any:
        if method != "GET":
            raise AssertionError("classification must be read-only")
        self.requests.append(path)
        if "/compare/" in path:
            source, target = path.rsplit("/compare/", 1)[-1].split("...", 1)
            if (source, target) in self.ancestors:
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
                "merge_base_commit": {"sha": "c" * 40},
                "head_commit": {"sha": target},
            }
        if "/actions/runs/" in path:
            run_id = int(path.rsplit("/", 1)[-1])
            return self.runs.get(run_id, {"id": run_id, "status": "completed", "conclusion": "failure"})
        if "/pulls/" in path:
            number = int(path.rsplit("/", 1)[-1])
            return {"number": number, "state": self.pulls.get(number, "open")}
        raise AssertionError(f"unexpected request {path}")


def comment(body: str, cid: int = 100, *, owner: bool = True) -> dict[str, Any]:
    return {
        "id": cid,
        "body": body,
        "user": {"login": "owner" if owner else "other"},
        "author_association": "OWNER" if owner else "CONTRIBUTOR",
    }


def successful_run(run_id: int, sha: str, event: str, attempt: int = 1) -> dict[str, Any]:
    return {
        "id": run_id,
        "head_sha": sha,
        "status": "completed",
        "conclusion": "success",
        "event": event,
        "run_attempt": attempt,
    }


class LegacyControlReconciliationTests(unittest.TestCase):
    def test_closed_owner_pr_lifecycle_is_control_terminal_only(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
owner: PR #816 Settlement Profitability Evidence Gate
state: MERGED_OWNER_COMPLETE
postmerge_exact_main: {OLD}
profitability_credit: 0
trusted_boundary: effective-independent N57 / TRAIN57 / VALIDATION0 / OOS0
FIRST_ZERO: first genuine VALIDATION
full_cost_ready: false
profitability_proven: false
"""
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT,
            github=FakeGitHub(pulls={816: "closed"})
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.reason, "historical_closed_owner_pr_lifecycle")
        self.assertIn("pr:816:closed", result.evidence)
        self.assertIn("economic_resolution_asserted:false", result.evidence)

    def test_open_owner_pr_lifecycle_stays_blocking(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
owner_pr: 807
exact_current_main: {OLD}
economic_credit_delta_from_pr807: 0
VALIDATION: 0
OOS: 0
FIRST_ZERO: FIRST_GENUINE_VALIDATION
"""
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT,
            github=FakeGitHub(pulls={807: "open"})
        )
        self.assertIsNone(result)

    def test_lifecycle_positive_economic_credit_stays_blocking(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
owner: PR #816 Settlement Profitability Evidence Gate
exact_main: {OLD}
profitability_credit: 1
VALIDATION: 0
OOS: 0
FIRST_ZERO: first genuine VALIDATION
"""
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT,
            github=FakeGitHub(pulls={816: "closed"})
        )
        self.assertIsNone(result)

    def test_natural_train_progress_requires_immutable_runs(self) -> None:
        body = f'''[WORKER_REPORT]
schema_version: 2
goal: "profitability proof closed-loop — genuine effective-independent monotonic advance"
status: "PROGRESS"
provenance:
  exactMainAtEvidence: "{OLD}"
  sourceRun: 101
  ingestRun: 102
  independenceRun: 103
evidence:
  previousEffectiveIndependentN: 56
  effectiveIndependentN: 57
  newIndependentRows: 1
  newSplit: "TRAIN"
  genuineFirstAttempt: true
  repairRowsUsed: 0
  backfillRowsUsed: 0
  rerunRowsUsed: 0
  manualRowsUsed: 0
  replayRowsUsed: 0
  economicCredit: 0
  VALIDATION: 0
  OOS: 0
finding:
  firstZero: "first genuine VALIDATION"
'''
        github = FakeGitHub(runs={
            101: successful_run(101, OLD, "schedule"),
            102: successful_run(102, OLD, "workflow_run"),
            103: successful_run(103, OLD, "workflow_run"),
        })
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT, github=github
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.reason, "historical_owner_natural_evidence_progress")
        self.assertIn("train_evidence_preserved:true", result.evidence)
        self.assertIn("validation_oos_credit:0", result.evidence)

    def test_natural_train_progress_rejects_rerun_source(self) -> None:
        body = f'''[WORKER_REPORT]
schema_version: 2
exactMainAtEvidence: {OLD}
sourceRun: 101
ingestRun: 102
independenceRun: 103
newSplit: TRAIN
genuineFirstAttempt: true
replayRowsUsed: 0
backfillRowsUsed: 0
manualRowsUsed: 0
economicCredit: 0
VALIDATION: 0
OOS: 0
firstZero: first genuine VALIDATION
'''
        github = FakeGitHub(runs={
            101: successful_run(101, OLD, "schedule", attempt=2),
            102: successful_run(102, OLD, "workflow_run"),
            103: successful_run(103, OLD, "workflow_run"),
        })
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT, github=github
        )
        self.assertIsNone(result)

    def test_producer_lineage_is_verified_separately(self) -> None:
        body = f'''[WORKER_REPORT]
schema_version: 2
report_id: PROFITABILITY_CLOSED_LOOP_SLOT164_N61_20260910
status: COMPLETE
exact_current_main: {OLD}
producer_head_sha: {PRODUCER}
ci_economic_credit: 0
- source_run: 201
- canonical_ingest_run: 202
- effective_independence_run: 203
- source_run_attempt: 1
- split: TRAIN
- replay: false
- backfill: false
- manual_batch: false
- VALIDATION: 0
- OOS: 0
- downstream_economic_credit_delta: 0
- FIRST_ZERO: first genuine VALIDATION
'''
        github = FakeGitHub(runs={
            201: successful_run(201, PRODUCER, "schedule"),
            202: successful_run(202, PRODUCER, "workflow_run"),
            203: successful_run(203, PRODUCER, "workflow_run"),
        })
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT, github=github
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn(f"producer_main:{PRODUCER}", result.evidence)

    def test_transport_correction_requires_future_data_only_and_successful_ci(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
task_id: profitability-closed-loop-n60-transport-correction-20260910
root_task_id: profitability-closed-loop
worker: agent-hub-validation
repository: {REPOSITORY}
base_branch: main
base_sha: {OLD}
branch: none
status: blocked
head_sha: {OLD}
pr_number: none
changed_files: []
ci_run_id: 301
summary: Transport correction only. Trusted state TRAIN60/VALIDATION0/OOS0. FIRST_ZERO remains first genuine VALIDATION. Economic credit delta from this correction is 0. No replay/backfill/synthetic/manual credit.
remaining: Fail closed until future natural evidence exists; do not create a code owner for a future-data-only blocker.
"""
        github = FakeGitHub(runs={301: successful_run(301, OLD, "workflow_dispatch")})
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT, github=github
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.reason, "historical_future_data_transport_correction")
        self.assertIn("future_data_only_blocker:true", result.evidence)

    def test_transport_correction_failed_ci_stays_blocking(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
root_task_id: profitability-closed-loop
worker: agent-hub-validation
base_sha: {OLD}
branch: none
status: blocked
head_sha: {OLD}
pr_number: none
changed_files: []
ci_run_id: 301
summary: Transport correction only. VALIDATION0/OOS0. FIRST_ZERO first genuine VALIDATION. Economic credit delta from this correction is 0. No replay/backfill/synthetic/manual credit.
remaining: future natural evidence only; do not create a code owner.
"""
        github = FakeGitHub(runs={301: {"id": 301, "head_sha": OLD, "status": "completed", "conclusion": "failure"}})
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT, github=github
        )
        self.assertIsNone(result)

    def test_non_owner_never_reconciles(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
owner: PR #816
exact_main: {OLD}
profitability_credit: 0
VALIDATION: 0
OOS: 0
FIRST_ZERO: first genuine VALIDATION
"""
        result = classify_if_supported(
            comment(body, owner=False), repository=REPOSITORY, current_sha=CURRENT,
            github=FakeGitHub(pulls={816: "closed"})
        )
        self.assertIsNone(result)

    def test_non_ancestor_historical_main_never_reconciles(self) -> None:
        body = f"""[WORKER_REPORT]
schema_version: 2
owner: PR #816
exact_main: {OLD}
profitability_credit: 0
VALIDATION: 0
OOS: 0
FIRST_ZERO: first genuine VALIDATION
"""
        result = classify_if_supported(
            comment(body), repository=REPOSITORY, current_sha=CURRENT,
            github=FakeGitHub(pulls={816: "closed"}, ancestors=set())
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
