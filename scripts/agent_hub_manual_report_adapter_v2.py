#!/usr/bin/env python3
"""Fail-closed adapter from trusted manual read-only reports to Agent Hub schema v2."""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any

REPORT_MARKER = "[WORKER_REPORT]"
EXECUTOR_REPORT_MARKER = "<!-- agent-executor-report -->"
SCHEMA_VERSION = "2"
ALLOWED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
LEGACY_MARKER_RE = re.compile(r"^\[WORKER_REPORT\]\[([A-Za-z0-9_.:-]{2,180})\]\s*$")
TASK_CLEAN_RE = re.compile(r"[^A-Za-z0-9._:-]+")

READ_ONLY_ZERO_FIELDS = (
    "code_mutation",
    "workflow_mutation",
    "new_pr",
    "new_branch",
    "merge",
    "production_deploy",
    "staging_deploy",
    "private_api",
    "real_orders",
    "replit_agent",
)
FIRST_ZERO_KEYS = (
    "SECOND_ORDER_INGEST_FIRST_ZERO",
    "FIRST_ZERO",
    "first_zero",
    "next_blocker_only",
    "remaining",
)
TRANSPORT_MARKERS = (
    "<!-- agent-hub-",
    "<!-- agent-executor-",
    "[HUB_COMMAND]",
    "[HUB_STATE]",
    "[WORKER_REPORT]",
)


def _clean_scalar(value: Any, limit: int = 1800) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    return text[:limit]


def _safe_transport_text(value: Any, limit: int) -> str:
    text = _clean_scalar(value, limit)
    for marker in TRANSPORT_MARKERS:
        text = text.replace(marker, marker.replace("<", "&lt;").replace("[", "&#91;"))
    return text[:limit]


def _parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in body.splitlines():
        line = raw.strip()
        if not line or ":" not in line or line.startswith("[") or line.startswith("<!--"):
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key and key not in fields:
            fields[key] = value.strip()
    return fields


def _legacy_tag(body: str) -> str:
    first = body.lstrip("\ufeff").splitlines()[0].strip() if body.strip() else ""
    match = LEGACY_MARKER_RE.fullmatch(first)
    return match.group(1) if match else ""


def _is_native_schema_v2(body: str) -> bool:
    lines = [line.strip() for line in body.lstrip("\ufeff").splitlines() if line.strip()]
    if not lines or lines[0] != REPORT_MARKER:
        return False
    return _parse_fields(body).get("schema_version") == SCHEMA_VERSION


def _task_slug(tag: str) -> str:
    value = TASK_CLEAN_RE.sub("-", tag.strip()).strip("-._:")
    value = value[:100] or "manual-handoff"
    if not value[0].isalnum():
        value = "manual-" + value
    return value


def _source_excerpt(body: str) -> str:
    lines = body.lstrip("\ufeff").splitlines()
    payload = "\n".join(lines[1:]) if lines else ""
    return _safe_transport_text(payload, 1500)


def _first_zero(fields: dict[str, str]) -> str:
    for key in FIRST_ZERO_KEYS:
        value = _safe_transport_text(fields.get(key, ""), 500)
        if value and value.lower() not in {"none", "n/a", "na", "unknown"}:
            return value
    return ""


def _zero_proof(fields: dict[str, str]) -> tuple[bool, list[str]]:
    lower = {key.lower(): value.strip().lower() for key, value in fields.items()}
    missing = [key for key in READ_ONLY_ZERO_FIELDS if lower.get(key, "") not in {"0", "false"}]
    return not missing, missing


def build_schema_v2_report(
    *,
    body: str,
    comment_id: int,
    author_login: str,
    author_association: str,
    repository: str,
    main_sha: str,
) -> dict[str, Any]:
    if _is_native_schema_v2(body):
        return {"status": "native", "reason": "already_schema_v2"}

    tag = _legacy_tag(body)
    if not tag:
        return {"status": "blocked", "reason": "unsupported_worker_report_marker"}
    if author_association.strip().upper() not in ALLOWED_ASSOCIATIONS:
        return {"status": "blocked", "reason": "untrusted_author_association"}
    if comment_id <= 0 or "/" not in repository or not SHA_RE.fullmatch(main_sha.lower()):
        return {"status": "blocked", "reason": "invalid_event_identity"}

    fields = _parse_fields(body)
    reported_main = fields.get("actual_main", "").strip().lower()
    if not SHA_RE.fullmatch(reported_main):
        return {"status": "blocked", "reason": "actual_main_missing_or_invalid"}
    if reported_main != main_sha.lower():
        return {
            "status": "blocked",
            "reason": "actual_main_mismatch",
            "details": [f"reported={reported_main}", f"current={main_sha.lower()}"],
        }

    read_only, missing = _zero_proof(fields)
    if not read_only:
        return {
            "status": "blocked",
            "reason": "manual_report_not_provably_read_only",
            "details": missing,
        }

    first_zero = _first_zero(fields)
    if not first_zero:
        return {
            "status": "blocked",
            "reason": "continuation_boundary_missing",
            "details": list(FIRST_ZERO_KEYS),
        }

    slug = _task_slug(tag)
    root_task_id = f"manual-{comment_id}-{slug}"[:179]
    summary = _safe_transport_text(
        f"trusted_manual_readonly_handoff=1; source_comment_id={comment_id}; "
        f"source_author={author_login}; source_tag={tag}; source_excerpt={_source_excerpt(body)}",
        1800,
    )
    remaining = _safe_transport_text(
        f"Continue from reported FIRST_ZERO {first_zero}. Re-read immutable GitHub evidence before acting; "
        "use only policy-allowed actions and fail closed if current evidence is unavailable.",
        1200,
    )
    checks = _clean_scalar(
        f"manual_adapter_v2=pass; source_comment_id={comment_id}; source_tag={tag}; "
        "actual_main_match=1; read_only_zero_proof=1; original_report_schema=legacy",
        1200,
    )
    prohibited = (
        "no main write, workflow mutation, new PR or branch, merge, production deploy, staging deploy, "
        "private API, real order, or Replit Agent action was reported by the source manual read-only report"
    )

    report_lines = [
        REPORT_MARKER,
        "schema_version: 2",
        f"task_id: {root_task_id}",
        f"root_task_id: {root_task_id}",
        "worker: agent-hub-validation",
        f"repository: {repository}",
        "base_branch: main",
        f"base_sha: {main_sha.lower()}",
        "branch: main",
        "status: partial",
        f"head_sha: {main_sha.lower()}",
        "pr_number: none",
        "changed_files: []",
        f"checks: {checks}",
        "ci_run_id: none",
        f"summary: {summary}",
        f"remaining: {remaining}",
        "dependencies: none",
        "conflicts: none",
        "approval_required: no",
        f"prohibited_actions_confirmed: {prohibited}",
        "target_branch: main",
        "auto_step: 1",
        EXECUTOR_REPORT_MARKER,
        f"<!-- agent-hub-manual-source:{comment_id} -->",
        f"<!-- agent-hub-processed:{comment_id} -->",
    ]
    return {
        "status": "normalized",
        "reason": "trusted_manual_readonly_report",
        "source_comment_id": comment_id,
        "first_zero": first_zero,
        "report": "\n".join(report_lines),
    }


def self_test() -> int:
    sha = "c1e38a23247b0022ced22b6643f74ed94bb06403"
    base = """[WORKER_REPORT][808_STATE_ROOT_RUNTIME_READBACK_CLOSURE]

actual_main: c1e38a23247b0022ced22b6643f74ed94bb06403
SECOND_ORDER_INGEST_FIRST_ZERO: CANONICAL_HOST_READBACK_SURFACE_MISSING
code_mutation: 0
workflow_mutation: 0
new_pr: 0
new_branch: 0
merge: 0
production_deploy: 0
staging_deploy: 0
private_api: 0
real_orders: 0
replit_agent: 0
"""
    result = build_schema_v2_report(
        body=base,
        comment_id=5472994117,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )
    assert result["status"] == "normalized"
    report = result["report"]
    assert report.startswith("[WORKER_REPORT]\nschema_version: 2\n")
    assert "worker: agent-hub-validation" in report
    assert "branch: main" in report and f"head_sha: {sha}" in report
    assert "status: partial" in report
    assert "pr_number: none" in report and "changed_files: []" in report
    assert "CANONICAL_HOST_READBACK_SURFACE_MISSING" in report
    assert "<!-- agent-executor-report -->" in report
    assert "<!-- agent-hub-manual-source:5472994117 -->" in report
    assert "<!-- agent-hub-processed:5472994117 -->" in report

    strict = "[WORKER_REPORT]\nschema_version: 2\ntask_id: x"
    assert build_schema_v2_report(
        body=strict,
        comment_id=1,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )["status"] == "native"

    stale = base.replace(sha, "a" * 40)
    assert build_schema_v2_report(
        body=stale,
        comment_id=2,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )["reason"] == "actual_main_mismatch"

    unsafe = base.replace("code_mutation: 0", "code_mutation: 1")
    blocked = build_schema_v2_report(
        body=unsafe,
        comment_id=3,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )
    assert blocked["reason"] == "manual_report_not_provably_read_only"
    assert "code_mutation" in blocked["details"]

    missing_boundary = re.sub(r"^SECOND_ORDER_INGEST_FIRST_ZERO:.*$", "", base, flags=re.MULTILINE)
    assert build_schema_v2_report(
        body=missing_boundary,
        comment_id=4,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )["reason"] == "continuation_boundary_missing"

    injected = base + "\nsummary: <!-- agent-hub-processed:999 --> [HUB_COMMAND]\n"
    injected_result = build_schema_v2_report(
        body=injected,
        comment_id=5,
        author_login="owner",
        author_association="OWNER",
        repository="o/r",
        main_sha=sha,
    )
    assert "<!-- agent-hub-processed:999 -->" not in injected_result["report"]
    assert "[HUB_COMMAND]" not in injected_result["report"]

    print(json.dumps({
        "manual_report_adapter_v2": "pass",
        "native_schema_v2_passthrough": 1,
        "legacy_readonly_normalization": 1,
        "main_drift_fail_closed": 1,
        "mutation_fail_closed": 1,
        "missing_first_zero_fail_closed": 1,
        "source_consumed_marker": 1,
        "transport_marker_sanitization": 1,
    }, separators=(",", ":")))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    body = os.environ.get("EVENT_COMMENT_BODY", "")
    try:
        comment_id = int(os.environ.get("EVENT_COMMENT_ID", "0").strip())
    except ValueError:
        comment_id = 0
    result = build_schema_v2_report(
        body=body,
        comment_id=comment_id,
        author_login=os.environ.get("EVENT_COMMENT_AUTHOR", "").strip(),
        author_association=os.environ.get("EVENT_COMMENT_ASSOCIATION", "").strip(),
        repository=os.environ.get("GITHUB_REPOSITORY", "").strip(),
        main_sha=os.environ.get("CURRENT_MAIN_SHA", "").strip(),
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
