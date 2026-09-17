#!/usr/bin/env python3
"""Fail-closed reconciliation for later historical Hub overflow report families.

This helper is intentionally narrower than the general stale-report reconciler. It handles
three OWNER-authored historical record families that can remain visible in an overflowed
processor window after their code/economic authority has already ended:

* closed-PR lifecycle checkpoints,
* immutable natural-evidence progress checkpoints, and
* read-only transport corrections blocked only on future natural evidence.

The helper never declares product/economic/profitability resolution. It emits only the same
canonical ``superseded`` Hub-control continuity command used by the existing recovery path,
and only after immutable GitHub lineage/run/PR evidence is re-verified. Unknown records are
left untouched so the existing recovery remains fail-closed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any, Mapping, Sequence

try:
    import agent_hub_contract_v2 as contract  # type: ignore
    import agent_hub_rollover_v2 as rollover  # type: ignore
    import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore
    import agent_hub_stale_report_reconciliation_v1 as stale  # type: ignore
except ModuleNotFoundError:
    from scripts import agent_hub_contract_v2 as contract  # type: ignore
    from scripts import agent_hub_rollover_v2 as rollover  # type: ignore
    from scripts import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore
    from scripts import agent_hub_stale_report_reconciliation_v1 as stale  # type: ignore


POLICY_VERSION = "agent-hub-recovery-legacy-control-v2"
SHA_CAPTURE = r"([0-9a-fA-F]{40})"
OWNER_PR_PATTERNS = (
    re.compile(r"(?im)^\s*owner\s*:\s*PR\s*#(\d+)\b"),
    re.compile(r"(?im)^\s*owner_pr\s*:\s*#?(\d+)\b"),
    re.compile(r"(?i)Existing downstream owner PR\s*#(\d+)\s+is reused"),
)
ECONOMIC_ZERO_KEYS = (
    "profitability_credit",
    "economic_credit_delta",
    "economic_credit_delta_from_pr807",
    "downstream_economic_credit_delta",
    "ci_economic_credit",
    "economicCredit",
)


class LegacyControlReconciliationError(RuntimeError):
    pass


def _comment_id(comment: Mapping[str, Any]) -> int:
    value = comment.get("id")
    if type(value) is not int or value <= 0:
        raise LegacyControlReconciliationError("pending report has no valid comment id")
    return value


def _owner_comment(comment: Mapping[str, Any], repository: str) -> bool:
    owner = repository.split("/", 1)[0]
    return (
        str(comment.get("author_association") or "").upper() == "OWNER"
        and str((comment.get("user") or {}).get("login") or "") == owner
    )


def _field(body: str, key: str) -> str:
    match = re.search(rf"(?im)^\s*-?\s*{re.escape(key)}\s*:\s*([^\n]+)$", body)
    if not match:
        return ""
    return match.group(1).strip().strip('"').strip("'")


def _sha_from(body: str, *keys: str) -> str:
    for key in keys:
        match = re.search(rf"(?im)^\s*-?\s*{re.escape(key)}\s*:\s*{SHA_CAPTURE}\b", body)
        if match:
            return match.group(1).lower()
    phrase = re.search(rf"(?i)exact current main\s*=\s*{SHA_CAPTURE}\b", body)
    return phrase.group(1).lower() if phrase else ""


def _int_from(body: str, *keys: str) -> int | None:
    for key in keys:
        value = _field(body, key)
        if value.isdigit() and int(value) > 0:
            return int(value)
    return None


def _current_main_sha(github: Any) -> str:
    payload = github.request("GET", f"/repos/{github.repository}/branches/main")
    sha = str(((payload or {}).get("commit") or {}).get("sha") or "").strip().lower()
    if not contract.SHA_RE.fullmatch(sha):
        raise LegacyControlReconciliationError("current main SHA is missing or invalid")
    return sha


def _pull_closed(github: Any, number: int) -> bool:
    payload = github.request("GET", f"/repos/{github.repository}/pulls/{number}")
    return bool(
        isinstance(payload, dict)
        and int(payload.get("number") or 0) == number
        and str(payload.get("state") or "").lower() == "closed"
    )


def _verified_ancestor(github: Any, source_sha: str, current_sha: str) -> bool:
    if not contract.SHA_RE.fullmatch(source_sha) or source_sha == current_sha:
        return False
    payload = github.request("GET", f"/repos/{github.repository}/compare/{source_sha}...{current_sha}")
    if not isinstance(payload, dict):
        return False
    return (
        str(payload.get("status") or "").lower() == "ahead"
        and int(payload.get("behind_by") or 0) == 0
        and str(((payload.get("base_commit") or {}).get("sha")) or "").lower() == source_sha
        and str(((payload.get("merge_base_commit") or {}).get("sha")) or "").lower() == source_sha
    )


def _successful_run(
    github: Any,
    run_id: int,
    sha: str,
    *,
    event: str | None = None,
    attempt: int | None = None,
) -> bool:
    payload = github.request("GET", f"/repos/{github.repository}/actions/runs/{run_id}")
    if not isinstance(payload, dict) or int(payload.get("id") or 0) != run_id:
        return False
    if str(payload.get("head_sha") or "").lower() != sha:
        return False
    if str(payload.get("status") or "").lower() != "completed":
        return False
    if str(payload.get("conclusion") or "").lower() != "success":
        return False
    if event is not None and str(payload.get("event") or "") != event:
        return False
    if attempt is not None and int(payload.get("run_attempt") or 0) != attempt:
        return False
    return True


def _has_zero_economic_truth(body: str) -> bool:
    values: list[int] = []
    for key in ECONOMIC_ZERO_KEYS:
        for match in re.finditer(rf"(?im)^\s*-?\s*{re.escape(key)}\s*:\s*(-?\d+)\b", body):
            values.append(int(match.group(1)))
    lowered = body.lower()
    if "economic credit delta from this correction is 0" in lowered:
        values.append(0)
    return bool(values) and all(value == 0 for value in values)


def _zero_split(body: str, name: str) -> bool:
    patterns = (
        rf"(?im)^\s*-?\s*{name}\s*:\s*0\b",
        rf"(?im)^\s*-?\s*{name}_n\s*:\s*0\b",
        rf"(?i)\b{name}\s*0\b",
    )
    return any(re.search(pattern, body) is not None for pattern in patterns)


def _future_validation_zero(body: str) -> bool:
    lowered = body.lower()
    return (
        _zero_split(body, "VALIDATION")
        and _zero_split(body, "OOS")
        and "first genuine validation" in lowered
    )


def _no_forbidden_credit(body: str) -> bool:
    lowered = body.lower()
    prohibited_positive = (
        r"(?im)^\s*-?\s*(?:replay|backfill|manual|synthetic)(?:rowsused|_rows_used|_credit)?\s*:\s*(?:true|[1-9]\d*)\b",
        r"(?im)^\s*-?\s*(?:manual_batch|operator_selected)\s*:\s*true\b",
    )
    if any(re.search(pattern, body) for pattern in prohibited_positive):
        return False
    if any(phrase in lowered for phrase in ("replay: true", "backfill: true", "manual_batch: true")):
        return False
    return True


def _owner_pr_refs(body: str) -> tuple[int, ...]:
    refs: set[int] = set()
    for pattern in OWNER_PR_PATTERNS:
        refs.update(int(value) for value in pattern.findall(body) if int(value) > 0)
    return tuple(sorted(refs))


def _closed_pr_lifecycle(
    comment: Mapping[str, Any], *, repository: str, current_sha: str, github: Any
) -> stale.Reconciliation | None:
    if not _owner_comment(comment, repository):
        return None
    body = str(comment.get("body") or "")
    if _field(body, "schema_version") != "2":
        return None
    refs = _owner_pr_refs(body)
    if not refs:
        return None
    historical_sha = _sha_from(body, "postmerge_exact_main", "exact_current_main", "exact_main", "premerge_main")
    if not historical_sha or not _verified_ancestor(github, historical_sha, current_sha):
        return None
    if not _has_zero_economic_truth(body) or not _future_validation_zero(body):
        return None
    if not _no_forbidden_credit(body):
        return None
    if not all(_pull_closed(github, number) for number in refs):
        return None
    cid = _comment_id(comment)
    task = _field(body, "task_id") or _field(body, "report_id") or f"report-{cid}"
    if not contract.TASK_RE.fullmatch(task):
        task = f"report-{cid}"
    evidence = tuple(f"pr:{number}:closed" for number in refs) + (
        f"historical_main:{historical_sha}",
        "economic_resolution_asserted:false",
        f"current_main:{current_sha}",
    )
    return stale.Reconciliation(cid, task, "historical_closed_owner_pr_lifecycle", evidence)


def _natural_evidence_progress(
    comment: Mapping[str, Any], *, repository: str, current_sha: str, github: Any
) -> stale.Reconciliation | None:
    if not _owner_comment(comment, repository):
        return None
    body = str(comment.get("body") or "")
    if _field(body, "schema_version") != "2" or _owner_pr_refs(body):
        return None
    lowered = body.lower()
    if not _future_validation_zero(body) or not _has_zero_economic_truth(body) or not _no_forbidden_credit(body):
        return None
    if not any(token in lowered for token in ("genuinefirstattempt: true", "source_run_attempt: 1")):
        return None
    if not any(token in lowered for token in ("newsplit: \"train\"", "newsplit: train", "split: train")):
        return None

    historical_sha = _sha_from(body, "exactMainAtEvidence", "exact_current_main", "exact_main")
    producer_sha = _sha_from(body, "producer_head_sha") or historical_sha
    if not historical_sha or not producer_sha:
        return None
    if historical_sha != current_sha and not _verified_ancestor(github, historical_sha, current_sha):
        return None
    if producer_sha != historical_sha and not _verified_ancestor(github, producer_sha, historical_sha):
        return None

    source_run = _int_from(body, "sourceRun", "source_run")
    ingest_run = _int_from(body, "ingestRun", "canonical_ingest_run", "ingest_run")
    independence_run = _int_from(body, "independenceRun", "effective_independence_run", "independence_run")
    if None in {source_run, ingest_run, independence_run}:
        return None
    if not _successful_run(github, int(source_run), producer_sha, event="schedule", attempt=1):
        return None
    if not _successful_run(github, int(ingest_run), producer_sha, event="workflow_run", attempt=1):
        return None
    if not _successful_run(github, int(independence_run), producer_sha, event="workflow_run", attempt=1):
        return None

    cid = _comment_id(comment)
    task = _field(body, "task_id") or _field(body, "report_id") or f"report-{cid}"
    if not contract.TASK_RE.fullmatch(task):
        task = f"report-{cid}"
    evidence = (
        f"historical_main:{historical_sha}",
        f"producer_main:{producer_sha}",
        f"source_run:{source_run}:schedule:success:first_attempt",
        f"ingest_run:{ingest_run}:workflow_run:success",
        f"independence_run:{independence_run}:workflow_run:success",
        "train_evidence_preserved:true",
        "validation_oos_credit:0",
        f"current_main:{current_sha}",
    )
    return stale.Reconciliation(cid, task, "historical_owner_natural_evidence_progress", evidence)


def _future_data_transport_correction(
    comment: Mapping[str, Any], *, repository: str, current_sha: str, github: Any
) -> stale.Reconciliation | None:
    if not _owner_comment(comment, repository):
        return None
    body = str(comment.get("body") or "")
    lowered = body.lower()
    if (
        _field(body, "schema_version") != "2"
        or _field(body, "worker") != "agent-hub-validation"
        or _field(body, "root_task_id") != "profitability-closed-loop"
        or _field(body, "status").lower() != "blocked"
        or _field(body, "branch").lower() != "none"
        or _field(body, "pr_number").lower() not in {"none", "n/a", ""}
        or _field(body, "changed_files") != "[]"
        or "transport correction only" not in lowered
        or "future natural" not in lowered
        or "do not create a code owner" not in lowered
        or not _future_validation_zero(body)
        or not _has_zero_economic_truth(body)
        or not _no_forbidden_credit(body)
    ):
        return None
    base_sha = _sha_from(body, "base_sha")
    head_sha = _sha_from(body, "head_sha")
    ci_run = _int_from(body, "ci_run_id")
    if not base_sha or head_sha != base_sha or ci_run is None:
        return None
    if not _verified_ancestor(github, base_sha, current_sha):
        return None
    if not _successful_run(github, ci_run, base_sha):
        return None
    cid = _comment_id(comment)
    task = _field(body, "root_task_id") or f"report-{cid}"
    if not contract.TASK_RE.fullmatch(task):
        task = f"report-{cid}"
    evidence = (
        f"historical_main:{base_sha}",
        f"required_ci_run:{ci_run}:success",
        "transport_only:true",
        "future_data_only_blocker:true",
        "economic_credit:0",
        f"current_main:{current_sha}",
    )
    return stale.Reconciliation(cid, task, "historical_future_data_transport_correction", evidence)


def classify_if_supported(
    comment: Mapping[str, Any], *, repository: str, current_sha: str, github: Any
) -> stale.Reconciliation | None:
    """Return a strict continuity classification or leave the report untouched."""
    classifiers = (
        _closed_pr_lifecycle,
        _natural_evidence_progress,
        _future_data_transport_correction,
    )
    matches = [
        item
        for classifier in classifiers
        if (item := classifier(comment, repository=repository, current_sha=current_sha, github=github)) is not None
    ]
    if len(matches) > 1:
        raise LegacyControlReconciliationError(
            f"pending report {_comment_id(comment)} matched multiple legacy-control families"
        )
    return matches[0] if matches else None


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
    current_sha = _current_main_sha(github)
    pending = stale.pending_report_comments(window.comments, repository=repository)

    plan: list[stale.Reconciliation] = []
    for comment in pending:
        item = classify_if_supported(
            comment, repository=repository, current_sha=current_sha, github=github
        )
        if item is not None:
            plan.append(item)

    if _current_main_sha(github) != current_sha:
        raise LegacyControlReconciliationError("main moved during legacy-control reconciliation")
    refreshed = github.issue(source_issue)
    if int(refreshed.get("comments") or 0) != total:
        raise LegacyControlReconciliationError("Hub comment count changed during legacy-control reconciliation")

    posted: list[int] = []
    if apply:
        for item in plan:
            body = stale.terminal_command_body(item, repository=repository, current_sha=current_sha)
            response = github.request(
                "POST", f"/repos/{repository}/issues/{source_issue}/comments", {"body": body}
            )
            comment_id = int((response or {}).get("id") or 0)
            if comment_id <= 0:
                raise LegacyControlReconciliationError(
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
