#!/usr/bin/env python3
"""Persistent event-driven controller for the existing Agent Hub.

The controller is deliberately a control-plane adapter, not a second coding agent.
GitHub content is untrusted. Only signed, deduplicated webhook events and strictly
validated machine-readable commands can alter operational state. Actual coding is
left to the existing Agent Hub coordinator/executor workflows.

This module contains no Production deployment, trading, private-provider, order,
transfer, withdrawal, secret-rotation, or destructive database adapter.
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import hmac
import json
import os
import re
import signal
import sqlite3
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONTROLLER_VERSION = "1.1.0"
DEFAULT_HUB_ISSUE = 660
DEFAULT_PORT = 8787
DEFAULT_RECONCILE_SECONDS = 30.0
DEFAULT_LEASE_SECONDS = 300
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_COMMENT_WINDOW = 1000
MAX_RETRIES = 3
CIRCUIT_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECONDS = 120

SUPPORTED_EVENTS = frozenset({
    "issue_comment",
    "issues",
    "push",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
    "check_run",
    "check_suite",
})
AUTHORIZED_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
COMMAND_MARKER = "[COMMAND_UPDATE]"
HUB_COMMAND_MARKER = "[HUB_COMMAND]"
WORKER_REPORT_MARKER = "[WORKER_REPORT]"
CENTRAL_PUBLISHER = "CENTRAL-COMMANDER"
COORDINATOR_WAKE_EVENT = "agent-executor-report-ready"
EXECUTOR_EVENT = "agent-hub-command-ready"
COMMAND_KEYS = frozenset({
    "COMMAND_VERSION", "SUPERSEDES", "PUBLISHER", "COMMAND_PUBLISHER", "REASON",
    "LATEST_MAIN", "PRIORITY", "KEEP", "ADD", "CANCEL", "COMPLETE", "MASTER_TASK_SET",
    "P0_TASKS", "P1_TASKS", "P2_TASKS", "P3_TASKS",
})
COMMAND_REQUIRED = frozenset({"COMMAND_VERSION", "SUPERSEDES", "LATEST_MAIN", "MASTER_TASK_SET"})
TERMINAL_TASK_STATES = frozenset({"COMPLETED", "CANCELLED", "SUPERSEDED"})
TASK_STATES = frozenset({
    "DISCOVERED", "PENDING", "READY", "CLAIMED", "IN_PROGRESS", "WAITING_CI",
    "WAITING_DEPENDENCY", "BLOCKED", "VERIFYING", "COMPLETED", "FAILED",
    "CANCELLED", "SUPERSEDED",
})
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#-]{0,179}$")
REF_RE = re.compile(r"^(?:#[1-9][0-9]*|[A-Za-z0-9][A-Za-z0-9._:#-]{0,179})$")
DELIVERY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
HUB_COMMAND_ID_RE = re.compile(r"^hub-[0-9]+-[0-9a-f]{16}$")
FORBIDDEN_TEXT = (
    "production_deploy", "production_activation", "live_trading", "private_trading",
    "place_order", "submit_order", "cancel_order", "amend_order", "withdraw", "transfer",
    "secret_rotation", "destructive_migration",
)


class ControllerError(RuntimeError):
    pass


class ValidationError(ControllerError):
    pass


class SafetyError(ControllerError):
    pass


def now_epoch() -> int:
    return int(time.time())


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _split_csv(value: str | None) -> list[str]:
    text = str(value or "").strip()
    if not text or text.upper() in {"NONE", "[]"}:
        return []
    return [part.strip() for part in re.split(r"[,;]", text) if part.strip()]


def _task_csv(value: str | None) -> tuple[str, ...]:
    result: list[str] = []
    for item in _split_csv(value):
        if not TASK_RE.fullmatch(item):
            raise ValidationError(f"invalid task id: {item[:80]}")
        if item not in result:
            result.append(item)
    return tuple(result)


def _reference_csv(value: str | None) -> tuple[str, ...]:
    result: list[str] = []
    for item in _split_csv(value):
        if not REF_RE.fullmatch(item):
            raise ValidationError(f"invalid task/PR reference: {item[:80]}")
        if item not in result:
            result.append(item)
    return tuple(result)


def task_priority(task_id: str) -> str:
    token = task_id.upper()
    if token.startswith(("P0", "GOV-", "CONTROL-")) or "REALTIME-CONTROLLER" in token or "FULL-COST" in token:
        return "P0"
    if token.startswith("P1") or any(x in token for x in ("SHADOW", "SETTLEMENT", "ACCOUNT", "TELEGRAM")):
        return "P1"
    if token.startswith("P3"):
        return "P3"
    return "P2"


def priority_rank(priority: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get(priority, 9)


def path_conflict(left: Sequence[str], right: Sequence[str]) -> bool:
    if not left or not right:
        return True
    return any(a == b or fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a) for a in left for b in right)


def parse_colon_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("[") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        if re.fullmatch(r"[a-z_][a-z0-9_]*", key):
            fields[key] = value.strip()
    return fields


@dataclass(frozen=True)
class ParsedCommand:
    version: int
    supersedes: str
    publisher: str
    latest_main: str
    keep: tuple[str, ...]
    add: tuple[str, ...]
    cancel: tuple[str, ...]
    complete: tuple[str, ...]
    master: tuple[str, ...]
    explicit_priorities: Mapping[str, str]
    source_comment_id: int
    body_sha256: str
    actor: str


@dataclass(frozen=True)
class ParsedHubCommand:
    task_id: str
    command_id: str
    worker_id: str
    files: tuple[str, ...]
    branch: str | None
    expected_head_sha: str | None
    source_comment_id: int


@dataclass(frozen=True)
class ParsedWorkerReport:
    task_id: str
    worker_id: str
    report_status: str
    head_sha: str | None
    pr_number: int | None
    ci_run_id: int | None
    source_comment_id: int


def parse_command(body: str, *, comment_id: int, actor: str, authorized_commanders: set[str]) -> ParsedCommand | None:
    if COMMAND_MARKER not in body:
        return None
    if body.count(COMMAND_MARKER) != 1 or actor not in authorized_commanders:
        raise ValidationError("command marker/actor is not authorized")
    lines = body.replace("\r\n", "\n").split("\n")
    marker_positions = [i for i, line in enumerate(lines) if line.strip() == COMMAND_MARKER]
    if len(marker_positions) != 1:
        raise ValidationError("COMMAND_UPDATE must occupy exactly one line")
    fields: dict[str, str] = {}
    for raw in lines[marker_positions[0] + 1:]:
        line = raw.strip()
        if not line:
            break
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if not match:
            raise ValidationError("command header is not machine-readable")
        key, value = match.group(1), match.group(2).strip()
        if key not in COMMAND_KEYS or key in fields:
            raise ValidationError(f"unsupported/duplicate command key: {key}")
        fields[key] = value
    missing = sorted(COMMAND_REQUIRED - fields.keys())
    if missing:
        raise ValidationError("command missing required keys: " + ",".join(missing))
    publisher = fields.get("PUBLISHER") or fields.get("COMMAND_PUBLISHER") or ""
    if publisher != CENTRAL_PUBLISHER:
        raise ValidationError("publisher is not CENTRAL-COMMANDER")
    raw_version = fields["COMMAND_VERSION"]
    if not raw_version.isdigit() or int(raw_version) <= 0:
        raise ValidationError("invalid COMMAND_VERSION")
    latest_main = fields["LATEST_MAIN"].lower()
    if not SHA_RE.fullmatch(latest_main):
        raise ValidationError("LATEST_MAIN is not a full SHA")
    master = _task_csv(fields.get("MASTER_TASK_SET"))
    if not master:
        raise ValidationError("MASTER_TASK_SET is empty")
    explicit: dict[str, str] = {}
    for priority in ("P0", "P1", "P2", "P3"):
        for task_id in _task_csv(fields.get(f"{priority}_TASKS")):
            explicit[task_id] = priority
    return ParsedCommand(
        version=int(raw_version), supersedes=fields["SUPERSEDES"], publisher=publisher,
        latest_main=latest_main, keep=_reference_csv(fields.get("KEEP")), add=_task_csv(fields.get("ADD")),
        cancel=_task_csv(fields.get("CANCEL")), complete=_reference_csv(fields.get("COMPLETE")), master=master,
        explicit_priorities=explicit, source_comment_id=comment_id, body_sha256=sha256_text(body), actor=actor,
    )


def parse_hub_command(body: str, *, comment_id: int) -> ParsedHubCommand | None:
    if HUB_COMMAND_MARKER not in body:
        return None
    fields = parse_colon_fields(body)
    task_id = fields.get("source_task_id", "")
    command_id = fields.get("command_id", "")
    status = fields.get("status", "").lower()
    mode = fields.get("execution_mode", "").lower()
    action = fields.get("action_type", "").lower()
    if not TASK_RE.fullmatch(task_id) or not HUB_COMMAND_ID_RE.fullmatch(command_id):
        return None
    if status != "ready" or mode not in {"read_only", "code_change"}:
        return None
    if any(fragment in action for fragment in FORBIDDEN_TEXT):
        raise SafetyError("HUB_COMMAND requests forbidden operation")
    files = tuple(item.strip() for item in re.split(r"[,;|]", fields.get("allowed_paths", "")) if item.strip() and item.strip().lower() != "none")
    expected = fields.get("expected_head_sha", "").lower()
    return ParsedHubCommand(task_id, command_id, fields.get("target_worker", "") or "agent-hub-validation", files,
                            fields.get("work_branch") or fields.get("target_branch") or None,
                            expected if SHA_RE.fullmatch(expected) else None, comment_id)


def parse_worker_report(body: str, *, comment_id: int) -> ParsedWorkerReport | None:
    if WORKER_REPORT_MARKER not in body:
        return None
    fields = parse_colon_fields(body)
    task_id = fields.get("root_task_id") or fields.get("task_id") or ""
    status = fields.get("status", "").lower()
    if not TASK_RE.fullmatch(task_id) or not status:
        return None
    head = fields.get("head_sha", "").lower()
    pr_raw = fields.get("pr_number", "").lstrip("#")
    run_raw = fields.get("ci_run_id", "")
    return ParsedWorkerReport(task_id, fields.get("worker", "") or fields.get("worker_id", "") or "unknown", status,
                              head if SHA_RE.fullmatch(head) else None,
                              int(pr_raw) if pr_raw.isdigit() else None,
                              int(run_raw) if run_raw.isdigit() else None, comment_id)


def validate_signature(secret: str, body: bytes, header: str | None) -> bool:
    if not secret or not header or not header.startswith("sha256=") or len(header) != 71:
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


class StateStore:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        return db

    @contextlib.contextmanager
    def connection(self) -> Iterable[sqlite3.Connection]:
        db = self._connect()
        try:
            yield db
        finally:
            db.close()

    def _init_schema(self) -> None:
        with self.connection() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS deliveries(delivery_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,payload_sha256 TEXT NOT NULL,received_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
            CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,priority TEXT NOT NULL,area TEXT NOT NULL DEFAULT 'UNKNOWN',command_version INTEGER NOT NULL,status TEXT NOT NULL,owner_worker TEXT,lease_id TEXT,dependencies TEXT NOT NULL DEFAULT '[]',files TEXT NOT NULL DEFAULT '[]',pr INTEGER,branch TEXT,head_sha TEXT,hub_command_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,blocked_by TEXT,success_criteria TEXT,last_update TEXT NOT NULL,next_action TEXT,last_error_digest TEXT,same_error_count INTEGER NOT NULL DEFAULT 0,loop_detected INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS workers(worker_id TEXT PRIMARY KEY,capabilities TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL,current_task TEXT,lease_id TEXT,pr INTEGER,head_sha TEXT,owned_files TEXT NOT NULL DEFAULT '[]',command_version INTEGER NOT NULL DEFAULT 0,last_heartbeat TEXT,last_progress TEXT,attempts INTEGER NOT NULL DEFAULT 0,blocked_by TEXT);
            CREATE TABLE IF NOT EXISTS leases(lease_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,worker_id TEXT NOT NULL,files TEXT NOT NULL,acquired_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS dispatches(dispatch_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,event_type TEXT NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS errors(error_id TEXT PRIMARY KEY,component TEXT NOT NULL,severity TEXT NOT NULL,message TEXT NOT NULL,digest TEXT NOT NULL,event_id TEXT,task_id TEXT,worker_id TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,retry_count INTEGER NOT NULL DEFAULT 0,root_cause TEXT,recovery TEXT,status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,state_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS lease_active_idx ON leases(status,expires_at);
            """)
            self.set_meta("controller_version", CONTROLLER_VERSION, db=db)
            if self.get_meta("controller_state", db=db) is None: self.set_meta("controller_state", "BOOTING", db=db)
            if self.get_meta("command_version", db=db) is None: self.set_meta("command_version", "0", db=db)

    def get_meta(self, key: str, default: str | None = None, *, db: sqlite3.Connection | None = None) -> str | None:
        own = db is None; conn = db or self._connect()
        try:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return str(row[0]) if row else default
        finally:
            if own: conn.close()

    def set_meta(self, key: str, value: str, *, db: sqlite3.Connection | None = None) -> None:
        own = db is None; conn = db or self._connect()
        try:
            conn.execute("INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (key, str(value), utc_now()))
        finally:
            if own: conn.close()

    def accept_delivery(self, delivery_id: str, event_type: str, digest: str) -> bool:
        with self.connection() as db:
            try:
                db.execute("INSERT INTO deliveries(delivery_id,event_type,payload_sha256,received_at,status) VALUES(?,?,?,?,?)", (delivery_id,event_type,digest,utc_now(),"RECEIVED")); return True
            except sqlite3.IntegrityError: return False

    def finish_delivery(self, delivery_id: str, status: str, error: str | None = None) -> None:
        with self.connection() as db: db.execute("UPDATE deliveries SET status=?,error=? WHERE delivery_id=?", (status,(error or "")[:800] or None,delivery_id))

    def upsert_task(self, task_id: str, priority: str, command_version: int, status: str = "PENDING") -> None:
        with self.connection() as db:
            db.execute("""INSERT INTO tasks(task_id,priority,command_version,status,last_update,next_action) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET priority=excluded.priority,command_version=MAX(tasks.command_version,excluded.command_version),status=CASE WHEN tasks.status IN ('COMPLETED','CANCELLED','SUPERSEDED') THEN tasks.status ELSE excluded.status END,last_update=excluded.last_update,next_action=excluded.next_action""", (task_id,priority,command_version,status,utc_now(),"await_reconcile"))

    def task(self, task_id: str) -> dict[str, Any] | None:
        with self.connection() as db:
            row=db.execute("SELECT * FROM tasks WHERE task_id=?",(task_id,)).fetchone(); return dict(row) if row else None

    def set_task(self, task_id: str, status: str, *, next_action: str | None=None, blocked_by: str | None=None) -> None:
        if status not in TASK_STATES: raise ControllerError("invalid task state")
        with self.connection() as db: db.execute("UPDATE tasks SET status=?,next_action=COALESCE(?,next_action),blocked_by=?,last_update=? WHERE task_id=?",(status,next_action,blocked_by,utc_now(),task_id))

    def apply_command(self, command: ParsedCommand) -> None:
        current=int(self.get_meta("command_version","0") or 0)
        if command.version < current: return
        if command.version == current:
            stored_comment=self.get_meta("command_comment_id"); stored_digest=self.get_meta("command_digest")
            if stored_comment and int(stored_comment)!=command.source_comment_id: raise ValidationError("same COMMAND_VERSION published by multiple comments")
            if stored_digest and stored_digest!=command.body_sha256: raise ValidationError("canonical command comment was mutated")
            return
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for task_id in command.master:
                row=db.execute("SELECT status FROM tasks WHERE task_id=?",(task_id,)).fetchone()
                if row and str(row[0]) in TERMINAL_TASK_STATES: continue
                priority=command.explicit_priorities.get(task_id,task_priority(task_id)); status="READY" if task_id in command.add else (str(row[0]) if row else "PENDING")
                db.execute("""INSERT INTO tasks(task_id,priority,command_version,status,last_update,next_action) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET priority=excluded.priority,command_version=excluded.command_version,status=CASE WHEN tasks.status IN ('COMPLETED','CANCELLED','SUPERSEDED') THEN tasks.status ELSE excluded.status END,last_update=excluded.last_update,next_action=excluded.next_action""",(task_id,priority,command.version,status,utc_now(),"await_reconcile"))
            for ref in command.complete:
                if not ref.startswith("#"): db.execute("UPDATE tasks SET status='COMPLETED',next_action='none',last_update=? WHERE task_id=?",(utc_now(),ref))
            for task_id in command.cancel: db.execute("UPDATE tasks SET status='CANCELLED',next_action='none',last_update=? WHERE task_id=? AND status!='COMPLETED'",(utc_now(),task_id))
            self.set_meta("command_version",str(command.version),db=db); self.set_meta("command_comment_id",str(command.source_comment_id),db=db); self.set_meta("command_digest",command.body_sha256,db=db); self.set_meta("command_main_sha",command.latest_main,db=db)
            db.execute("COMMIT")

    def attach_hub_command(self, command: ParsedHubCommand) -> None:
        if not self.task(command.task_id): self.upsert_task(command.task_id,task_priority(command.task_id),int(self.get_meta("command_version","0") or 0),"PENDING")
        with self.connection() as db:
            db.execute("UPDATE tasks SET hub_command_id=?,owner_worker=?,files=?,branch=COALESCE(?,branch),head_sha=COALESCE(?,head_sha),last_update=?,next_action='agent_hub_command_observed' WHERE task_id=?",(command.command_id,command.worker_id,json_dumps(list(command.files)),command.branch,command.expected_head_sha,utc_now(),command.task_id))
            db.execute("INSERT INTO workers(worker_id,status,current_task,owned_files,last_heartbeat,last_progress) VALUES(?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET current_task=excluded.current_task,owned_files=excluded.owned_files,last_heartbeat=excluded.last_heartbeat",(command.worker_id,"ACTIVE",command.task_id,json_dumps(list(command.files)),utc_now(),utc_now()))

    def next_ready(self) -> dict[str, Any] | None:
        with self.connection() as db:
            rows=db.execute("SELECT * FROM tasks WHERE status='READY' ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,last_update,task_id").fetchall()
            for row in rows:
                task=dict(row); deps=json.loads(str(task.get("dependencies") or "[]"))
                if all((self.task(dep) or {}).get("status")=="COMPLETED" for dep in deps): return task
        return None

    def acquire_lease(self, task_id: str, worker_id: str, files: Sequence[str], ttl_seconds: int) -> str | None:
        epoch=now_epoch(); lease_id="lease-"+sha256_text(f"{task_id}|{worker_id}|{epoch}")[:20]
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE"); row=db.execute("SELECT status,attempts FROM tasks WHERE task_id=?",(task_id,)).fetchone()
            if not row or str(row[0])!="READY" or int(row[1])>=MAX_RETRIES: db.execute("ROLLBACK"); return None
            for active in db.execute("SELECT task_id,files FROM leases WHERE status='ACTIVE' AND expires_at>?",(epoch,)).fetchall():
                if str(active[0])==task_id or path_conflict(files,json.loads(str(active[1]) or "[]")): db.execute("ROLLBACK"); return None
            db.execute("INSERT INTO leases(lease_id,task_id,worker_id,files,acquired_at,heartbeat_at,expires_at,status) VALUES(?,?,?,?,?,?,?,'ACTIVE')",(lease_id,task_id,worker_id,json_dumps(list(files)),epoch,epoch,epoch+ttl_seconds))
            db.execute("UPDATE tasks SET status='CLAIMED',owner_worker=?,lease_id=?,attempts=attempts+1,last_update=?,next_action='wake_existing_coordinator' WHERE task_id=?",(worker_id,lease_id,utc_now(),task_id)); db.execute("COMMIT")
        return lease_id

    def heartbeat(self, task_id: str) -> None:
        epoch=now_epoch()
        with self.connection() as db: db.execute("UPDATE leases SET heartbeat_at=?,expires_at=? WHERE task_id=? AND status='ACTIVE'",(epoch,epoch+DEFAULT_LEASE_SECONDS,task_id))

    def release_lease(self, task_id: str) -> None:
        with self.connection() as db:
            row=db.execute("SELECT lease_id,worker_id FROM leases WHERE task_id=? AND status='ACTIVE'",(task_id,)).fetchone()
            if not row: return
            db.execute("UPDATE leases SET status='RELEASED' WHERE lease_id=?",(str(row[0]),)); db.execute("UPDATE tasks SET lease_id=NULL WHERE task_id=?",(task_id,)); db.execute("UPDATE workers SET status='AVAILABLE',current_task=NULL,lease_id=NULL,owned_files='[]' WHERE worker_id=?",(str(row[1]),))

    def expire_leases(self) -> list[str]:
        epoch=now_epoch(); expired=[]
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in db.execute("SELECT lease_id,task_id,worker_id FROM leases WHERE status='ACTIVE' AND expires_at<=?",(epoch,)).fetchall():
                lease_id,task_id,worker_id=map(str,row); db.execute("UPDATE leases SET status='EXPIRED' WHERE lease_id=?",(lease_id,)); db.execute("UPDATE tasks SET status='BLOCKED',lease_id=NULL,blocked_by='LEASE_EXPIRED_REQUIRES_REMOTE_RECONCILE',next_action='inspect_worker_pr_ci_before_reassignment',last_update=? WHERE task_id=?",(utc_now(),task_id)); db.execute("UPDATE workers SET status='STALE',current_task=NULL,lease_id=NULL WHERE worker_id=?",(worker_id,)); expired.append(task_id)
            db.execute("COMMIT")
        return expired

    def record_dispatch(self, task_id: str, event_type: str) -> bool:
        key=sha256_text(f"{task_id}|{event_type}|{self.get_meta('command_version','0')}")
        with self.connection() as db:
            try: db.execute("INSERT INTO dispatches(dispatch_key,task_id,event_type,created_at) VALUES(?,?,?,?)",(key,task_id,event_type,utc_now())); return True
            except sqlite3.IntegrityError: return False

    def apply_verified_report(self, report: ParsedWorkerReport, *, verification_ok: bool) -> None:
        if not self.task(report.task_id): return
        if report.head_sha:
            with self.connection() as db: db.execute("UPDATE tasks SET head_sha=?,pr=COALESCE(?,pr),owner_worker=?,last_update=? WHERE task_id=?",(report.head_sha,report.pr_number,report.worker_id,utc_now(),report.task_id))
        if report.report_status in {"blocked","failed","waiting_approval","stale","expired"}: self.set_task(report.task_id,"BLOCKED",next_action="root_cause_reconcile",blocked_by=f"WORKER_{report.report_status.upper()}"); self.release_lease(report.task_id); return
        if report.report_status not in {"completed","success","done"}: self.set_task(report.task_id,"IN_PROGRESS",next_action="await_worker_progress"); return
        if verification_ok: self.set_task(report.task_id,"COMPLETED",next_action="reconcile_next_task"); self.release_lease(report.task_id)
        else: self.set_task(report.task_id,"VERIFYING",next_action="verify_exact_pr_ci_success_criteria")

    def dependency_cycles(self) -> list[list[str]]:
        with self.connection() as db: rows=db.execute("SELECT task_id,dependencies FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED')").fetchall()
        graph={str(r[0]):list(json.loads(str(r[1]) or "[]")) for r in rows}; visiting=[]; visited=set(); cycles=[]
        def visit(node: str) -> None:
            if node in visiting: cycles.append(visiting[visiting.index(node):]+[node]); return
            if node in visited or node not in graph: return
            visiting.append(node)
            for child in graph[node]: visit(child)
            visiting.pop(); visited.add(node)
        for node in graph: visit(node)
        return cycles

    def snapshot(self) -> dict[str, Any]:
        with self.connection() as db:
            queue={str(r[0]):int(r[1]) for r in db.execute("SELECT priority,COUNT(*) FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED') GROUP BY priority")}; states={str(r[0]):int(r[1]) for r in db.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status")}; active_workers=int(db.execute("SELECT COUNT(*) FROM workers WHERE status='ACTIVE'").fetchone()[0]); active_leases=int(db.execute("SELECT COUNT(*) FROM leases WHERE status='ACTIVE' AND expires_at>?",(now_epoch(),)).fetchone()[0])
        return {"controller_version":CONTROLLER_VERSION,"controller_state":self.get_meta("controller_state","ERROR"),"command_version":int(self.get_meta("command_version","0") or 0),"latest_main":self.get_meta("latest_main","unknown"),"last_reconcile_at":self.get_meta("last_reconcile_at","never"),"queue_depth_by_priority":{p:queue.get(p,0) for p in ("P0","P1","P2","P3")},"task_states":states,"active_workers":active_workers,"active_leases":active_leases,"safety":{"LIVE_TRADING":False,"executionAuthority":"NONE","REAL_ORDER_ALLOWED":False,"PRIVATE_TRADING_API_ALLOWED":False,"realOrders":0}}

    def checkpoint(self) -> dict[str, Any]:
        snap=self.snapshot()
        with self.connection() as db: db.execute("INSERT INTO checkpoints(created_at,state_json) VALUES(?,?)",(utc_now(),json_dumps(snap)))
        return snap


class GitHubClient:
    def __init__(self, repository: str, token: str, api_url: str="https://api.github.com"):
        self.repository=repository; self.token=token.strip(); self.api_url=api_url.rstrip("/")
        if not self.token: raise ControllerError("GITHUB_TOKEN is required")
    def request(self, method: str, path: str, payload: Mapping[str,Any] | None=None) -> Any:
        url=path if path.startswith("http") else self.api_url+path; headers={"Accept":"application/vnd.github+json","Authorization":f"Bearer {self.token}","X-GitHub-Api-Version":"2022-11-28","User-Agent":f"investment-realtime-controller/{CONTROLLER_VERSION}"}; data=None
        if payload is not None: data=json_dumps(dict(payload)).encode(); headers["Content-Type"]="application/json"
        last=None
        for attempt in range(MAX_RETRIES):
            try:
                with urlopen(Request(url,data=data,headers=headers,method=method),timeout=30) as response:
                    raw=response.read().decode(); return json.loads(raw) if raw else None
            except HTTPError as exc:
                detail=exc.read().decode(errors="replace")
                if exc.code in {429,502,503,504} and attempt+1<MAX_RETRIES: time.sleep(min(4,2**attempt)); last=exc; continue
                raise ControllerError(f"GitHub HTTP {exc.code}: {detail[:500]}") from exc
            except (URLError,json.JSONDecodeError) as exc:
                last=exc
                if attempt+1<MAX_RETRIES: time.sleep(min(4,2**attempt)); continue
        raise ControllerError(f"GitHub request failed: {last}")
    def main_sha(self) -> str:
        payload=self.request("GET",f"/repos/{self.repository}/branches/main"); sha=str(((payload or {}).get("commit") or {}).get("sha") or "").lower()
        if not SHA_RE.fullmatch(sha): raise ControllerError("exact main SHA unavailable")
        return sha
    def issue_comment_tail(self, issue_number: int, window: int=MAX_COMMENT_WINDOW) -> list[dict[str,Any]]:
        issue=self.request("GET",f"/repos/{self.repository}/issues/{issue_number}"); total=int((issue or {}).get("comments") or 0)
        if total<=0: return []
        desired=max(1,min(window,MAX_COMMENT_WINDOW)); per_page=100; first_offset=max(0,total-desired); first_page=first_offset//per_page+1; last_page=(total-1)//per_page+1; comments=[]
        for page in range(first_page,last_page+1):
            payload=self.request("GET",f"/repos/{self.repository}/issues/{issue_number}/comments?{urlencode({'per_page':per_page,'page':page})}")
            if not isinstance(payload,list): raise ControllerError("comment page is invalid")
            comments.extend(item for item in payload if isinstance(item,dict))
        if len(comments)<min(total,desired): raise ControllerError("bounded comment tail is incomplete")
        return comments[-desired:]
    def dispatch(self,event_type: str,payload: Mapping[str,Any]) -> None: self.request("POST",f"/repos/{self.repository}/dispatches",{"event_type":event_type,"client_payload":dict(payload)})
    def workflow_run(self,run_id: int) -> dict[str,Any]:
        value=self.request("GET",f"/repos/{self.repository}/actions/runs/{run_id}");
        if not isinstance(value,dict): raise ControllerError("workflow run invalid")
        return value
    def pull_request(self,pr_number: int) -> dict[str,Any]:
        value=self.request("GET",f"/repos/{self.repository}/pulls/{pr_number}");
        if not isinstance(value,dict): raise ControllerError("pull request invalid")
        return value


class RealtimeController:
    def __init__(self,*,store: StateStore,repository: str,webhook_secret: str,authorized_commanders: set[str],github: GitHubClient | Any | None,hub_issue: int=DEFAULT_HUB_ISSUE,controller_enabled: bool=True,dispatch_enabled: bool=False,ai_workers_enabled: bool=False,lease_seconds: int=DEFAULT_LEASE_SECONDS):
        self.store=store; self.repository=repository; self.webhook_secret=webhook_secret; self.authorized_commanders=set(authorized_commanders); self.github=github; self.hub_issue=hub_issue; self.controller_enabled=controller_enabled; self.dispatch_enabled=dispatch_enabled; self.ai_workers_enabled=ai_workers_enabled; self.lease_seconds=lease_seconds; self._stop=threading.Event(); self._wake=threading.Event(); self._failures=0; self._circuit_until=0.0; self.store.set_meta("controller_state","BOOTING")
    def _trusted_command_comment(self,comment: Mapping[str,Any]) -> bool:
        login=str(((comment.get("user") or {}).get("login") or "")); assoc=str(comment.get("author_association") or "").upper(); return login in self.authorized_commanders and assoc in AUTHORIZED_ASSOCIATIONS
    def _trusted_report_comment(self,comment: Mapping[str,Any]) -> bool:
        login=str(((comment.get("user") or {}).get("login") or "")); assoc=str(comment.get("author_association") or "").upper(); return login=="github-actions[bot]" or (login in self.authorized_commanders and assoc in AUTHORIZED_ASSOCIATIONS)
    def ingest_webhook(self,*,event_type: str,delivery_id: str,signature: str,raw_body: bytes) -> dict[str,Any]:
        if event_type not in SUPPORTED_EVENTS: raise ValidationError("unsupported event")
        if not DELIVERY_RE.fullmatch(delivery_id): raise ValidationError("invalid delivery id")
        if len(raw_body)>MAX_BODY_BYTES: raise ValidationError("payload too large")
        if not validate_signature(self.webhook_secret,raw_body,signature): raise ValidationError("invalid webhook signature")
        digest=hashlib.sha256(raw_body).hexdigest()
        if not self.store.accept_delivery(delivery_id,event_type,digest): return {"accepted":False,"duplicate":True}
        try:
            payload=json.loads(raw_body.decode())
            if not isinstance(payload,dict): raise ValidationError("payload must be an object")
            if str(((payload.get("repository") or {}).get("full_name") or ""))!=self.repository: raise ValidationError("repository identity mismatch")
            if event_type=="issue_comment" and str(payload.get("action") or "")=="created":
                issue_number=int(((payload.get("issue") or {}).get("number") or 0)); comment=payload.get("comment") or {}; sender=str(((payload.get("sender") or {}).get("login") or "")); author=str(((comment.get("user") or {}).get("login") or "")) if isinstance(comment,Mapping) else ""; body=str(comment.get("body") or "") if isinstance(comment,Mapping) else ""
                if issue_number==self.hub_issue and COMMAND_MARKER in body:
                    if sender!=author or not self._trusted_command_comment(comment): raise ValidationError("command sender/author is not authorized")
                    command=parse_command(body,comment_id=int(comment.get("id") or 0),actor=author,authorized_commanders=self.authorized_commanders)
                    if command: self.store.apply_command(command)
            self.store.finish_delivery(delivery_id,"PROCESSED"); self._wake.set(); return {"accepted":True,"duplicate":False}
        except Exception as exc: self.store.finish_delivery(delivery_id,"REJECTED",str(exc)); raise
    def _command_history(self,comments: Sequence[Mapping[str,Any]]) -> list[ParsedCommand]:
        by_version={}
        for comment in comments:
            body=str(comment.get("body") or "")
            if COMMAND_MARKER not in body or not self._trusted_command_comment(comment): continue
            login=str(((comment.get("user") or {}).get("login") or ""))
            try: command=parse_command(body,comment_id=int(comment.get("id") or 0),actor=login,authorized_commanders=self.authorized_commanders)
            except ValidationError: continue
            if not command: continue
            prior=by_version.get(command.version)
            if prior and prior.source_comment_id!=command.source_comment_id: raise ValidationError(f"COMMAND_VERSION={command.version:03d} has multiple comments")
            by_version[command.version]=command
        return [by_version[v] for v in sorted(by_version)]
    def _verify_report(self,report: ParsedWorkerReport) -> bool:
        if self.github is None or not report.head_sha or not report.pr_number or not report.ci_run_id: return False
        run=self.github.workflow_run(report.ci_run_id)
        if str(run.get("status") or "")!="completed" or str(run.get("conclusion") or "") not in {"success","neutral","skipped"} or str(run.get("head_sha") or "").lower()!=report.head_sha: return False
        pr=self.github.pull_request(report.pr_number)
        return str(((pr.get("head") or {}).get("sha") or "")).lower()==report.head_sha and str(pr.get("state") or "")=="open"
    def reconcile(self) -> dict[str,Any]:
        if not self.controller_enabled: self.store.set_meta("controller_state","WAITING_EVENT"); return self.store.checkpoint()
        if self.github is None: self.store.set_meta("controller_state","DEGRADED"); self.store.set_meta("last_reconcile_at",utc_now()); return self.store.checkpoint()
        if time.time()<self._circuit_until: self.store.set_meta("controller_state","DEGRADED"); return self.store.checkpoint()
        self.store.set_meta("controller_state","RECONCILING")
        try:
            main_sha=self.github.main_sha(); self.store.set_meta("latest_main",main_sha); comments=self.github.issue_comment_tail(self.hub_issue,MAX_COMMENT_WINDOW)
            for command in self._command_history(comments): self.store.apply_command(command)
            for comment in comments:
                body=str(comment.get("body") or ""); login=str(((comment.get("user") or {}).get("login") or ""))
                if HUB_COMMAND_MARKER in body and login=="github-actions[bot]":
                    hub=parse_hub_command(body,comment_id=int(comment.get("id") or 0));
                    if hub: self.store.attach_hub_command(hub)
                if WORKER_REPORT_MARKER in body and self._trusted_report_comment(comment):
                    report=parse_worker_report(body,comment_id=int(comment.get("id") or 0));
                    if report and self.store.task(report.task_id): self.store.apply_verified_report(report,verification_ok=self._verify_report(report) if report.report_status in {"completed","success","done"} else False)
            for cycle in self.store.dependency_cycles():
                for task_id in set(cycle): self.store.set_task(task_id,"BLOCKED",next_action="dependency_cycle_escalation",blocked_by="DEPENDENCY_CYCLE")
            self.store.expire_leases(); self.store.set_meta("last_reconcile_at",utc_now()); self.store.set_meta("controller_state","RUNNING"); self._failures=0; self.dispatch_next(); self.store.set_meta("controller_state","WAITING_EVENT"); return self.store.checkpoint()
        except Exception as exc:
            self._failures+=1; self.store.set_meta("last_reconcile_error",str(exc)[:800]); self.store.set_meta("last_reconcile_at",utc_now())
            if self._failures>=CIRCUIT_THRESHOLD: self._circuit_until=time.time()+CIRCUIT_COOLDOWN_SECONDS; self.store.set_meta("controller_state","DEGRADED")
            else: self.store.set_meta("controller_state","ERROR")
            raise
    def dispatch_next(self) -> str | None:
        if not (self.controller_enabled and self.dispatch_enabled and self.ai_workers_enabled) or self.github is None: return None
        task=self.store.next_ready()
        if not task: return None
        task_id=str(task["task_id"]); files=list(json.loads(str(task.get("files") or "[]")))
        if not self.store.acquire_lease(task_id,"agent-hub-coordinator",files,self.lease_seconds): return None
        if not self.store.record_dispatch(task_id,COORDINATOR_WAKE_EVENT): self.store.set_task(task_id,"IN_PROGRESS",next_action="await_existing_coordinator_dispatch"); return task_id
        try:
            self.github.dispatch(COORDINATOR_WAKE_EVENT,{"source":"realtime-controller","task_id":task_id}); self.store.set_task(task_id,"IN_PROGRESS",next_action="await_agent_hub_command_worker_ci"); self.store.heartbeat(task_id); return task_id
        except Exception:
            self.store.set_task(task_id,"FAILED",next_action="diagnose_dispatch_failure",blocked_by="COORDINATOR_WAKE_FAILED"); self.store.release_lease(task_id); raise
    def handle_ci_event(self,payload: Mapping[str,Any],event_type: str) -> None:
        obj=payload.get(event_type) or {}
        if not isinstance(obj,Mapping): return
        suite=obj.get("check_suite") if isinstance(obj.get("check_suite"),Mapping) else {}; head=str(obj.get("head_sha") or suite.get("head_sha") or "").lower()
        if not SHA_RE.fullmatch(head): return
        status=str(obj.get("status") or "").lower(); conclusion=str(obj.get("conclusion") or "").lower()
        with self.store.connection() as db: rows=db.execute("SELECT task_id FROM tasks WHERE head_sha=? AND status IN ('CLAIMED','IN_PROGRESS','WAITING_CI','VERIFYING')",(head,)).fetchall()
        for row in rows:
            task_id=str(row[0])
            if status!="completed": self.store.set_task(task_id,"WAITING_CI",next_action="await_ci_terminal")
            elif conclusion in {"success","neutral","skipped"}: self.store.set_task(task_id,"VERIFYING",next_action="verify_worker_report_pr_ci_success_criteria")
            else: self.store.set_task(task_id,"BLOCKED",next_action="ci_failure_diagnosis",blocked_by=f"CI_{conclusion or 'UNKNOWN'}")
    def run_loop(self,interval: float) -> None:
        self.store.set_meta("controller_state","RUNNING")
        while not self._stop.is_set():
            try: self.reconcile()
            except Exception: pass
            self._wake.wait(timeout=max(5.0,interval)); self._wake.clear()
    def stop(self) -> None: self.store.set_meta("controller_state","SHUTTING_DOWN"); self._stop.set(); self._wake.set()


class ControllerHTTPHandler(BaseHTTPRequestHandler):
    server_version="InvestmentRealtimeController/1.1"
    @property
    def controller(self) -> RealtimeController: return getattr(self.server,"controller")
    def log_message(self,fmt: str,*args: Any) -> None: print(json_dumps({"timestamp":utc_now(),"component":"http","message":fmt%args}))
    def _reply(self,status: int,payload: Mapping[str,Any]) -> None:
        raw=json_dumps(dict(payload)).encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(raw))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(raw)
    def do_GET(self) -> None:
        if self.path=="/health/live":
            state=self.controller.store.get_meta("controller_state","ERROR"); live=state not in {"ERROR","SHUTTING_DOWN"}; self._reply(HTTPStatus.OK if live else HTTPStatus.SERVICE_UNAVAILABLE,{"live":live,"state":state}); return
        if self.path=="/health/ready":
            state=self.controller.store.get_meta("controller_state","ERROR"); ready=state in {"RUNNING","WAITING_EVENT","RECONCILING"} and bool(self.controller.webhook_secret); self._reply(HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,{"ready":ready,"state":state}); return
        if self.path=="/status": self._reply(HTTPStatus.OK,self.controller.store.snapshot()); return
        self._reply(HTTPStatus.NOT_FOUND,{"error":"not_found"})
    def do_POST(self) -> None:
        if self.path!="/github/webhook": self._reply(HTTPStatus.NOT_FOUND,{"error":"not_found"}); return
        try:
            length=int(self.headers.get("Content-Length") or "0")
            if length<=0 or length>MAX_BODY_BYTES: raise ValidationError("invalid content length")
            raw=self.rfile.read(length); event_type=str(self.headers.get("X-GitHub-Event") or ""); result=self.controller.ingest_webhook(event_type=event_type,delivery_id=str(self.headers.get("X-GitHub-Delivery") or ""),signature=str(self.headers.get("X-Hub-Signature-256") or ""),raw_body=raw)
            if event_type in {"workflow_run","check_run","check_suite"} and result.get("accepted"): self.controller.handle_ci_event(json.loads(raw.decode()),event_type)
            self._reply(HTTPStatus.ACCEPTED if result.get("accepted") else HTTPStatus.OK,result)
        except ValidationError as exc: self._reply(HTTPStatus.UNAUTHORIZED,{"accepted":False,"error":str(exc)})
        except SafetyError as exc: self._reply(HTTPStatus.FORBIDDEN,{"accepted":False,"error":str(exc)})
        except Exception as exc: self._reply(HTTPStatus.INTERNAL_SERVER_ERROR,{"accepted":False,"error":str(exc)[:300]})


def authorized_commanders_from_env(repository: str) -> set[str]:
    explicit={item.strip() for item in os.environ.get("CONTROLLER_AUTHORIZED_COMMANDERS","").split(",") if item.strip()}
    return explicit or {repository.split("/",1)[0]}


def build_from_env() -> RealtimeController:
    repository=os.environ.get("GITHUB_REPOSITORY","seungjae3908-source/seungjae20260713").strip(); store=StateStore(os.environ.get("CONTROLLER_DB_PATH","/var/lib/investment-realtime-controller/controller.db")); token=os.environ.get("GITHUB_TOKEN","").strip(); github=GitHubClient(repository,token) if token else None
    return RealtimeController(store=store,repository=repository,webhook_secret=os.environ.get("GITHUB_WEBHOOK_SECRET",""),authorized_commanders=authorized_commanders_from_env(repository),github=github,hub_issue=int(os.environ.get("CONTROLLER_HUB_ISSUE",str(DEFAULT_HUB_ISSUE))),controller_enabled=os.environ.get("CONTROLLER_ENABLED","true").lower()=="true",dispatch_enabled=os.environ.get("DISPATCH_ENABLED","false").lower()=="true",ai_workers_enabled=os.environ.get("AI_WORKERS_ENABLED","false").lower()=="true",lease_seconds=int(os.environ.get("CONTROLLER_LEASE_SECONDS",str(DEFAULT_LEASE_SECONDS))))


def serve(controller: RealtimeController,host: str,port: int,interval: float) -> None:
    server=ThreadingHTTPServer((host,port),ControllerHTTPHandler); setattr(server,"controller",controller); thread=threading.Thread(target=controller.run_loop,args=(interval,),daemon=True,name="realtime-controller-reconciler"); thread.start()
    def shutdown(_signum: int,_frame: Any) -> None: controller.stop(); threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,shutdown); signal.signal(signal.SIGINT,shutdown)
    try: server.serve_forever(poll_interval=0.5)
    finally: controller.stop(); thread.join(timeout=10); server.server_close()


def main() -> int:
    parser=argparse.ArgumentParser(description="Persistent realtime Agent Hub controller"); sub=parser.add_subparsers(dest="command",required=True); sub.add_parser("status"); sub.add_parser("reconcile"); serve_parser=sub.add_parser("serve"); serve_parser.add_argument("--host",default=os.environ.get("CONTROLLER_BIND","127.0.0.1")); serve_parser.add_argument("--port",type=int,default=int(os.environ.get("CONTROLLER_PORT",str(DEFAULT_PORT)))); serve_parser.add_argument("--reconcile-seconds",type=float,default=float(os.environ.get("CONTROLLER_RECONCILE_SECONDS",str(DEFAULT_RECONCILE_SECONDS)))); args=parser.parse_args(); controller=build_from_env()
    if args.command=="status": print(json_dumps(controller.store.snapshot())); return 0
    if args.command=="reconcile":
        try: print(json_dumps(controller.reconcile())); return 0
        except Exception as exc: print(json_dumps({"status":"error","error":str(exc)[:500]})); return 1
    serve(controller,args.host,args.port,args.reconcile_seconds); return 0


if __name__=="__main__": raise SystemExit(main())
