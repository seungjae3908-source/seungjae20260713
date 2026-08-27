#!/usr/bin/env python3
"""Resolve and proactively roll the canonical Agent Hub without losing provenance.

The bootstrap issue remains stable. Each archived Hub points to exactly one successor in
its body, so callers can resolve the current canonical Hub without rewriting repository
configuration or committing directly to main.
"""
from __future__ import annotations

import argparse
import hashlib
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
PREPARE_THRESHOLD = 2200
ROLLOVER_THRESHOLD = 2400
COMMENT_LIMIT = 2500
MAX_CHAIN_DEPTH = 32
TAIL_COMMENT_PAGES = 3
GITHUB_API_VERSION = "2022-11-28"

SUCCESSOR_RE = re.compile(r"<!--\s*agent-hub-successor:(\d+)\s*-->")
PREDECESSOR_RE = re.compile(r"<!--\s*agent-hub-predecessor:(\d+)\s*-->")
PREPARE_MARKER = "<!-- agent-hub-rollover-prepare:v2 -->"
CANONICAL_MARKER = "<!-- agent-hub-canonical:v2 -->"
ARCHIVE_MARKER = "<!-- agent-hub-archive:v2 -->"
ROLLOVER_EVENT_MARKER = "[HUB_ROLLOVER]"

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
SAFE_LEASE_FIELDS = ("OWNER", "CURRENT_MAIN", "SCOPE", "FILES", "BRANCH", "SAFETY", "NEXT")


class RolloverError(RuntimeError):
    """Fail-closed rollover or routing error."""


def _clean(value: Any, limit: int = 1200) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    return text[:limit]


def _field_lines(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in str(body or "").splitlines():
        line = raw.strip()
        if not line or line.startswith(("[", "<!--")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            fields[key] = _clean(value, 1600)
    return fields


def successor_from_body(body: str) -> int | None:
    matches = [int(value) for value in SUCCESSOR_RE.findall(str(body or ""))]
    if not matches:
        return None
    if len(set(matches)) != 1:
        raise RolloverError("multiple conflicting successor markers")
    value = matches[0]
    if value <= 0:
        raise RolloverError("invalid successor issue")
    return value


def predecessor_from_body(body: str) -> int | None:
    matches = [int(value) for value in PREDECESSOR_RE.findall(str(body or ""))]
    if not matches:
        return None
    if len(set(matches)) != 1:
        raise RolloverError("multiple conflicting predecessor markers")
    return matches[0]


class GitHubClient:
    def __init__(self, token: str, api_url: str, repository: str) -> None:
        self.token = token.strip()
        self.api_url = api_url.rstrip("/")
        self.repository = repository.strip()
        if not self.token or not self.repository:
            raise RolloverError("GITHUB_TOKEN and GITHUB_REPOSITORY are required")

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        url = path if path.startswith("http") else f"{self.api_url}{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "agent-hub-rollover-v2/1.0",
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

    def tail_comments(self, number: int, comment_count: int) -> list[dict[str, Any]]:
        if comment_count <= 0:
            return []
        last_page = max(1, math.ceil(comment_count / 100))
        first_page = max(1, last_page - TAIL_COMMENT_PAGES + 1)
        comments: list[dict[str, Any]] = []
        for page in range(first_page, last_page + 1):
            query = urlencode({"per_page": 100, "page": page})
            payload = self.request("GET", f"/repos/{self.repository}/issues/{number}/comments?{query}")
            if not isinstance(payload, list):
                raise RolloverError("issue comments response was not a list")
            comments.extend(item for item in payload if isinstance(item, dict))
        return comments

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
        payload = self.request(
            "POST",
            f"/repos/{self.repository}/issues",
            {"title": title, "body": body, "labels": list(labels)},
        )
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
            return current
        successor_issue = github.issue(successor)
        predecessor = predecessor_from_body(str(successor_issue.get("body") or ""))
        if predecessor != current:
            raise RolloverError(f"successor #{successor} does not attest predecessor #{current}")
        current = successor
    raise RolloverError("Central Hub successor chain exceeds safety depth")


def _safe_state_lines(comments: Sequence[Mapping[str, Any]]) -> list[str]:
    found: dict[str, str] = {}
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        for raw in body.splitlines():
            line = raw.strip().lstrip("- ").strip()
            for key in SAFE_STATE_KEYS:
                if key in found:
                    continue
                match = re.match(rf"^{re.escape(key)}\s*[:=]\s*(.+)$", line, flags=re.IGNORECASE)
                if match:
                    found[key] = _clean(match.group(1), 240)
        if len(found) == len(SAFE_STATE_KEYS):
            break
    return [f"- {key}: `{found[key]}`" for key in SAFE_STATE_KEYS if key in found]


def _recent_report_summaries(comments: Sequence[Mapping[str, Any]], limit: int = 10) -> list[str]:
    rows: list[str] = []
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if "[WORKER_REPORT]" not in body:
            continue
        fields = _field_lines(body)
        selected = [f"{key}={fields[key]}" for key in SAFE_REPORT_FIELDS if fields.get(key)]
        if selected:
            cid = int(comment.get("id") or 0)
            rows.append(f"- comment `{cid}` — " + "; ".join(selected)[:1600])
        if len(rows) >= limit:
            break
    return rows


def _recent_lease_summaries(comments: Sequence[Mapping[str, Any]], limit: int = 10) -> list[str]:
    rows: list[str] = []
    for comment in reversed(comments):
        body = str(comment.get("body") or "")
        if "[LEASE]" not in body:
            continue
        fields: dict[str, str] = {}
        for raw in body.splitlines():
            line = raw.strip()
            if "=" in line:
                key, value = line.split("=", 1)
                if key in SAFE_LEASE_FIELDS:
                    fields[key] = _clean(value, 800)
        selected = [f"{key}={fields[key]}" for key in SAFE_LEASE_FIELDS if fields.get(key)]
        if selected:
            cid = int(comment.get("id") or 0)
            rows.append(f"- comment `{cid}` — " + "; ".join(selected)[:1600])
        if len(rows) >= limit:
            break
    return rows


def _open_pr_rows(pulls: Sequence[Mapping[str, Any]], limit: int = 40) -> list[str]:
    rows: list[str] = []
    for pull in sorted(pulls, key=lambda item: int(item.get("number") or 0), reverse=True)[:limit]:
        number = int(pull.get("number") or 0)
        title = _clean(pull.get("title"), 180)
        draft = bool(pull.get("draft"))
        head = str(((pull.get("head") or {}).get("sha") or ""))[:12]
        base = str(((pull.get("base") or {}).get("ref") or ""))
        rows.append(f"- #{number} {'Draft' if draft else 'Ready'} `{head}` → `{base}` — {title}")
    return rows


def build_successor_body(*, predecessor: int, predecessor_comments: int, main_sha: str, statuses: Mapping[str, str], comments: Sequence[Mapping[str, Any]], pulls: Sequence[Mapping[str, Any]], repository: str, now_kst: datetime) -> str:
    status_lines = [f"- `{context}`: **{statuses.get(context, 'missing')}**" for context in REQUIRED_STATUS_CONTEXTS]
    report_rows = _recent_report_summaries(comments)
    lease_rows = _recent_lease_summaries(comments)
    state_rows = _safe_state_lines(comments)
    pr_rows = _open_pr_rows(pulls)
    body = "\n".join([
        "## 목적", "", f"이 Issue는 Central Hub **#{predecessor}의 자동 후속 Hub**다.",
        "이전 Hub의 감사 이력은 보존하고 신규 WORKER_REPORT / HUB_COMMAND / 상태 스냅샷은 이 Hub에서 이어간다.", "",
        "## Automatic rollover provenance", "", f"- predecessor: #{predecessor}",
        f"- rollover time KST: {now_kst.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"- predecessor comment count at rollover: {predecessor_comments}",
        f"- proactive threshold: {ROLLOVER_THRESHOLD} / hard limit: {COMMENT_LIMIT}",
        f"- repository: `{repository}`", f"- actual main at rollover: `{main_sha}`",
        "- reason: preserve fresh `issue_comment` triggers and append-only audit continuity before GitHub comment exhaustion",
        "- predecessor policy: close + lock only after successor verification; historical content is never deleted or rewritten", "",
        "## Exact-main Required CI snapshot", "", *status_lines, "", "## Carry-forward safe state", "",
        *(state_rows or ["- no whitelisted state key found in the retained tail window"]), "", "## Recent active leases", "",
        *(lease_rows or ["- none found in retained tail window"]), "", "## Recent worker reports", "",
        *(report_rows or ["- none found in retained tail window"]), "", "## Open PR snapshot", "",
        *(pr_rows or ["- none"]), "", "## Safety invariants", "",
        "- `main` / `master` direct modification by Agent Hub: forbidden",
        "- Required CI bypass / failed-test concealment: forbidden",
        "- Ready / merge / deploy / DB / Secret / permissions changes: explicit approval required",
        "- private account / balance / position / trading API: forbidden unless separately approved by policy",
        "- live order / cancel / amend / transfer / withdrawal: forbidden",
        "- paid AI fallback: disabled; free quota exhaustion fails closed",
        "- Production observer remains read-only and may create only bounded incident branches/Draft remediation work", "",
        "## Routing", "", f"- bootstrap Hub remains `#{BOOTSTRAP_HUB_ISSUE}`",
        "- callers resolve the canonical Hub by following validated predecessor/successor markers",
        "- a later rollover will append exactly one successor marker to this body", "",
        f"<!-- agent-hub-predecessor:{predecessor} -->", CANONICAL_MARKER,
    ]).strip() + "\n"
    if len(body) > 60000:
        raise RolloverError("successor issue body exceeded safety size")
    return body


def _append_successor_marker(body: str, successor: int, now_kst: datetime) -> str:
    if successor_from_body(body) is not None:
        raise RolloverError("predecessor already has a successor")
    addition = "\n".join(["", "## Automatic rollover", "", f"- successor: #{successor}",
        f"- activated KST: {now_kst.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        "- this predecessor is archived after successor verification", f"<!-- agent-hub-successor:{successor} -->", ARCHIVE_MARKER, ""])
    result = body.rstrip() + "\n" + addition
    if len(result) > 64000:
        raise RolloverError("predecessor body lacks room for successor marker")
    return result


def _prepare_comment(active: int, count: int) -> str:
    return "\n".join(["[HUB_ROLLOVER_PREPARE]", "schema_version: 2", f"active_hub: #{active}",
        f"comment_count: {count}", f"rollover_threshold: {ROLLOVER_THRESHOLD}", f"hard_limit: {COMMENT_LIMIT}",
        "status: preparing", "action: no route change yet; automatic successor creation remains fail-closed", PREPARE_MARKER])


def perform_rollover(github: GitHubClient, bootstrap: int = BOOTSTRAP_HUB_ISSUE) -> dict[str, Any]:
    active = resolve_active_issue(github, bootstrap)
    issue = github.issue(active)
    count = int(issue.get("comments") or 0)
    tail = github.tail_comments(active, count)
    already_prepared = any(PREPARE_MARKER in str(item.get("body") or "") for item in tail)
    if count >= PREPARE_THRESHOLD and count < ROLLOVER_THRESHOLD and not already_prepared:
        github.post_comment(active, _prepare_comment(active, count))
        return {"active_issue": active, "rolled_over": False, "prepared": True, "comment_count": count}
    if count < ROLLOVER_THRESHOLD:
        return {"active_issue": active, "rolled_over": False, "prepared": already_prepared, "comment_count": count}
    issue = github.issue(active)
    existing = successor_from_body(str(issue.get("body") or ""))
    if existing is not None:
        resolved = resolve_active_issue(github, bootstrap)
        return {"active_issue": resolved, "rolled_over": resolved != active, "prepared": True, "comment_count": count}
    main_sha = github.branch_sha("main")
    statuses = github.commit_status(main_sha)
    pulls = github.open_pulls()
    now_kst = datetime.now(timezone(timedelta(hours=9)))
    labels = [str(item.get("name") or "") for item in (issue.get("labels") or []) if isinstance(item, dict) and str(item.get("name") or "")]
    if "active" not in labels:
        labels.append("active")
    successor_body = build_successor_body(predecessor=active, predecessor_comments=count, main_sha=main_sha, statuses=statuses, comments=tail, pulls=pulls, repository=github.repository, now_kst=now_kst)
    successor = github.create_issue(title=f"[AGENT-HUB] 중앙 명령·완료 보고 허브 — Auto Rollover {now_kst.strftime('%Y-%m-%d')}", body=successor_body, labels=labels)
    successor_number = int(successor["number"])
    verified = github.issue(successor_number)
    if predecessor_from_body(str(verified.get("body") or "")) != active or CANONICAL_MARKER not in str(verified.get("body") or "") or str(verified.get("state") or "") != "open":
        raise RolloverError("successor verification failed; predecessor remains canonical")
    github.post_comment(successor_number, "\n".join([ROLLOVER_EVENT_MARKER, "schema_version: 2", f"predecessor: #{active}", f"successor: #{successor_number}", f"main_sha: {main_sha}", f"predecessor_comment_count: {count}", "status: successor_verified", "production_deploy: 0", "db_mutation: 0", "private_api: 0", "live_trading: 0", "real_orders: 0"]))
    predecessor_body = _append_successor_marker(str(issue.get("body") or ""), successor_number, now_kst)
    github.update_issue(active, body=predecessor_body)
    resolved = resolve_active_issue(github, bootstrap)
    if resolved != successor_number:
        raise RolloverError("routing verification failed; predecessor was not archived")
    github.update_issue(active, state="closed")
    try:
        github.lock_issue(active)
    except RolloverError:
        github.post_comment(successor_number, "[HUB_ROLLOVER_WARNING]\nstatus: predecessor_lock_failed\n" f"predecessor: #{active}\naction: predecessor is closed; routing remains successor #{successor_number}")
    return {"active_issue": successor_number, "rolled_over": True, "prepared": True, "comment_count": count, "predecessor": active, "main_sha": main_sha}


def set_output(name: str, value: Any) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"{name}={value}\n")


class FakeGitHub:
    def __init__(self) -> None:
        self.repository = "owner/repo"
        self.issues: dict[int, dict[str, Any]] = {660: {"number": 660, "body": "", "comments": 10, "state": "open", "labels": [{"name": "active"}]}}
    def issue(self, number: int) -> dict[str, Any]:
        return self.issues[number]


def self_test() -> int:
    assert successor_from_body("x") is None
    assert successor_from_body("<!-- agent-hub-successor:777 -->") == 777
    try:
        successor_from_body("<!-- agent-hub-successor:777 --><!-- agent-hub-successor:778 -->")
    except RolloverError:
        pass
    else:
        raise AssertionError("conflicting successor markers accepted")
    fake = FakeGitHub()
    assert resolve_active_issue(fake) == 660
    fake.issues[660]["body"] = "<!-- agent-hub-successor:777 -->"
    fake.issues[777] = {"number": 777, "body": "<!-- agent-hub-predecessor:660 -->\n<!-- agent-hub-canonical:v2 -->", "comments": 0, "state": "open", "labels": [{"name": "active"}]}
    assert resolve_active_issue(fake) == 777
    now = datetime(2026, 8, 27, 12, 0, tzinfo=timezone(timedelta(hours=9)))
    body = build_successor_body(predecessor=660, predecessor_comments=2400, main_sha="a" * 40, statuses={context: "success" for context in REQUIRED_STATUS_CONTEXTS}, comments=[], pulls=[], repository="owner/repo", now_kst=now)
    assert "<!-- agent-hub-predecessor:660 -->" in body and CANONICAL_MARKER in body
    archived = _append_successor_marker("base\n", 777, now)
    assert successor_from_body(archived) == 777 and ARCHIVE_MARKER in archived
    assert hashlib.sha256(b"dedup").hexdigest()
    print(json.dumps({"agent_hub_rollover_v2": "pass", "bootstrap": 660, "prepare": 2200, "rollover": 2400}))
    return 0


def _client_from_env() -> GitHubClient:
    return GitHubClient(os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GITHUB_API_URL", "https://api.github.com"), os.environ.get("GITHUB_REPOSITORY", ""))


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
