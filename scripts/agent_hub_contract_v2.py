#!/usr/bin/env python3
"""Schema v2 and deterministic transport helpers for Agent Hub.

This module validates reports and commands but does not call models or execute work.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

SCHEMA_VERSION = "2"
PROVIDER = "gemini-developer-api-free"
MODEL = "gemini-3.1-flash-lite"
AUTO_LIMIT = 3
REPORT_MARKER = "[WORKER_REPORT]"
COMMAND_MARKER = "[HUB_COMMAND]"
STATE_MARKER = "[HUB_STATE]"
EXECUTOR_REPORT_MARKER = "<!-- agent-executor-report -->"
PROCESSED_MARKER_PREFIX = "<!-- agent-hub-processed:"
COMMAND_MARKER_PREFIX = "<!-- agent-hub-command:"
EXECUTOR_PROCESSED_PREFIX = "<!-- agent-executor-processed:"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
COMMAND_ID_RE = re.compile(r"^hub-[0-9]+-[0-9a-f]{16}$")
WORKER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,179}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

WORKER_IDS = (
    "ai-signal-scanner",
    "approved-order-trading",
    "market-information-room",
    "ai-chart",
    "test-runner",
    "integration-planner",
    "security-inspector",
    "operations-worker",
    "agent-hub-validation",
)

REPORT_FIELDS = (
    "schema_version", "task_id", "worker", "repository", "base_branch", "base_sha", "branch",
    "status", "head_sha", "pr_number", "changed_files", "checks", "ci_run_id", "summary",
    "remaining", "dependencies", "conflicts", "approval_required", "prohibited_actions_confirmed",
)
REPORT_STATUSES = {"completed", "partial", "blocked", "failed", "waiting_approval"}
COMMAND_STATUSES = {
    "needs_context", "ready", "waiting", "waiting_approval", "blocked", "stale", "expired",
    "superseded", "no_action",
}
RISK_LEVELS = {"low", "medium", "high", "prohibited"}
EXECUTION_MODES = {"read_only", "code_change", "none"}
PATHLESS_READ_ONLY_ACTIONS = frozenset({
    "inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_ci_failure", "analyze_logs",
    "analyze_playwright_trace", "run_typecheck", "run_unit_tests", "run_build", "run_playwright",
    "report_results", "analyze_conflicts", "create_integration_plan", "inspect_security_contract",
    "inspect_private_api_calls", "inspect_paper_vs_live_order_separation",
})
COMMAND_FIELDS = (
    "schema_version", "command_id", "source_task_id", "source_report_comment_id", "target_worker",
    "status", "action_type", "risk_level", "execution_mode", "repository", "base_branch", "base_sha",
    "target_branch", "expected_head_sha", "work_branch", "allowed_paths", "prohibited_paths",
    "instruction", "evidence_ids", "validation", "stop_conditions", "expires_at", "auto_step",
    "auto_limit", "approval_required", "required_approval_phrase", "max_attempts", "policy_version",
    "provider", "model",
)


class ContractError(RuntimeError):
    """Expected fail-closed contract validation error."""


@dataclass(frozen=True)
class WorkerReport:
    comment_id: int
    author: str
    fields: dict[str, str]
    raw_body: str

    @property
    def task_id(self) -> str:
        return self.fields["task_id"]

    @property
    def root_task_id(self) -> str:
        return self.fields.get("root_task_id", "").strip() or self.fields["task_id"]

    @property
    def worker(self) -> str:
        return self.fields["worker"]

    @property
    def branch(self) -> str:
        return self.fields["branch"]

    @property
    def head_sha(self) -> str:
        return self.fields["head_sha"]

    @property
    def status(self) -> str:
        return self.fields["status"]


@dataclass(frozen=True)
class HubCommand:
    comment_id: int
    fields: dict[str, str]
    raw_body: str


def _clean(value: Any, *, limit: int = 4000, allow_empty: bool = False) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    if not text and not allow_empty:
        raise ContractError("required scalar is empty")
    if len(text) > limit:
        raise ContractError("scalar exceeds length limit")
    return text


def parse_key_values(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current = ""
    buffer: list[str] = []

    def flush() -> None:
        nonlocal current, buffer
        if current:
            fields[current] = "\n".join(buffer).strip()
        current = ""
        buffer = []

    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith("[") or stripped.startswith("<!--"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", stripped)
        if match:
            flush()
            current = match.group(1).lower()
            buffer = [match.group(2)]
        elif current and stripped:
            buffer.append(stripped)
    flush()
    return fields


def parse_json_list(value: Any, field: str, *, allow_empty: bool = True) -> tuple[str, ...]:
    if isinstance(value, str):
        text = value.strip()
        if text.lower() == "none" or not text:
            parsed: Any = []
        elif text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ContractError(f"{field} must be a JSON list") from exc
        else:
            parsed = [item.strip() for item in re.split(r"[,;|\n]", text) if item.strip()]
    else:
        parsed = value
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise ContractError(f"{field} must be a string list")
    result: list[str] = []
    for item in parsed:
        item = item.strip().replace("\\", "/")
        if not item:
            continue
        if item.startswith("/") or "\x00" in item or ".." in item.split("/"):
            raise ContractError(f"{field} contains unsafe path/value")
        result.append(item)
    result = list(dict.fromkeys(result))
    if not allow_empty and not result:
        raise ContractError(f"{field} must not be empty")
    return tuple(result)


def bool_text(value: Any, field: str) -> bool:
    text = str(value or "").strip().lower()
    if text in {"yes", "true", "1"}:
        return True
    if text in {"no", "false", "0"}:
        return False
    raise ContractError(f"{field} must be yes/no")


def none_or_sha(value: str, field: str) -> str:
    value = value.strip().lower()
    if value == "none":
        return value
    if not SHA_RE.fullmatch(value):
        raise ContractError(f"{field} must be a 40-character SHA or none")
    return value


def none_or_int(value: str, field: str) -> str:
    value = value.strip().lower()
    if value == "none":
        return value
    if not value.isdigit() or int(value) <= 0:
        raise ContractError(f"{field} must be a positive integer or none")
    return value


def validate_report(
    body: str,
    *,
    comment_id: int,
    author: str,
    expected_repository: str,
    allowed_workers: Iterable[str] = WORKER_IDS,
) -> WorkerReport:
    if REPORT_MARKER not in body:
        raise ContractError("WORKER_REPORT marker missing")
    fields = parse_key_values(body)
    missing = [field for field in REPORT_FIELDS if field not in fields]
    if missing:
        raise ContractError("report missing fields: " + ", ".join(missing))
    extra_allowed = {"profile", "auto_step", "root_task_id", "failure_signature", "target_branch"}
    unknown = sorted(set(fields) - set(REPORT_FIELDS) - extra_allowed)
    if unknown:
        raise ContractError("report has unsupported fields: " + ", ".join(unknown))
    if fields["schema_version"].strip() != SCHEMA_VERSION:
        raise ContractError("unsupported report schema_version")
    task_id = _clean(fields["task_id"], limit=180)
    if not TASK_RE.fullmatch(task_id):
        raise ContractError("invalid task_id")
    root_task_id = _clean(fields.get("root_task_id", task_id), limit=180)
    if not TASK_RE.fullmatch(root_task_id):
        raise ContractError("invalid root_task_id")
    worker = _clean(fields["worker"], limit=64)
    allowed = set(allowed_workers)
    if worker not in allowed or not WORKER_RE.fullmatch(worker):
        raise ContractError("unregistered worker")
    repository = _clean(fields["repository"], limit=200)
    if repository != expected_repository:
        raise ContractError("repository mismatch")
    if fields["base_branch"].strip() != "main":
        raise ContractError("base_branch must be main")
    base_sha = none_or_sha(fields["base_sha"], "base_sha")
    branch = _clean(fields["branch"], limit=180)
    if branch.lower() in {"main", "master"}:
        raise ContractError("report branch cannot be main/master")
    if branch == "none" and fields["status"].strip().lower() == "completed":
        raise ContractError("completed report requires a real branch")
    status = fields["status"].strip().lower()
    if status not in REPORT_STATUSES:
        raise ContractError("invalid report status")
    head_sha = none_or_sha(fields["head_sha"], "head_sha")
    pr_number = none_or_int(fields["pr_number"], "pr_number")
    ci_run_id = none_or_int(fields["ci_run_id"], "ci_run_id")
    changed_files = parse_json_list(fields["changed_files"], "changed_files")
    approval_required = bool_text(fields["approval_required"], "approval_required")
    prohibited_confirmed = _clean(fields["prohibited_actions_confirmed"], limit=1200)
    if prohibited_confirmed.lower() in {"no", "false", "none"}:
        raise ContractError("prohibited_actions_confirmed must affirm no prohibited action")
    if status == "completed":
        if head_sha == "none" or ci_run_id == "none":
            raise ContractError("completed report requires head_sha and ci_run_id")
    if status == "waiting_approval" and not approval_required:
        raise ContractError("waiting_approval report must require approval")
    normalized = dict(fields)
    normalized.update(
        {
            "task_id": task_id,
            "root_task_id": root_task_id,
            "worker": worker,
            "repository": repository,
            "base_sha": base_sha,
            "branch": branch,
            "status": status,
            "head_sha": head_sha,
            "pr_number": pr_number,
            "ci_run_id": ci_run_id,
            "changed_files": json.dumps(list(changed_files), ensure_ascii=False, separators=(",", ":")),
            "approval_required": "yes" if approval_required else "no",
        }
    )
    return WorkerReport(comment_id=comment_id, author=author, fields=normalized, raw_body=body)


def command_id(report_comment_id: int, task_id: str, worker: str, action_type: str, policy_version: str) -> str:
    digest = hashlib.sha256(
        f"{report_comment_id}|{task_id}|{worker}|{action_type}|{policy_version}|schema2".encode("utf-8")
    ).hexdigest()[:16]
    return f"hub-{report_comment_id}-{digest}"


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_command(fields: Mapping[str, Any], *, policy_version: str) -> dict[str, str]:
    missing = [field for field in COMMAND_FIELDS if field not in fields or str(fields[field]).strip() == ""]
    if missing:
        raise ContractError("command missing fields: " + ", ".join(missing))
    normalized = {key: str(value).strip() for key, value in fields.items()}
    if normalized["schema_version"] != SCHEMA_VERSION:
        raise ContractError("unsupported command schema_version")
    if not COMMAND_ID_RE.fullmatch(normalized["command_id"]):
        raise ContractError("invalid command_id")
    if not TASK_RE.fullmatch(normalized["source_task_id"]):
        raise ContractError("invalid source_task_id")
    if not normalized["source_report_comment_id"].isdigit():
        raise ContractError("invalid source_report_comment_id")
    if normalized["target_worker"] not in WORKER_IDS:
        raise ContractError("unregistered command worker")
    if normalized["status"] not in COMMAND_STATUSES:
        raise ContractError("invalid command status")
    if normalized["risk_level"] not in RISK_LEVELS:
        raise ContractError("invalid command risk")
    if normalized["execution_mode"] not in EXECUTION_MODES:
        raise ContractError("invalid execution_mode")
    if normalized["base_branch"] != "main":
        raise ContractError("command base_branch must be main")
    none_or_sha(normalized["base_sha"], "base_sha")
    none_or_sha(normalized["expected_head_sha"], "expected_head_sha")
    if normalized["target_branch"].lower() in {"main", "master"}:
        raise ContractError("command target_branch cannot be main/master")
    allowed_paths = parse_json_list(normalized["allowed_paths"], "allowed_paths")
    prohibited_paths = parse_json_list(normalized["prohibited_paths"], "prohibited_paths", allow_empty=False)
    evidence_ids = parse_json_list(normalized["evidence_ids"], "evidence_ids")
    if normalized["status"] == "ready":
        if normalized["risk_level"] != "low" or normalized["execution_mode"] == "none":
            raise ContractError("ready command must be low-risk and executable")
        pathless_read_only = (
            normalized["execution_mode"] == "read_only"
            and normalized["action_type"] in PATHLESS_READ_ONLY_ACTIONS
        )
        if not allowed_paths and not pathless_read_only:
            raise ContractError("ready command requires allowed_paths unless action is pathless read-only")
        if normalized["execution_mode"] == "code_change" and not allowed_paths:
            raise ContractError("code-change command requires allowed_paths")
    else:
        if normalized["execution_mode"] != "none" and normalized["status"] not in {"waiting", "stale"}:
            raise ContractError("non-ready command must not be executable")
    approval = bool_text(normalized["approval_required"], "approval_required")
    if normalized["status"] == "waiting_approval" and not approval:
        raise ContractError("waiting_approval command must require approval")
    if normalized["status"] == "blocked" and normalized["risk_level"] != "prohibited":
        raise ContractError("blocked command must use prohibited risk")
    try:
        expires = datetime.strptime(normalized["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ContractError("invalid expires_at") from exc
    if not ISO_RE.fullmatch(normalized["expires_at"]) or expires.tzinfo is None:
        raise ContractError("invalid expires_at")
    try:
        auto_step = int(normalized["auto_step"])
        auto_limit = int(normalized["auto_limit"])
        max_attempts = int(normalized["max_attempts"])
    except ValueError as exc:
        raise ContractError("auto/retry fields must be integers") from exc
    if auto_limit != AUTO_LIMIT or not 0 <= auto_step <= auto_limit:
        raise ContractError("invalid automatic step limit")
    if not 1 <= max_attempts <= 2:
        raise ContractError("max_attempts must be one or two")
    if normalized["provider"] != PROVIDER or normalized["model"] != MODEL:
        raise ContractError("provider/model mismatch")
    if normalized["policy_version"] != policy_version:
        raise ContractError("policy_version mismatch")
    normalized["allowed_paths"] = json.dumps(list(allowed_paths), ensure_ascii=False, separators=(",", ":"))
    normalized["prohibited_paths"] = json.dumps(list(prohibited_paths), ensure_ascii=False, separators=(",", ":"))
    normalized["evidence_ids"] = json.dumps(list(evidence_ids), ensure_ascii=False, separators=(",", ":"))
    return normalized


def format_command(fields: Mapping[str, Any], *, policy_version: str) -> str:
    normalized = validate_command(fields, policy_version=policy_version)
    lines = [COMMAND_MARKER]
    for key in COMMAND_FIELDS:
        lines.append(f"{key}: {normalized[key]}")
    # Compatibility aliases consumed by the PR #70 executor. Extra fields are ignored by its strict required-field check.
    lines.extend(
        [
            f"branch: {normalized['target_branch']}",
            f"forbidden_paths: {normalized['prohibited_paths']}",
            f"requires_user_approval: {'true' if normalized['approval_required'] == 'yes' else 'false'}",
            f"paid_fallback: false",
            f"{PROCESSED_MARKER_PREFIX}{normalized['source_report_comment_id']} -->",
            f"{COMMAND_MARKER_PREFIX}{normalized['command_id']} -->",
        ]
    )
    return "\n".join(lines)


def parse_command(body: str, *, comment_id: int, policy_version: str) -> HubCommand:
    if COMMAND_MARKER not in body:
        raise ContractError("HUB_COMMAND marker missing")
    fields = validate_command(parse_key_values(body), policy_version=policy_version)
    return HubCommand(comment_id=comment_id, fields=fields, raw_body=body)


def path_overlap(pattern: str, path: str) -> bool:
    pattern = pattern.replace("\\", "/")
    path = path.replace("\\", "/")
    if fnmatch.fnmatchcase(path, pattern):
        return True
    plain = pattern.replace("**", "").replace("*", "").strip("/")
    return bool(plain and (path.startswith(plain) or plain.startswith(path.strip("/"))))


def any_file_overlap(patterns: Sequence[str], files: Iterable[str]) -> list[str]:
    matched: list[str] = []
    for file in files:
        if any(path_overlap(pattern, file) for pattern in patterns):
            matched.append(file)
    return sorted(set(matched))


def find_marked(body_text: str, prefix: str, value: str | int) -> bool:
    return f"{prefix}{value} -->" in body_text


def self_test() -> int:
    report_body = """[WORKER_REPORT]
schema_version: 2
task_id: test-001
worker: test-runner
repository: owner/repo
base_branch: main
base_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch: feature/test
status: completed
head_sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
pr_number: 70
changed_files: [\"tests/a.test.ts\"]
checks: typecheck success
ci_run_id: 12345678
summary: completed
remaining: none
dependencies: none
conflicts: none
approval_required: no
prohibited_actions_confirmed: no merge, deploy, DB, Secret, or live order action performed
"""
    report = validate_report(report_body, comment_id=9, author="owner", expected_repository="owner/repo")
    assert report.worker == "test-runner"
    cid = command_id(9, report.task_id, report.worker, "report_results", "agent-hub-v4.0")
    fields = {
        "schema_version": "2",
        "command_id": cid,
        "source_task_id": report.task_id,
        "source_report_comment_id": "9",
        "target_worker": "test-runner",
        "status": "ready",
        "action_type": "run_typecheck",
        "risk_level": "low",
        "execution_mode": "read_only",
        "repository": "owner/repo",
        "base_branch": "main",
        "base_sha": "a" * 40,
        "target_branch": "feature/test",
        "expected_head_sha": "b" * 40,
        "work_branch": "none",
        "allowed_paths": '["tests/**"]',
        "prohibited_paths": '[".github/**"]',
        "instruction": "Run typecheck.",
        "evidence_ids": '["CI-123"]',
        "validation": "Exit zero.",
        "stop_conditions": "Stop on failure.",
        "expires_at": "2026-08-05T00:00:00Z",
        "auto_step": "1",
        "auto_limit": "3",
        "approval_required": "no",
        "required_approval_phrase": "none",
        "max_attempts": "2",
        "policy_version": "agent-hub-v4.0",
        "provider": PROVIDER,
        "model": MODEL,
    }
    text = format_command(fields, policy_version="agent-hub-v4.0")
    parsed = parse_command(text, comment_id=10, policy_version="agent-hub-v4.0")
    assert parsed.fields["status"] == "ready"

    pathless = {
        **fields,
        "command_id": command_id(10, report.task_id, "operations-worker", "inspect_repository", "agent-hub-v4.0"),
        "source_report_comment_id": "10",
        "target_worker": "operations-worker",
        "action_type": "inspect_repository",
        "target_branch": "ops/read-only-agent-hub",
        "allowed_paths": "[]",
        "instruction": "Inspect repository state only.",
    }
    normalized_pathless = validate_command(pathless, policy_version="agent-hub-v4.0")
    assert normalized_pathless["allowed_paths"] == "[]"
    parse_command(format_command(pathless, policy_version="agent-hub-v4.0"), comment_id=11, policy_version="agent-hub-v4.0")

    empty_change = {
        **fields,
        "command_id": command_id(11, report.task_id, "test-runner", "modify_feature_branch", "agent-hub-v4.0"),
        "source_report_comment_id": "11",
        "action_type": "modify_feature_branch",
        "execution_mode": "code_change",
        "allowed_paths": "[]",
    }
    try:
        validate_command(empty_change, policy_version="agent-hub-v4.0")
    except ContractError:
        pass
    else:
        raise AssertionError("empty code-change command scope was accepted")

    assert any_file_overlap(["stock-analyzer/src/**"], ["stock-analyzer/src/App.tsx"]) == ["stock-analyzer/src/App.tsx"]
    bad = report_body.replace("schema_version: 2\n", "")
    try:
        validate_report(bad, comment_id=1, author="x", expected_repository="owner/repo")
    except ContractError:
        pass
    else:
        raise AssertionError("missing schema field was accepted")
    print(json.dumps({
        "contract_v2": "pass",
        "workers": len(WORKER_IDS),
        "report_fields": len(REPORT_FIELDS),
        "command_fields": len(COMMAND_FIELDS),
        "pathless_read_only": 1,
        "code_change_empty_allowed_paths": 0,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
