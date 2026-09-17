#!/usr/bin/env python3
"""Fail-closed stale-report reconciliation for processor-window recovery.

The normal Hub rollover intentionally refuses to move while a trusted schema-v2 report
has no command record.  Very old overflowed Hubs can contain historical report records
whose owner work is already terminal, or read-only snapshots that were never executable
worker tasks.  This helper does not declare the underlying product/economic issue fixed.
It only emits explicit terminal HUB_COMMAND continuity records after every pending report
in the bounded processor window is conservatively proven stale/superseded.

The helper is mutation-capable only for the same explicit workflow_dispatch + issue-scoped
confirmation used by processor-window recovery.  Classification is all-or-nothing before
any issue comment is posted.  Unknown or still-open work fails closed.
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
OWNER_LINEAGE_RE = re.compile(r"(?im)^\s*-?\s*owner\s*:\s*#(\d+)\s*$")
LINEAGE_LINE_RE = re.compile(r"(?im)^\s*lineage\s*:\s*([^\n]+)$")
PR_REF_RE = re.compile(r"#(\d+)")


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


def classify_pending_report(comment: Mapping[str, Any], *, repository: str, current_sha: str, github: Any) -> Reconciliation:
    """Prove one pending report is stale for rollover control, or fail closed."""
    cid = _comment_id(comment)
    body = str(comment.get("body") or "")
    fields = rollover.parse_fields(body)
    author = str((comment.get("user") or {}).get("login") or "unknown")

    try:
        report = contract.validate_report(
            body,
            comment_id=cid,
            author=author,
            expected_repository=repository,
            allowed_workers=contract.WORKER_IDS,
        )
    except contract.ContractError as exc:
        if _historical_manual_snapshot(fields, current_sha):
            return Reconciliation(
                cid,
                _task_id(fields, cid),
                "historical_read_only_snapshot",
                (f"source_head:{fields.get('head_sha', '')}", f"current_main:{current_sha}"),
            )
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
        raise StaleReportReconciliationError(
            f"pending report {cid} is noncanonical but not provably stale: {exc}"
        ) from exc

    pr_text = str(report.fields.get("pr_number") or "").strip().lower()
    if pr_text.isdigit():
        number = int(pr_text)
        state = _pull_state(github, number)
        if state == "closed":
            return Reconciliation(
                cid,
                report.root_task_id,
                "closed_canonical_pr_lineage",
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
        classify_pending_report(comment, repository=repository, current_sha=current_sha, github=github)
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
