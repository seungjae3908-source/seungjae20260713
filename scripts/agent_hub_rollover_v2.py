#!/usr/bin/env python3
"""Fail-closed Central Hub resolver and proactive rollover manager.

The Hub bootstrap remains Issue #660.  Archived Hubs contain exactly one successor
marker and each successor attests its predecessor, allowing all scheduled workers to
resolve the current Hub without a mutable hard-coded issue number.

Rollover happens before the existing Agent Hub 1,000-comment processing window.  It is
also deferred while a trusted report is pending or a schema-v2 command is still active,
so route changes cannot strand an in-flight task or approval.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

BOOTSTRAP_HUB_ISSUE = 660
PROCESSOR_COMMENT_WINDOW = 1000
PREPARE_THRESHOLD = 850
ROLLOVER_THRESHOLD = 925
GITHUB_COMMENT_HARD_LIMIT = 2500
MAX_CHAIN_DEPTH = 32
GITHUB_API_VERSION = "2022-11-28"

REPORT_MARKER = "[WORKER_REPORT]"
COMMAND_MARKER = "[HUB_COMMAND]"
STATE_MARKER = "[HUB_STATE]"
EXECUTOR_REPORT_MARKER = "<!-- agent-executor-report -->"
COMMAND_ATTEST_PREFIX = "<!-- agent-hub-command:"
PREPARE_MARKER = "<!-- agent-hub-rollover-prepare:v2 -->"
CANONICAL_MARKER = "<!-- agent-hub-canonical:v2 -->"
ARCHIVE_MARKER = "<!-- agent-hub-archive:v2 -->"
SUCCESSOR_RE = re.compile(r"<!--\s*agent-hub-successor:(\d+)\s*-->")
PREDECESSOR_RE = re.compile(r"<!--\s*agent-hub-predecessor:(\d+)\s*-->")

TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
ACTIVE_COMMAND_STATUSES = {"needs_context", "ready", "waiting", "waiting_approval"}
TERMINAL_COMMAND_STATUSES = {"blocked", "stale", "expired", "superseded", "no_action"}
TERMINAL_EXECUTOR_STATES = {"completed", "failed", "blocked", "stale", "expired", "superseded"}
ACTIVE_EXECUTOR_STATES = {"running"}

REQUIRED_STATUS_CONTEXTS = (
    "application-ci/verified",
    "browser-ui/verified",
    "security-integration/verified",
    "ai-privacy/verified",
    "database-rls/verified",
    "futures-public-network-smoke/verified",
)
SAFE_STATE_KEYS = (
    "PROFITABILITY_PROVEN",
    "CURRENT_VALIDATED_CHAMPION",
    "LIVE_TRADING",
    "LIVE_TRADING_READY",
    "EXECUTION_AUTHORITY",
    "executionAuthority",
    "PRIVATE_API_ENABLED",
    "PRIVATE_TRADING_API_ALLOWED",
    "REAL_ORDER_ENABLED",
    "SCHEDULE_ACTIVE",
    "FIRST_NATURAL_CRON_CYCLE_VERIFIED",
)
SAFE_REPORT_FIELDS = (
    "task_id", "root_task_id", "worker", "status", "head_sha", "pr_number",
    "summary", "remaining", "dependencies", "conflicts", "approval_required",
)
SAFE_COMMAND_FIELDS = (
    "command_id", "source_task_id", "target_worker", "status", "action_type",
    "risk_level", "target_branch", "expected_head_sha", "approval_required", "expires_at",
)
SAFE_LEASE_FIELDS = ("OWNER", "CURRENT_MAIN", "SCOPE", "FILES", "BRANCH", "SAFETY", "NEXT")


class RolloverError(RuntimeError):
    pass


def _safe_text(value: Any, limit: int = 1200) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[REDACTED_EMAIL]", text, flags=re.I)
    text = re.sub(r"\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b", "[REDACTED_PHONE]", text)
    text = re.sub(r"(?i)\b(password|secret|token|api[_ -]?key)\s*[:=]\s*\S+", r"\1=[REDACTED]", text)
    return text[:limit]


def parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in str(body or "").splitlines():
        line = raw.strip()
        if not line or line.startswith(("[", "<!--")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            fields[key] = _safe_text(value, 1600)
    return fields


def successor_from_body(body: str) -> int | None:
    values = [int(item) for item in SUCCESSOR_RE.findall(str(body or ""))]
    if not values:
        return None
    if len(set(values)) != 1 or values[0] <= 0:
        raise RolloverError("conflicting or invalid successor markers")
    return values[0]


def predecessor_from_body(body: str) -> int | None:
    values = [int(item) for item in PREDECESSOR_RE.findall(str(body or ""))]
    if not values:
        return None
    if len(set(values)) != 1 or values[0] <= 0:
        raise RolloverError("conflicting or invalid predecessor markers")
    return values[0]


def _comment_id(comment: Mapping[str, Any]) -> int:
    try:
        return int(comment.get("id") or 0)
    except (TypeError, ValueError):
        return 0


def _comment_login(comment: Mapping[str, Any]) -> str:
    return str((comment.get("user") or {}).get("login") or "")


def trusted_report_comment(comment: Mapping[str, Any]) -> bool:
    body = str(comment.get("body") or "")
    if REPORT_MARKER not in body:
        return False
    association = str(comment.get("author_association") or "").upper()
    if association in TRUSTED_ASSOCIATIONS:
        return True
    return _comment_login(comment) == "github-actions[bot]" and EXECUTOR_REPORT_MARKER in body


def trusted_command_comment(comment: Mapping[str, Any]) -> bool:
    body = str(comment.get("body") or "")
    return (
        COMMAND_MARKER in body
        and COMMAND_ATTEST_PREFIX in body
        and _comment_login(comment) == "github-actions[bot]"
        and parse_fields(body).get("schema_version") == "2"
    )


def _parse_iso(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def unresolved_control_work(comments: Sequence[Mapping[str, Any]], *, now: datetime | None = None) -> list[str]:
    """Return bounded reasons that make a rollover unsafe right now."""
    current = now or datetime.now(timezone.utc)
    command_source_reports: set[int] = set()
    commands: dict[str, tuple[int, dict[str, str]]] = {}
    latest_state: dict[str, tuple[int, str]] = {}

    for comment in comments:
        cid = _comment_id(comment)
        body = str(comment.get("body") or "")
        fields = parse_fields(body)
        if trusted_command_comment(comment):
            command_id = fields.get("command_id", "")
            if command_id:
                commands[command_id] = (cid, fields)
            source = fields.get("source_report_comment_id", "")
            if source.isdigit():
                command_source_reports.add(int(source))
        elif STATE_MARKER in body and _comment_login(comment) == "github-actions[bot]":
            command_id = fields.get("command_id", "")
            status = fields.get("status", "")
            if command_id and status:
                latest_state[command_id] = (cid, status)

    reasons: list[str] = []
    for comment in comments:
        if not trusted_report_comment(comment):
            continue
        cid = _comment_id(comment)
        fields = parse_fields(str(comment.get("body") or ""))
        if fields.get("schema_version") != "2" or cid <= 0:
            continue
        if cid not in command_source_reports:
            task = _safe_text(fields.get("root_task_id") or fields.get("task_id") or "unknown", 180)
            reasons.append(f"pending_report:{cid}:{task}")

    for command_id, (cid, fields) in commands.items():
        status = fields.get("status", "")
        if status in TERMINAL_COMMAND_STATUSES:
            continue
        state = latest_state.get(command_id)
        if state is not None and state[0] > cid:
            if state[1] in TERMINAL_EXECUTOR_STATES:
                continue
            if state[1] in ACTIVE_EXECUTOR_STATES:
                reasons.append(f"active_command:{command_id}:{state[1]}")
                continue
        expires = _parse_iso(fields.get("expires_at", ""))
        if expires is not None and expires <= current:
            continue
        if status in ACTIVE_COMMAND_STATUSES or status not in TERMINAL_COMMAND_STATUSES:
            reasons.append(f"active_command:{command_id}:{status or 'unknown'}")
    return sorted(dict.fromkeys(reasons))[:20]


class GitHubClient:
    def __init__(self, token: str, api_url: str, repository: str) -> None:
        self.token = token.strip()
        self.api_url = api_url.rstrip("/")
        self.repository = repository.strip()
        if not self.token or "/" not in self.repository:
            raise RolloverError("GITHUB_TOKEN and GITHUB_REPOSITORY are required")

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        url = path if path.startswith("http") else f"{self.api_url}{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "agent-hub-rollover-v2/2.0",
        }
        data = None
        if payload is not None:
            data = json.dumps(dict(payload), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            with urlopen(Request(url, data=data, headers=headers, method=method), timeout=45) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RolloverError(f"GitHub HTTP {exc.code}: {detail[:700]}") from exc
        except (URLError, json.JSONDecodeError) as exc:
            raise RolloverError(f"GitHub request failed: {exc}") from exc

    def issue(self, number: int) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}/issues/{number}")
        if not isinstance(payload, dict) or payload.get("pull_request"):
            raise RolloverError(f"issue #{number} is missing or not a plain issue")
        return payload

    def comments(self, number: int, count: int, *, tail_only: bool = False) -> list[dict[str, Any]]:
        if count <= 0:
            return []
        last_page = max(1, math.ceil(count / 100))
        first_page = max(1, last_page - 2) if tail_only else 1
        payloads: list[dict[str, Any]] = []
        for page in range(first_page, last_page + 1):
            query = urlencode({"per_page": 100, "page": page})
            batch = self.request("GET", f"/repos/{self.repository}/issues/{number}/comments?{query}")
            if not isinstance(batch, list):
                raise RolloverError("issue comments response was not a list")
            payloads.extend(item for item in batch if isinstance(item, dict))
        return payloads

    def post_comment(self, number: int, body: str) -> dict[str, Any]:
        payload = self.request("POST", f"/repos/{self.repository}/issues/{number}/comments", {"body": body})
        if not isinstance(payload, dict):
            raise RolloverError("comment creation returned a non-object")
        return payload

    def update_issue(self, number: int, **fields: Any) -> dict[str, Any]:
        payload = self.request("PATCH", f"/repos/{self.repository}/issues/{number}", fields)
        if not isinstance(payload, dict):
            raise RolloverError("issue update returned a non-object")
        return payload

    def create_issue(self, *, title: str, body: str, labels: Sequence[str]) -> dict[str, Any]:
        payload = self.request("POST", f"/repos/{self.repository}/issues", {"title": title, "body": body, "labels": list(labels)})
        if not isinstance(payload, dict) or int(payload.get("number") or 0) <= 0:
            raise RolloverError("successor issue creation failed")
        return payload

    def lock_issue(self, number: int) -> None:
        self.request("PUT", f"/repos/{self.repository}/issues/{number}/lock", {"lock_reason": "resolved"})

    def branch_sha(self, branch: str = "main") -> str:
        encoded = quote(f"heads/{branch}", safe="")
        payload = self.request("GET", f"/repos/{self.repository}/git/ref/{encoded}")
        sha = str(((payload or {}).get("object") or {}).get("sha") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise RolloverError(f"cannot resolve {branch} SHA")
        return sha

    def commit_status(self, sha: str) -> dict[str, str]:
        payload = self.request("GET", f"/repos/{self.repository}/commits/{sha}/status")
        statuses = payload.get("statuses") if isinstance(payload, dict) else None
        if not isinstance(statuses, list):
            raise RolloverError("commit status response missing statuses")
        latest: dict[str, str] = {}
        for item in statuses:
            if not isinstance(item, dict):
                continue
            context = str(item.get("context") or "")
            if context and context not in latest:
                latest[context] = str(item.get("state") or "")
        return latest

    def open_pulls(self) -> list[dict[str, Any]]:
        payload = self.request("GET", f"/repos/{self.repository}/pulls?state=open&per_page=100")
        if not isinstance(payload, list):
            raise RolloverError("open pull request response was not a list")
        return [item for item in payload if isinstance(item, dict)]


def resolve_active_issue(github: GitHubClient, bootstrap: int = BOOTSTRAP_HUB_ISSUE) -> int:
    current = int(bootstrap)
    seen: set[int] = set()
    for _ in range(MAX_CHAIN_DEPTH):
        if current in seen:
            raise RolloverError("Central Hub successor chain contains a cycle")
        seen.add(current)
        issue = github.issue(current)
        successor = successor_from_body(str(issue.get("body") or ""))
        if successor is None:
            if str(issue.get("state") or "") != "open":
                raise RolloverError(f"terminal canonical Hub #{current} is not open")
            return current
        next_issue = github.issue(successor)
        next_body = str(next_issue.get("body") or "")
        if predecessor_from_body(next_body) != current or CANONICAL_MARKER not in next_body:
            raise RolloverError(f"successor #{successor} provenance is invalid")
        current = successor
    raise RolloverError("Central Hub successor chain exceeds safety depth")


def _safe_state_lines(comments: Sequence[Mapping[str, Any]]) -> list[str]:
    found: dict[str, str] = {}
    for comment in reversed(comments):
        for raw in str(comment.get("body") or "").splitlines():
            line = raw.strip().lstrip("- ").strip()
            for key in SAFE_STATE_KEYS:
                if key in found:
                    continue
                match = re.match(rf"^{re.escape(key)}\s*[:=]\s*(.+)$", line, flags=re.I)
                if match:
                    found[key] = _safe_text(match.group(1), 240)
    return [f"- {key}: `{found[key]}`" for key in SAFE_STATE_KEYS if key in found]


def _summary_rows(comments: Sequence[Mapping[str, Any]], marker: str, keys: Sequence[str], limit: int = 10) -> list[str]:
    rows: list[str] = []
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if marker not in body:
            continue
        fields = parse_fields(body)
        selected = [f"{key}={_safe_text(fields[key], 700)}" for key in keys if fields.get(key)]
        if selected:
            rows.append(f"- comment `{_comment_id(comment)}` — " + "; ".join(selected)[:1600])
        if len(rows) >= limit:
            break
    return rows


def _lease_rows(comments: Sequence[Mapping[str, Any]], limit: int = 10) -> list[str]:
    rows: list[str] = []
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if "[LEASE]" not in body:
            continue
        values: dict[str, str] = {}
        for raw in body.splitlines():
            if "=" not in raw:
                continue
            key, value = raw.strip().split("=", 1)
            if key in SAFE_LEASE_FIELDS:
                values[key] = _safe_text(value, 800)
        selected = [f"{key}={values[key]}" for key in SAFE_LEASE_FIELDS if values.get(key)]
        if selected:
            rows.append(f"- comment `{_comment_id(comment)}` — " + "; ".join(selected)[:1600])
        if len(rows) >= limit:
            break
    return rows


def _pr_rows(pulls: Sequence[Mapping[str, Any]], limit: int = 40) -> list[str]:
    rows: list[str] = []
    for pull in sorted(pulls, key=lambda item: int(item.get("number") or 0), reverse=True)[:limit]:
        number = int(pull.get("number") or 0)
        title = _safe_text(pull.get("title"), 180)
        draft = "Draft" if bool(pull.get("draft")) else "Ready"
        head = str(((pull.get("head") or {}).get("sha") or ""))[:12]
        base = str(((pull.get("base") or {}).get("ref") or ""))
        rows.append(f"- #{number} {draft} `{head}` → `{base}` — {title}")
    return rows


def build_successor_body(
    *, predecessor: int, predecessor_comments: int, main_sha: str,
    statuses: Mapping[str, str], recent_comments: Sequence[Mapping[str, Any]],
    pulls: Sequence[Mapping[str, Any]], repository: str, now_kst: datetime,
) -> str:
    reports = _summary_rows(recent_comments, REPORT_MARKER, SAFE_REPORT_FIELDS)
    commands = _summary_rows(recent_comments, COMMAND_MARKER, SAFE_COMMAND_FIELDS)
    leases = _lease_rows(recent_comments)
    states = _safe_state_lines(recent_comments)
    prs = _pr_rows(pulls)
    ci = [f"- `{context}`: **{statuses.get(context, 'missing')}**" for context in REQUIRED_STATUS_CONTEXTS]
    body = "\n".join([
        "## 목적", "", f"이 Issue는 Central Hub **#{predecessor}의 자동 후속 Hub**다.",
        "이전 Hub는 감사 이력으로 보존하고 신규 보고·명령·스냅샷은 이 Hub에서 이어간다.", "",
        "## Automatic rollover provenance", "", f"- predecessor: #{predecessor}",
        f"- rollover time KST: {now_kst.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"- predecessor comment count: {predecessor_comments}",
        f"- processor window: {PROCESSOR_COMMENT_WINDOW}",
        f"- proactive rollover threshold: {ROLLOVER_THRESHOLD}",
        f"- GitHub hard limit: {GITHUB_COMMENT_HARD_LIMIT}",
        f"- repository: `{repository}`", f"- actual main at rollover: `{main_sha}`",
        "- control-work gate: no trusted pending report or unexpired active command existed at canonical switch",
        "- historical comments are never deleted or rewritten", "",
        "## Exact-main Required CI snapshot", "", *ci, "",
        "## Carry-forward safe state", "", *(states or ["- no whitelisted state key found in recent history"]), "",
        "## Recent leases", "", *(leases or ["- none found"]), "",
        "## Recent worker reports", "", *(reports or ["- none found"]), "",
        "## Recent command audit", "", *(commands or ["- none found"]), "",
        "## Open PR snapshot", "", *(prs or ["- none"]), "",
        "## Safety invariants", "",
        "- main/master direct modification by Agent Hub: forbidden",
        "- Required CI bypass / failed-test concealment: forbidden",
        "- Ready / merge / deploy / DB / Secret / permission changes: explicit approval required",
        "- private account/trading access and live order/cancel/amend/transfer/withdrawal: forbidden",
        "- paid AI fallback: disabled; free quota exhaustion fails closed",
        "- Production observer remains unauthenticated and read-only", "",
        "## Routing", "", f"- bootstrap Hub remains `#{BOOTSTRAP_HUB_ISSUE}`",
        "- scheduled callers follow validated predecessor/successor markers to this canonical Hub", "",
        f"<!-- agent-hub-predecessor:{predecessor} -->", CANONICAL_MARKER,
    ]).strip() + "\n"
    if len(body) > 60000:
        raise RolloverError("successor issue body exceeded safety size")
    return body


def _append_successor_marker(body: str, successor: int, now_kst: datetime) -> str:
    if successor_from_body(body) is not None:
        raise RolloverError("predecessor already has a successor")
    addition = "\n".join([
        "", "## Automatic rollover", "", f"- successor: #{successor}",
        f"- activated KST: {now_kst.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        "- predecessor is audit-only after successor verification",
        f"<!-- agent-hub-successor:{successor} -->", ARCHIVE_MARKER, "",
    ])
    result = body.rstrip() + "\n" + addition
    if len(result) > 64000:
        raise RolloverError("predecessor body lacks room for successor marker")
    return result


def _prepare_comment(active: int, count: int) -> str:
    return "\n".join([
        "[HUB_ROLLOVER_PREPARE]", "schema_version: 2", f"active_hub: #{active}",
        f"comment_count: {count}", f"processor_window: {PROCESSOR_COMMENT_WINDOW}",
        f"rollover_threshold: {ROLLOVER_THRESHOLD}", f"github_hard_limit: {GITHUB_COMMENT_HARD_LIMIT}",
        "status: preparing", "action: canonical route is unchanged; rollover remains fail-closed",
        PREPARE_MARKER,
    ])


def perform_rollover(github: GitHubClient, bootstrap: int = BOOTSTRAP_HUB_ISSUE) -> dict[str, Any]:
    active = resolve_active_issue(github, bootstrap)
    issue = github.issue(active)
    count = int(issue.get("comments") or 0)
    if count < PREPARE_THRESHOLD:
        return {"active_issue": active, "rolled_over": False, "prepared": False, "deferred": False, "comment_count": count}

    recent = github.comments(active, count, tail_only=True)
    prepared = any(PREPARE_MARKER in str(item.get("body") or "") for item in recent)
    if count < ROLLOVER_THRESHOLD:
        if not prepared:
            github.post_comment(active, _prepare_comment(active, count))
            prepared = True
        return {"active_issue": active, "rolled_over": False, "prepared": prepared, "deferred": False, "comment_count": count}

    # Fetch the full processor-visible history only at the rollover boundary.
    if count >= PROCESSOR_COMMENT_WINDOW:
        raise RolloverError("Hub reached processor comment window before a safe rollover")
    all_comments = github.comments(active, count, tail_only=False)
    pending = unresolved_control_work(all_comments)
    if pending:
        return {
            "active_issue": active, "rolled_over": False, "prepared": prepared,
            "deferred": True, "comment_count": count, "deferred_reason": ",".join(pending[:8]),
        }

    issue = github.issue(active)
    existing = successor_from_body(str(issue.get("body") or ""))
    if existing is not None:
        resolved = resolve_active_issue(github, bootstrap)
        return {"active_issue": resolved, "rolled_over": resolved != active, "prepared": True, "deferred": False, "comment_count": count}

    now_kst = datetime.now(timezone(timedelta(hours=9)))
    # Preflight marker capacity before creating a successor; avoids an orphan Hub.
    _append_successor_marker(str(issue.get("body") or ""), 999999999, now_kst)
    main_sha = github.branch_sha("main")
    statuses = github.commit_status(main_sha)
    pulls = github.open_pulls()
    labels = [str(item.get("name") or "") for item in (issue.get("labels") or []) if isinstance(item, dict) and str(item.get("name") or "")]
    if "active" not in labels:
        labels.append("active")
    successor_body = build_successor_body(
        predecessor=active, predecessor_comments=count, main_sha=main_sha,
        statuses=statuses, recent_comments=recent, pulls=pulls,
        repository=github.repository, now_kst=now_kst,
    )
    successor = github.create_issue(
        title=f"[AGENT-HUB] 중앙 명령·완료 보고 허브 — Auto Rollover {now_kst.strftime('%Y-%m-%d')}",
        body=successor_body, labels=labels,
    )
    successor_number = int(successor["number"])
    verified = github.issue(successor_number)
    verified_body = str(verified.get("body") or "")
    if predecessor_from_body(verified_body) != active or CANONICAL_MARKER not in verified_body or str(verified.get("state") or "") != "open":
        raise RolloverError("successor verification failed; predecessor remains canonical")

    predecessor_body = _append_successor_marker(str(issue.get("body") or ""), successor_number, now_kst)
    github.update_issue(active, body=predecessor_body)
    if resolve_active_issue(github, bootstrap) != successor_number:
        raise RolloverError("successor route verification failed; predecessor remains open")

    warnings: list[str] = []
    try:
        github.post_comment(successor_number, "\n".join([
            "[HUB_ROLLOVER]", "schema_version: 2", f"predecessor: #{active}",
            f"successor: #{successor_number}", f"main_sha: {main_sha}",
            f"predecessor_comment_count: {count}", "status: successor_verified",
            "pending_control_work_at_switch: 0", "production_deploy: 0", "db_mutation: 0",
            "private_api: 0", "live_trading: 0", "real_orders: 0",
        ]))
    except RolloverError:
        warnings.append("rollover_audit_comment_failed")
    try:
        github.update_issue(active, state="closed")
    except RolloverError:
        warnings.append("predecessor_close_failed")
    try:
        github.lock_issue(active)
    except RolloverError:
        warnings.append("predecessor_lock_failed")
    if warnings:
        try:
            github.post_comment(successor_number, "\n".join([
                "[HUB_ROLLOVER_WARNING]", "schema_version: 2", f"predecessor: #{active}",
                f"successor: #{successor_number}", f"warnings: {','.join(warnings)}",
                "routing_status: successor remains canonical; archival cleanup may require manual review",
            ]))
        except RolloverError:
            pass
    return {
        "active_issue": successor_number, "rolled_over": True, "prepared": True,
        "deferred": False, "comment_count": count, "predecessor": active,
        "main_sha": main_sha, "warnings": ",".join(warnings) if warnings else "none",
    }


def set_output(name: str, value: Any) -> None:
    output = os.environ.get("GITHUB_OUTPUT", "").strip()
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


class FakeGitHub:
    def __init__(self) -> None:
        self.issues = {660: {"number": 660, "body": "", "comments": 0, "state": "open"}}
    def issue(self, number: int) -> dict[str, Any]:
        return self.issues[number]


def _test_comment(cid: int, body: str, *, login: str = "github-actions[bot]", association: str = "NONE") -> dict[str, Any]:
    return {"id": cid, "body": body, "user": {"login": login}, "author_association": association}


def self_test() -> int:
    assert 0 < PREPARE_THRESHOLD < ROLLOVER_THRESHOLD < PROCESSOR_COMMENT_WINDOW < GITHUB_COMMENT_HARD_LIMIT
    assert successor_from_body("x") is None
    assert successor_from_body("<!-- agent-hub-successor:777 -->") == 777
    fake = FakeGitHub()
    assert resolve_active_issue(fake) == 660
    fake.issues[660] = {"number": 660, "body": "<!-- agent-hub-successor:777 -->", "comments": 0, "state": "closed"}
    fake.issues[777] = {"number": 777, "body": "<!-- agent-hub-predecessor:660 -->\n<!-- agent-hub-canonical:v2 -->", "comments": 0, "state": "open"}
    assert resolve_active_issue(fake) == 777

    report = _test_comment(10, "[WORKER_REPORT]\nschema_version: 2\ntask_id: demo\nroot_task_id: demo\n<!-- agent-executor-report -->")
    assert unresolved_control_work([report]) == ["pending_report:10:demo"]
    command = _test_comment(11, "[HUB_COMMAND]\nschema_version: 2\ncommand_id: hub-1-0123456789abcdef\nsource_report_comment_id: 10\nstatus: ready\nexpires_at: 2099-01-01T00:00:00Z\n<!-- agent-hub-command:hub-1-0123456789abcdef -->")
    pending = unresolved_control_work([report, command], now=datetime(2026, 8, 27, tzinfo=timezone.utc))
    assert pending == ["active_command:hub-1-0123456789abcdef:ready"]
    state = _test_comment(12, "[HUB_STATE]\ncommand_id: hub-1-0123456789abcdef\nstatus: completed")
    assert unresolved_control_work([report, command, state], now=datetime(2026, 8, 27, tzinfo=timezone.utc)) == []
    expired = _test_comment(13, "[HUB_COMMAND]\nschema_version: 2\ncommand_id: hub-2-0123456789abcdef\nsource_report_comment_id: 10\nstatus: waiting_approval\nexpires_at: 2026-08-26T00:00:00Z\n<!-- agent-hub-command:hub-2-0123456789abcdef -->")
    assert unresolved_control_work([report, expired], now=datetime(2026, 8, 27, tzinfo=timezone.utc)) == []
    assert "[REDACTED_EMAIL]" in _safe_text("contact user@example.com")
    print(json.dumps({
        "agent_hub_rollover_v2": "pass", "bootstrap": BOOTSTRAP_HUB_ISSUE,
        "prepare": PREPARE_THRESHOLD, "rollover": ROLLOVER_THRESHOLD,
        "processor_window": PROCESSOR_COMMENT_WINDOW, "hard_limit": GITHUB_COMMENT_HARD_LIMIT,
        "pending_report_guard": 1, "active_command_guard": 1,
    }))
    return 0


def _client_from_env() -> GitHubClient:
    return GitHubClient(
        os.environ.get("GITHUB_TOKEN", ""),
        os.environ.get("GITHUB_API_URL", "https://api.github.com"),
        os.environ.get("GITHUB_REPOSITORY", ""),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("resolve", "rollover", "self-test"))
    parser.add_argument("--bootstrap", type=int, default=BOOTSTRAP_HUB_ISSUE)
    args = parser.parse_args()
    if args.command == "self-test":
        return self_test()
    github = _client_from_env()
    if args.command == "resolve":
        active = resolve_active_issue(github, args.bootstrap)
        set_output("active_issue", active)
        print(json.dumps({"active_issue": active, "bootstrap": args.bootstrap}))
        return 0
    result = perform_rollover(github, args.bootstrap)
    for key, value in result.items():
        set_output(key, str(value).lower() if isinstance(value, bool) else value)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
