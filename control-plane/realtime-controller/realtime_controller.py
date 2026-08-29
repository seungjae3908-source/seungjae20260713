#!/usr/bin/env python3
"""Persistent event-driven control plane for the Central Hub.

This controller deliberately does not implement a second coding agent. It persists
GitHub event delivery state, mirrors the canonical #660 command into a SQLite master
queue, leases one executable task at a time, and wakes the existing Agent Hub Free
coordinator. The existing Agent Hub Executor remains the only coding-worker adapter.

Server installation, GitHub webhook registration, and Secret provisioning are
separate operational approval boundaries. Running this module locally or in CI does
not activate Production, trading, private provider APIs, or any order authority.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import signal
import socket
import sqlite3
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SUPPORTED_EVENTS = frozenset(
    {
        "issue_comment",
        "issues",
        "push",
        "pull_request",
        "pull_request_review",
        "workflow_run",
        "check_run",
        "check_suite",
    }
)
COMMAND_MARKER = "[COMMAND_UPDATE]"
WORKER_REPORT_MARKER = "[WORKER_REPORT]"
CENTRAL_PUBLISHER = "CENTRAL-COMMANDER"
DEFAULT_HUB_ISSUE = 660
DEFAULT_LEASE_TTL_SECONDS = 1800
DEFAULT_HEARTBEAT_SECONDS = 10
DEFAULT_PORT = 8787
MAX_BODY_BYTES = 2 * 1024 * 1024
WAKEUP_EVENT_TYPE = "agent-hub-wakeup"

TERMINAL_WORKER_STATUSES = {"completed": "COMPLETE"}
BLOCKED_WORKER_STATUSES = {
    "blocked": "BLOCKED",
    "failed": "BLOCKED",
    "waiting_approval": "BLOCKED",
}


class ControllerError(RuntimeError):
    pass


class GitHubApiError(ControllerError):
    pass


def now_epoch() -> int:
    return int(time.time())


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _kv_lines(body: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("[") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().upper()
        if key:
            values[key] = value.strip()
    return values


def _csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def task_priority(task_id: str) -> int:
    token = task_id.upper()
    if "REALTIME-CONTROLLER" in token:
        return 0
    if "#798" in token or "CONTROL-001" in token or "HUB-RECOVERY" in token:
        return 10
    if "#799" in token or "CONTROL-002" in token or "ACTIVATION-FILTER" in token:
        return 20
    if "CONTROL-003" in token or "ACTIONS-QUEUE" in token:
        return 30
    if token.startswith("P0"):
        return 40
    if token.startswith("P1"):
        return 60
    return 100


@dataclass(frozen=True)
class ParsedCommand:
    version: int
    publisher: str
    keep: tuple[str, ...]
    add: tuple[str, ...]
    complete: tuple[str, ...]
    body_sha256: str
    source_comment_id: int


@dataclass(frozen=True)
class ParsedWorkerReport:
    task_id: str
    report_status: str
    source_comment_id: int


def parse_command(body: str, *, comment_id: int = 0) -> ParsedCommand | None:
    if COMMAND_MARKER not in body:
        return None
    fields = _kv_lines(body)
    raw_version = fields.get("COMMAND_VERSION", "")
    if not raw_version.isdigit():
        return None
    publisher = fields.get("PUBLISHER", "")
    return ParsedCommand(
        version=int(raw_version),
        publisher=publisher,
        keep=_csv(fields.get("KEEP")),
        add=_csv(fields.get("ADD")),
        complete=_csv(fields.get("COMPLETE")),
        body_sha256=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        source_comment_id=comment_id,
    )


def parse_worker_report(body: str, *, comment_id: int = 0) -> ParsedWorkerReport | None:
    if WORKER_REPORT_MARKER not in body:
        return None
    fields = _kv_lines(body)
    task_id = fields.get("TASK_ID") or ""
    status = fields.get("STATUS") or ""
    if not task_id or not status:
        # schema-v2 reports often use colon-separated fields.
        colon: dict[str, str] = {}
        for raw in body.splitlines():
            line = raw.strip()
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            colon[key.strip().lower()] = value.strip()
        task_id = task_id or colon.get("task_id", "")
        status = status or colon.get("status", "")
    if not task_id or not status:
        return None
    return ParsedWorkerReport(task_id=task_id, report_status=status.lower(), source_comment_id=comment_id)


def validate_signature(secret: str, body: bytes, header: str | None) -> bool:
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


class StateStore:
    """SQLite-backed master queue and idempotency ledger."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._init_schema()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def _init_schema(self) -> None:
        with self._lock:
            self.conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS deliveries (
                    delivery_id TEXT PRIMARY KEY,
                    event_name TEXT NOT NULL,
                    payload_sha256 TEXT NOT NULL,
                    received_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    command_version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    priority INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    blocker TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS leases (
                    task_id TEXT PRIMARY KEY,
                    holder TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    heartbeat_at INTEGER NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
                );
                CREATE TABLE IF NOT EXISTS dispatches (
                    dispatch_key TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    command_version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
                );
                CREATE TABLE IF NOT EXISTS controller_lease (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    holder TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    heartbeat_at INTEGER NOT NULL
                );
                """
            )

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def get_meta(self, key: str, default: str = "") -> str:
        with self._lock:
            row = self.conn.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else default

    def record_delivery(self, delivery_id: str, event_name: str, payload: Mapping[str, Any], *, now: int | None = None) -> bool:
        timestamp = now if now is not None else now_epoch()
        digest = hashlib.sha256(json_dumps(payload).encode("utf-8")).hexdigest()
        with self._lock:
            cursor = self.conn.execute(
                "INSERT OR IGNORE INTO deliveries(delivery_id,event_name,payload_sha256,received_at) VALUES(?,?,?,?)",
                (delivery_id, event_name, digest, timestamp),
            )
        return cursor.rowcount == 1

    def apply_command(self, command: ParsedCommand, *, now: int | None = None) -> None:
        timestamp = now if now is not None else now_epoch()
        if command.publisher and command.publisher != CENTRAL_PUBLISHER:
            raise ControllerError(f"unauthorized command publisher: {command.publisher}")
        current = int(self.get_meta("command_version", "0") or 0)
        if command.version < current:
            return
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                for task_id in command.keep:
                    row = self.conn.execute("SELECT status FROM tasks WHERE task_id=?", (task_id,)).fetchone()
                    if row is None:
                        self.conn.execute(
                            "INSERT INTO tasks(task_id,command_version,status,priority,payload_json,updated_at) VALUES(?,?,?,?,?,?)",
                            (task_id, command.version, "READY", task_priority(task_id), "{}", timestamp),
                        )
                    elif row[0] not in {"COMPLETE", "BLOCKED", "DISPATCHED"}:
                        self.conn.execute(
                            "UPDATE tasks SET command_version=?,status='READY',priority=?,updated_at=? WHERE task_id=?",
                            (command.version, task_priority(task_id), timestamp, task_id),
                        )
                for task_id in command.add:
                    row = self.conn.execute("SELECT status FROM tasks WHERE task_id=?", (task_id,)).fetchone()
                    status = "READY" if row is None or row[0] != "COMPLETE" else "COMPLETE"
                    self.conn.execute(
                        """
                        INSERT INTO tasks(task_id,command_version,status,priority,payload_json,updated_at)
                        VALUES(?,?,?,?,?,?)
                        ON CONFLICT(task_id) DO UPDATE SET
                          command_version=excluded.command_version,
                          status=CASE WHEN tasks.status='COMPLETE' THEN 'COMPLETE' ELSE excluded.status END,
                          priority=excluded.priority,
                          updated_at=excluded.updated_at
                        """,
                        (task_id, command.version, status, task_priority(task_id), "{}", timestamp),
                    )
                for task_id in command.complete:
                    self.conn.execute(
                        """
                        INSERT INTO tasks(task_id,command_version,status,priority,payload_json,updated_at)
                        VALUES(?,?,?,?,?,?)
                        ON CONFLICT(task_id) DO UPDATE SET
                          command_version=excluded.command_version,status='COMPLETE',blocker='',updated_at=excluded.updated_at
                        """,
                        (task_id, command.version, "COMPLETE", task_priority(task_id), "{}", timestamp),
                    )
                    self.conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                self.conn.execute(
                    "INSERT INTO metadata(key,value) VALUES('command_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(command.version),),
                )
                self.conn.execute(
                    "INSERT INTO metadata(key,value) VALUES('command_comment_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(command.source_comment_id),),
                )
                self.conn.execute(
                    "INSERT INTO metadata(key,value) VALUES('command_body_sha256',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (command.body_sha256,),
                )
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def apply_worker_report(self, report: ParsedWorkerReport, *, now: int | None = None) -> bool:
        timestamp = now if now is not None else now_epoch()
        target = TERMINAL_WORKER_STATUSES.get(report.report_status) or BLOCKED_WORKER_STATUSES.get(report.report_status)
        if target is None:
            return False
        with self._lock:
            row = self.conn.execute("SELECT task_id FROM tasks WHERE task_id=?", (report.task_id,)).fetchone()
            if row is None:
                return False
            blocker = "" if target == "COMPLETE" else f"WORKER_REPORT:{report.report_status}"
            self.conn.execute(
                "UPDATE tasks SET status=?,blocker=?,updated_at=? WHERE task_id=?",
                (target, blocker, timestamp, report.task_id),
            )
            self.conn.execute("DELETE FROM leases WHERE task_id=?", (report.task_id,))
            self.set_meta("last_worker_report_comment_id", str(report.source_comment_id))
        return True

    def active_inflight(self, *, now: int | None = None) -> str | None:
        timestamp = now if now is not None else now_epoch()
        with self._lock:
            row = self.conn.execute(
                """
                SELECT t.task_id FROM tasks t
                JOIN leases l ON l.task_id=t.task_id
                WHERE t.status='DISPATCHED' AND l.expires_at>?
                ORDER BY l.expires_at LIMIT 1
                """,
                (timestamp,),
            ).fetchone()
        return str(row[0]) if row else None

    def block_expired_dispatches(self, *, now: int | None = None) -> int:
        """Fail closed after lease expiry instead of spawning a duplicate worker."""
        timestamp = now if now is not None else now_epoch()
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT t.task_id FROM tasks t JOIN leases l ON l.task_id=t.task_id
                WHERE t.status='DISPATCHED' AND l.expires_at<=?
                """,
                (timestamp,),
            ).fetchall()
            for row in rows:
                task_id = str(row[0])
                self.conn.execute(
                    "UPDATE tasks SET status='BLOCKED',blocker='LEASE_EXPIRED_REQUIRES_REMOTE_RECONCILE',updated_at=? WHERE task_id=?",
                    (timestamp, task_id),
                )
                self.conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
        return len(rows)

    def next_ready(self, *, now: int | None = None) -> sqlite3.Row | None:
        timestamp = now if now is not None else now_epoch()
        if self.active_inflight(now=timestamp):
            return None
        with self._lock:
            return self.conn.execute(
                "SELECT * FROM tasks WHERE status='READY' ORDER BY priority ASC, updated_at ASC, task_id ASC LIMIT 1"
            ).fetchone()

    def acquire_task_lease(self, task_id: str, holder: str, *, ttl: int = DEFAULT_LEASE_TTL_SECONDS, now: int | None = None) -> bool:
        timestamp = now if now is not None else now_epoch()
        expires = timestamp + ttl
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                existing = self.conn.execute("SELECT holder,expires_at FROM leases WHERE task_id=?", (task_id,)).fetchone()
                if existing and int(existing[1]) > timestamp and str(existing[0]) != holder:
                    self.conn.execute("ROLLBACK")
                    return False
                self.conn.execute(
                    """
                    INSERT INTO leases(task_id,holder,expires_at,heartbeat_at) VALUES(?,?,?,?)
                    ON CONFLICT(task_id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at
                    """,
                    (task_id, holder, expires, timestamp),
                )
                self.conn.execute("COMMIT")
                return True
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def mark_dispatched(self, task_id: str, holder: str, payload: Mapping[str, Any], *, now: int | None = None) -> str:
        timestamp = now if now is not None else now_epoch()
        with self._lock:
            row = self.conn.execute("SELECT command_version,status FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            if row is None:
                raise ControllerError(f"unknown task: {task_id}")
            version = int(row[0])
            dispatch_key = f"{version}:{task_id}"
            cursor = self.conn.execute(
                "INSERT OR IGNORE INTO dispatches(dispatch_key,task_id,command_version,status,created_at,payload_json) VALUES(?,?,?,?,?,?)",
                (dispatch_key, task_id, version, "SENT", timestamp, json_dumps(payload)),
            )
            if cursor.rowcount != 1:
                raise ControllerError(f"duplicate dispatch blocked: {dispatch_key}")
            self.conn.execute(
                "UPDATE tasks SET status='DISPATCHED',blocker='',updated_at=? WHERE task_id=?",
                (timestamp, task_id),
            )
            self.conn.execute(
                "UPDATE leases SET holder=?,heartbeat_at=? WHERE task_id=?",
                (holder, timestamp, task_id),
            )
        return dispatch_key

    def release_failed_dispatch(self, task_id: str, reason: str, *, now: int | None = None) -> None:
        timestamp = now if now is not None else now_epoch()
        with self._lock:
            self.conn.execute(
                "UPDATE tasks SET status='BLOCKED',blocker=?,updated_at=? WHERE task_id=?",
                (reason[:240], timestamp, task_id),
            )
            self.conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))

    def acquire_controller_lease(self, holder: str, *, ttl: int = 30, now: int | None = None) -> bool:
        timestamp = now if now is not None else now_epoch()
        expires = timestamp + ttl
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                row = self.conn.execute("SELECT holder,expires_at FROM controller_lease WHERE singleton=1").fetchone()
                if row and int(row[1]) > timestamp and str(row[0]) != holder:
                    self.conn.execute("ROLLBACK")
                    return False
                self.conn.execute(
                    """
                    INSERT INTO controller_lease(singleton,holder,expires_at,heartbeat_at) VALUES(1,?,?,?)
                    ON CONFLICT(singleton) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at
                    """,
                    (holder, expires, timestamp),
                )
                self.conn.execute("COMMIT")
                return True
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def heartbeat_controller(self, holder: str, *, ttl: int = 30, now: int | None = None) -> bool:
        timestamp = now if now is not None else now_epoch()
        with self._lock:
            cursor = self.conn.execute(
                "UPDATE controller_lease SET expires_at=?,heartbeat_at=? WHERE singleton=1 AND holder=?",
                (timestamp + ttl, timestamp, holder),
            )
        return cursor.rowcount == 1

    def task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def dispatch_count(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) FROM dispatches").fetchone()
        return int(row[0])

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            tasks = [dict(row) for row in self.conn.execute("SELECT * FROM tasks ORDER BY priority,task_id").fetchall()]
            controller = self.conn.execute("SELECT * FROM controller_lease WHERE singleton=1").fetchone()
        return {
            "commandVersion": int(self.get_meta("command_version", "0") or 0),
            "commandCommentId": int(self.get_meta("command_comment_id", "0") or 0),
            "tasks": tasks,
            "controllerLease": dict(controller) if controller else None,
            "dispatchCount": self.dispatch_count(),
        }


class GitHubClient:
    def __init__(self, repository: str, token: str, *, api_url: str = "https://api.github.com"):
        if "/" not in repository:
            raise ValueError("GITHUB_REPOSITORY must be owner/name")
        self.repository = repository
        self.token = token
        self.api_url = api_url.rstrip("/")

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        body = json_dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            self.api_url + path,
            data=body,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "investment-realtime-controller/1",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise GitHubApiError(f"GitHub {method} {path} failed: HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise GitHubApiError(f"GitHub {method} {path} transport failed: {exc.reason}") from exc
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def issue_comments(self, issue_number: int = DEFAULT_HUB_ISSUE) -> list[Mapping[str, Any]]:
        comments: list[Mapping[str, Any]] = []
        for page in range(1, 101):
            batch = self.request(
                "GET",
                f"/repos/{self.repository}/issues/{issue_number}/comments?per_page=100&page={page}",
            )
            if not isinstance(batch, list):
                raise GitHubApiError("issue comments response is not a list")
            comments.extend(item for item in batch if isinstance(item, dict))
            if len(batch) < 100:
                break
        else:
            raise GitHubApiError("hub comment pagination exceeded hard safety bound")
        return comments

    def repository_dispatch(self, event_type: str, client_payload: Mapping[str, Any]) -> None:
        self.request(
            "POST",
            f"/repos/{self.repository}/dispatches",
            {"event_type": event_type, "client_payload": dict(client_payload)},
        )


class AgentHubWakeupAdapter:
    """The controller wakes the existing coordinator; it never creates code/PRs itself."""

    def __init__(self, github: GitHubClient):
        self.github = github

    def dispatch(self, task_id: str, command_version: int, dispatch_key: str) -> Mapping[str, Any]:
        payload = {
            "source": "realtime-controller",
            "task_id": task_id,
            "command_version": command_version,
            "controller_dispatch_key": dispatch_key,
        }
        self.github.repository_dispatch(WAKEUP_EVENT_TYPE, payload)
        return payload


class Controller:
    def __init__(
        self,
        store: StateStore,
        github: Any,
        adapter: Any,
        *,
        hub_issue: int = DEFAULT_HUB_ISSUE,
        holder: str | None = None,
        lease_ttl: int = DEFAULT_LEASE_TTL_SECONDS,
    ):
        self.store = store
        self.github = github
        self.adapter = adapter
        self.hub_issue = hub_issue
        self.holder = holder or f"{socket.gethostname()}:{os.getpid()}"
        self.lease_ttl = lease_ttl

    def reconcile_remote(self) -> dict[str, Any]:
        comments = list(self.github.issue_comments(self.hub_issue))
        latest: ParsedCommand | None = None
        reports: list[ParsedWorkerReport] = []
        for comment in comments:
            body = str(comment.get("body") or "")
            comment_id = int(comment.get("id") or 0)
            parsed = parse_command(body, comment_id=comment_id)
            if parsed and (latest is None or (parsed.version, parsed.source_comment_id) > (latest.version, latest.source_comment_id)):
                latest = parsed
            report = parse_worker_report(body, comment_id=comment_id)
            if report:
                reports.append(report)
        if latest is not None:
            if latest.publisher and latest.publisher != CENTRAL_PUBLISHER:
                self.store.set_meta("control_blocker", "GOV-UNAUTHORIZED-COMMAND-PUBLISHER")
                raise ControllerError("latest command publisher is not CENTRAL-COMMANDER")
            self.store.apply_command(latest)
            self.store.set_meta("control_blocker", "")
        for report in reports:
            self.store.apply_worker_report(report)
        expired = self.store.block_expired_dispatches()
        self.store.set_meta("last_reconcile_epoch", str(now_epoch()))
        return {
            "commandVersion": int(self.store.get_meta("command_version", "0") or 0),
            "commentsExamined": len(comments),
            "reportsExamined": len(reports),
            "expiredDispatchesBlocked": expired,
        }

    def dispatch_next(self) -> dict[str, Any]:
        inflight = self.store.active_inflight()
        if inflight:
            return {"state": "WAITING_RESULT", "taskId": inflight, "dispatched": False}
        row = self.store.next_ready()
        if row is None:
            return {"state": "WAITING_EVENT", "taskId": None, "dispatched": False}
        task_id = str(row["task_id"])
        command_version = int(row["command_version"])
        if not self.store.acquire_task_lease(task_id, self.holder, ttl=self.lease_ttl):
            return {"state": "LEASE_BUSY", "taskId": task_id, "dispatched": False}
        dispatch_key = f"{command_version}:{task_id}"
        payload = {
            "source": "realtime-controller",
            "task_id": task_id,
            "command_version": command_version,
            "controller_dispatch_key": dispatch_key,
        }
        try:
            self.store.mark_dispatched(task_id, self.holder, payload)
            actual = self.adapter.dispatch(task_id, command_version, dispatch_key)
        except Exception as exc:
            self.store.release_failed_dispatch(task_id, f"DISPATCH_FAILED:{type(exc).__name__}")
            raise
        self.store.set_meta("last_dispatched_task", task_id)
        return {"state": "DISPATCHED", "taskId": task_id, "dispatchKey": dispatch_key, "payload": dict(actual), "dispatched": True}

    def run_until_blocked(self) -> dict[str, Any]:
        # Only one worker lease may be in flight. A worker result event re-enters this
        # loop and immediately dispatches the next READY task without waiting for chat.
        return self.dispatch_next()

    def process_event(self, delivery_id: str, event_name: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if event_name not in SUPPORTED_EVENTS:
            return {"accepted": False, "ignored": True, "event": event_name}
        is_new = self.store.record_delivery(delivery_id, event_name, payload)
        if not is_new:
            return {
                "accepted": True,
                "duplicate": True,
                "eventDeduped": True,
                "reconcileTriggered": False,
            }
        reconciliation = self.reconcile_remote()
        transition = self.run_until_blocked()
        self.store.set_meta("last_event", event_name)
        self.store.set_meta("last_delivery_id", delivery_id)
        return {
            "accepted": True,
            "duplicate": False,
            "eventDeduped": True,
            "reconcileTriggered": True,
            "reconciliation": reconciliation,
            "transition": transition,
        }


class ControllerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], controller: Controller, store: StateStore, webhook_secret: str):
        self.controller = controller
        self.store = store
        self.webhook_secret = webhook_secret
        super().__init__(address, ControllerHandler)


class ControllerHandler(BaseHTTPRequestHandler):
    server: ControllerHTTPServer

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        data = json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            snapshot = self.server.store.snapshot()
            self._json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "processRunning": True,
                    "commandVersion": snapshot["commandVersion"],
                    "dispatchCount": snapshot["dispatchCount"],
                    "lastEvent": self.server.store.get_meta("last_event", ""),
                },
            )
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/github/webhook":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "NOT_FOUND"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "BODY_SIZE_INVALID"})
            return
        raw = self.rfile.read(length)
        signature = self.headers.get("X-Hub-Signature-256")
        if not validate_signature(self.server.webhook_secret, raw, signature):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "signatureValid": False})
            return
        delivery_id = self.headers.get("X-GitHub-Delivery") or ""
        event_name = self.headers.get("X-GitHub-Event") or ""
        if not delivery_id:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "DELIVERY_ID_REQUIRED"})
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
            result = self.server.controller.process_event(delivery_id, event_name, payload)
        except (ValueError, ControllerError, GitHubApiError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "signatureValid": True, "error": str(exc)[:500]})
            return
        self._json(
            HTTPStatus.ACCEPTED,
            {"ok": True, "webhookReceived": True, "signatureValid": True, **result},
        )


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ControllerError(f"required environment variable missing: {name}")
    return value


def build_runtime() -> tuple[StateStore, Controller, str]:
    repository = _required_env("GITHUB_REPOSITORY")
    token = _required_env("GITHUB_TOKEN")
    webhook_secret = _required_env("GITHUB_WEBHOOK_SECRET")
    db_path = os.environ.get("CONTROLLER_DB_PATH", "/var/lib/investment-realtime-controller/controller.db")
    hub_issue = int(os.environ.get("CONTROLLER_HUB_ISSUE", str(DEFAULT_HUB_ISSUE)))
    store = StateStore(db_path)
    github = GitHubClient(repository, token)
    controller = Controller(store, github, AgentHubWakeupAdapter(github), hub_issue=hub_issue)
    return store, controller, webhook_secret


def serve() -> int:
    store, controller, webhook_secret = build_runtime()
    holder = controller.holder
    heartbeat_interval = int(os.environ.get("CONTROLLER_HEARTBEAT_SECONDS", str(DEFAULT_HEARTBEAT_SECONDS)))
    lease_ttl = max(heartbeat_interval * 3, 30)
    if not store.acquire_controller_lease(holder, ttl=lease_ttl):
        raise ControllerError("another realtime controller holds the persistent controller lease")

    stop = threading.Event()

    def heartbeat() -> None:
        while not stop.wait(heartbeat_interval):
            if not store.heartbeat_controller(holder, ttl=lease_ttl):
                stop.set()
                return

    thread = threading.Thread(target=heartbeat, name="controller-heartbeat", daemon=True)
    thread.start()

    # Event-loss reconciliation and READY queue dispatch happen before the server waits.
    controller.reconcile_remote()
    controller.run_until_blocked()

    host = os.environ.get("CONTROLLER_BIND", "127.0.0.1")
    port = int(os.environ.get("CONTROLLER_PORT", str(DEFAULT_PORT)))
    server = ControllerHTTPServer((host, port), controller, store, webhook_secret)

    def shutdown(*_: Any) -> None:
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        stop.set()
        server.server_close()
        store.close()
    return 0


def reconcile_once() -> int:
    store, controller, _ = build_runtime()
    try:
        result = controller.reconcile_remote()
        transition = controller.run_until_blocked()
        print(json.dumps({"reconciliation": result, "transition": transition, "snapshot": store.snapshot()}, indent=2))
    finally:
        store.close()
    return 0


def status_once() -> int:
    db_path = os.environ.get("CONTROLLER_DB_PATH", "/var/lib/investment-realtime-controller/controller.db")
    store = StateStore(db_path)
    try:
        print(json.dumps(store.snapshot(), indent=2))
    finally:
        store.close()
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent Agent Hub realtime controller")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve")
    sub.add_parser("reconcile")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    if args.command == "serve":
        return serve()
    if args.command == "reconcile":
        return reconcile_once()
    return status_once()


if __name__ == "__main__":
    raise SystemExit(main())
