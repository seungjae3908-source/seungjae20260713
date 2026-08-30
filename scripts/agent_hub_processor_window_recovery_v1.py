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
import re
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
MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS = 1500
TOP_LEVEL_SECTION_RE = re.compile(r"^\[[A-Z][A-Z0-9_:-]*\](?:\[[A-Z][A-Z0-9_:-]*\])*$")


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


def _contract_module():
    try:
        import agent_hub_contract_v2 as contract  # type: ignore
    except ModuleNotFoundError:
        from scripts import agent_hub_contract_v2 as contract  # type: ignore
    return contract


def coordinator_actionable_control_comments(
    comments: Sequence[Mapping[str, Any]],
    repository: str,
) -> tuple[Mapping[str, Any], ...]:
    """Keep control-work reports aligned with the canonical schema-v2 worker registry."""
    rollover = _rollover_module()
    contract = _contract_module()
    retained: list[Mapping[str, Any]] = []
    for comment in comments:
        if not rollover.trusted_report_comment(comment):
            retained.append(comment)
            continue
        body = str(comment.get("body") or "")
        fields = rollover.parse_fields(body)
        if fields.get("schema_version") != "2":
            retained.append(comment)
            continue
        try:
            comment_id = int(comment.get("id") or 0)
        except (TypeError, ValueError):
            comment_id = 0
        author = str((comment.get("user") or {}).get("login") or "unknown")
        try:
            contract.validate_report(
                body,
                comment_id=comment_id,
                author=author,
                expected_repository=repository,
                allowed_workers=contract.WORKER_IDS,
            )
        except contract.ContractError as exc:
            if str(exc) == "unregistered worker":
                continue
            retained.append(comment)
            continue
        retained.append(comment)
    return tuple(retained)


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


def _comment_id(comment: Mapping[str, Any]) -> int:
    cid = comment.get("id")
    if type(cid) is not int or cid <= 0:
        raise ProcessorWindowRecoveryError("recovery comment has no valid comment id")
    return cid


def _validated_comment_page(batch: Any, *, expected_count: int, scope: str) -> list[Mapping[str, Any]]:
    if not isinstance(batch, list):
        raise ProcessorWindowRecoveryError(f"{scope} comments response was not a list")
    if len(batch) != expected_count:
        raise ProcessorWindowRecoveryError(
            f"{scope} pagination count mismatch: expected {expected_count}, got {len(batch)}"
        )
    previous_id = 0
    for item in batch:
        if not isinstance(item, dict) or not isinstance(item.get("body"), str):
            raise ProcessorWindowRecoveryError(f"{scope} comments response contained malformed entries")
        cid = _comment_id(item)
        if cid <= previous_id:
            raise ProcessorWindowRecoveryError(f"{scope} pagination ids are duplicated or out of order")
        previous_id = cid
    return batch


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
        batch = _validated_comment_page(
            github.request("GET", f"/repos/{github.repository}/issues/{issue_number}/comments?{query}"),
            expected_count=min(per_page, total_count - (page - 1) * per_page),
            scope="processor tail",
        )
        if comments and _comment_id(batch[0]) <= _comment_id(comments[-1]):
            raise ProcessorWindowRecoveryError("processor tail pagination pages overlap or are out of order")
        comments.extend(batch)
    if len(comments) < processor_window:
        raise ProcessorWindowRecoveryError(
            f"bounded recovery tail under-fetched comments: expected at least {processor_window}, got {len(comments)}"
        )
    comments = comments[-processor_window:]
    return BoundedCommentWindow(tuple(comments), total_count, len(comments), processor_window)


def _latest_comment_with_marker(comments: Sequence[Mapping[str, Any]], marker: str) -> Mapping[str, Any] | None:
    for comment in reversed(comments):
        if marker in str(comment.get("body") or ""):
            return comment
    return None


def _normalized_ledger_block(body: str) -> str:
    """Extract a ledger using either explicit close or the canonical next-section delimiter.

    Current canonical PIPELINE_SNAPSHOT comments use a top-level section form:
    [PERSISTENT_TASK_LEDGER] ... [NEXT_GATE]. Older evidence may include an explicit
    [/PERSISTENT_TASK_LEDGER] close. Both are accepted, but an unterminated ledger at end
    of comment remains fail-closed. The returned block is normalized with an explicit
    close marker for successor continuity.
    """
    lines = str(body or "").splitlines()
    starts = [idx for idx, line in enumerate(lines) if line.strip() == LEDGER_START]
    if not starts:
        raise ProcessorWindowRecoveryError("bounded recovery window is missing PERSISTENT_TASK_LEDGER")
    start = starts[-1]
    content: list[str] = []
    terminated = False
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped == LEDGER_END:
            terminated = True
            break
        if TOP_LEVEL_SECTION_RE.fullmatch(stripped):
            terminated = True
            break
        content.append(line)
    while content and not content[0].strip():
        content.pop(0)
    while content and not content[-1].strip():
        content.pop()
    if not terminated or not any(line.strip() for line in content):
        raise ProcessorWindowRecoveryError("latest PERSISTENT_TASK_LEDGER occurrence is incomplete")
    block = "\n".join([LEDGER_START, *content, LEDGER_END]).strip()
    if len(block) > MAX_LEDGER_CHARS:
        raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER block exceeds bounded successor-body budget")
    return block


def latest_complete_ledger(comments: Sequence[Mapping[str, Any]]) -> tuple[int, str]:
    latest = _latest_comment_with_marker(comments, LEDGER_START)
    if latest is None:
        raise ProcessorWindowRecoveryError("bounded recovery window is missing PERSISTENT_TASK_LEDGER")
    block = _normalized_ledger_block(str(latest.get("body") or ""))
    return _comment_id(latest), block


def resolve_complete_ledger_anchor(
    github: Any,
    issue_number: int,
    window: BoundedCommentWindow,
    *,
    max_lookback_comments: int = MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS,
) -> tuple[int, str, int]:
    """Resolve the newest ledger without expanding executable control validation."""
    if _latest_comment_with_marker(window.comments, LEDGER_START) is not None:
        ledger_id, block = latest_complete_ledger(window.comments)
        if ledger_id <= 0:
            raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER anchor has no valid comment id")
        return ledger_id, block, 0
    older_count = max(0, window.source_total_comments - window.comments_examined)
    if older_count <= 0:
        raise ProcessorWindowRecoveryError("bounded recovery window is missing PERSISTENT_TASK_LEDGER")
    if type(max_lookback_comments) is not int or not 0 < max_lookback_comments <= MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS:
        raise ProcessorWindowRecoveryError("ledger anchor lookback budget must be positive and at most 1500")
    if older_count > max_lookback_comments:
        raise ProcessorWindowRecoveryError(
            "PERSISTENT_TASK_LEDGER anchor is outside bounded lookback budget: "
            f"older_prefix={older_count}, limit={max_lookback_comments}"
        )
    per_page = 100
    page_count = max(1, math.ceil(older_count / per_page))
    comments_examined = 0
    upper_bound_id = _comment_id(window.comments[0])
    for page in range(page_count, 0, -1):
        query = urlencode({"per_page": per_page, "page": page})
        batch = _validated_comment_page(
            github.request("GET", f"/repos/{github.repository}/issues/{issue_number}/comments?{query}"),
            expected_count=per_page,
            scope="ledger anchor lookup",
        )
        take = older_count - ((page_count - 1) * per_page) if page == page_count else per_page
        if take < per_page:
            overlap_ids = [_comment_id(item) for item in batch[take:]]
            tail_ids = [_comment_id(item) for item in window.comments[:per_page - take]]
            if overlap_ids != tail_ids:
                raise ProcessorWindowRecoveryError("ledger anchor lookup pagination disagrees with processor tail boundary")
        selected = batch[:take]
        if _comment_id(selected[-1]) >= upper_bound_id:
            raise ProcessorWindowRecoveryError("ledger anchor lookup pagination pages overlap or are out of order")
        upper_bound_id = _comment_id(selected[0])
        comments_examined += len(selected)
        for comment in reversed(selected):
            if LEDGER_START not in str(comment.get("body") or ""):
                continue
            ledger_id, block = latest_complete_ledger((comment,))
            if ledger_id <= 0:
                raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER anchor has no valid comment id")
            return ledger_id, block, comments_examined
    raise ProcessorWindowRecoveryError(
        "bounded ledger anchor lookup is missing PERSISTENT_TASK_LEDGER after examining "
        f"{comments_examined} older comments"
    )


def validate_continuity_anchors(window: BoundedCommentWindow, *, ledger_id: int | None = None) -> dict[str, int]:
    anchors: dict[str, int] = {}
    for marker in REQUIRED_ANCHORS:
        comment = _latest_comment_with_marker(window.comments, marker)
        if comment is None:
            raise ProcessorWindowRecoveryError(f"bounded recovery window is missing continuity anchor {marker}")
        cid = _comment_id(comment)
        anchors[marker] = cid
    resolved_ledger_id = ledger_id
    if resolved_ledger_id is None:
        resolved_ledger_id, _ = latest_complete_ledger(window.comments)
    if type(resolved_ledger_id) is not int or resolved_ledger_id <= 0:
        raise ProcessorWindowRecoveryError("PERSISTENT_TASK_LEDGER anchor has no valid comment id")
    anchors[LEDGER_START] = resolved_ledger_id
    return anchors


def sanitize_ledger_block(block: str, sanitizer: Callable[[str], str]) -> str:
    return "\n".join(sanitizer(line) for line in block.splitlines()).strip()


def _comment_range_provenance(window: BoundedCommentWindow, lookup_count: int) -> dict[str, list[int]]:
    older_count = window.source_total_comments - window.comments_examined
    return {
        "processor_tail_comment_range": [older_count + 1, window.source_total_comments],
        "ledger_anchor_lookup_comment_range": [older_count - lookup_count + 1, older_count] if lookup_count else [],
    }


def augment_successor_body(
    standard_body: str,
    *,
    window: BoundedCommentWindow,
    anchors: Mapping[str, int],
    ledger_block: str,
    sanitizer: Callable[[str], str],
    ledger_anchor_lookup_comments_examined: int = 0,
    ledger_anchor_lookup_limit: int = MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS,
) -> str:
    if ledger_anchor_lookup_comments_examined < 0 or ledger_anchor_lookup_comments_examined > ledger_anchor_lookup_limit:
        raise ProcessorWindowRecoveryError("ledger anchor lookup provenance exceeded configured bounds")
    sanitized_ledger = sanitize_ledger_block(ledger_block, sanitizer)
    anchor_lines = [f"- `{marker}`: comment `{anchors[marker]}`" for marker in (*REQUIRED_ANCHORS, LEDGER_START)]
    prefix = "\n".join([
        "## Processor-window overflow recovery provenance", "",
        f"- history_validation_mode: `{RECOVERY_MODE}`",
        f"- full_history_validated: `{str(FULL_HISTORY_VALIDATED).lower()}`",
        f"- source_total_comments: `{window.source_total_comments}`",
        f"- processor_window_comments_examined: `{window.comments_examined}`",
        f"- processor_window_limit: `{window.processor_window}`",
        f"- ledger_anchor_lookup_comments_examined: `{ledger_anchor_lookup_comments_examined}`",
        f"- ledger_anchor_lookup_limit: `{ledger_anchor_lookup_limit}`",
        *[f"- {name}: `{json.dumps(value)}`" for name, value in _comment_range_provenance(window, ledger_anchor_lookup_comments_examined).items()],
        "- comment_range_basis: one-based ordinal positions in the validated source comment count",
        f"- ledger_source_comment_id: `{anchors[LEDGER_START]}`",
        "- ledger_anchor_lookup_scope: continuity-only older-prefix lookup when the ledger is absent from the processor tail; excluded from pending control-work validation",
        "- ledger_source_termination: explicit close marker or next canonical top-level section marker; normalized with explicit close in successor",
        "- recovery_scope: executable pending-control validation remains the latest bounded processor-visible tail only; no claim of full-history validation",
        "- scheduled/default rollover semantics: unchanged and fail-closed",
        "- continuity_anchors_verified:", *anchor_lines, "",
        "## Persistent task ledger continuity", "", sanitized_ledger, "", "---", "",
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
    ledger_id, ledger, ledger_lookup_comments_examined = resolve_complete_ledger_anchor(github, source_issue, window)
    anchors = validate_continuity_anchors(window, ledger_id=ledger_id)
    actionable_comments = coordinator_actionable_control_comments(window.comments, github.repository)
    pending = rollover.unresolved_control_work(actionable_comments)
    if pending:
        raise ProcessorWindowRecoveryError("bounded continuity window contains unresolved control work: " + ",".join(pending[:8]))
    main_sha = github.branch_sha("main")
    statuses = github.commit_status(main_sha)
    missing_or_bad = [context for context in rollover.REQUIRED_STATUS_CONTEXTS if statuses.get(context) != "success"]
    if missing_or_bad:
        raise ProcessorWindowRecoveryError("exact-main Required CI is not 6/6 success: " + ",".join(missing_or_bad))
    pulls = github.open_pulls()
    now_kst = datetime.now(timezone(timedelta(hours=9)))
    rollover._append_successor_marker(str(issue.get("body") or ""), 999999999, now_kst)
    standard_body = rollover.build_successor_body(
        predecessor=source_issue, predecessor_comments=total_count, main_sha=main_sha,
        statuses=statuses, recent_comments=window.comments, pulls=pulls,
        repository=github.repository, now_kst=now_kst,
    )
    successor_body = augment_successor_body(
        standard_body, window=window, anchors=anchors, ledger_block=ledger,
        sanitizer=lambda line: rollover._safe_text(line, 1600),
        ledger_anchor_lookup_comments_examined=ledger_lookup_comments_examined,
    )
    labels = [str(item.get("name") or "") for item in (issue.get("labels") or []) if isinstance(item, dict) and str(item.get("name") or "")]
    if "active" not in labels:
        labels.append("active")
    return {
        "issue": issue, "window": window, "anchors": anchors, "main_sha": main_sha,
        "statuses": statuses, "pulls": pulls, "now_kst": now_kst,
        "successor_body": successor_body, "labels": labels,
        "ledger_anchor_lookup_comments_examined": ledger_lookup_comments_examined,
    }


def perform_recovery(github: Any, source_issue: int, *, apply: bool) -> dict[str, Any]:
    rollover = _rollover_module()
    plan = build_recovery_plan(github, source_issue)
    window: BoundedCommentWindow = plan["window"]
    base_result = {
        "source_issue": source_issue, "history_validation_mode": RECOVERY_MODE,
        "full_history_validated": FULL_HISTORY_VALIDATED,
        "source_total_comments": window.source_total_comments,
        "comments_examined": window.comments_examined,
        "ledger_anchor_lookup_comments_examined": plan["ledger_anchor_lookup_comments_examined"],
        **_comment_range_provenance(window, plan["ledger_anchor_lookup_comments_examined"]),
        "ledger_source_comment_id": plan["anchors"][LEDGER_START],
        "main_sha": plan["main_sha"], "continuity_anchors": plan["anchors"], "apply": apply,
    }
    if not apply:
        return {**base_result, "rolled_over": False, "dry_run": True, "mutation_count": 0}
    successor = github.create_issue(
        title=f"[AGENT-HUB] 중앙 명령·완료 보고 허브 — Overflow Recovery {plan['now_kst'].strftime('%Y-%m-%d')}",
        body=plan["successor_body"], labels=plan["labels"],
    )
    successor_number = int(successor.get("number") or 0)
    if successor_number <= 0:
        raise ProcessorWindowRecoveryError("successor issue creation returned an invalid issue number")
    verified = github.issue(successor_number)
    verified_body = str(verified.get("body") or "")
    if (rollover.predecessor_from_body(verified_body) != source_issue or rollover.CANONICAL_MARKER not in verified_body or RECOVERY_MODE not in verified_body or str(verified.get("state") or "") != "open"):
        raise ProcessorWindowRecoveryError("successor verification failed; predecessor remains canonical")
    predecessor_body = rollover._append_successor_marker(str(plan["issue"].get("body") or ""), successor_number, plan["now_kst"])
    github.update_issue(source_issue, body=predecessor_body)
    if rollover.resolve_active_issue(github, rollover.BOOTSTRAP_HUB_ISSUE) != successor_number:
        raise ProcessorWindowRecoveryError("successor route verification failed; predecessor remains canonical")
    warnings: list[str] = []
    try:
        github.post_comment(successor_number, "\n".join([
            "[HUB_PROCESSOR_WINDOW_RECOVERY]", "schema_version: 1",
            f"predecessor: #{source_issue}", f"successor: #{successor_number}",
            f"main_sha: {plan['main_sha']}", f"source_total_comments: {window.source_total_comments}",
            f"comments_examined: {window.comments_examined}",
            f"ledger_anchor_lookup_comments_examined: {plan['ledger_anchor_lookup_comments_examined']}",
            *[f"{name}: {json.dumps(value)}" for name, value in _comment_range_provenance(window, plan["ledger_anchor_lookup_comments_examined"]).items()],
            f"ledger_source_comment_id: {plan['anchors'][LEDGER_START]}",
            f"history_validation_mode: {RECOVERY_MODE}", "full_history_validated: false",
            "production_deploy: 0", "db_mutation: 0", "secret_mutation: 0",
            "private_api: 0", "live_trading: 0", "real_orders: 0",
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
    return {**base_result, "rolled_over": True, "dry_run": False, "successor_issue": successor_number, "warnings": warnings}


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
    github = rollover.GitHubClient(os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GITHUB_API_URL", "https://api.github.com"), os.environ.get("GITHUB_REPOSITORY", ""))
    result = perform_recovery(github, args.source_issue, apply=args.apply)
    for key, value in result.items():
        set_output(key, value)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
