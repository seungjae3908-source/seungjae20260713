#!/usr/bin/env python3
"""Agent Hub V5 autonomous engine primitives."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from typing import Any, Iterable, Sequence

from agent_hub_policy import PolicyError, load_workers

TERMINAL_TASK_STATES = {"completed", "blocked", "cancelled"}
SAFE_AUTO_ACTIONS = {
    "inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_ci_failure",
    "analyze_logs", "analyze_conflicts", "modify_feature_branch", "add_or_update_tests",
    "run_typecheck", "run_unit_tests", "run_build", "run_playwright",
    "update_draft_pr_description", "report_results",
}
PROHIBITED_ACTIONS = {
    "merge", "deploy", "production_deploy", "database_change", "secret_change",
    "env_change", "live_order", "cancel_order", "transfer", "withdrawal",
    "force_push", "paid_fallback", "private_trading_api",
}
REQUIRED_CONTEXTS = (
    "application-ci/verified", "browser-ui/verified", "database-rls/verified",
    "security-integration/verified", "ai-privacy/verified",
    "futures-public-network-smoke/verified",
)


class AutonomyError(RuntimeError):
    """Fail-closed V5 autonomy error."""


def _clean(value: Any, limit: int = 500) -> str:
    text = "" if value is None else str(value)
    return " ".join(text.replace("\x00", "").split())[:limit]


def _canonical_worker_ids() -> frozenset[str]:
    """Load worker IDs from the authoritative registry; never invent defaults."""
    try:
        workers = load_workers()
    except PolicyError as exc:
        raise AutonomyError("canonical worker registry is unavailable") from exc
    if not workers:
        raise AutonomyError("canonical worker registry is empty")
    return frozenset(workers)


def _paths(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        text = value.strip()
        if not text or text in {"none", "[]"}:
            return ()
        if text.startswith("["):
            try:
                value = json.loads(text)
            except json.JSONDecodeError as exc:
                raise AutonomyError("paths must be valid JSON") from exc
        else:
            value = [part.strip() for part in text.replace(";", ",").split(",") if part.strip()]
    if not isinstance(value, (list, tuple)) or any(not isinstance(item, str) for item in value):
        raise AutonomyError("paths must be a string list")
    return tuple(dict.fromkeys(_clean(item, 400) for item in value if _clean(item, 400)))


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:20]


@dataclass(frozen=True)
class OwnerCandidate:
    pr_number: int
    branch: str
    title: str
    body: str
    changed_files: tuple[str, ...]
    task_id: str = "none"
    worker: str = "none"
    draft: bool = True
    open: bool = True


@dataclass(frozen=True)
class OwnerResolution:
    status: str
    owner_pr: int | None
    branch: str | None
    reason: str
    score: int
    ambiguous_prs: tuple[int, ...] = ()


def resolve_existing_owner(*, task_id: str, worker_hint: str, requested_paths: Sequence[str], candidates: Sequence[OwnerCandidate]) -> OwnerResolution:
    task_id = _clean(task_id, 180)
    worker_hint = _clean(worker_hint, 80)
    wanted_paths = set(_paths(requested_paths))
    ranked: list[tuple[int, OwnerCandidate, list[str]]] = []
    for candidate in candidates:
        if not candidate.open:
            continue
        score = 0
        reasons: list[str] = []
        if task_id and task_id != "none" and candidate.task_id == task_id:
            score += 100; reasons.append("task_id")
        if worker_hint and worker_hint != "none" and candidate.worker == worker_hint:
            score += 30; reasons.append("worker")
        overlap = sorted(wanted_paths.intersection(candidate.changed_files))
        if overlap:
            score += min(60, 20 + 10 * len(overlap)); reasons.append("path_overlap")
        title_body = f"{candidate.title} {candidate.body}".casefold()
        if task_id and task_id != "none" and task_id.casefold() in title_body:
            score += 25; reasons.append("task_text")
        if score:
            ranked.append((score, candidate, reasons))
    if not ranked:
        return OwnerResolution("new_owner", None, None, "no_existing_owner", 0)
    ranked.sort(key=lambda item: (-item[0], item[1].pr_number))
    top_score = ranked[0][0]
    top = [item for item in ranked if item[0] == top_score]
    if len(top) != 1:
        return OwnerResolution("ambiguous", None, None, "multiple_equal_owner_candidates", top_score, tuple(item[1].pr_number for item in top))
    _, owner, reasons = top[0]
    return OwnerResolution("reuse_owner", owner.pr_number, owner.branch, "+".join(reasons), top_score)


@dataclass(frozen=True)
class EvidenceRecord:
    kind: str
    source: str
    head_sha: str
    value: str
    observed_at: str
    digest: str


def evidence_record(*, kind: str, source: str, head_sha: str, value: Any, observed_at: str) -> EvidenceRecord:
    payload = {"kind": _clean(kind, 80), "source": _clean(source, 240), "head_sha": _clean(head_sha, 80), "value": _clean(value, 2000), "observed_at": _clean(observed_at, 80)}
    if not payload["kind"] or not payload["source"] or not payload["head_sha"]:
        raise AutonomyError("evidence requires kind, source, and head_sha")
    return EvidenceRecord(**payload, digest=_digest(payload))


def required_ci_truth(records: Sequence[EvidenceRecord], *, head_sha: str) -> dict[str, str]:
    result = {context: "missing" for context in REQUIRED_CONTEXTS}
    for record in records:
        if record.head_sha != head_sha or record.kind != "required_ci":
            continue
        if record.source in result:
            state = record.value.lower()
            result[record.source] = state if state in {"success", "failure", "pending"} else "invalid"
    return result


def exact_head_ci_ready(records: Sequence[EvidenceRecord], *, head_sha: str) -> bool:
    truth = required_ci_truth(records, head_sha=head_sha)
    return all(truth[context] == "success" for context in REQUIRED_CONTEXTS)


def economic_truth(value: Any) -> str:
    if value is None:
        return "MISSING"
    text = _clean(value, 80)
    return text if text else "MISSING"


@dataclass(frozen=True)
class FailureObservation:
    attempt: int
    fingerprint: str
    first_error: str
    action: str


def failure_fingerprint(*, first_error: str, action: str, changed_files: Iterable[str]) -> str:
    return _digest({"first_error": _clean(first_error, 1200), "action": _clean(action, 120), "changed_files": sorted(_paths(list(changed_files)))})


def next_self_heal_action(*, attempts: Sequence[FailureObservation], proposed_action: str, max_attempts: int = 3) -> str:
    action = _clean(proposed_action, 120)
    if action in PROHIBITED_ACTIONS or action not in SAFE_AUTO_ACTIONS:
        return "stop_policy"
    if len(attempts) >= max_attempts:
        return "stop_attempt_limit"
    if len(attempts) >= 2 and attempts[-1].fingerprint == attempts[-2].fingerprint:
        return "stop_repeated_failure"
    return action


@dataclass(frozen=True)
class AutonomousTask:
    task_id: str
    goal: str
    worker: str
    branch: str
    owner_pr: int | None
    state: str
    current_step: str
    attempt: int
    first_zero: str
    remaining_steps: tuple[str, ...]
    authority: str = "NONE"


def start_task(*, task_id: str, goal: str, worker: str, branch: str, owner_pr: int | None = None) -> AutonomousTask:
    if not _clean(task_id, 180) or not _clean(goal, 800):
        raise AutonomyError("task_id and goal are required")
    worker_id = _clean(worker, 80)
    if not worker_id or worker_id == "none":
        raise AutonomyError("autonomous task requires registered worker")
    if worker_id not in _canonical_worker_ids():
        raise AutonomyError(f"autonomous task worker is not registered: {worker_id}")
    return AutonomousTask(_clean(task_id, 180), _clean(goal, 800), worker_id, _clean(branch, 180), owner_pr, "planning", "resolve_owner", 0, "MISSING", ("inspect", "implement", "validate", "draft_pr", "exact_head_ci", "report"))


def advance_task(task: AutonomousTask, event: str, *, first_zero: str | None = None) -> AutonomousTask:
    event = _clean(event, 120)
    table = {
        ("planning", "owner_resolved"): ("inspecting", "inspect"),
        ("inspecting", "root_cause_found"): ("implementing", "implement"),
        ("implementing", "change_applied"): ("validating", "validate"),
        ("validating", "checks_failed"): ("self_healing", "analyze_failure"),
        ("self_healing", "retry_safe"): ("implementing", "implement_retry"),
        ("validating", "checks_passed"): ("draft_ready", "draft_pr"),
        ("draft_ready", "draft_pr_created"): ("ci_wait", "exact_head_ci"),
        ("ci_wait", "ci_failed"): ("self_healing", "analyze_ci_failure"),
        ("ci_wait", "ci_passed"): ("waiting_approval", "ready_merge_approval"),
        ("waiting_approval", "human_ready_merge_approved"): ("ready_merge", "ready_merge"),
        ("ready_merge", "merged"): ("post_merge_ci", "post_merge_ci"),
        ("post_merge_ci", "post_merge_ci_passed"): ("completed", "done"),
    }
    if event in {"policy_blocked", "ambiguous_owner", "attempt_limit", "repeated_failure"}:
        return replace(task, state="blocked", current_step=event, first_zero=_clean(first_zero or task.first_zero, 500))
    key = (task.state, event)
    if key not in table:
        raise AutonomyError(f"invalid task transition: {task.state} + {event}")
    state, step = table[key]
    return replace(task, state=state, current_step=step, attempt=task.attempt + (1 if event == "retry_safe" else 0), first_zero=_clean(first_zero or task.first_zero, 500), remaining_steps=tuple(item for item in task.remaining_steps if item != step))


def approval_allowed(task: AutonomousTask, action: str, *, human_approval: bool) -> bool:
    action = _clean(action, 120)
    if action in {"ready", "merge", "staging"}:
        return human_approval and task.state in {"waiting_approval", "ready_merge"}
    if action in PROHIBITED_ACTIONS:
        return False
    return action in SAFE_AUTO_ACTIONS


def self_test() -> int:
    candidates = [OwnerCandidate(101, "feature/chart", "AI chart cold fix", "task chart-cold", ("stock-analyzer/src/pages/ai-chart.tsx",), "chart-cold", "ai-chart"), OwnerCandidate(102, "feature/scanner", "scanner", "other task", ("api-server/src/routes/bounded-market-scan.ts",), "scanner", "ai-signal-scanner")]
    owner = resolve_existing_owner(task_id="chart-cold", worker_hint="ai-chart", requested_paths=["stock-analyzer/src/pages/ai-chart.tsx"], candidates=candidates)
    assert owner.status == "reuse_owner" and owner.owner_pr == 101
    tie = resolve_existing_owner(task_id="none", worker_hint="none", requested_paths=["same.ts"], candidates=[OwnerCandidate(1, "a", "a", "", ("same.ts",)), OwnerCandidate(2, "b", "b", "", ("same.ts",))])
    assert tie.status == "ambiguous" and tie.owner_pr is None

    fp = failure_fingerprint(first_error="TS2322", action="modify_feature_branch", changed_files=["a.ts"])
    first = FailureObservation(1, fp, "TS2322", "modify_feature_branch")
    second = FailureObservation(2, fp, "TS2322", "modify_feature_branch")
    assert next_self_heal_action(attempts=[first], proposed_action="modify_feature_branch") == "modify_feature_branch"
    assert next_self_heal_action(attempts=[first, second], proposed_action="modify_feature_branch") == "stop_repeated_failure"
    assert next_self_heal_action(attempts=[], proposed_action="merge") == "stop_policy"

    head = "a" * 40
    records = [evidence_record(kind="required_ci", source=context, head_sha=head, value="success", observed_at="2026-09-11T00:00:00Z") for context in REQUIRED_CONTEXTS]
    assert exact_head_ci_ready(records, head_sha=head)
    assert not exact_head_ci_ready(records[:-1], head_sha=head)
    assert economic_truth(None) == "MISSING" and economic_truth(0) == "0"
    assert len({record.digest for record in records}) == len(records)

    task = start_task(task_id="demo", goal="finish safely", worker="agent-hub-validation", branch="feature/demo")
    try:
        start_task(task_id="missing-worker", goal="fail closed", worker="", branch="feature/demo")
    except AutonomyError as exc:
        assert "requires registered worker" in str(exc)
    else:
        raise AssertionError("missing autonomous task worker was silently defaulted")
    try:
        start_task(task_id="rogue-worker", goal="fail closed", worker="rogue-worker", branch="feature/demo")
    except AutonomyError as exc:
        assert "not registered" in str(exc)
    else:
        raise AssertionError("unregistered autonomous task worker was accepted")

    for event in ("owner_resolved", "root_cause_found", "change_applied", "checks_passed", "draft_pr_created", "ci_passed"):
        task = advance_task(task, event)
    assert task.state == "waiting_approval"
    assert approval_allowed(task, "merge", human_approval=True)
    assert not approval_allowed(task, "merge", human_approval=False)
    task = advance_task(task, "human_ready_merge_approved")
    task = advance_task(task, "merged")
    task = advance_task(task, "post_merge_ci_passed")
    assert task.state == "completed" and task.authority == "NONE"

    print(json.dumps({"agent_hub_v5_3_owner_resolver": "pass", "agent_hub_v5_4_self_healing": "pass", "agent_hub_v5_5_evidence_engine": "pass", "agent_hub_v5_7_long_running_orchestrator": "pass", "task_worker_registry_fail_closed": True, "replit_used": False, "authority": "NONE", "live_trading": False, "paid_fallback": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
