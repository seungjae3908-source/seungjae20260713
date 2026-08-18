#!/usr/bin/env python3
"""Read-only Research Lab dashboard HTTP server.

Uses only the Python standard library so the long-running dashboard does not
require V8 JIT, executable-memory remapping, WebAssembly, Undici, or package
installation on the production host.
"""

from __future__ import annotations

import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MODULE_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_ROOT = Path("/var/lib/investment-research-production")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18090
MAX_JSON_BYTES = 12 * 1024 * 1024
PROFILES = ("forward", "fast-historical", "long-history")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
}


def finite_number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    if number.is_integer():
        return int(number)
    return number


def integer_count(value):
    number = finite_number(value)
    return int(number) if isinstance(number, int) and number >= 0 else 0


def read_json_optional(path: Path):
    try:
        metadata = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file():
        return None
    if metadata.st_size > MAX_JSON_BYTES:
        raise RuntimeError(f"state file exceeds {MAX_JSON_BYTES} bytes")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # fail closed with bounded detail at HTTP layer
        raise RuntimeError(f"unable to read research state {path}: {str(exc)[:240]}") from exc


def summarize_task(row=None):
    row = row if isinstance(row, dict) else {}
    return {
        "id": str(row.get("id", "unknown")),
        "status": str(row.get("status", "unknown")),
        "durationMs": finite_number(row.get("durationMs")),
        "startedAt": finite_number(row.get("startedAt")),
        "endedAt": finite_number(row.get("endedAt")),
        "timedOut": row.get("timedOut") is True,
    }


def summarize_cycle(profile: str, value):
    if not isinstance(value, dict):
        return {"profile": profile, "present": False, "status": "not_started", "tasks": []}
    rows = value.get("results") if isinstance(value.get("results"), list) else []
    tasks = [summarize_task(row) for row in rows]
    return {
        "profile": profile,
        "present": True,
        "status": str(value.get("status", "unknown")),
        "cycleId": value.get("cycleId") if isinstance(value.get("cycleId"), str) else None,
        "researchSha": value.get("researchSha") if isinstance(value.get("researchSha"), str) else None,
        "generatedAt": finite_number(value.get("generatedAt")),
        "concurrency": integer_count(value.get("concurrency")),
        "taskCount": integer_count(value.get("taskCount", len(tasks))),
        "successCount": integer_count(value.get("successCount")),
        "blockedDataCount": integer_count(value.get("blockedDataCount")),
        "failedCount": integer_count(value.get("failedCount")),
        "tasks": tasks,
    }


def summarize_paper_runtime(value):
    if not isinstance(value, dict):
        return {"present": False, "status": "not_started", "lanes": []}
    lanes = []
    for lane in value.get("lanes") if isinstance(value.get("lanes"), list) else []:
        lane = lane if isinstance(lane, dict) else {}
        market = lane.get("market") or lane.get("lane") or lane.get("provider") or "unknown"
        lanes.append({"market": str(market), "status": str(lane.get("status", "unknown"))})
    return {
        "present": True,
        "status": str(value.get("status", "unknown")),
        "cycleId": value.get("cycleId") if isinstance(value.get("cycleId"), str) else None,
        "scheduleActive": value.get("scheduleActive") is True,
        "allProvidersReady": value.get("allProvidersReady") is True,
        "publicForwardEvidenceAccumulating": value.get("publicForwardEvidenceAccumulating") is True,
        "paperTradeOutcomeAccumulating": value.get("paperTradeOutcomeAccumulating") is True,
        "privateRequestCount": integer_count(value.get("privateRequestCount")),
        "financialMutationCount": integer_count(value.get("financialMutationCount")),
        "orderCount": integer_count(value.get("orderCount")),
        "liveTrading": value.get("liveTrading") is True,
        "orderAuthority": value.get("orderAuthority") is True,
        "lanes": lanes,
    }


def summarize_paper_ledger(value):
    if not isinstance(value, dict):
        return {"present": False, "cycleCount": 0, "positionCount": 0, "settlementCount": 0}
    return {
        "present": True,
        "cycleCount": len(value.get("cycles")) if isinstance(value.get("cycles"), list) else 0,
        "positionCount": len(value.get("positions")) if isinstance(value.get("positions"), list) else 0,
        "settlementCount": len(value.get("settlements")) if isinstance(value.get("settlements"), list) else 0,
    }


def summarize_shadow_groups(value):
    if not isinstance(value, dict):
        return []
    source = value.get("groups") if isinstance(value.get("groups"), dict) else value
    groups = []
    for name, row in source.items():
        if not isinstance(row, dict):
            continue
        total = finite_number(row.get("total", row.get("totalCount", row.get("records", row.get("sampleSize")))))
        settled = finite_number(row.get("settled", row.get("settledCount")))
        pending = finite_number(row.get("pending", row.get("pendingCount")))
        health = row.get("predictionHealth") if isinstance(row.get("predictionHealth"), dict) else {}
        metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
        collapsed_raw = health.get("collapsed", row.get("collapsed"))
        macro_f1 = finite_number(row.get("macroF1", metrics.get("macroF1")))
        balanced = finite_number(row.get("balancedAccuracy", metrics.get("balancedAccuracy")))
        if all(item is None for item in (total, settled, pending, macro_f1, balanced)) and not isinstance(collapsed_raw, bool):
            continue
        groups.append({
            "name": str(name),
            "total": total,
            "settled": settled,
            "pending": pending,
            "collapsed": collapsed_raw if isinstance(collapsed_raw, bool) else None,
            "macroF1": macro_f1,
            "balancedAccuracy": balanced,
        })
    return groups


def count_shadow_records(value):
    seen = set()
    counts = {"totalRecords": 0, "settledRecords": 0, "pendingRecords": 0}

    def visit(node):
        if not isinstance(node, (dict, list)):
            return
        marker = id(node)
        if marker in seen:
            return
        seen.add(marker)
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        records = node.get("records")
        if isinstance(records, list):
            counts["totalRecords"] += len(records)
            for record in records:
                if isinstance(record, dict) and record.get("status") == "settled":
                    counts["settledRecords"] += 1
                if isinstance(record, dict) and record.get("status") == "pending":
                    counts["pendingRecords"] += 1
        for key, child in node.items():
            if key != "records":
                visit(child)

    visit(value)
    return {"present": value is not None, **counts}


def build_research_overview(state_root=DEFAULT_STATE_ROOT):
    root = Path(state_root).resolve()
    cycles = [summarize_cycle(profile, read_json_optional(root / "latest" / f"{profile}.json")) for profile in PROFILES]
    paper_runtime = summarize_paper_runtime(read_json_optional(root / "forward" / "paper" / "status" / "runtime-status.json"))
    paper_ledger = summarize_paper_ledger(read_json_optional(root / "forward" / "paper" / "state" / "recurring-paper-loop.json"))
    shadow_groups = summarize_shadow_groups(read_json_optional(root / "forward" / "shadow-summary.json"))
    shadow_records = count_shadow_records(read_json_optional(root / "forward" / "shadow-state.json"))
    failed_tasks = sum(cycle.get("failedCount", 0) for cycle in cycles)
    blocked_tasks = sum(cycle.get("blockedDataCount", 0) for cycle in cycles)
    forbidden = (
        paper_runtime.get("privateRequestCount", 0) > 0
        or paper_runtime.get("financialMutationCount", 0) > 0
        or paper_runtime.get("orderCount", 0) > 0
        or paper_runtime.get("liveTrading") is True
        or paper_runtime.get("orderAuthority") is True
    )
    timestamps = [cycle.get("generatedAt") for cycle in cycles if isinstance(cycle.get("generatedAt"), (int, float))]
    latest_cycle_at = max(timestamps) if timestamps else None
    state_present = any(cycle.get("present") for cycle in cycles) or paper_runtime.get("present") or paper_ledger.get("present") or shadow_records.get("present")
    return {
        "schemaVersion": "research-dashboard-overview-v1",
        "generatedAt": int(__import__("time").time() * 1000),
        "state": {"present": bool(state_present), "latestCycleAt": latest_cycle_at},
        "safety": {
            "readOnlyDashboard": True,
            "liveTrading": False,
            "privateApi": False,
            "orderAuthority": False,
            "forbiddenAuthorityObserved": bool(forbidden),
        },
        "research": {
            "status": "safety_block" if forbidden else "attention" if failed_tasks > 0 else "collecting",
            "failedTasks": failed_tasks,
            "blockedDataTasks": blocked_tasks,
            "cycles": cycles,
        },
        "paper": {"runtime": paper_runtime, "ledger": paper_ledger},
        "shadow": {"groups": shadow_groups, "records": shadow_records},
        "profitability": {
            "proven": False,
            "status": "evidence_collection",
            "note": "Dashboard never promotes profitability by itself; promotion remains evidence-gated in the research pipeline.",
        },
    }


class ResearchDashboardServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class ResearchDashboardHandler(BaseHTTPRequestHandler):
    server_version = "InvestmentResearchDashboard"
    sys_version = ""
    state_root = DEFAULT_STATE_ROOT
    public_root = MODULE_DIR / "public"

    def version_string(self):
        return self.server_version

    def log_message(self, _format, *_args):
        return

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

    def _send_bytes(self, status: int, body: bytes, content_type: str, cache_control: str = "no-store", send_body: bool = True):
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_json(self, status: int, payload, send_body: bool = True):
        body = (json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", "no-store", send_body)

    def _handle_read(self, send_body: bool):
        try:
            pathname = unquote(urlsplit(self.path).path)
            if pathname == "/api/health":
                self._send_json(200, {
                    "ok": True,
                    "service": "investment-research-dashboard",
                    "readOnly": True,
                    "liveTrading": False,
                    "privateApi": False,
                    "orderAuthority": False,
                }, send_body)
                return
            if pathname == "/api/research/overview":
                self._send_json(200, build_research_overview(self.state_root), send_body)
                return
            if pathname.startswith("/api/"):
                self._send_json(404, {"ok": False, "error": "not_found"}, send_body)
                return

            relative = "index.html" if pathname == "/" else pathname.lstrip("/")
            root = Path(self.public_root).resolve()
            candidate = (root / relative).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                self._send_json(404, {"ok": False, "error": "not_found"}, send_body)
                return
            if not candidate.is_file():
                self._send_json(404, {"ok": False, "error": "not_found"}, send_body)
                return
            body = candidate.read_bytes()
            extension = candidate.suffix.lower()
            cache = "no-cache" if extension == ".html" or candidate.name == "sw.js" else "public, max-age=3600"
            self._send_bytes(200, body, CONTENT_TYPES.get(extension, "application/octet-stream"), cache, send_body)
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": "research_state_unavailable", "detail": str(exc)[:240]}, send_body)

    def do_GET(self):
        self._handle_read(True)

    def do_HEAD(self):
        self._handle_read(False)

    def _reject_write(self):
        self.send_response(405)
        self._security_headers()
        self.send_header("Allow", "GET, HEAD")
        body = b'{"ok":false,"error":"read_only_dashboard"}\n'
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = _reject_write
    do_PUT = _reject_write
    do_PATCH = _reject_write
    do_DELETE = _reject_write


def create_server(host=DEFAULT_HOST, port=DEFAULT_PORT, state_root=DEFAULT_STATE_ROOT, public_root=MODULE_DIR / "public"):
    handler = type("ConfiguredResearchDashboardHandler", (ResearchDashboardHandler,), {
        "state_root": Path(state_root).resolve(),
        "public_root": Path(public_root).resolve(),
    })
    return ResearchDashboardServer((host, int(port)), handler)


def main():
    host = os.environ.get("RESEARCH_DASHBOARD_HOST", DEFAULT_HOST)
    port = int(os.environ.get("RESEARCH_DASHBOARD_PORT", str(DEFAULT_PORT)))
    if port < 1 or port > 65535:
        raise ValueError("RESEARCH_DASHBOARD_PORT must be a valid TCP port")
    state_root = Path(os.environ.get("RESEARCH_STATE_ROOT", str(DEFAULT_STATE_ROOT)))
    server = create_server(host=host, port=port, state_root=state_root)
    print(json.dumps({
        "service": "investment-research-dashboard",
        "host": host,
        "port": port,
        "stateRoot": str(state_root),
        "readOnly": True,
        "liveTrading": False,
        "privateApi": False,
        "orderAuthority": False,
    }, separators=(",", ":")), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
