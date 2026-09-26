#!/usr/bin/env python3
"""Fail-closed reconciliation for compact historical TRAIN evidence checkpoints.

This helper handles one narrow OWNER-authored legacy report shape that predates the
canonical WorkerReport control fields. It never converts TRAIN progress into Validation,
OOS, Full Cost, profitability, or any other economic/product resolution. A report is
terminal for Hub control continuity only after its historical producer SHA is proven to
be an ancestor of current main and its source/ingest/independence runs are re-verified as
first-attempt successful GitHub Actions runs on that exact producer SHA.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any, Mapping

try:
    import agent_hub_contract_v2 as contract  # type: ignore
    import agent_hub_rollover_v2 as rollover  # type: ignore
    import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore
    import agent_hub_stale_report_reconciliation_v1 as stale  # type: ignore
    import agent_hub_legacy_control_reconciliation_v2 as legacy  # type: ignore
except ModuleNotFoundError:
    from scripts import agent_hub_contract_v2 as contract  # type: ignore
    from scripts import agent_hub_rollover_v2 as rollover  # type: ignore
    from scripts import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore
    from scripts import agent_hub_stale_report_reconciliation_v1 as stale  # type: ignore
    from scripts import agent_hub_legacy_control_reconciliation_v2 as legacy  # type: ignore


POLICY_VERSION = "agent-hub-recovery-legacy-compact-train-v1"
REPORT_ID_RE = re.compile(r"^PROFITABILITY_CLOSED_LOOP_SLOT\d+_N\d+_\d{8}$")


class CompactTrainReconciliationError(RuntimeError):
    pass


def _nonnegative_int(body: str, key: str) -> int | None:
    value = legacy._field(body, key)
    if not value.isdigit():
        return None
    return int(value)


def _normalized(value: str) -> str:
    return re.sub(r"[_-]+", " ", value.strip().lower())


def classify_if_supported(
    comment: Mapping[str, Any],
    *,
    repository: str,
    source_issue: int,
    current_sha: str,
    github: Any,
) -> stale.Reconciliation | None:
    """Classify only the compact natural TRAIN checkpoint family; unknowns stay blocking."""
    if not legacy._owner_comment(comment, repository):
        return None
    body = str(comment.get("body") or "")
    report_id = legacy._field(body, "report_id")
    if (
        legacy._field(body, "schema_version") != "2"
        or not REPORT_ID_RE.fullmatch(report_id)
        or legacy._field(body, "repository") != repository
        or legacy._field(body, "canonical_hub") != str(source_issue)
        or legacy._field(body, "release_control") != "23"
        or legacy._owner_pr_refs(body)
        or legacy._field(body, "split").upper() != "TRAIN"
        or legacy._field(body, "aggressive_side").upper() not in {"BUY", "SELL"}
        or _normalized(legacy._field(body, "first_zero")) != "first genuine validation"
        or legacy._field(body, "calibration").upper() != "BLOCKED_DATA"
        or legacy._field(body, "liquidity_impact").upper() != "BLOCKED_DATA"
        or legacy._field(body, "full_cost").upper() != "BLOCKED_DATA"
        or legacy._field(body, "profitability_proven").lower() != "false"
        or legacy._field(body, "forbidden_actions_performed").lower() != "none"
        or not legacy._future_validation_zero(body)
        or not legacy._has_zero_economic_truth(body)
        or not legacy._no_forbidden_credit(body)
    ):
        return None

    slot_index = _nonnegative_int(body, "slot_index")
    effective_n = _nonnegative_int(body, "effective_independent_n")
    buy_n = _nonnegative_int(body, "independent_buy_n")
    sell_n = _nonnegative_int(body, "independent_sell_n")
    train_n = _nonnegative_int(body, "train_n")
    validation_n = _nonnegative_int(body, "validation_n")
    oos_n = _nonnegative_int(body, "oos_n")
    prospective_credit = _nonnegative_int(body, "prospective_slot_credit")
    manual_credit = _nonnegative_int(body, "manual_credit")
    replay_credit = _nonnegative_int(body, "replay_credit")
    backfill_credit = _nonnegative_int(body, "backfill_credit")
    economic_credit = _nonnegative_int(body, "economic_credit_delta")
    counts = (
        slot_index,
        effective_n,
        buy_n,
        sell_n,
        train_n,
        validation_n,
        oos_n,
        prospective_credit,
        manual_credit,
        replay_credit,
        backfill_credit,
        economic_credit,
    )
    if any(value is None for value in counts):
        return None
    assert slot_index is not None
    assert effective_n is not None
    assert buy_n is not None
    assert sell_n is not None
    assert train_n is not None
    assert validation_n is not None
    assert oos_n is not None
    assert prospective_credit is not None
    assert manual_credit is not None
    assert replay_credit is not None
    assert backfill_credit is not None
    assert economic_credit is not None
    if (
        slot_index <= 0
        or effective_n <= 0
        or buy_n + sell_n != effective_n
        or train_n != effective_n
        or validation_n != 0
        or oos_n != 0
        or prospective_credit != 1
        or manual_credit != 0
        or replay_credit != 0
        or backfill_credit != 0
        or economic_credit != 0
    ):
        return None

    producer_sha = legacy._sha_from(body, "producer_sha")
    source_run = legacy._int_from(body, "source_run")
    ingest_run = legacy._int_from(body, "ingest_run")
    independence_run = legacy._int_from(body, "independence_run")
    if not producer_sha or None in {source_run, ingest_run, independence_run}:
        return None
    if producer_sha != current_sha and not legacy._verified_ancestor(github, producer_sha, current_sha):
        return None
    if not legacy._successful_run(github, int(source_run), producer_sha, event="schedule", attempt=1):
        return None
    if not legacy._successful_run(github, int(ingest_run), producer_sha, event="workflow_run", attempt=1):
        return None
    if not legacy._successful_run(github, int(independence_run), producer_sha, event="workflow_run", attempt=1):
        return None

    cid = legacy._comment_id(comment)
    task = report_id if contract.TASK_RE.fullmatch(report_id) else f"report-{cid}"
    evidence = (
        f"producer_main:{producer_sha}",
        f"source_run:{source_run}:schedule:success:first_attempt",
        f"ingest_run:{ingest_run}:workflow_run:success:first_attempt",
        f"independence_run:{independence_run}:workflow_run:success:first_attempt",
        f"slot_index:{slot_index}",
        f"effective_independent_n:{effective_n}",
        "train_evidence_preserved:true",
        "validation_oos_credit:0",
        "economic_credit:0",
        f"current_main:{current_sha}",
    )
    return stale.Reconciliation(
        cid,
        task,
        "historical_owner_compact_train_evidence_progress",
        evidence,
    )


def reconcile(*, source_issue: int, confirmation: str, apply: bool) -> dict[str, Any]:
    recovery.assert_manual_invocation(source_issue=source_issue, confirmation=confirmation)
    token = os.environ.get("GITHUB_TOKEN", "")
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    github = rollover.GitHubClient(token, api_url, repository)

    source = github.issue(source_issue)
    total = int(source.get("comments") or 0)
    window = recovery.read_bounded_comment_window(
        github, source_issue, total, rollover.PROCESSOR_COMMENT_WINDOW
    )
    current_sha = legacy._current_main_sha(github)
    pending = stale.pending_report_comments(window.comments, repository=repository)

    plan: list[stale.Reconciliation] = []
    for comment in pending:
        item = classify_if_supported(
            comment,
            repository=repository,
            source_issue=source_issue,
            current_sha=current_sha,
            github=github,
        )
        if item is not None:
            plan.append(item)

    if legacy._current_main_sha(github) != current_sha:
        raise CompactTrainReconciliationError("main moved during compact TRAIN reconciliation")
    refreshed = github.issue(source_issue)
    if int(refreshed.get("comments") or 0) != total:
        raise CompactTrainReconciliationError("Hub comment count changed during compact TRAIN reconciliation")

    posted: list[int] = []
    if apply:
        for item in plan:
            body = stale.terminal_command_body(item, repository=repository, current_sha=current_sha)
            response = github.request(
                "POST", f"/repos/{repository}/issues/{source_issue}/comments", {"body": body}
            )
            comment_id = int((response or {}).get("id") or 0)
            if comment_id <= 0:
                raise CompactTrainReconciliationError(
                    f"terminal continuity comment was not acknowledged for source {item.source_report_comment_id}"
                )
            posted.append(comment_id)

    result = {
        "source_issue": source_issue,
        "current_main": current_sha,
        "pending_report_count": len(pending),
        "recognized_count": len(plan),
        "recognized": [
            {
                "source_report_comment_id": item.source_report_comment_id,
                "reason": item.reason,
                "evidence": list(item.evidence),
            }
            for item in plan
        ],
        "apply": apply,
        "posted_terminal_commands": posted,
        "unknown_reports_left_blocking": len(pending) - len(plan),
        "economic_or_product_resolution_asserted": False,
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-issue", type=int, required=True)
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    reconcile(source_issue=args.source_issue, confirmation=args.confirmation, apply=args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
