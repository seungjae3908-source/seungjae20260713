#!/usr/bin/env python3
"""Manual, fail-closed recovery for a Central Hub that exceeded the 1,000-comment processor window.

This path is intentionally separate from the scheduled Agent Hub rollover. It may only
run from workflow_dispatch with an explicit issue-scoped confirmation. It validates a
bounded tail of at most PROCESSOR_COMMENT_WINDOW comments and never claims full-history
validation.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlencode

RECOVERY_MODE = "bounded_overflow_recovery"
FULL_HISTORY_VALIDATED = False
LEDGER_START = "[PERSISTENT_TASK_LEDGER]"
LEDGER_END = "[/PERSISTENT_TASK_LEDGER]"
REQUIRED_ANCHORS = ("[PIPELINE_SNAPSHOT]", "[LEASE]", "[WATCH_EVENT]")
MAX_LEDGER_CHARS = 18000


class ProcessorWindowRecoveryError(RuntimeError):
    pass


@dataclass(frozen=True)
class BoundedCommentWindow:
    comments: tuple[Mapping[str, Any], ...]
    source_total_comments: int
    comments_examined: int
    processor_window: int


def _rollover_module():
    try:
        import agent_hub_rollover_v2 as rollover  # type: ignore
    except ModuleNotFoundError:
        from scripts import agent_hub_rollover_v2 as rollover  # type: ignore
    return rollover


def expected_confirmation(source_issue: int) -> str:
    return f"RECOVER_ISSUE_{source_issue}_PROCESSOR_OVERFLOW"


def assert_manual_invocation(*, source_issue: int, confirmation: str, environ: Mapping[str, str] | None = None) -> None:
    env = environ if environ is not None else os.environ
    if source_issue <= 0:
        raise ProcessorWindowRecoveryError("source issue must be a positive integer")
    if confirmation.strip() != expected_confirmation(source_issue):
        raise ProcessorWindowRecoveryError("issue-scoped processor overflow confirmation is missing or invalid")
    if env.get("GITHUB_ACTIONS", "").lower() == "true" and env.get("GITHUB_EVENT_NAME", "") != "workflow_dispatch":
        raise ProcessorWindowRecoveryError("processor overflow recovery is workflow_dispatch-only in GitHub Actions")


def read_bounded_comment_window(github: Any, issue_number: int, total_count: int, processor_window: int) -> BoundedCommentWindow:
    if total_count <= processor_window:
        raise ProcessorWindowRecoveryError(
            f"issue #{issue_number} has {total_count} comments; use the normal rollover path at or below {processor_window}"
        )
    if processor_window <= 0 or processor_window % 100 != 0:
        raise ProcessorWindowRecoveryError("processor window must be a positive multiple of 100")

    per_page = 100
    page_count = max(1, math.ceil(total_count / per_page))
    tail_start_offset = max(0, total_count - processor_window)
    first_page = (tail_start_offset // per_page) + 1
    comments: list[Mapping[str, Any]] = []
    for page in range(first_page, page_count + 1):
        query = urlencode({"per_page": per_page, "page": page})
        batch = github.request("GET", f"/repos/{github.repository}/issues/{issue_number}/comments?{query}")
        if not isinstance(batch, list):
            raise ProcessorWindowRecoveryError("issue comments response was not a list")
        comments.extend(item for item in batch if isinstance(item, dict))

    if len(comments) < processor_window:
        raise ProcessorWindowRecoveryError(
            f"bounded recovery tail under-fetched comments: expected at least {processor_window}, got {len(comments)}"
        )
    comments = comments[-processor_window:]
    comments.sort(key=lambda item: int(item.get("id") or 0))
    return BoundedCommentWindow(
        comments=tuple(comments),
        source_total_comments=total_count,
        comments_examined=len(comments),
        processor_window=processor_window,
    )


def _latest_comment_with_marker(comments: Sequence[Mapping[str, Any]], marker: str) -> Mapping[str, Any] | None:
    for comment in reversed(comments):
        if marker in str(comment.get("body") or ""):
            return comment
    return None


def latest_complete_ledger(comments: Sequence[Mapping[str, Any]]) -> tuple[int, str]:
    latest = _latest_comment_with_marker(comments, LEDGER_START)
    if latest is None:
        raise ProcessorWindowRecoveryError("bounded recovery window is missing PERSISTENT_TASK_LEDGER")
    body = str(latest.get("body") or "")
    start = body.rfind(LEDGER_START)
    end = body.find(LEDGER_END, start + len(LEDGER_START))
    if start < 0 or end < 0 or end <= start:
        raise ProcessorWindowRecoveryError("latest PERSISTENT_TASK_LEDGER occurrence is incomplete")
    block = body[start : end + len(LEDGER_END)].strip()
    if len(block) > MAX_LEDGER_CHARS:
        raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER block exceeds bounded successor-body budget")
    return int(latest.get("id") or 0), block


def validate_continuity_anchors(window: BoundedCommentWindow) -> dict[str, int]:
    anchors: dict[str, int] = {}
    for marker in REQUIRED_ANCHORS:
        comment = _latest_comment_with_marker(window.comments, marker)
        if comment is None:
            raise ProcessorWindowRecoveryError(f"bounded recovery window is missing continuity anchor {marker}")
        cid = int(comment.get("id") or 0)
        if cid <= 0:
            raise ProcessorWindowRecoveryError(f"continuity anchor {marker} has no valid comment id")
        anchors[marker] = cid
    ledger_id, _ = latest_complete_ledger(window.comments)
    if ledger_id <= 0:
        raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER anchor has no valid comment id")
    anchors[LEDGER_START] = ledger_id
    return anchors


def sanitize_ledger_block(block: str, sanitizer: Callable[[str], str]) -> str:
    return "\n".join(sanitizer(line) for line in block.splitlines()).strip()


def augment_successor_body(
    standard_body: str,
    *,
    window: BoundedCommentWindow,
    anchors: Mapping[str, int],
    ledger_block: str,
    sanitizer: Callable[[str], str],
) -> str:
    sanitized_ledger = sanitize_ledger_block(ledger_block, sanitizer)
    anchor_lines = [f"- `{marker}`: comment `{anchors[marker]}`" for marker in (*REQUIRED_ANCHORS, LEDGER_START)]
    prefix = "\n".join([
        "## Processor-window overflow recovery provenance",
        "",
        f"- history_validation_mode: `{RECOVERY_MODE}`",
        f"- full_history_validated: `{str(FULL_HISTORY_VALIDATED).lower()}`",
        f"- source_total_comments: `{window.source_total_comments}`",
        f"- processor_window_comments_examined: `{window.comments_examined}`",
        f"- processor_window_limit: `{window.processor_window}`",
        "- recovery_scope: latest bounded processor-visible tail only; no claim of full-history validation",
        "- scheduled/default rollover semantics: unchanged and fail-closed",
        "- continuity_anchors_verified:",
        *anchor_lines,
        "",
        "## Persistent task ledger continuity",
        "",
        sanitized_ledger,
        "",
        "---",
        "",
    ])
    body = prefix + standard_body.lstrip()
    if len(body) > 60000:
        raise ProcessorWindowRecoveryError("successor issue body exceeded safety size after continuity preservation")
    return body


def build_recovery_plan(github: Any, source_issue: int) -> dict[str, Any]:
    rollover = _rollover_module()
    active = rollover.resolve_active_issue(github, rollover.BOOTSTRAP_HUB_ISSUE)
    if active != source_issue:
        raise ProcessorWindowRecoveryError(
            f"source issue #{source_issue} is not the current canonical Hub; resolved active Hub is #{active}"
        )
    issue = github.issue(source_issue)
    total_count = int(issue.get("comments") or 0)
    if total_count >= rollover.GITHUB_COMMENT_HARD_LIMIT:
        raise ProcessorWindowRecoveryError("source Hub is at or above the GitHub comment hard limit")

    window = read_bounded_comment_window(github, source_issue, total_count, rollover.PROCESSOR_COMMENT_WINDOW)
    anchors = validate_continuity_anchors(window)
    pending = rollover.unresolved_control_work(window.comments)
    if pending:
        raise ProcessorWindowRecoveryError("bounded continuity window contains unresolved control work: " + ",".join(pending[:8]))

    main_sha = github.branch_sha("main")
    statuses = github.commit_status(main_sha)
    missing_or_bad = [
        context for context in rollover.REQUIRED_STATUS_CONTEXTS
        if statuses.get(context) != "success"
    ]
    if missing_or_bad:
        raise ProcessorWindowRecoveryError("exact-main Required CI is not 6/6 success: " + ",".join(missing_or_bad))

    pulls = github.open_pulls()
    now_kst = datetime.now(timezone(timedelta(hours=9)))
    rollover._append_successor_marker(str(issue.get("body") or ""), 999999999, now_kst)

    standard_body = rollover.build_successor_body(
        predecessor=source_issue,
        predecessor_comments=total_count,
        main_sha=main_sha,
        statuses=statuses,
        recent_comments=window.comments,
        pulls=pulls,
        repository=github.repository,
        now_kst=now_kst,
    )
    _, ledger = latest_complete_ledger(window.comments)
    successor_body = augment_successor_body(
        standard_body,
        window=window,
        anchors=anchors,
        ledger_block=ledger,
        sanitizer=lambda line: rollover._safe_text(line, 1600),
    )
    labels = [
        str(item.get("name") or "") for item in (issue.get("labels") or [])
        if isinstance(item, dict) and str(item.get("name") or "")
    ]
    if "active" not in labels:
        labels.append("active")
    return {
        "issue": issue,
        "window": window,
        "anchors": anchors,
        "main_sha": main_sha,
        "statuses": statuses,
        "pulls": pulls,
        "now_kst": now_kst,
        "successor_body": successor_body,
        "labels": labels,
    }


def perform_recovery(github: Any, source_issue: int, *, apply: bool) -> dict[str, Any]:
    rollover = _rollover_module()
    plan = build_recovery_plan(github, source_issue)
    window: BoundedCommentWindow = plan["window"]
    base_result = {
        "source_issue": source_issue,
        "history_validation_mode": RECOVERY_MODE,
        "full_history_validated": FULL_HISTORY_VALIDATED,
        "source_total_comments": window.source_total_comments,
        "comments_examined": window.comments_examined,
        "main_sha": plan["main_sha"],
        "continuity_anchors": plan["anchors"],
        "apply": apply,
    }
    if not apply:
        return {**base_result, "rolled_over": False, "dry_run": True, "mutation_count": 0}

    successor = github.create_issue(
        title=f"[AGENT-HUB] 중앙 명령·완료 보고 허브 — Overflow Recovery {plan['now_kst'].strftime('%Y-%m-%d')}",
        body=plan["successor_body"],
        labels=plan["labels"],
    )
    successor_number = int(successor.get("number") or 0)
    if successor_number <= 0:
        raise ProcessorWindowRecoveryError("successor issue creation returned an invalid issue number")

    verified = github.issue(successor_number)
    verified_body = str(verified.get("body") or "")
    if (
        rollover.predecessor_from_body(verified_body) != source_issue
        or rollover.CANONICAL_MARKER not in verified_body
        or RECOVERY_MODE not in verified_body
        or str(verified.get("state") or "") != "open"
    ):
        raise ProcessorWindowRecoveryError("successor verification failed; predecessor remains canonical")

    predecessor_body = rollover._append_successor_marker(
        str(plan["issue"].get("body") or ""), successor_number, plan["now_kst"]
    )
    github.update_issue(source_issue, body=predecessor_body)
    if rollover.resolve_active_issue(github, rollover.BOOTSTRAP_HUB_ISSUE) != successor_number:
        raise ProcessorWindowRecoveryError("successor route verification failed; predecessor remains canonical")

    warnings: list[str] = []
    try:
        github.post_comment(successor_number, "\n".join([
            "[HUB_PROCESSOR_WINDOW_RECOVERY]",
            "schema_version: 1",
            f"predecessor: #{source_issue}",
            f"successor: #{successor_number}",
            f"main_sha: {plan['main_sha']}",
            f"source_total_comments: {window.source_total_comments}",
            f"comments_examined: {window.comments_examined}",
            f"history_validation_mode: {RECOVERY_MODE}",
            "full_history_validated: false",
            "production_deploy: 0",
            "db_mutation: 0",
            "secret_mutation: 0",
            "private_api: 0",
            "live_trading: 0",
            "real_orders: 0",
        ]))
    except Exception:
        warnings.append("recovery_audit_comment_failed")
    try:
        github.update_issue(source_issue, state="closed")
    except Exception:
        warnings.append("predecessor_close_failed")
    try:
        github.lock_issue(source_issue)
    except Exception:
        warnings.append("predecessor_lock_failed")

    return {
        **base_result,
        "rolled_over": True,
        "dry_run": False,
        "successor_issue": successor_number,
        "warnings": warnings,
    }


def set_output(name: str, value: Any) -> None:
    output = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not output:
        return
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True) if isinstance(value, (dict, list)) else str(value)
    with open(output, "a", encoding="utf-8") as handle:
        handle.write(f"{name}={serialized}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-issue", type=int, required=True)
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--apply", action="store_true", help="Perform issue mutation. Default is dry-run only.")
    args = parser.parse_args()
    assert_manual_invocation(source_issue=args.source_issue, confirmation=args.confirmation)

    rollover = _rollover_module()
    github = rollover.GitHubClient(
        os.environ.get("GITHUB_TOKEN", ""),
        os.environ.get("GITHUB_API_URL", "https://api.github.com"),
        os.environ.get("GITHUB_REPOSITORY", ""),
    )
    result = perform_recovery(github, args.source_issue, apply=args.apply)
    for key, value in result.items():
        set_output(key, value)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
