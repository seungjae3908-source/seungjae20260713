#!/usr/bin/env python3
"""Fail-closed reconciliation for historical manual-adapter handoff reports.

This helper handles one narrow canonical WorkerReport family emitted by the trusted
manual read-only adapter before the owner branch had a PR number. It does not infer that
the reported product work succeeded. It only marks the old Hub control record terminal
after immutable GitHub evidence proves that the exact owner branch named by the source
OWNER comment later became a merged PR whose merge commit is an ancestor of current
main. Unknown, open, unmerged, ambiguous, or moving evidence remains blocking.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any, Mapping
from urllib.parse import quote

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

POLICY_VERSION = "agent-hub-recovery-legacy-manual-handoff-v1"
WORKER = "agent-hub-validation"
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}[A-Za-z0-9_/-]$")
OWNER_BRANCH_RE = re.compile(
    r"(?im)\bexisting owner branch\s+([A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_/-])(?=[.\s]|$)"
)


class ManualHandoffReconciliationError(RuntimeError):
    pass


def _token_value(text: str, key: str) -> str:
    match = re.search(rf"(?:^|[;\s]){re.escape(key)}=([^;\s]+)", text)
    return match.group(1).strip() if match else ""


def _zero_field(body: str, key: str) -> bool:
    return re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*0\s*$", body) is not None


def _source_comment(github: Any, repository: str, comment_id: int) -> Mapping[str, Any] | None:
    payload = github.request("GET", f"/repos/{repository}/issues/comments/{comment_id}")
    if not isinstance(payload, dict) or int(payload.get("id") or 0) != comment_id:
        return None
    return payload


def _merged_owner_pr(github: Any, repository: str, branch: str) -> Mapping[str, Any] | None:
    owner = repository.split("/", 1)[0]
    head = quote(f"{owner}:{branch}", safe="")
    payload = github.request("GET", f"/repos/{repository}/pulls?state=closed&head={head}&per_page=20")
    if not isinstance(payload, list):
        return None
    matches: list[Mapping[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        if str(item.get("state") or "").lower() != "closed" or not item.get("merged_at"):
            continue
        if str(((item.get("head") or {}).get("ref")) or "") != branch:
            continue
        if str(((item.get("base") or {}).get("ref")) or "") != "main":
            continue
        number = item.get("number")
        merge_sha = str(item.get("merge_commit_sha") or "").strip().lower()
        if type(number) is not int or number <= 0 or not contract.SHA_RE.fullmatch(merge_sha):
            continue
        matches.append(item)
    return matches[0] if len(matches) == 1 else None


def classify_if_supported(
    comment: Mapping[str, Any],
    *,
    repository: str,
    source_issue: int,
    current_sha: str,
    github: Any,
) -> stale.Reconciliation | None:
    """Classify only a trusted read-only handoff whose named owner branch is now merged."""
    body = str(comment.get("body") or "")
    checks = legacy._field(body, "checks")
    summary = legacy._field(body, "summary")
    base_sha = legacy._sha_from(body, "base_sha")
    head_sha = legacy._sha_from(body, "head_sha")
    source_id_text = _token_value(checks, "source_comment_id")
    source_tag = _token_value(checks, "source_tag")
    owner = repository.split("/", 1)[0]

    if (
        legacy._field(body, "schema_version") != "2"
        or legacy._field(body, "worker") != WORKER
        or legacy._field(body, "repository") != repository
        or legacy._field(body, "base_branch") != "main"
        or legacy._field(body, "branch").lower() != "none"
        or legacy._field(body, "status") != "partial"
        or legacy._field(body, "pr_number").lower() != "none"
        or legacy._field(body, "changed_files") != "[]"
        or legacy._field(body, "ci_run_id").lower() != "none"
        or legacy._field(body, "approval_required").lower() != "no"
        or "manual_adapter_v2=pass" not in checks
        or "actual_main_match=1" not in checks
        or "read_only_zero_proof=1" not in checks
        or "original_report_schema=legacy" not in checks
        or "trusted_manual_readonly_handoff=1" not in summary
        or _token_value(summary, "source_author") != owner
        or not source_id_text.isdigit()
        or int(source_id_text) <= 0
        or not source_tag
        or not base_sha
        or base_sha != head_sha
        or base_sha == current_sha
        or not legacy._verified_ancestor(github, base_sha, current_sha)
    ):
        return None

    source_id = int(source_id_text)
    source = _source_comment(github, repository, source_id)
    if source is None or not legacy._owner_comment(source, repository):
        return None
    source_body = str(source.get("body") or "")
    if f"[WORKER_REPORT][{source_tag}]" not in source_body:
        return None
    if legacy._sha_from(source_body, "actual_main") != base_sha:
        return None
    if not all(_zero_field(source_body, key) for key in ("code_mutation", "workflow_mutation", "new_pr")):
        return None

    branch_match = OWNER_BRANCH_RE.search(source_body)
    if not branch_match:
        return None
    branch = branch_match.group(1)
    if not BRANCH_RE.fullmatch(branch) or ".." in branch or branch.startswith("/") or branch.endswith("/"):
        return None

    pull = _merged_owner_pr(github, repository, branch)
    if pull is None:
        return None
    number = int(pull["number"])
    merge_sha = str(pull["merge_commit_sha"]).lower()
    if merge_sha != current_sha and not legacy._verified_ancestor(github, merge_sha, current_sha):
        return None

    cid = legacy._comment_id(comment)
    task = legacy._field(body, "root_task_id") or legacy._field(body, "task_id")
    if not contract.TASK_RE.fullmatch(task):
        task = f"report-{cid}"
    return stale.Reconciliation(
        cid,
        task,
        "historical_manual_handoff_owner_pr_merged",
        (
            f"source_comment:{source_id}:owner",
            f"source_main:{base_sha}:ancestor",
            f"owner_branch:{branch}",
            f"pr:{number}:merged",
            f"merge_commit:{merge_sha}:ancestor",
            f"current_main:{current_sha}",
            "economic_or_product_resolution_asserted:false",
        ),
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
        raise ManualHandoffReconciliationError("main moved during manual handoff reconciliation")
    refreshed = github.issue(source_issue)
    if int(refreshed.get("comments") or 0) != total:
        raise ManualHandoffReconciliationError("Hub comment count changed during manual handoff reconciliation")

    posted: list[int] = []
    if apply:
        for item in plan:
            command = stale.terminal_command_body(item, repository=repository, current_sha=current_sha)
            response = github.request(
                "POST", f"/repos/{repository}/issues/{source_issue}/comments", {"body": command}
            )
            comment_id = int((response or {}).get("id") or 0)
            if comment_id <= 0:
                raise ManualHandoffReconciliationError(
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
