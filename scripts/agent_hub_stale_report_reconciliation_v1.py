#!/usr/bin/env python3
"""Fail-closed stale-report reconciliation for processor-window recovery.

The normal Hub rollover intentionally refuses to move while a trusted schema-v2 report
has no command record. Very old overflowed Hubs can contain historical report records
whose owner work is already terminal, or read-only snapshots that were never executable
worker tasks. This helper does not declare the underlying product/economic issue fixed.
It only emits explicit terminal HUB_COMMAND continuity records after every pending report
in the bounded processor window is conservatively proven stale/superseded.

The helper is mutation-capable only for the same explicit workflow_dispatch + issue-scoped
confirmation used by processor-window recovery. Classification is all-or-nothing before
any issue comment is posted. Unknown or still-open work fails closed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

try:
    import agent_hub_contract_v2 as contract  # type: ignore
    import agent_hub_rollover_v2 as rollover  # type: ignore
    import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore
except ModuleNotFoundError:
    from scripts import agent_hub_contract_v2 as contract  # type: ignore
    from scripts import agent_hub_rollover_v2 as rollover  # type: ignore
    from scripts import agent_hub_processor_window_recovery_v1 as recovery  # type: ignore

POLICY_VERSION = "agent-hub-recovery-stale-report-v1"
MANUAL_ADAPTER_WORKER = "agent-hub-validation"
MANUAL_ADAPTER_CHECKS = ("manual_adapter_v2=pass", "read_only_zero_proof=1")
OWNER_LINEAGE_RE = re.compile(r"(?im)^\s*-?\s*owner\s*:\s*#(\d+)\b.*$")
LINEAGE_LINE_RE = re.compile(r"(?im)^\s*lineage\s*:\s*([^\n]+)$")
PR_REF_RE = re.compile(r"#(\d+)")
LEGACY_CHANGED_FILE_RE = re.compile(r"^[A-Za-z0-9_.@+/-]+$")
LEGACY_EVIDENCE_STATUS = "VERIFIED_EVIDENCE_INCREASE"
LEGACY_TRAIN_CI_CLOSED_STATUS = "VERIFIED_EVIDENCE_INCREASE_CI_CLOSED"
LEGACY_EVIDENCE_RUN_FIELDS = (
    "required_ci_run",
    "source_capture_run_id",
    "ingest_run_id",
    "independence_run_id",
)


class StaleReportReconciliationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Reconciliation:
    source_report_comment_id: int
    source_task_id: str
    reason: str
    evidence: tuple[str, ...]


def _comment_id(comment: Mapping[str, Any]) -> int:
    value = comment.get("id")
    if type(value) is not int or value <= 0:
        raise StaleReportReconciliationError("pending report has no valid comment id")
    return value


def _current_main_sha(github: Any) -> str:
    payload = github.request("GET", f"/repos/{github.repository}/branches/main")
    sha = str(((payload or {}).get("commit") or {}).get("sha") or "").strip().lower()
    if not contract.SHA_RE.fullmatch(sha):
        raise StaleReportReconciliationError("current main SHA is missing or invalid")
    return sha


def _pull_state(github: Any, number: int) -> str:
    payload = github.request("GET", f"/repos/{github.repository}/pulls/{number}")
    if not isinstance(payload, dict) or int(payload.get("number") or 0) != number:
        raise StaleReportReconciliationError(f"PR #{number} lookup was malformed")
    state = str(payload.get("state") or "").strip().lower()
    if state not in {"open", "closed"}:
        raise StaleReportReconciliationError(f"PR #{number} has unknown state")
    return state


def _task_id(fields: Mapping[str, str], comment_id: int) -> str:
    candidate = str(fields.get("root_task_id") or fields.get("task_id") or "").strip()
    if candidate and contract.TASK_RE.fullmatch(candidate):
        return candidate
    return f"report-{comment_id}"


def _historical_manual_snapshot(fields: Mapping[str, str], current_sha: str) -> bool:
    checks = str(fields.get("checks") or "")
    head_sha = str(fields.get("head_sha") or "").strip().lower()
    return (
        str(fields.get("worker") or "").strip() == MANUAL_ADAPTER_WORKER
        and str(fields.get("base_branch") or "").strip() == "main"
        and str(fields.get("branch") or "").strip() == "main"
        and str(fields.get("pr_number") or "").strip().lower() in {"", "none", "n/a"}
        and str(fields.get("changed_files") or "").strip() == "[]"
        and all(token in checks for token in MANUAL_ADAPTER_CHECKS)
        and bool(contract.SHA_RE.fullmatch(head_sha))
        and head_sha != current_sha
    )


def _verified_historical_main(github: Any, source_sha: str, current_sha: str) -> bool:
    """Require the legacy snapshot SHA to be an actual ancestor of current main."""
    if not contract.SHA_RE.fullmatch(source_sha) or source_sha == current_sha:
        return False
    payload = github.request(
        "GET",
        f"/repos/{github.repository}/compare/{source_sha}...{current_sha}",
    )
    if not isinstance(payload, dict):
        return False
    base = str(((payload.get("base_commit") or {}).get("sha")) or "").strip().lower()
    merge_base = str(((payload.get("merge_base_commit") or {}).get("sha")) or "").strip().lower()
    return (
        str(payload.get("status") or "").strip().lower() == "ahead"
        and int(payload.get("behind_by") or 0) == 0
        and base == source_sha
        and merge_base == source_sha
    )


def _successful_run_for_sha(
    github: Any,
    run_id: int,
    source_sha: str,
    *,
    expected_event: str | None = None,
    expected_attempt: int | None = None,
) -> bool:
    payload = github.request("GET", f"/repos/{github.repository}/actions/runs/{run_id}")
    if not isinstance(payload, dict) or int(payload.get("id") or 0) != run_id:
        return False
    if expected_event is not None and str(payload.get("event") or "").strip() != expected_event:
        return False
    if expected_attempt is not None and int(payload.get("run_attempt") or 0) != expected_attempt:
        return False
    return (
        str(payload.get("head_sha") or "").strip().lower() == source_sha
        and str(payload.get("status") or "").strip().lower() == "completed"
        and str(payload.get("conclusion") or "").strip().lower() == "success"
    )


def _historical_owner_evidence_checkpoint(
    comment: Mapping[str, Any],
    *,
    fields: Mapping[str, str],
    repository: str,
    current_sha: str,
    github: Any,
) -> tuple[str, ...] | None:
    """Recognize one strict historical evidence-only report family without inventing closure.

    Early profitability evidence collectors posted OWNER-authored schema-v2 checkpoints before
    the canonical worker-report fields existed. They did not own a PR or executable task; they
    recorded immutable natural-evidence counters and an explicit next zero. Such a record may be
    terminalized only for Hub control continuity when its old exact-main is a real ancestor of
    current main and its referenced CI run is a real successful run for that exact old SHA.
    Economic/runtime truth in the source report is preserved unchanged.
    """
    owner = repository.split("/", 1)[0] if "/" in repository else repository
    author = str((comment.get("user") or {}).get("login") or "")
    source_sha = str(fields.get("exact_main") or "").strip().lower()
    run_values = {name: str(fields.get(name) or "").strip() for name in LEGACY_EVIDENCE_RUN_FIELDS}

    if (
        str(comment.get("author_association") or "").upper() != "OWNER"
        or author != owner
        or str(fields.get("schema_version") or "").strip() != "2"
        or str(fields.get("status") or "").strip() != LEGACY_EVIDENCE_STATUS
        or not contract.TASK_RE.fullmatch(str(fields.get("task_id") or "").strip())
        or str(fields.get("canonical_hub") or "").strip() != "838"
        or str(fields.get("release_control") or "").strip() != "23"
        or str(fields.get("required_ci") or "").strip() != "6/6 SUCCESS"
        or str(fields.get("execution_authority") or "").strip() != "NONE"
        or str(fields.get("forbidden_actions_performed") or "").strip() != "0"
        or str(fields.get("downstream_economic_credit_delta") or "").strip() != "0"
        or str(fields.get("full_cost_ready") or "").strip().lower() != "false"
        or str(fields.get("net_alpha_ready") or "").strip().lower() != "false"
        or str(fields.get("profitability_proven") or "").strip().lower() != "false"
        or not str(fields.get("source_contract_family") or "").strip()
        or not str(fields.get("first_zero") or "").strip()
        or str(fields.get("pr_number") or "").strip().lower() not in {"", "none", "n/a"}
        or any(not value.isdigit() or int(value) <= 0 for value in run_values.values())
        or not contract.SHA_RE.fullmatch(source_sha)
        or source_sha == current_sha
    ):
        return None

    if not _verified_historical_main(github, source_sha, current_sha):
        return None
    required_ci_run = int(run_values["required_ci_run"])
    if not _successful_run_for_sha(github, required_ci_run, source_sha):
        return None

    return (
        f"source_main:{source_sha}",
        f"required_ci_run:{required_ci_run}:success",
        f"source_capture_run:{run_values['source_capture_run_id']}",
        f"ingest_run:{run_values['ingest_run_id']}",
        f"independence_run:{run_values['independence_run_id']}",
        f"first_zero:{fields.get('first_zero', '')}",
        f"current_main:{current_sha}",
    )


def _owner_comment(comment: Mapping[str, Any], repository: str) -> bool:
    owner = repository.split("/", 1)[0] if "/" in repository else repository
    return (
        str(comment.get("author_association") or "").upper() == "OWNER"
        and str((comment.get("user") or {}).get("login") or "") == owner
    )


def _positive_int(fields: Mapping[str, str], name: str) -> int | None:
    value = str(fields.get(name) or "").strip()
    if not value.isdigit() or int(value) <= 0:
        return None
    return int(value)


def _legacy_train_original_shape(fields: Mapping[str, str]) -> bool:
    exact_main = str(fields.get("exact_current_main") or "").strip().lower()
    source_sha = str(fields.get("source_exact_main_at_capture") or "").strip().lower()
    required_run = _positive_int(fields, "exact_current_main_required_ci_run")
    source_run = _positive_int(fields, "source_run")
    ingest_run = _positive_int(fields, "ingest_run")
    independence_run = _positive_int(fields, "independence_run")
    artifact_id = _positive_int(fields, "independence_artifact_id")
    previous_run = _positive_int(fields, "previous_trusted_independence_run")
    previous_artifact = _positive_int(fields, "previous_trusted_independence_artifact_id")
    previous_n = _positive_int(fields, "previous_effective_independent_n")
    current_n = _positive_int(fields, "current_effective_independent_n")
    delta = _positive_int(fields, "independent_sample_delta")
    buy_n = _positive_int(fields, "current_independent_buy_n")
    sell_n = _positive_int(fields, "current_independent_sell_n")
    train_n = _positive_int(fields, "train_n")
    raw_accepted_n = _positive_int(fields, "raw_accepted_n")
    source_slot = _positive_int(fields, "source_slot")
    digest = str(fields.get("independence_artifact_digest") or "").strip().lower()
    lineage = str(fields.get("lineage_comparison") or "").strip().upper()
    return bool(
        str(fields.get("schema_version") or "").strip() == "2"
        and str(fields.get("status") or "").strip() == LEGACY_EVIDENCE_STATUS
        and contract.TASK_RE.fullmatch(str(fields.get("task_id") or "").strip())
        and str(fields.get("canonical_hub") or "").strip() == "838"
        and str(fields.get("release_control") or "").strip() == "23"
        and str(fields.get("profile") or "").strip() == "PROFITABILITY_PROOF"
        and str(fields.get("target_branch") or "").strip() == "main"
        and contract.SHA_RE.fullmatch(exact_main)
        and contract.SHA_RE.fullmatch(source_sha)
        and exact_main != source_sha
        and all(value is not None for value in (
            required_run, source_run, ingest_run, independence_run, artifact_id,
            previous_run, previous_artifact, previous_n, current_n, delta,
            buy_n, sell_n, train_n, raw_accepted_n, source_slot,
        ))
        and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None
        and str(fields.get("source_run_event") or "").strip() == "schedule"
        and str(fields.get("source_split") or "").strip() == "TRAIN"
        and str(fields.get("source_capture_status") or "").strip() == "PRESENT"
        and str(fields.get("source_prospective_slot_credit") or "").strip() == "1"
        and str(fields.get("source_run_attempt") or "").strip() == "1"
        and str(fields.get("source_manual_credit") or "").strip() == "0"
        and str(fields.get("source_replay_credit") or "").strip() == "0"
        and str(fields.get("source_backfill_credit") or "").strip() == "0"
        and str(fields.get("source_synthetic_credit") or "").strip() == "0"
        and str(fields.get("source_private_api_used") or "").strip().lower() == "false"
        and str(fields.get("source_live_trading") or "").strip().lower() == "false"
        and str(fields.get("source_real_orders") or "").strip() == "0"
        and previous_n is not None and current_n == previous_n + 1
        and delta == 1
        and buy_n is not None and sell_n is not None and current_n == buy_n + sell_n
        and train_n == current_n
        and str(fields.get("validation_n") or "").strip() == "0"
        and str(fields.get("oos_n") or "").strip() == "0"
        and raw_accepted_n is not None and current_n is not None and raw_accepted_n >= current_n
        and str(fields.get("raw_n_equals_independent_n") or "").strip().lower() == "false"
        and "STABLE_OBSERVATIONS_PRESERVED_PLUS_EXACTLY_ONE_NEW_" in lineage
        and str(fields.get("removed_prior_independent_observations") or "").strip() == "0"
        and str(fields.get("changed_prior_slot_event_side_assignments") or "").strip() == "0"
        and str(fields.get("retrospective_split_selection") or "").strip().lower() == "false"
        and str(fields.get("synthetic_split_assignment") or "").strip().lower() == "false"
        and str(fields.get("oos_outcome_credit") or "").strip() == "0"
        and str(fields.get("calibration_artifact_produced") or "").strip().lower() == "false"
        and str(fields.get("liquidity_impact_status") or "").strip() == "BLOCKED_DATA"
        and str(fields.get("full_cost_ready") or "").strip().lower() == "false"
        and str(fields.get("evidence_complete") or "").strip() == "0"
        and str(fields.get("profitability_proven") or "").strip().lower() == "false"
        and str(fields.get("execution_authority") or "").strip() == "NONE"
        and str(fields.get("first_zero") or "").strip() == "FIRST_GENUINE_VALIDATION"
        and str(fields.get("active_same_purpose_new_owner") or "").strip() == "NONE_CREATED"
        and str(fields.get("forbidden_actions_performed") or "").strip() == "NONE"
    )


def _legacy_train_closure_matches(original: Mapping[str, str], closure: Mapping[str, str]) -> bool:
    same_fields = (
        "exact_current_main",
        "exact_current_main_required_ci_run",
        "source_run",
        "ingest_run",
        "independence_run",
        "previous_effective_independent_n",
        "current_effective_independent_n",
        "independent_sample_delta",
        "train_n",
        "validation_n",
        "oos_n",
        "first_zero",
    )
    return bool(
        str(closure.get("schema_version") or "").strip() == "2"
        and str(closure.get("status") or "").strip() == LEGACY_TRAIN_CI_CLOSED_STATUS
        and contract.TASK_RE.fullmatch(str(closure.get("task_id") or "").strip())
        and str(closure.get("canonical_hub") or "").strip() == "838"
        and str(closure.get("release_control") or "").strip() == "23"
        and str(closure.get("profile") or "").strip() == "PROFITABILITY_PROOF"
        and all(str(closure.get(name) or "").strip() == str(original.get(name) or "").strip() for name in same_fields)
        and str(closure.get("required_ci_total") or "").strip() == "6"
        and str(closure.get("required_ci_success") or "").strip() == "6"
        and all(str(closure.get(name) or "").strip() == "SUCCESS" for name in (
            "application_ci_verified",
            "browser_ui_verified",
            "database_rls_verified",
            "security_integration_verified",
            "ai_privacy_verified",
            "futures_public_network_smoke_verified",
        ))
        and str(closure.get("current_credited_slot") or "").strip() == str(original.get("source_slot") or "").strip()
        and str(closure.get("economic_credit_change_beyond_independent_sample") or "").strip() == "0"
        and str(closure.get("calibration_artifact_produced") or "").strip().lower() == "false"
        and str(closure.get("liquidity_impact_status") or "").strip() == "BLOCKED_DATA"
        and str(closure.get("full_cost_ready") or "").strip().lower() == "false"
        and str(closure.get("profitability_proven") or "").strip().lower() == "false"
        and str(closure.get("execution_authority") or "").strip() == "NONE"
        and str(closure.get("active_same_purpose_new_owner") or "").strip() == "NONE_CREATED"
        and str(closure.get("forbidden_actions_performed") or "").strip() == "NONE"
    )


def _historical_owner_train_evidence_pair(
    comment: Mapping[str, Any],
    *,
    fields: Mapping[str, str],
    repository: str,
    current_sha: str,
    github: Any,
    pending_context: Sequence[Mapping[str, Any]],
) -> tuple[str, ...] | None:
    """Close only a fully paired legacy TRAIN evidence checkpoint at the Hub-control layer.

    This family carries one genuine immutable TRAIN credit, so unlike zero-credit checkpoints it
    is never auto-terminalized in isolation. A later OWNER-authored CI-closure report must match
    the same capture/ingest/independence lineage and counters exactly. All referenced runs are
    then re-read from GitHub and must be successful on the recorded immutable SHAs. The source
    economic evidence remains untouched; the terminal command only prevents an informational
    historical report pair from blocking Hub rollover forever.
    """
    if not _owner_comment(comment, repository) or not pending_context:
        return None
    status = str(fields.get("status") or "").strip()
    cid = _comment_id(comment)

    candidates: list[tuple[Mapping[str, Any], Mapping[str, str], Mapping[str, Any], Mapping[str, str]]] = []
    if status == LEGACY_EVIDENCE_STATUS and _legacy_train_original_shape(fields):
        for other in pending_context:
            if not _owner_comment(other, repository) or _comment_id(other) <= cid:
                continue
            other_fields = rollover.parse_fields(str(other.get("body") or ""))
            if _legacy_train_closure_matches(fields, other_fields):
                candidates.append((comment, fields, other, other_fields))
    elif status == LEGACY_TRAIN_CI_CLOSED_STATUS:
        for other in pending_context:
            if not _owner_comment(other, repository) or _comment_id(other) >= cid:
                continue
            other_fields = rollover.parse_fields(str(other.get("body") or ""))
            if _legacy_train_original_shape(other_fields) and _legacy_train_closure_matches(other_fields, fields):
                candidates.append((other, other_fields, comment, fields))
    else:
        return None

    if len(candidates) != 1:
        return None
    original_comment, original, closure_comment, _closure = candidates[0]
    exact_main = str(original.get("exact_current_main") or "").strip().lower()
    source_sha = str(original.get("source_exact_main_at_capture") or "").strip().lower()
    required_ci_run = _positive_int(original, "exact_current_main_required_ci_run")
    source_run = _positive_int(original, "source_run")
    ingest_run = _positive_int(original, "ingest_run")
    independence_run = _positive_int(original, "independence_run")
    if None in {required_ci_run, source_run, ingest_run, independence_run}:
        return None

    if not _verified_historical_main(github, exact_main, current_sha):
        return None
    if not _verified_historical_main(github, source_sha, exact_main):
        return None
    if not _successful_run_for_sha(github, int(required_ci_run), exact_main):
        return None
    if not _successful_run_for_sha(
        github, int(source_run), source_sha, expected_event="schedule", expected_attempt=1
    ):
        return None
    if not _successful_run_for_sha(github, int(ingest_run), source_sha, expected_event="workflow_run", expected_attempt=1):
        return None
    if not _successful_run_for_sha(
        github, int(independence_run), source_sha, expected_event="workflow_run", expected_attempt=1
    ):
        return None

    return (
        f"legacy_train_report:{_comment_id(original_comment)}",
        f"legacy_train_ci_closure:{_comment_id(closure_comment)}",
        f"source_main:{source_sha}",
        f"report_main:{exact_main}",
        f"required_ci_run:{required_ci_run}:success",
        f"source_capture_run:{source_run}:success",
        f"ingest_run:{ingest_run}:success",
        f"independence_run:{independence_run}:success",
        f"effective_independent_n:{original.get('current_effective_independent_n', '')}",
        "economic_credit_preserved:1_train_only",
        f"current_main:{current_sha}",
    )


def _owner_lineage_prs(comment: Mapping[str, Any], fields: Mapping[str, str], current_sha: str) -> tuple[int, ...]:
    if str(comment.get("author_association") or "").upper() != "OWNER":
        return ()
    actual_main = str(fields.get("actual_main") or "").strip().lower()
    if not contract.SHA_RE.fullmatch(actual_main) or actual_main == current_sha:
        return ()
    body = str(comment.get("body") or "")
    refs: set[int] = {int(value) for value in OWNER_LINEAGE_RE.findall(body)}
    for lineage in LINEAGE_LINE_RE.findall(body):
        refs.update(int(value) for value in PR_REF_RE.findall(lineage))
    return tuple(sorted(number for number in refs if number > 0))


def _legacy_bare_changed_files_report(
    comment: Mapping[str, Any],
    *,
    fields: Mapping[str, str],
    repository: str,
    comment_id: int,
    author: str,
) -> contract.WorkerReport | None:
    """Normalize one historical OWNER-only bare-list field, then re-run the full contract.

    Older schema-v2 reports sometimes emitted ``changed_files: [a, b]`` before the Hub
    required JSON quoting. This adapter is deliberately local to overflow reconciliation:
    the canonical report validator remains strict, every other field is revalidated, and
    unsafe/ambiguous paths still fail closed.
    """
    owner = repository.split("/", 1)[0] if "/" in repository else repository
    if (
        str(comment.get("author_association") or "").upper() != "OWNER"
        or author != owner
    ):
        return None

    raw = str(fields.get("changed_files") or "").strip()
    if len(raw) < 2 or not raw.startswith("[") or not raw.endswith("]"):
        return None
    inner = raw[1:-1].strip()
    if not inner or '"' in inner or "'" in inner:
        return None

    items = [item.strip() for item in inner.split(",")]
    if any(not item or not LEGACY_CHANGED_FILE_RE.fullmatch(item) for item in items):
        return None
    try:
        normalized_items = contract.parse_json_list(items, "changed_files", allow_empty=False)
    except contract.ContractError:
        return None

    body = str(comment.get("body") or "")
    replacement = "changed_files: " + json.dumps(list(normalized_items), separators=(",", ":"))
    normalized_body, count = re.subn(
        r"(?m)^\s*changed_files\s*:\s*.*$",
        replacement,
        body,
        count=1,
    )
    if count != 1:
        return None
    try:
        return contract.validate_report(
            normalized_body,
            comment_id=comment_id,
            author=author,
            expected_repository=repository,
            allowed_workers=contract.WORKER_IDS,
        )
    except contract.ContractError:
        return None


def classify_pending_report(
    comment: Mapping[str, Any],
    *,
    repository: str,
    current_sha: str,
    github: Any,
    pending_context: Sequence[Mapping[str, Any]] = (),
) -> Reconciliation:
    """Prove one pending report is stale for rollover control, or fail closed."""
    cid = _comment_id(comment)
    body = str(comment.get("body") or "")
    fields = rollover.parse_fields(body)
    author = str((comment.get("user") or {}).get("login") or "unknown")
    legacy_bare_list = False

    try:
        report = contract.validate_report(
            body,
            comment_id=cid,
            author=author,
            expected_repository=repository,
            allowed_workers=contract.WORKER_IDS,
        )
    except contract.ContractError as exc:
        report = None
        if str(exc) == "changed_files must be a JSON list":
            report = _legacy_bare_changed_files_report(
                comment,
                fields=fields,
                repository=repository,
                comment_id=cid,
                author=author,
            )
            legacy_bare_list = report is not None
        if report is None and _historical_manual_snapshot(fields, current_sha):
            return Reconciliation(
                cid,
                _task_id(fields, cid),
                "historical_read_only_snapshot",
                (f"source_head:{fields.get('head_sha', '')}", f"current_main:{current_sha}"),
            )
        if report is None:
            checkpoint_evidence = _historical_owner_evidence_checkpoint(
                comment,
                fields=fields,
                repository=repository,
                current_sha=current_sha,
                github=github,
            )
            if checkpoint_evidence is not None:
                return Reconciliation(
                    cid,
                    _task_id(fields, cid),
                    "historical_owner_evidence_checkpoint",
                    checkpoint_evidence,
                )
        if report is None:
            train_pair_evidence = _historical_owner_train_evidence_pair(
                comment,
                fields=fields,
                repository=repository,
                current_sha=current_sha,
                github=github,
                pending_context=pending_context,
            )
            if train_pair_evidence is not None:
                return Reconciliation(
                    cid,
                    _task_id(fields, cid),
                    "historical_owner_train_evidence_ci_pair",
                    train_pair_evidence,
                )
        if report is None:
            refs = _owner_lineage_prs(comment, fields, current_sha)
            if refs:
                states = tuple((number, _pull_state(github, number)) for number in refs)
                if all(state == "closed" for _, state in states):
                    return Reconciliation(
                        cid,
                        _task_id(fields, cid),
                        "closed_noncanonical_owner_lineage",
                        tuple(f"pr:{number}:closed" for number, _ in states) + (f"current_main:{current_sha}",),
                    )
        if report is None:
            raise StaleReportReconciliationError(
                f"pending report {cid} is noncanonical but not provably stale: {exc}"
            ) from exc

    pr_text = str(report.fields.get("pr_number") or "").strip().lower()
    if pr_text.isdigit():
        number = int(pr_text)
        state = _pull_state(github, number)
        if state == "closed":
            reason = "closed_legacy_bare_list_pr_lineage" if legacy_bare_list else "closed_canonical_pr_lineage"
            return Reconciliation(
                cid,
                report.root_task_id,
                reason,
                (f"pr:{number}:closed", f"current_main:{current_sha}"),
            )
        raise StaleReportReconciliationError(f"pending report {cid} still owns open PR #{number}")

    raise StaleReportReconciliationError(
        f"pending canonical report {cid} has no terminal PR evidence; rollover remains blocked"
    )


def terminal_command_body(item: Reconciliation, *, repository: str, current_sha: str, now: datetime | None = None) -> str:
    """Build a canonical terminal command that resolves only the source-report control record."""
    current = now or datetime.now(timezone.utc)
    fields = {
        "schema_version": "2",
        "command_id": contract.command_id(
            item.source_report_comment_id,
            item.source_task_id,
            "operations-worker",
            "report_results",
            POLICY_VERSION,
        ),
        "source_task_id": item.source_task_id,
        "source_report_comment_id": str(item.source_report_comment_id),
        "target_worker": "operations-worker",
        "status": "superseded",
        "action_type": "report_results",
        "risk_level": "low",
        "execution_mode": "none",
        "repository": repository,
        "base_branch": "main",
        "base_sha": current_sha,
        "target_branch": "hub/recovery-reconciliation",
        "expected_head_sha": current_sha,
        "work_branch": "none",
        "allowed_paths": "[]",
        "prohibited_paths": '["**"]',
        "instruction": (
            "Mark only this historical source report as superseded for Hub rollover control. "
            f"classification={item.reason}. Do not infer product, economic, profitability, or runtime resolution."
        ),
        "evidence_ids": json.dumps(list(item.evidence), separators=(",", ":")),
        "validation": "Source report remains immutable; post-recovery current Hub must be freshly rescanned.",
        "stop_conditions": "No execution or code change is authorized by this terminal continuity record.",
        "expires_at": contract.iso_z(current + timedelta(days=1)),
        "auto_step": "0",
        "auto_limit": str(contract.AUTO_LIMIT),
        "approval_required": "no",
        "required_approval_phrase": "none",
        "max_attempts": "1",
        "policy_version": POLICY_VERSION,
        "provider": contract.PROVIDER,
        "model": contract.MODEL,
    }
    return contract.format_command(fields, policy_version=POLICY_VERSION)


def pending_report_comments(comments: Sequence[Mapping[str, Any]], *, repository: str) -> tuple[Mapping[str, Any], ...]:
    actionable = recovery.coordinator_actionable_control_comments(comments, repository)
    reasons = rollover.unresolved_control_work(actionable)
    non_report = [reason for reason in reasons if not reason.startswith("pending_report:")]
    if non_report:
        raise StaleReportReconciliationError(
            "bounded Hub contains active non-report control work: " + ", ".join(non_report)
        )
    ids: list[int] = []
    for reason in reasons:
        parts = reason.split(":", 2)
        if len(parts) < 2 or not parts[1].isdigit():
            raise StaleReportReconciliationError(f"malformed pending-report reason: {reason}")
        ids.append(int(parts[1]))
    by_id = {int(comment.get("id") or 0): comment for comment in actionable}
    missing = [cid for cid in ids if cid not in by_id]
    if missing:
        raise StaleReportReconciliationError(f"pending report comments missing from bounded window: {missing}")
    return tuple(by_id[cid] for cid in ids)


def reconcile(*, source_issue: int, confirmation: str, apply: bool) -> dict[str, Any]:
    recovery.assert_manual_invocation(source_issue=source_issue, confirmation=confirmation)
    token = os.environ.get("GITHUB_TOKEN", "")
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    github = rollover.GitHubClient(token, api_url, repository)

    source = github.issue(source_issue)
    total = int(source.get("comments") or 0)
    window = recovery.read_bounded_comment_window(
        github,
        source_issue,
        total,
        rollover.PROCESSOR_COMMENT_WINDOW,
    )
    current_sha = _current_main_sha(github)
    pending = pending_report_comments(window.comments, repository=repository)
    plan = tuple(
        classify_pending_report(
            comment,
            repository=repository,
            current_sha=current_sha,
            github=github,
            pending_context=pending,
        )
        for comment in pending
    )

    # All classification is complete before any mutation. Recheck both main and Hub count
    # to prevent terminalizing evidence against a moving control plane.
    if _current_main_sha(github) != current_sha:
        raise StaleReportReconciliationError("main moved during stale-report reconciliation")
    refreshed = github.issue(source_issue)
    if int(refreshed.get("comments") or 0) != total:
        raise StaleReportReconciliationError("Hub comment count changed during stale-report reconciliation")

    posted: list[int] = []
    if apply:
        for item in plan:
            body = terminal_command_body(item, repository=repository, current_sha=current_sha)
            response = github.request(
                "POST",
                f"/repos/{repository}/issues/{source_issue}/comments",
                {"body": body},
            )
            comment_id = int((response or {}).get("id") or 0)
            if comment_id <= 0:
                raise StaleReportReconciliationError(
                    f"terminal reconciliation comment was not acknowledged for source {item.source_report_comment_id}"
                )
            posted.append(comment_id)

    result = {
        "source_issue": source_issue,
        "current_main": current_sha,
        "pending_report_count": len(plan),
        "classifications": [
            {
                "source_report_comment_id": item.source_report_comment_id,
                "reason": item.reason,
                "evidence": list(item.evidence),
            }
            for item in plan
        ],
        "apply": apply,
        "posted_terminal_commands": posted,
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
