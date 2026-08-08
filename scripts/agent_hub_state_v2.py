#!/usr/bin/env python3
"""Compact, non-sensitive Agent Hub state snapshots and deterministic deltas."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

STATE_MARKER = "[HUB_COMPACT_STATE]"
STATE_JSON_FIELD = "state_json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class StateError(RuntimeError):
    """Fail-closed compact-state parsing error."""


def _clean(value: Any, limit: int = 240) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    return text[:limit]


def _string_list(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    parsed: Any = value
    if isinstance(value, str):
        text = value.strip()
        if not text or text.lower() in {"none", "[]"}:
            return ()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise StateError("changed_files must be valid JSON") from exc
        else:
            parsed = [item.strip() for item in re.split(r"[,;|\n]", text) if item.strip()]
    if not isinstance(parsed, (list, tuple)) or any(not isinstance(item, str) for item in parsed):
        raise StateError("changed_files must be a string list")
    result = tuple(sorted(dict.fromkeys(_clean(item, 500) for item in parsed if _clean(item, 500))))
    if len(result) > 100:
        raise StateError("changed_files exceeds compact-state limit")
    return result


def _sha_or_none(value: Any, field: str) -> str:
    text = _clean(value, 80).lower()
    if text in {"", "none"}:
        return "none"
    if not SHA_RE.fullmatch(text):
        raise StateError(f"{field} is not a full SHA")
    return text


@dataclass(frozen=True)
class CompactState:
    repository: str
    worker: str
    branch: str
    status: str
    base_sha: str
    head_sha: str
    pr_number: str
    ci_run_id: str
    changed_files: tuple[str, ...]
    checks_digest: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["changed_files"] = list(self.changed_files)
        return value


def build_current_state(fields: Mapping[str, Any], *, updated_at: str = "") -> CompactState:
    checks = _clean(fields.get("checks"), 12000)
    supplied_digest = _clean(fields.get("checks_digest"), 32)
    digest = supplied_digest or (hashlib.sha256(checks.encode("utf-8")).hexdigest()[:16] if checks else "none")
    return CompactState(
        repository=_clean(fields.get("repository"), 200),
        worker=_clean(fields.get("worker"), 80),
        branch=_clean(fields.get("branch"), 180),
        status=_clean(fields.get("status"), 40),
        base_sha=_sha_or_none(fields.get("base_sha"), "base_sha"),
        head_sha=_sha_or_none(fields.get("head_sha"), "head_sha"),
        pr_number=_clean(fields.get("pr_number"), 24) or "none",
        ci_run_id=_clean(fields.get("ci_run_id"), 32) or "none",
        changed_files=_string_list(fields.get("changed_files")),
        checks_digest=digest,
        updated_at=_clean(updated_at or fields.get("updated_at"), 40) or "none",
    )


def state_delta(previous: CompactState | None, current: CompactState) -> dict[str, dict[str, Any]]:
    if previous is None:
        return {"initial": {"before": None, "after": current.as_dict()}}
    before = previous.as_dict()
    after = current.as_dict()
    return {
        key: {"before": before[key], "after": after[key]}
        for key in after
        if before.get(key) != after.get(key)
    }


def format_state_snapshot(state: CompactState) -> str:
    encoded = json.dumps(state.as_dict(), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return f"{STATE_MARKER}\n{STATE_JSON_FIELD}: {encoded}"


def parse_state_snapshot(body: str) -> CompactState | None:
    if STATE_MARKER not in body:
        return None
    for raw in body.splitlines():
        line = raw.strip()
        if not line.startswith(f"{STATE_JSON_FIELD}:"):
            continue
        try:
            value = json.loads(line.split(":", 1)[1].strip())
        except json.JSONDecodeError as exc:
            raise StateError("compact state JSON is invalid") from exc
        if not isinstance(value, dict):
            raise StateError("compact state must be an object")
        return build_current_state(value, updated_at=str(value.get("updated_at") or ""))
    raise StateError("compact state marker has no state_json")


def latest_matching_state(
    comments: Sequence[Mapping[str, Any]],
    *,
    repository: str,
    worker: str,
    branch: str,
) -> CompactState | None:
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if STATE_MARKER not in body:
            continue
        try:
            state = parse_state_snapshot(body)
        except StateError:
            continue
        if state and (state.repository, state.worker, state.branch) == (repository, worker, branch):
            return state
    return None


def self_test() -> int:
    fields = {
        "repository": "owner/repo",
        "worker": "integration-planner",
        "branch": "feature/demo",
        "status": "partial",
        "base_sha": "a" * 40,
        "head_sha": "b" * 40,
        "pr_number": "70",
        "ci_run_id": "123",
        "changed_files": ["docs/b.md", "docs/a.md"],
        "checks": "success",
    }
    current = build_current_state(fields, updated_at="2026-08-05T00:00:00Z")
    assert state_delta(current, current) == {}
    changed = build_current_state({**fields, "head_sha": "c" * 40, "status": "completed"})
    delta = state_delta(current, changed)
    assert set(delta) == {"status", "head_sha", "updated_at"}
    body = format_state_snapshot(current)
    assert parse_state_snapshot(body) == current
    assert latest_matching_state([{"body": body}], repository="owner/repo", worker="integration-planner", branch="feature/demo") == current
    print(json.dumps({"compact_state_v2": "pass", "delta_fields": sorted(delta)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
