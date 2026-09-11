#!/usr/bin/env python3
"""Deterministic, non-authoritative natural-language gateway for Agent Hub V5.

The gateway classifies user intent and resume context only. It never grants
execution authority, risk, approval, merge, deploy, database, secret, paid
fallback, or trading permissions. Existing coordinator/policy layers remain the
only components allowed to decide those fields.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

GATEWAY_VERSION = "agent-hub-natural-language-v5.0"
MAX_COMMAND_CHARS = 1200
MAX_GOAL_CHARS = 800
MAX_TASKS = 24
RESUME_TERMS = (
    "이어서 해",
    "이어서 진행",
    "계속 해",
    "계속 진행",
    "continue",
    "continue it",
    "resume",
    "resume task",
)
TERMINAL_STATUSES = {"completed", "expired", "superseded", "no_action"}

ROUTES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("agent-hub-validation", ("agent hub", "agent-hub", "코덱", "codex", "에이전트 허브")),
    ("ai-chart", ("ai차트", "ai 차트", "chart", "차트", "캔들", "indicator", "지표")),
    ("ai-signal-scanner", ("scanner", "스캐너", "신호검색", "신호 검색", "검색기", "signal")),
    ("test-runner", ("playwright", "browser", "브라우저", "e2e", "ui 테스트", "테스트")),
    ("security-inspector", ("security", "보안", "secret", "시크릿", "privacy", "개인정보")),
    ("market-information-room", ("news", "뉴스", "공시", "market info", "시장정보", "종목검색")),
)


class NaturalLanguageGatewayError(RuntimeError):
    """Fail-closed natural-language gateway error."""


def _clean(value: Any, limit: int) -> str:
    text = str(value or "").replace("\x00", "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"[\r\n\t]+", " ", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text[:limit]


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _valid_repository(repository: str) -> str:
    value = _clean(repository, 200)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise NaturalLanguageGatewayError("repository must be owner/name")
    return value


def _is_resume(command: str) -> bool:
    folded = command.casefold()
    return any(term.casefold() in folded for term in RESUME_TERMS)


def _route_hint(command: str) -> str:
    folded = command.casefold()
    for worker, keywords in ROUTES:
        if any(keyword.casefold() in folded for keyword in keywords):
            return worker
    return "integration-planner"


def _action_hint(command: str) -> str:
    folded = command.casefold()
    if any(term in folded for term in ("ci 실패", "ci fail", "failure", "failed", "로그", "log")):
        return "analyze_ci_failure"
    if any(term in folded for term in ("충돌", "conflict", "겹침", "owner", "오너")):
        return "analyze_conflicts"
    return "inspect_repository"


def _normalized_task(task: Mapping[str, Any]) -> dict[str, Any]:
    task_id = _clean(task.get("task_id"), 180)
    if not task_id or task_id == "none":
        raise NaturalLanguageGatewayError("resumable task requires task_id")
    remaining_raw = task.get("remaining_steps") or []
    if isinstance(remaining_raw, str):
        try:
            parsed = json.loads(remaining_raw) if remaining_raw.strip().startswith("[") else [remaining_raw]
        except json.JSONDecodeError as exc:
            raise NaturalLanguageGatewayError("remaining_steps must be valid JSON when encoded") from exc
    else:
        parsed = remaining_raw
    if not isinstance(parsed, (list, tuple)) or any(not isinstance(item, str) for item in parsed):
        raise NaturalLanguageGatewayError("remaining_steps must be a string list")
    return {
        "task_id": task_id,
        "goal": _clean(task.get("goal"), MAX_GOAL_CHARS) or "none",
        "status": _clean(task.get("status"), 40) or "none",
        "current_step": _clean(task.get("current_step"), 400) or "none",
        "first_zero": _clean(task.get("first_zero"), 400) or "none",
        "remaining_steps": [_clean(item, 400) for item in parsed[:24] if _clean(item, 400)],
        "worker": _clean(task.get("worker"), 80) or "integration-planner",
        "branch": _clean(task.get("branch"), 180) or "none",
        "head_sha": _clean(task.get("head_sha"), 80) or "none",
        "pr_number": _clean(task.get("pr_number"), 24) or "none",
        "ci_run_id": _clean(task.get("ci_run_id"), 32) or "none",
        "updated_at": _clean(task.get("updated_at"), 40) or "none",
    }


@dataclass(frozen=True)
class IntentEnvelope:
    gateway_version: str
    repository: str
    mode: str
    task_id: str
    goal: str
    normalized_command: str
    command_digest: str
    worker_hint: str
    action_hint: str
    resume_context: dict[str, Any]
    authority: str = "NONE"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def compile_natural_language_command(
    *,
    command: str,
    repository: str,
    resumable_tasks: Sequence[Mapping[str, Any]] = (),
    task_id: str | None = None,
) -> IntentEnvelope:
    """Compile user text into a bounded intent envelope without authorization."""
    repo = _valid_repository(repository)
    normalized = _clean(command, MAX_COMMAND_CHARS)
    if not normalized:
        raise NaturalLanguageGatewayError("command is required")
    if len(resumable_tasks) > MAX_TASKS:
        raise NaturalLanguageGatewayError("too many resumable tasks")

    explicit_task = _clean(task_id, 180) if task_id else ""
    resume = _is_resume(normalized) or bool(explicit_task)
    selected: dict[str, Any] | None = None

    tasks = [_normalized_task(item) for item in resumable_tasks]
    if resume:
        candidates = [item for item in tasks if item["status"] not in TERMINAL_STATUSES]
        if explicit_task:
            candidates = [item for item in candidates if item["task_id"] == explicit_task]
            if not candidates:
                raise NaturalLanguageGatewayError("requested task_id is not resumable")
        if len(candidates) == 0:
            raise NaturalLanguageGatewayError("resume requested but no resumable task exists")
        if len(candidates) > 1:
            raise NaturalLanguageGatewayError("resume command is ambiguous; task_id is required")
        selected = candidates[0]

    if selected is not None:
        goal = selected["goal"] if selected["goal"] != "none" else normalized
        worker_hint = selected["worker"]
        selected_task_id = selected["task_id"]
        mode = "resume"
        resume_context = selected
    else:
        goal = normalized[:MAX_GOAL_CHARS]
        worker_hint = _route_hint(normalized)
        selected_task_id = "none"
        mode = "new"
        resume_context = {}

    return IntentEnvelope(
        gateway_version=GATEWAY_VERSION,
        repository=repo,
        mode=mode,
        task_id=selected_task_id,
        goal=goal,
        normalized_command=normalized,
        command_digest=_digest(normalized),
        worker_hint=worker_hint,
        action_hint=_action_hint(normalized),
        resume_context=resume_context,
    )


def format_intent_for_coordinator(envelope: IntentEnvelope) -> str:
    """Serialize intent as untrusted coordinator input, never as HUB_COMMAND."""
    payload = json.dumps(envelope.as_dict(), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return "[USER_INTENT]\nintent_json: " + payload


def self_test() -> int:
    chart = compile_natural_language_command(
        command="AI차트 오류 계속 잡아",
        repository="owner/repo",
    )
    assert chart.mode == "new"
    assert chart.worker_hint == "ai-chart"
    assert chart.action_hint == "inspect_repository"
    assert chart.authority == "NONE"

    state = {
        "task_id": "profitability-proof",
        "goal": "finish genuine OOS evidence loop",
        "status": "partial",
        "current_step": "collect next prospective sample",
        "first_zero": "genuine_oos_n=0",
        "remaining_steps": ["collect", "settle", "full-cost"],
        "worker": "integration-planner",
        "branch": "feature/profitability",
        "head_sha": "a" * 40,
        "pr_number": "none",
        "ci_run_id": "none",
        "updated_at": "2026-09-11T00:00:00Z",
    }
    resumed = compile_natural_language_command(
        command="이어서 해",
        repository="owner/repo",
        resumable_tasks=[state],
    )
    assert resumed.mode == "resume"
    assert resumed.task_id == "profitability-proof"
    assert resumed.resume_context["first_zero"] == "genuine_oos_n=0"
    assert resumed.worker_hint == "integration-planner"
    assert "[USER_INTENT]" in format_intent_for_coordinator(resumed)
    assert "[HUB_COMMAND]" not in format_intent_for_coordinator(resumed)

    ambiguous = [state, {**state, "task_id": "ai-chart"}]
    try:
        compile_natural_language_command(command="계속 진행", repository="owner/repo", resumable_tasks=ambiguous)
    except NaturalLanguageGatewayError as exc:
        assert "ambiguous" in str(exc)
    else:
        raise AssertionError("ambiguous resume was accepted")

    try:
        compile_natural_language_command(command="", repository="owner/repo")
    except NaturalLanguageGatewayError:
        pass
    else:
        raise AssertionError("empty command was accepted")

    print(json.dumps({
        "natural_language_gateway_v5": "pass",
        "new_command_route": chart.worker_hint,
        "resume_task": resumed.task_id,
        "authority": resumed.authority,
        "ambiguous_resume_fail_closed": True,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
