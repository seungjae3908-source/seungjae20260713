#!/usr/bin/env python3
"""Persistent, event-driven, fail-closed Agent Hub controller.

This daemon does not execute natural-language GitHub content and does not automate
web ChatGPT.  It treats GitHub as an untrusted event source, persists operational
state locally, and only wakes the repository's existing deterministic Agent Hub
coordinator/executor after strict validation.

Runtime activation, webhook registration, secrets, server configuration, Production
operations, private trading APIs, and financial actions are intentionally outside
this module.
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import hmac
import json
import os
import random
import re
import signal
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONTROLLER_VERSION = "1.0.0"
GITHUB_API_VERSION = "2022-11-28"
DEFAULT_HUB_ISSUE = 660
DEFAULT_RECONCILE_SECONDS = 30.0
MAX_WEBHOOK_BYTES = 2 * 1024 * 1024
MAX_EVENT_TYPE_LENGTH = 80
MAX_DELIVERY_ID_LENGTH = 160
MAX_TASK_ATTEMPTS = 3
LEASE_SECONDS = 300
HEARTBEAT_STALE_SECONDS = 180
CIRCUIT_FAILURE_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECONDS = 120

CONTROLLER_STATES = {
    "BOOTING", "RUNNING", "RECONCILING", "DISPATCHING", "WAITING_EVENT",
    "DEGRADED", "SHUTTING_DOWN", "ERROR",
}
TASK_STATES = {
    "DISCOVERED", "PENDING", "READY", "CLAIMED", "IN_PROGRESS", "WAITING_CI",
    "WAITING_DEPENDENCY", "BLOCKED", "VERIFYING", "COMPLETED", "FAILED",
    "CANCELLED", "SUPERSEDED",
}
WORKER_STATES = {"AVAILABLE", "ACTIVE", "WAITING_CI", "BLOCKED", "STALE", "DEAD", "DRAINING"}
ALLOWED_EVENTS = {
    "issue_comment", "issues", "push", "pull_request", "pull_request_review",
    "pull_request_review_comment", "workflow_run", "check_run", "check_suite",
}
COMMAND_MARKER = "[COMMAND_UPDATE]"
HUB_COMMAND_MARKER = "[HUB_COMMAND]"
WORKER_REPORT_MARKER = "[WORKER_REPORT]"
AUTHORIZED_PUBLISHER = "CENTRAL-COMMANDER"
COMMAND_HEADER_KEYS = {
    "COMMAND_VERSION", "SUPERSEDES", "PUBLISHER", "COMMAND_PUBLISHER", "REASON",
    "LATEST_MAIN", "PRIORITY", "KEEP", "ADD", "CANCEL", "COMPLETE", "MASTER_TASK_SET",
    "P0_TASKS", "P1_TASKS", "P2_TASKS", "P3_TASKS",
}
COMMAND_REQUIRED_KEYS = {"COMMAND_VERSION", "SUPERSEDES", "LATEST_MAIN", "MASTER_TASK_SET"}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#-]{0,179}$")
DELIVERY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")

SAFE_TASK_TYPES = {
    "CI_DIAGNOSIS", "PR_ALIGNMENT", "FORWARD_DIAGNOSTIC", "CODE_REMEDIATION",
    "RUNTIME_VERIFY", "CONTROL_PLANE_REMEDIATION",
}
FORBIDDEN_ACTION_FRAGMENTS = {
    "production_deploy", "production_activation", "live_trading", "real_order",
    "place_order", "cancel_order", "amend_order", "transfer", "withdraw",
    "private_trading", "secret_rotation", "destructive_migration",
}
TERMINAL_TASK_STATES = {"COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"}


class ControllerError(RuntimeError):
    """Expected fail-closed controller error."""


class ValidationError(ControllerError):
    """Untrusted event or command failed validation."""


class SafetyError(ControllerError):
    """Requested transition exceeds the controller safety boundary."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def csv_items(value: str | None) -> list[str]:
    text = str(value or "").strip()
    if not text or text.upper() in {"NONE", "[]"}:
        return []
    items = [item.strip() for item in re.split(r"[,;]", text) if item.strip()]
    result: list[str] = []
    for item in items:
        if not TASK_ID_RE.fullmatch(item):
            raise ValidationError(f"invalid task id: {item[:80]}")
        if item not in result:
            result.append(item)
    return result


def infer_priority(task_id: str) -> str:
    upper = task_id.upper()
    if upper.startswith("P0") or upper.startswith("GOV-") or upper.startswith("CONTROL-"):
        return "P0"
    if upper.startswith("P1"):
        return "P1"
    if upper.startswith("P2"):
        return "P2"
    if upper.startswith("P3"):
        return "P3"
    if any(token in upper for token in ("FULL-COST", "NATURAL-LIFECYCLE", "REALTIME-CONTROLLER")):
        return "P0"
    if any(token in upper for token in ("SETTLEMENT", "SHADOW", "ACCOUNT", "TELEGRAM")):
        return "P1"
    return "P2"


def priority_rank(priority: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get(priority, 9)


def task_type_for(task_id: str) -> str:
    upper = task_id.upper()
    if "CONTROL" in upper or "GOV" in upper:
        return "CONTROL_PLANE_REMEDIATION"
    if "CI" in upper:
        return "CI_DIAGNOSIS"
    if "FORWARD" in upper:
        return "FORWARD_DIAGNOSTIC"
    return "CODE_REMEDIATION"


def paths_overlap(left: Sequence[str], right: Sequence[str]) -> bool:
    for a in left:
        for b in right:
            if a == b or fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a):
                return True
    return False


def parse_colon_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current = ""
    buf: list[str] = []

    def flush() -> None:
        nonlocal current, buf
        if current:
            fields[current] = "\n".join(buf).strip()
        current = ""
        buf = []

    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith("[") or stripped.startswith("<!--"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", stripped)
        if match:
            flush()
            current = match.group(1).lower()
            buf = [match.group(2)]
        elif current and stripped:
            buf.append(stripped)
    flush()
    return fields


@dataclass(frozen=True)
class CommandUpdate:
    version: int
    supersedes: str
    publisher: str
    latest_main: str
    priority: str
    add: tuple[str, ...]
    cancel: tuple[str, ...]
    complete: tuple[str, ...]
    master: tuple[str, ...]
    explicit_priorities: Mapping[str, str]
    comment_id: int
    actor: str


def parse_command_update(body: str, *, comment_id: int, actor: str, authorized_actors: set[str]) -> CommandUpdate:
    if body.count(COMMAND_MARKER) != 1:
        raise ValidationError("command marker must appear exactly once")
    if actor not in authorized_actors:
        raise ValidationError("command actor is not authorized")
    lines = body.replace("\r\n", "\n").split("\n")
    try:
        marker_index = next(index for index, value in enumerate(lines) if value.strip() == COMMAND_MARKER)
    except StopIteration as exc:
        raise ValidationError("command marker must occupy its own line") from exc
    fields: dict[str, str] = {}
    for raw in lines[marker_index + 1:]:
        line = raw.strip()
        if not line:
            break
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if not match:
            raise ValidationError("command header contains non-machine-readable content")
        key, value = match.group(1), match.group(2).strip()
        if key not in COMMAND_HEADER_KEYS:
            raise ValidationError(f"unsupported command header key: {key}")
        if key in fields:
            raise ValidationError(f"duplicate command header key: {key}")
        fields[key] = value
    missing = sorted(COMMAND_REQUIRED_KEYS - fields.keys())
    if missing:
        raise ValidationError("command header missing: " + ",".join(missing))
    publisher = fields.get("PUBLISHER") or fields.get("COMMAND_PUBLISHER") or ""
    if publisher != AUTHORIZED_PUBLISHER:
        raise ValidationError("command publisher is not CENTRAL-COMMANDER")
    version_raw = fields["COMMAND_VERSION"]
    if not version_raw.isdigit() or int(version_raw) <= 0:
        raise ValidationError("invalid command version")
    main_sha = fields["LATEST_MAIN"].lower()
    if not SHA_RE.fullmatch(main_sha):
        raise ValidationError("command LATEST_MAIN is not a full SHA")
    explicit: dict[str, str] = {}
    for priority in ("P0", "P1", "P2", "P3"):
        for task_id in csv_items(fields.get(f"{priority}_TASKS")):
            explicit[task_id] = priority
    return CommandUpdate(
        version=int(version_raw),
        supersedes=fields["SUPERSEDES"],
        publisher=publisher,
        latest_main=main_sha,
        priority=fields.get("PRIORITY", ""),
        add=tuple(csv_items(fields.get("ADD"))),
        cancel=tuple(csv_items(fields.get("CANCEL"))),
        complete=tuple(csv_items(fields.get("COMPLETE"))),
        master=tuple(csv_items(fields.get("MASTER_TASK_SET"))),
        explicit_priorities=explicit,
        comment_id=comment_id,
        actor=actor,
    )


class PersistentStore:
    """SQLite operational store; independent of application/financial databases."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextlib.contextmanager
    def connection(self) -> Iterable[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(
                  delivery_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload_digest TEXT NOT NULL,
                  received_at TEXT NOT NULL, processed_at TEXT, status TEXT NOT NULL, error TEXT
                );
                CREATE TABLE IF NOT EXISTS tasks(
                  task_id TEXT PRIMARY KEY, priority TEXT NOT NULL, area TEXT NOT NULL,
                  command_version INTEGER NOT NULL, task_type TEXT NOT NULL, owner_worker TEXT,
                  lease_id TEXT, dependencies TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]',
                  pr TEXT, branch TEXT, head_sha TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                  blocked_by TEXT, success_criteria TEXT, last_update TEXT NOT NULL, next_action TEXT,
                  hub_command_id TEXT, loop_detected INTEGER NOT NULL DEFAULT 0, last_error_digest TEXT,
                  same_error_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS workers(
                  worker_id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, status TEXT NOT NULL,
                  current_task TEXT, lease_id TEXT, pr TEXT, head_sha TEXT, owned_files TEXT NOT NULL DEFAULT '[]',
                  command_version INTEGER NOT NULL DEFAULT 0, last_heartbeat TEXT, last_progress TEXT,
                  attempts INTEGER NOT NULL DEFAULT 0, blocked_by TEXT
                );
                CREATE TABLE IF NOT EXISTS leases(
                  lease_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, files TEXT NOT NULL,
                  acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                  status TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(task_id)
                );
                CREATE INDEX IF NOT EXISTS leases_status_expiry ON leases(status, expires_at);
                CREATE TABLE IF NOT EXISTS errors(
                  error_id TEXT PRIMARY KEY, component TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
                  digest TEXT NOT NULL, event_id TEXT, task_id TEXT, worker_id TEXT, first_seen TEXT NOT NULL,
                  last_seen TEXT NOT NULL, retry_count INTEGER NOT NULL, root_cause TEXT, recovery TEXT, status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS checkpoints(
                  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, state_json TEXT NOT NULL
                );
                """
            )
            self.set_meta("controller_version", CONTROLLER_VERSION, db=db)
            if self.get_meta("controller_state", db=db) is None:
                self.set_meta("controller_state", "BOOTING", db=db)
            if self.get_meta("command_version", db=db) is None:
                self.set_meta("command_version", "0", db=db)

    def set_meta(self, key: str, value: str, *, db: sqlite3.Connection | None = None) -> None:
        own = db is None
        connection = db or self._connect()
        try:
            connection.execute(
                "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, str(value), utc_now()),
            )
        finally:
            if own:
                connection.close()

    def get_meta(self, key: str, *, db: sqlite3.Connection | None = None) -> str | None:
        own = db is None
        connection = db or self._connect()
        try:
            row = connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return str(row[0]) if row else None
        finally:
            if own:
                connection.close()

    def set_controller_state(self, state: str) -> None:
        if state not in CONTROLLER_STATES:
            raise ControllerError(f"invalid controller state: {state}")
        self.set_meta("controller_state", state)

    def accept_event(self, delivery_id: str, event_type: str, payload_digest: str) -> bool:
        with self.connection() as db:
            try:
                db.execute(
                    "INSERT INTO events(delivery_id,event_type,payload_digest,received_at,status) VALUES(?,?,?,?,?)",
                    (delivery_id, event_type, payload_digest, utc_now(), "RECEIVED"),
                )
                return True
            except sqlite3.IntegrityError:
                return False

    def finish_event(self, delivery_id: str, status: str, error: str | None = None) -> None:
        with self.connection() as db:
            db.execute(
                "UPDATE events SET processed_at=?,status=?,error=? WHERE delivery_id=?",
                (utc_now(), status, (error or "")[:1000] or None, delivery_id),
            )

    def upsert_task(
        self,
        task_id: str,
        *,
        priority: str,
        command_version: int,
        status: str = "PENDING",
        task_type: str | None = None,
        area: str = "CONTROL_PLANE",
        dependencies: Sequence[str] = (),
        files: Sequence[str] = (),
        next_action: str = "await_hub_command_or_reconcile",
    ) -> None:
        if status not in TASK_STATES:
            raise ControllerError("invalid task status")
        task_type = task_type or task_type_for(task_id)
        if task_type not in SAFE_TASK_TYPES:
            raise SafetyError("task type is not registered")
        now = utc_now()
        with self.connection() as db:
            db.execute(
                """
                INSERT INTO tasks(task_id,priority,area,command_version,task_type,dependencies,files,status,last_update,next_action)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(task_id) DO UPDATE SET
                  priority=excluded.priority,
                  command_version=MAX(tasks.command_version,excluded.command_version),
                  dependencies=CASE WHEN excluded.dependencies='[]' THEN tasks.dependencies ELSE excluded.dependencies END,
                  files=CASE WHEN excluded.files='[]' THEN tasks.files ELSE excluded.files END,
                  status=CASE WHEN tasks.status IN ('COMPLETED','CANCELLED','SUPERSEDED') THEN tasks.status ELSE excluded.status END,
                  last_update=excluded.last_update,
                  next_action=excluded.next_action
                """,
                (task_id, priority, area, command_version, task_type, json_dumps(list(dependencies)), json_dumps(list(files)), status, now, next_action),
            )

    def task(self, task_id: str) -> dict[str, Any] | None:
        with self.connection() as db:
            row = db.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            return dict(row) if row else None

    def set_task_status(self, task_id: str, status: str, *, next_action: str | None = None, blocked_by: str | None = None) -> None:
        if status not in TASK_STATES:
            raise ControllerError("invalid task status")
        with self.connection() as db:
            db.execute(
                "UPDATE tasks SET status=?,next_action=COALESCE(?,next_action),blocked_by=?,last_update=? WHERE task_id=?",
                (status, next_action, blocked_by, utc_now(), task_id),
            )

    def attach_hub_command(self, task_id: str, *, command_id: str, worker_id: str, files: Sequence[str], branch: str | None, head_sha: str | None) -> None:
        with self.connection() as db:
            db.execute(
                "UPDATE tasks SET hub_command_id=?,owner_worker=?,files=?,branch=COALESCE(?,branch),head_sha=COALESCE(?,head_sha),status='READY',next_action='dispatch_existing_agent_hub_executor',last_update=? WHERE task_id=? AND status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED')",
                (command_id, worker_id, json_dumps(list(files)), branch, head_sha, utc_now(), task_id),
            )

    def apply_command(self, command: CommandUpdate) -> None:
        current = int(self.get_meta("command_version") or "0")
        if command.version < current:
            return
        if command.version == current:
            stored_comment = self.get_meta("command_comment_id")
            if stored_comment and int(stored_comment) != command.comment_id:
                raise ValidationError("same command version arrived from a different comment")
            return
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for task_id in command.master:
                priority = command.explicit_priorities.get(task_id, infer_priority(task_id))
                existing = db.execute("SELECT status FROM tasks WHERE task_id=?", (task_id,)).fetchone()
                if existing and str(existing[0]) in {"COMPLETED", "CANCELLED", "SUPERSEDED"}:
                    continue
                status = "READY" if task_id in command.add else "PENDING"
                db.execute(
                    """
                    INSERT INTO tasks(task_id,priority,area,command_version,task_type,status,last_update,next_action)
                    VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(task_id) DO UPDATE SET priority=excluded.priority,command_version=excluded.command_version,
                      status=CASE WHEN tasks.status IN ('COMPLETED','CANCELLED','SUPERSEDED') THEN tasks.status ELSE excluded.status END,
                      last_update=excluded.last_update,next_action=excluded.next_action
                    """,
                    (task_id, priority, "CONTROL_PLANE" if "CONTROL" in task_id.upper() or "GOV" in task_id.upper() or "REALTIME" in task_id.upper() else "APP", command.version, task_type_for(task_id), status, utc_now(), "await_hub_command_or_reconcile"),
                )
            for task_id in command.complete:
                db.execute("UPDATE tasks SET status='COMPLETED',next_action='none',last_update=? WHERE task_id=?", (utc_now(), task_id))
            for task_id in command.cancel:
                db.execute("UPDATE tasks SET status='CANCELLED',next_action='none',last_update=? WHERE task_id=? AND status!='COMPLETED'", (utc_now(), task_id))
            self.set_meta("command_version", str(command.version), db=db)
            self.set_meta("command_comment_id", str(command.comment_id), db=db)
            self.set_meta("command_main_sha", command.latest_main, db=db)
            self.set_meta("command_supersedes", command.supersedes, db=db)
            db.execute("COMMIT")

    def register_worker(self, worker_id: str, capabilities: Sequence[str]) -> None:
        with self.connection() as db:
            db.execute(
                """
                INSERT INTO workers(worker_id,capabilities,status,last_heartbeat,last_progress)
                VALUES(?,?, 'AVAILABLE',?,?)
                ON CONFLICT(worker_id) DO UPDATE SET capabilities=excluded.capabilities
                """,
                (worker_id, json_dumps(list(capabilities)), utc_now(), utc_now()),
            )

    def heartbeat(self, worker_id: str, *, task_id: str | None = None, progress: bool = False) -> None:
        now = utc_now()
        with self.connection() as db:
            db.execute(
                "UPDATE workers SET last_heartbeat=?,last_progress=CASE WHEN ? THEN ? ELSE last_progress END,current_task=COALESCE(?,current_task) WHERE worker_id=?",
                (now, 1 if progress else 0, now, task_id, worker_id),
            )
            if task_id:
                lease = db.execute("SELECT lease_id FROM leases WHERE task_id=? AND worker_id=? AND status='ACTIVE'", (task_id, worker_id)).fetchone()
                if lease:
                    epoch = int(time.time())
                    db.execute("UPDATE leases SET heartbeat_at=?,expires_at=? WHERE lease_id=?", (epoch, epoch + LEASE_SECONDS, str(lease[0])))

    def acquire_lease(self, task_id: str, worker_id: str, files: Sequence[str]) -> str | None:
        epoch = int(time.time())
        lease_id = "lease-" + sha256_text(f"{task_id}|{worker_id}|{epoch}|{random.random()}")[:20]
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            task = db.execute("SELECT status,attempts FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            if not task or str(task[0]) != "READY" or int(task[1]) >= MAX_TASK_ATTEMPTS:
                db.execute("ROLLBACK")
                return None
            active = db.execute("SELECT task_id,files FROM leases WHERE status='ACTIVE' AND expires_at>?", (epoch,)).fetchall()
            for row in active:
                if str(row[0]) == task_id or paths_overlap(list(files), json.loads(str(row[1]) or "[]")):
                    db.execute("ROLLBACK")
                    return None
            db.execute(
                "INSERT INTO leases(lease_id,task_id,worker_id,files,acquired_at,heartbeat_at,expires_at,status) VALUES(?,?,?,?,?,?,?,'ACTIVE')",
                (lease_id, task_id, worker_id, json_dumps(list(files)), epoch, epoch, epoch + LEASE_SECONDS),
            )
            db.execute("UPDATE tasks SET status='CLAIMED',owner_worker=?,lease_id=?,attempts=attempts+1,last_update=?,next_action='dispatch' WHERE task_id=?", (worker_id, lease_id, utc_now(), task_id))
            db.execute("UPDATE workers SET status='ACTIVE',current_task=?,lease_id=?,owned_files=?,last_heartbeat=?,last_progress=? WHERE worker_id=?", (task_id, lease_id, json_dumps(list(files)), utc_now(), utc_now(), worker_id))
            db.execute("COMMIT")
        return lease_id

    def release_lease(self, task_id: str, *, final_worker_state: str = "AVAILABLE") -> None:
        with self.connection() as db:
            row = db.execute("SELECT lease_id,worker_id FROM leases WHERE task_id=? AND status='ACTIVE'", (task_id,)).fetchone()
            if not row:
                return
            lease_id, worker_id = str(row[0]), str(row[1])
            db.execute("UPDATE leases SET status='RELEASED' WHERE lease_id=?", (lease_id,))
            db.execute("UPDATE workers SET status=?,current_task=NULL,lease_id=NULL,owned_files='[]' WHERE worker_id=?", (final_worker_state, worker_id))
            db.execute("UPDATE tasks SET lease_id=NULL WHERE task_id=?", (task_id,))

    def recover_expired_leases(self) -> list[str]:
        epoch = int(time.time())
        recovered: list[str] = []
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT lease_id,task_id,worker_id FROM leases WHERE status='ACTIVE' AND expires_at<=?", (epoch,)).fetchall()
            for row in rows:
                lease_id, task_id, worker_id = map(str, row)
                db.execute("UPDATE leases SET status='EXPIRED' WHERE lease_id=?", (lease_id,))
                db.execute("UPDATE workers SET status='STALE',lease_id=NULL,current_task=NULL,owned_files='[]' WHERE worker_id=?", (worker_id,))
                task = db.execute("SELECT attempts FROM tasks WHERE task_id=?", (task_id,)).fetchone()
                status = "BLOCKED" if task and int(task[0]) >= MAX_TASK_ATTEMPTS else "READY"
                db.execute("UPDATE tasks SET status=?,lease_id=NULL,blocked_by=?,next_action=?,last_update=? WHERE task_id=?", (status, "LEASE_EXPIRED" if status == "BLOCKED" else None, "manual_escalation" if status == "BLOCKED" else "recover_and_redispatch", utc_now(), task_id))
                recovered.append(task_id)
            db.execute("COMMIT")
        return recovered

    def record_task_failure(self, task_id: str, message: str) -> None:
        digest = sha256_text(message)[:24]
        with self.connection() as db:
            row = db.execute("SELECT last_error_digest,same_error_count,attempts FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            if not row:
                return
            same = int(row[1]) + 1 if str(row[0] or "") == digest else 1
            loop = same >= 2
            status = "BLOCKED" if loop or int(row[2]) >= MAX_TASK_ATTEMPTS else "FAILED"
            db.execute("UPDATE tasks SET status=?,last_error_digest=?,same_error_count=?,loop_detected=?,blocked_by=?,next_action=?,last_update=? WHERE task_id=?", (status, digest, same, 1 if loop else 0, "LOOP_DETECTED" if loop else None, "root_cause_escalation" if loop else "diagnose_failure", utc_now(), task_id))
        self.release_lease(task_id, final_worker_state="BLOCKED" if loop else "AVAILABLE")

    def ready_tasks(self) -> list[dict[str, Any]]:
        with self.connection() as db:
            rows = db.execute("SELECT * FROM tasks WHERE status='READY' ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,last_update,task_id").fetchall()
            return [dict(row) for row in rows]

    def dependencies_satisfied(self, task: Mapping[str, Any]) -> bool:
        dependencies = json.loads(str(task.get("dependencies") or "[]"))
        if not dependencies:
            return True
        with self.connection() as db:
            for dependency in dependencies:
                row = db.execute("SELECT status FROM tasks WHERE task_id=?", (dependency,)).fetchone()
                if not row or str(row[0]) != "COMPLETED":
                    return False
        return True

    def dependency_cycles(self) -> list[list[str]]:
        with self.connection() as db:
            rows = db.execute("SELECT task_id,dependencies FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED')").fetchall()
        graph = {str(row[0]): list(json.loads(str(row[1]) or "[]")) for row in rows}
        cycles: list[list[str]] = []
        visiting: list[str] = []
        visited: set[str] = set()

        def visit(node: str) -> None:
            if node in visiting:
                index = visiting.index(node)
                cycles.append(visiting[index:] + [node])
                return
            if node in visited or node not in graph:
                return
            visiting.append(node)
            for child in graph[node]:
                visit(child)
            visiting.pop()
            visited.add(node)

        for node in graph:
            visit(node)
        return cycles

    def status_snapshot(self) -> dict[str, Any]:
        with self.connection() as db:
            counts = {row[0]: int(row[1]) for row in db.execute("SELECT priority,COUNT(*) FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED') GROUP BY priority")}
            states = {row[0]: int(row[1]) for row in db.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status")}
            workers = {row[0]: int(row[1]) for row in db.execute("SELECT status,COUNT(*) FROM workers GROUP BY status")}
            leases = int(db.execute("SELECT COUNT(*) FROM leases WHERE status='ACTIVE' AND expires_at>?", (int(time.time()),)).fetchone()[0])
            duplicate_events = int(db.execute("SELECT COUNT(*) FROM events WHERE status='DUPLICATE'").fetchone()[0])
        return {
            "controller_version": CONTROLLER_VERSION,
            "controller_state": self.get_meta("controller_state") or "ERROR",
            "command_version": int(self.get_meta("command_version") or "0"),
            "latest_main": self.get_meta("latest_main") or "unknown",
            "last_reconcile_at": self.get_meta("last_reconcile_at") or "never",
            "queue_depth_by_priority": {priority: counts.get(priority, 0) for priority in ("P0", "P1", "P2", "P3")},
            "task_states": states,
            "worker_states": workers,
            "active_leases": leases,
            "duplicate_events": duplicate_events,
            "safety": {
                "LIVE_TRADING": False,
                "executionAuthority": "NONE",
                "REAL_ORDER_ALLOWED": False,
                "PRIVATE_TRADING_API_ALLOWED": False,
                "realOrders": 0,
            },
        }

    def checkpoint(self) -> dict[str, Any]:
        state = self.status_snapshot()
        with self.connection() as db:
            db.execute("INSERT INTO checkpoints(created_at,state_json) VALUES(?,?)", (utc_now(), json_dumps(state)))
        return state


class GitHubClient:
    def __init__(self, *, repository: str, token: str, api_url: str = "https://api.github.com") -> None:
        self.repository = repository
        self.token = token.strip()
        self.api_url = api_url.rstrip("/")
        if not self.token:
            raise ControllerError("GITHUB_TOKEN is required for runtime reconciliation")

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        url = path if path.startswith("http") else f"{self.api_url}{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": f"investment-realtime-controller/{CONTROLLER_VERSION}",
        }
        data = None
        if payload is not None:
            data = json_dumps(dict(payload)).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            with urlopen(Request(url, data=data, headers=headers, method=method), timeout=30) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ControllerError(f"GitHub HTTP {exc.code}: {detail[:800]}") from exc
        except (URLError, json.JSONDecodeError) as exc:
            raise ControllerError(f"GitHub request failed: {exc}") from exc

    def repository_default_branch_sha(self) -> str:
        payload = self.request("GET", f"/repos/{self.repository}/branches/main")
        sha = str(((payload or {}).get("commit") or {}).get("sha") or "").lower()
        if not SHA_RE.fullmatch(sha):
            raise ControllerError("cannot resolve exact main SHA")
        return sha

    def issue_comment_count(self, issue_number: int) -> int:
        payload = self.request("GET", f"/repos/{self.repository}/issues/{issue_number}")
        return int((payload or {}).get("comments") or 0)

    def issue_comment_tail(self, issue_number: int, window: int = 500) -> list[dict[str, Any]]:
        total = self.issue_comment_count(issue_number)
        if total <= 0:
            return []
        per_page = 100
        first_offset = max(0, total - max(1, window))
        first_page = first_offset // per_page + 1
        last_page = (total - 1) // per_page + 1
        comments: list[dict[str, Any]] = []
        for page in range(first_page, last_page + 1):
            query = urlencode({"per_page": per_page, "page": page})
            payload = self.request("GET", f"/repos/{self.repository}/issues/{issue_number}/comments?{query}")
            if not isinstance(payload, list):
                raise ControllerError("issue comment page is not a list")
            comments.extend(item for item in payload if isinstance(item, dict))
        return comments[-window:]

    def workflow_run(self, run_id: int) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}/actions/runs/{run_id}")
        if not isinstance(payload, dict):
            raise ControllerError("workflow run response is invalid")
        return payload

    def dispatch(self, event_type: str, payload: Mapping[str, Any]) -> None:
        self.request("POST", f"/repos/{self.repository}/dispatches", {"event_type": event_type, "client_payload": dict(payload)})


class RepositoryDispatchWorkerAdapter:
    """Wakes existing Agent Hub workflows; never executes issue text as code."""

    def __init__(self, github: GitHubClient) -> None:
        self.github = github

    def start_task(self, task: Mapping[str, Any]) -> None:
        command_id = str(task.get("hub_command_id") or "")
        if not command_id:
            raise ControllerError("task has no validated HUB_COMMAND to execute")
        action = str(task.get("next_action") or "")
        if any(fragment in action.casefold() for fragment in FORBIDDEN_ACTION_FRAGMENTS):
            raise SafetyError("forbidden action requested")
        self.github.dispatch(
            "agent-hub-command-ready",
            {"source": "realtime-controller", "task_id": str(task["task_id"]), "hub_command_id": command_id},
        )

    def wake_coordinator(self, *, report_comment_id: int) -> None:
        self.github.dispatch("agent-executor-report-ready", {"source": "realtime-controller", "report_comment_id": report_comment_id})


class RealtimeController:
    def __init__(
        self,
        *,
        store: PersistentStore,
        repository: str,
        webhook_secret: str,
        authorized_commanders: set[str],
        github: GitHubClient | None = None,
        worker_adapter: RepositoryDispatchWorkerAdapter | Any | None = None,
        hub_issue: int = DEFAULT_HUB_ISSUE,
        controller_enabled: bool = True,
        dispatch_enabled: bool = True,
        ai_workers_enabled: bool = True,
    ) -> None:
        self.store = store
        self.repository = repository
        self.webhook_secret = webhook_secret.encode("utf-8")
        self.authorized_commanders = set(authorized_commanders)
        self.github = github
        self.worker_adapter = worker_adapter or (RepositoryDispatchWorkerAdapter(github) if github else None)
        self.hub_issue = hub_issue
        self.controller_enabled = controller_enabled
        self.dispatch_enabled = dispatch_enabled
        self.ai_workers_enabled = ai_workers_enabled
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._consecutive_external_failures = 0
        self._circuit_open_until = 0.0
        self.store.set_controller_state("BOOTING")

    def verify_signature(self, raw_body: bytes, signature: str) -> None:
        if not self.webhook_secret:
            raise ValidationError("webhook secret is not configured")
        if not signature.startswith("sha256=") or len(signature) != 71:
            raise ValidationError("invalid webhook signature format")
        expected = "sha256=" + hmac.new(self.webhook_secret, raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValidationError("webhook signature mismatch")

    def ingest_webhook(self, *, event_type: str, delivery_id: str, signature: str, raw_body: bytes) -> dict[str, Any]:
        if event_type not in ALLOWED_EVENTS or len(event_type) > MAX_EVENT_TYPE_LENGTH:
            raise ValidationError("event type is not allowlisted")
        if not DELIVERY_RE.fullmatch(delivery_id) or len(delivery_id) > MAX_DELIVERY_ID_LENGTH:
            raise ValidationError("delivery id is invalid")
        if len(raw_body) > MAX_WEBHOOK_BYTES:
            raise ValidationError("webhook payload exceeds limit")
        self.verify_signature(raw_body, signature)
        digest = hashlib.sha256(raw_body).hexdigest()
        if not self.store.accept_event(delivery_id, event_type, digest):
            return {"accepted": False, "duplicate": True}
        try:
            payload = json.loads(raw_body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValidationError("webhook body must be an object")
            repo_name = str(((payload.get("repository") or {}).get("full_name") or ""))
            if repo_name != self.repository:
                raise ValidationError("repository identity mismatch")
            self._process_event(event_type, payload)
            self.store.finish_event(delivery_id, "PROCESSED")
            self._wake.set()
            return {"accepted": True, "duplicate": False}
        except Exception as exc:
            self.store.finish_event(delivery_id, "REJECTED", str(exc))
            raise

    def _process_event(self, event_type: str, payload: Mapping[str, Any]) -> None:
        if event_type == "issue_comment":
            issue_number = int(((payload.get("issue") or {}).get("number") or 0))
            if issue_number != self.hub_issue:
                return
            action = str(payload.get("action") or "")
            if action not in {"created", "edited"}:
                return
            comment = payload.get("comment") or {}
            if not isinstance(comment, Mapping):
                raise ValidationError("comment payload invalid")
            body = str(comment.get("body") or "")
            comment_id = int(comment.get("id") or 0)
            actor = str(((comment.get("user") or {}).get("login") or ""))
            if COMMAND_MARKER in body:
                command = parse_command_update(body, comment_id=comment_id, actor=actor, authorized_actors=self.authorized_commanders)
                self.store.apply_command(command)
            elif HUB_COMMAND_MARKER in body:
                self._ingest_hub_command(body)
            elif WORKER_REPORT_MARKER in body:
                self._ingest_worker_report(body, comment_id=comment_id)
        elif event_type in {"workflow_run", "check_run", "check_suite"}:
            self._ingest_ci_event(event_type, payload)

    def _ingest_hub_command(self, body: str) -> None:
        fields = parse_colon_fields(body)
        task_id = fields.get("source_task_id", "").strip()
        command_id = fields.get("command_id", "").strip()
        worker = fields.get("target_worker", "").strip()
        status = fields.get("status", "").strip().lower()
        execution_mode = fields.get("execution_mode", "").strip().lower()
        action_type = fields.get("action_type", "").strip().lower()
        if not TASK_ID_RE.fullmatch(task_id) or not command_id or status != "ready":
            return
        if execution_mode not in {"read_only", "code_change"}:
            return
        if any(fragment in action_type for fragment in FORBIDDEN_ACTION_FRAGMENTS):
            raise SafetyError("HUB_COMMAND requests a forbidden action")
        files = [item.strip() for item in re.split(r"[,;|\n]", fields.get("allowed_paths", "")) if item.strip() and item.strip().lower() != "none"]
        task = self.store.task(task_id)
        if not task:
            self.store.upsert_task(task_id, priority=infer_priority(task_id), command_version=int(self.store.get_meta("command_version") or "0"), status="PENDING")
        self.store.attach_hub_command(
            task_id,
            command_id=command_id,
            worker_id=worker or "agent-hub-validation",
            files=files,
            branch=fields.get("work_branch") or fields.get("target_branch") or None,
            head_sha=fields.get("expected_head_sha") if SHA_RE.fullmatch(fields.get("expected_head_sha", "")) else None,
        )

    def _ingest_worker_report(self, body: str, *, comment_id: int) -> None:
        fields = parse_colon_fields(body)
        task_id = (fields.get("root_task_id") or fields.get("task_id") or "").strip()
        if not TASK_ID_RE.fullmatch(task_id):
            return
        status = fields.get("status", "").strip().lower()
        head_sha = fields.get("head_sha", "").strip().lower()
        run_id = fields.get("ci_run_id", "").strip()
        task = self.store.task(task_id)
        if not task:
            return
        if status == "completed":
            if self.github is None or not run_id.isdigit() or not SHA_RE.fullmatch(head_sha):
                self.store.set_task_status(task_id, "VERIFYING", next_action="verify_ci_and_success_criteria")
                return
            run = self.github.workflow_run(int(run_id))
            if str(run.get("head_sha") or "").lower() != head_sha:
                self.store.record_task_failure(task_id, "worker report CI SHA mismatch")
                return
            if str(run.get("status") or "") == "completed" and str(run.get("conclusion") or "") in {"success", "neutral", "skipped"}:
                self.store.set_task_status(task_id, "COMPLETED", next_action="reconcile_next_task")
                self.store.release_lease(task_id)
            else:
                self.store.record_task_failure(task_id, f"worker report CI not successful: {run.get('status')}/{run.get('conclusion')}")
        elif status in {"failed", "blocked", "stale", "expired"}:
            self.store.record_task_failure(task_id, f"worker report status={status}")
        else:
            self.store.set_task_status(task_id, "VERIFYING", next_action="verify_worker_report")
        if self.worker_adapter and comment_id > 0 and status in {"completed", "failed", "blocked"}:
            # Existing coordinator remains authoritative for its own command/report lifecycle.
            self.worker_adapter.wake_coordinator(report_comment_id=comment_id)

    def _ingest_ci_event(self, event_type: str, payload: Mapping[str, Any]) -> None:
        obj = payload.get(event_type) or payload.get(event_type.replace("_", "")) or {}
        if not isinstance(obj, Mapping):
            return
        head_sha = str(obj.get("head_sha") or ((obj.get("check_suite") or {}).get("head_sha") if isinstance(obj.get("check_suite"), Mapping) else "") or "").lower()
        if not SHA_RE.fullmatch(head_sha):
            return
        status = str(obj.get("status") or "").lower()
        conclusion = str(obj.get("conclusion") or "").lower()
        with self.store.connection() as db:
            rows = db.execute("SELECT task_id,status FROM tasks WHERE head_sha=? AND status IN ('CLAIMED','IN_PROGRESS','WAITING_CI','VERIFYING')", (head_sha,)).fetchall()
        for row in rows:
            task_id = str(row[0])
            if status != "completed":
                self.store.set_task_status(task_id, "WAITING_CI", next_action="await_ci_terminal_event")
            elif conclusion in {"success", "neutral", "skipped"}:
                self.store.set_task_status(task_id, "VERIFYING", next_action="verify_worker_report_and_success_criteria")
            elif conclusion in {"failure", "cancelled", "timed_out", "action_required", "startup_failure"}:
                self.store.record_task_failure(task_id, f"{event_type}:{conclusion}")

    def reconcile(self) -> dict[str, Any]:
        if not self.controller_enabled:
            self.store.set_controller_state("WAITING_EVENT")
            return self.store.checkpoint()
        if self.github is None:
            self.store.set_controller_state("DEGRADED")
            self.store.set_meta("last_reconcile_at", utc_now())
            return self.store.checkpoint()
        if time.time() < self._circuit_open_until:
            self.store.set_controller_state("DEGRADED")
            return self.store.checkpoint()
        self.store.set_controller_state("RECONCILING")
        try:
            main_sha = self.github.repository_default_branch_sha()
            self.store.set_meta("latest_main", main_sha)
            comments = self.github.issue_comment_tail(self.hub_issue, window=500)
            valid_commands: list[CommandUpdate] = []
            for comment in comments:
                body = str(comment.get("body") or "")
                if COMMAND_MARKER not in body:
                    continue
                try:
                    valid_commands.append(
                        parse_command_update(
                            body,
                            comment_id=int(comment.get("id") or 0),
                            actor=str(((comment.get("user") or {}).get("login") or "")),
                            authorized_actors=self.authorized_commanders,
                        )
                    )
                except ValidationError:
                    continue
            if valid_commands:
                highest_version = max(item.version for item in valid_commands)
                candidates = [item for item in valid_commands if item.version == highest_version]
                if len(candidates) != 1:
                    raise ValidationError("ambiguous highest COMMAND_VERSION")
                latest = candidates[0]
                if latest.latest_main != main_sha:
                    self.store.set_meta("command_main_drift", f"{latest.latest_main}->{main_sha}")
                self.store.apply_command(latest)
            for comment in comments:
                body = str(comment.get("body") or "")
                if HUB_COMMAND_MARKER in body:
                    self._ingest_hub_command(body)
            cycles = self.store.dependency_cycles()
            if cycles:
                for cycle in cycles:
                    for task_id in set(cycle):
                        self.store.set_task_status(task_id, "BLOCKED", next_action="dependency_cycle_escalation", blocked_by="DEPENDENCY_CYCLE")
            self.store.recover_expired_leases()
            self._consecutive_external_failures = 0
            self.store.set_meta("last_reconcile_at", utc_now())
            self.store.set_controller_state("RUNNING")
            self.dispatch_next()
            self.store.set_controller_state("WAITING_EVENT")
            return self.store.checkpoint()
        except Exception as exc:
            self._consecutive_external_failures += 1
            if self._consecutive_external_failures >= CIRCUIT_FAILURE_THRESHOLD:
                self._circuit_open_until = time.time() + CIRCUIT_COOLDOWN_SECONDS
                self.store.set_controller_state("DEGRADED")
            else:
                self.store.set_controller_state("ERROR")
            self.store.set_meta("last_reconcile_error", str(exc)[:1000])
            self.store.set_meta("last_reconcile_at", utc_now())
            raise

    def dispatch_next(self) -> str | None:
        if not (self.controller_enabled and self.dispatch_enabled and self.ai_workers_enabled):
            return None
        if self.worker_adapter is None:
            return None
        self.store.set_controller_state("DISPATCHING")
        for task in self.store.ready_tasks():
            if int(task.get("loop_detected") or 0):
                continue
            if not self.store.dependencies_satisfied(task):
                self.store.set_task_status(str(task["task_id"]), "WAITING_DEPENDENCY", next_action="await_dependencies")
                continue
            if not task.get("hub_command_id"):
                self.store.set_task_status(str(task["task_id"]), "PENDING", next_action="await_validated_hub_command")
                continue
            worker_id = str(task.get("owner_worker") or "agent-hub-validation")
            self.store.register_worker(worker_id, [str(task.get("task_type") or "CODE_REMEDIATION")])
            files = list(json.loads(str(task.get("files") or "[]")))
            lease_id = self.store.acquire_lease(str(task["task_id"]), worker_id, files)
            if not lease_id:
                continue
            try:
                self.worker_adapter.start_task(self.store.task(str(task["task_id"])) or task)
                self.store.set_task_status(str(task["task_id"]), "IN_PROGRESS", next_action="await_worker_or_ci_event")
                self.store.heartbeat(worker_id, task_id=str(task["task_id"]), progress=True)
                return str(task["task_id"])
            except Exception as exc:
                self.store.record_task_failure(str(task["task_id"]), f"dispatch failure: {exc}")
                continue
        return None

    def stop(self) -> None:
        self.store.set_controller_state("SHUTTING_DOWN")
        self._stop.set()
        self._wake.set()

    def run_loop(self, reconcile_seconds: float = DEFAULT_RECONCILE_SECONDS) -> None:
        self.store.set_controller_state("RUNNING")
        while not self._stop.is_set():
            try:
                self.reconcile()
            except Exception:
                pass
            self._wake.wait(timeout=max(5.0, reconcile_seconds))
            self._wake.clear()


class ControllerHTTPHandler(BaseHTTPRequestHandler):
    server_version = "InvestmentRealtimeController/1.0"

    @property
    def controller(self) -> RealtimeController:
        return getattr(self.server, "controller")  # type: ignore[no-any-return]

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep server logs concise and never log request bodies, signatures, or tokens.
        print(json_dumps({"timestamp": utc_now(), "component": "http", "message": fmt % args}))

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        raw = json_dumps(dict(payload)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health/live":
            state = self.controller.store.get_meta("controller_state") or "ERROR"
            self._json(HTTPStatus.OK if state not in {"ERROR", "SHUTTING_DOWN"} else HTTPStatus.SERVICE_UNAVAILABLE, {"live": state not in {"ERROR", "SHUTTING_DOWN"}, "state": state})
            return
        if self.path == "/health/ready":
            state = self.controller.store.get_meta("controller_state") or "ERROR"
            ready = state in {"RUNNING", "WAITING_EVENT", "RECONCILING", "DISPATCHING"} and bool(self.controller.webhook_secret)
            self._json(HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE, {"ready": ready, "state": state})
            return
        if self.path == "/status":
            self._json(HTTPStatus.OK, self.controller.store.status_snapshot())
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/github/webhook":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0 or length > MAX_WEBHOOK_BYTES:
                raise ValidationError("invalid content length")
            raw = self.rfile.read(length)
            result = self.controller.ingest_webhook(
                event_type=str(self.headers.get("X-GitHub-Event") or ""),
                delivery_id=str(self.headers.get("X-GitHub-Delivery") or ""),
                signature=str(self.headers.get("X-Hub-Signature-256") or ""),
                raw_body=raw,
            )
            self._json(HTTPStatus.ACCEPTED if result.get("accepted") else HTTPStatus.OK, result)
        except ValidationError as exc:
            self._json(HTTPStatus.UNAUTHORIZED, {"accepted": False, "error": str(exc)})
        except SafetyError as exc:
            self._json(HTTPStatus.FORBIDDEN, {"accepted": False, "error": str(exc)})
        except Exception as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"accepted": False, "error": str(exc)[:300]})


def load_authorized_commanders(policy_path: Path) -> set[str]:
    try:
        payload = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControllerError(f"cannot load Agent Hub policy: {exc}") from exc
    candidates = payload.get("allowed_command_authors") or payload.get("central_commander_logins") or []
    if not isinstance(candidates, list) or not candidates or any(not isinstance(item, str) for item in candidates):
        raise ControllerError("Agent Hub policy has no authorized command authors")
    return {item.strip() for item in candidates if item.strip()}


def load_worker_registry(store: PersistentStore, workers_path: Path) -> None:
    try:
        payload = json.loads(workers_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControllerError(f"cannot load Agent Hub worker registry: {exc}") from exc
    values = payload.get("workers") if isinstance(payload, dict) else payload
    if isinstance(values, dict):
        iterable = values.values()
    elif isinstance(values, list):
        iterable = values
    else:
        raise ControllerError("worker registry shape is invalid")
    for value in iterable:
        if not isinstance(value, Mapping):
            continue
        worker_id = str(value.get("worker_id") or value.get("id") or "").strip()
        if not worker_id:
            continue
        raw_caps = value.get("allowed_action_types") or value.get("capabilities") or []
        caps = [str(item) for item in raw_caps] if isinstance(raw_caps, list) else []
        store.register_worker(worker_id, caps)


def build_controller_from_env() -> RealtimeController:
    repository = os.environ.get("CONTROLLER_REPOSITORY", "seungjae3908-source/seungjae20260713").strip()
    db_path = os.environ.get("CONTROLLER_DB_PATH", "/var/lib/investment-realtime-controller/controller.sqlite3")
    repo_root = Path(os.environ.get("CONTROLLER_REPO_ROOT", Path(__file__).resolve().parents[2]))
    store = PersistentStore(db_path)
    authorized = load_authorized_commanders(repo_root / ".github" / "agent-hub" / "policy.json")
    load_worker_registry(store, repo_root / ".github" / "agent-hub" / "workers.json")
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    github = GitHubClient(repository=repository, token=token) if token else None
    controller = RealtimeController(
        store=store,
        repository=repository,
        webhook_secret=os.environ.get("GITHUB_WEBHOOK_SECRET", ""),
        authorized_commanders=authorized,
        github=github,
        hub_issue=int(os.environ.get("CONTROLLER_HUB_ISSUE", str(DEFAULT_HUB_ISSUE))),
        controller_enabled=os.environ.get("CONTROLLER_ENABLED", "true").lower() == "true",
        dispatch_enabled=os.environ.get("DISPATCH_ENABLED", "false").lower() == "true",
        ai_workers_enabled=os.environ.get("AI_WORKERS_ENABLED", "false").lower() == "true",
    )
    return controller


def serve(controller: RealtimeController, host: str, port: int, reconcile_seconds: float) -> None:
    server = ThreadingHTTPServer((host, port), ControllerHTTPHandler)
    setattr(server, "controller", controller)
    loop_thread = threading.Thread(target=controller.run_loop, args=(reconcile_seconds,), name="controller-reconciler", daemon=True)
    loop_thread.start()

    def shutdown(_signum: int, _frame: Any) -> None:
        controller.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        controller.stop()
        loop_thread.join(timeout=10)
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Persistent realtime Agent Hub controller")
    parser.add_argument("--host", default=os.environ.get("CONTROLLER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CONTROLLER_PORT", "8765")))
    parser.add_argument("--reconcile-seconds", type=float, default=float(os.environ.get("CONTROLLER_RECONCILE_SECONDS", str(DEFAULT_RECONCILE_SECONDS))))
    parser.add_argument("--once", action="store_true", help="run one reconciliation cycle and exit")
    args = parser.parse_args()
    controller = build_controller_from_env()
    if args.once:
        try:
            print(json_dumps(controller.reconcile()))
            return 0
        except Exception as exc:
            print(json_dumps({"status": "error", "error": str(exc)[:500]}))
            return 1
    serve(controller, args.host, args.port, args.reconcile_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
