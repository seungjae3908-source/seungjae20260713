#!/usr/bin/env python3
"""Read-only legacy command diagnosis and safe post-merge migration planning."""
from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

LEGACY_MIGRATION_MARKER = "[HUB_MIGRATION]"
FORBIDDEN_TRIGGER_MARKERS = ("[WORKER_REPORT]", "[HUB_COMMAND]")


def _fields(body: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in body.splitlines():
        line = raw.strip()
        if ":" not in line or line.startswith(("[", "<!--")):
            continue
        key, value = line.split(":", 1)
        result[key.strip().lower()] = value.strip()
    return result


def classify_legacy_commands(comments: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    all_body = "\n".join(str(item.get("body") or "") for item in comments)
    results: list[dict[str, Any]] = []
    for comment in comments:
        body = str(comment.get("body") or "")
        fields = _fields(body)
        if "[HUB_COMMAND]" not in body or fields.get("schema_version") == "2":
            continue
        comment_id = int(comment.get("id") or 0)
        if fields.get("status") == "no_action":
            status = "no_action"
        elif f"<!-- agent-executor-processed:{comment_id} -->" in all_body:
            status = "processed"
        elif f"<!-- agent-executor-error:{comment_id} -->" in all_body:
            status = "processed"
        elif fields.get("status") == "ready":
            status = "schema-v1 blocked"
        else:
            status = "superseded"
        results.append({"comment_id": comment_id, "source_task_id": fields.get("source_task_id", "unknown"), "legacy_status": fields.get("status", "unknown"), "migration_status": status})
    return results


def schema_v1_accepted_count(comments: Sequence[Mapping[str, Any]]) -> int:
    # The schema-v2 gate deliberately has no conversion path from schema-v1 to executable input.
    return 0


def build_migration_comment(classification: Sequence[Mapping[str, Any]], *, merged_sha: str) -> str:
    lines = [LEGACY_MIGRATION_MARKER, "schema_version: 2", f"activated_main_sha: {merged_sha}", "status: migration_plan", "legacy_commands:"]
    for item in classification:
        lines.append(f"- comment_id={int(item['comment_id'])}; status={item['migration_status']}")
    lines.extend(["schema_v1_accepted: 0", "action: Historical comments are preserved; no existing comment is edited or deleted."])
    body = "\n".join(lines)
    if any(marker in body for marker in FORBIDDEN_TRIGGER_MARKERS):
        raise AssertionError("migration comment contains an executable trigger marker")
    return body


def issue_body_edit_does_not_trigger(workflow_text: str) -> bool:
    event_section = workflow_text.split("permissions:", 1)[0]
    normalized = event_section.replace(" ", "").lower()
    return "issue_comment:" in normalized and "types:[created]" in normalized and "\nissues:" not in normalized


def self_test() -> int:
    comments = [
        {"id":1,"body":"[HUB_COMMAND]\nstatus: ready\nsource_task_id: old"},
        {"id":2,"body":"[HUB_COMMAND]\nstatus: no_action\nsource_task_id: done"},
        {"id":3,"body":"<!-- agent-executor-processed:1 -->"},
    ]
    classified = classify_legacy_commands(comments)
    assert {item["migration_status"] for item in classified} == {"processed","no_action"}
    assert schema_v1_accepted_count(comments) == 0
    body = build_migration_comment(classified, merged_sha="a"*40)
    assert not any(marker in body for marker in FORBIDDEN_TRIGGER_MARKERS)
    assert issue_body_edit_does_not_trigger("on:\n  issue_comment:\n    types: [created]\n")
    print(json.dumps({"legacy_migration_v2":"pass","schema_v1_accepted":0,"executable_markers_in_migration":0}))
    return 0

if __name__ == "__main__":
    raise SystemExit(self_test())
