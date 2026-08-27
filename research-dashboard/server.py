#!/usr/bin/env python3
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MODULE_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_ROOT = Path('/var/lib/investment-research-production')
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 18090
MAX_JSON_BYTES = 12 * 1024 * 1024
PROFILES = ('forward', 'fast-historical', 'long-history')
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
}


def finite_number(value):
    if isinstance(value, bool):
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


def optional_integer_count(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or not number.is_integer() or number < 0:
        return None
    return int(number)


def optional_boolean(value):
    return value if isinstance(value, bool) else None


def read_json_optional(path):
    path = Path(path)
    try:
        metadata = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file():
        return None
    if metadata.st_size > MAX_JSON_BYTES:
        raise RuntimeError(f'state file exceeds {MAX_JSON_BYTES} bytes')
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as error:
        raise RuntimeError(f'unable to read research state {path}: {str(error)[:240]}') from error


def summarize_task(row=None):
    row = row if isinstance(row, dict) else {}
    return {
        'id': str(row.get('id', 'unknown')),
        'status': str(row.get('status', 'unknown')),
        'durationMs': finite_number(row.get('durationMs')),
        'startedAt': finite_number(row.get('startedAt')),
        'endedAt': finite_number(row.get('endedAt')),
        'timedOut': row.get('timedOut') is True,
    }


def summarize_cycle(profile, value):
    if not isinstance(value, dict):
        return {
            'profile': profile,
            'present': False,
            'status': 'not_started',
            'concurrency': None,
            'taskCount': None,
            'successCount': None,
            'blockedDataCount': None,
            'failedCount': None,
            'tasks': [],
        }
    has_task_evidence = isinstance(value.get('results'), list)
    raw_results = value.get('results') if has_task_evidence else []
    tasks = [summarize_task(row) for row in raw_results]
    task_count = optional_integer_count(value.get('taskCount'))
    success_count = optional_integer_count(value.get('successCount'))
    blocked_data_count = optional_integer_count(value.get('blockedDataCount'))
    failed_count = optional_integer_count(value.get('failedCount'))
    return {
        'profile': profile,
        'present': True,
        'status': str(value.get('status', 'unknown')),
        'cycleId': value.get('cycleId') if isinstance(value.get('cycleId'), str) else None,
        'researchSha': value.get('researchSha') if isinstance(value.get('researchSha'), str) else None,
        'generatedAt': finite_number(value.get('generatedAt')),
        'concurrency': optional_integer_count(value.get('concurrency')),
        'taskCount': task_count if task_count is not None else (len(tasks) if has_task_evidence else None),
        'successCount': success_count if success_count is not None else (sum(task['status'] == 'success' for task in tasks) if has_task_evidence else None),
        'blockedDataCount': blocked_data_count if blocked_data_count is not None else (sum(task['status'] == 'blocked_data' for task in tasks) if has_task_evidence else None),
        'failedCount': failed_count if failed_count is not None else (sum(task['status'] == 'failed' for task in tasks) if has_task_evidence else None),
        'tasks': tasks,
    }


def summarize_paper_runtime(value):
    if not isinstance(value, dict):
        return {
            'present': False,
            'status': 'not_started',
            'scheduleActive': None,
            'allProvidersReady': None,
            'publicForwardEvidenceAccumulating': None,
            'paperTradeOutcomeAccumulating': None,
            'privateRequestCount': None,
            'financialMutationCount': None,
            'orderCount': None,
            'liveTrading': None,
            'orderAuthority': None,
            'safetyEvidenceComplete': True,
            'lanes': [],
        }
    raw_lanes = value.get('lanes') if isinstance(value.get('lanes'), list) else []
    lanes = []
    for lane in raw_lanes:
        lane = lane if isinstance(lane, dict) else {}
        market = lane.get('market', lane.get('lane', lane.get('provider', 'unknown')))
        lanes.append({'market': str(market), 'status': str(lane.get('status', 'unknown'))})
    private_request_count = optional_integer_count(value.get('privateRequestCount'))
    financial_mutation_count = optional_integer_count(value.get('financialMutationCount'))
    order_count = optional_integer_count(value.get('orderCount'))
    live_trading = optional_boolean(value.get('liveTrading'))
    order_authority = optional_boolean(value.get('orderAuthority'))
    safety_evidence_complete = all(item is not None for item in (
        private_request_count,
        financial_mutation_count,
        order_count,
        live_trading,
        order_authority,
    ))
    return {
        'present': True,
        'status': str(value.get('status', 'unknown')),
        'cycleId': value.get('cycleId') if isinstance(value.get('cycleId'), str) else None,
        'scheduleActive': optional_boolean(value.get('scheduleActive')),
        'allProvidersReady': optional_boolean(value.get('allProvidersReady')),
        'publicForwardEvidenceAccumulating': optional_boolean(value.get('publicForwardEvidenceAccumulating')),
        'paperTradeOutcomeAccumulating': optional_boolean(value.get('paperTradeOutcomeAccumulating')),
        'privateRequestCount': private_request_count,
        'financialMutationCount': financial_mutation_count,
        'orderCount': order_count,
        'liveTrading': live_trading,
        'orderAuthority': order_authority,
        'safetyEvidenceComplete': safety_evidence_complete,
        'lanes': lanes,
    }


def summarize_paper_ledger(value):
    if not isinstance(value, dict):
        return {'present': False, 'cycleCount': None, 'sampleCount': None, 'positionCount': None, 'settlementCount': None}
    return {
        'present': True,
        'cycleCount': len(value.get('cycles')) if isinstance(value.get('cycles'), list) else None,
        'sampleCount': len(value.get('samples')) if isinstance(value.get('samples'), list) else None,
        'positionCount': len(value.get('positions')) if isinstance(value.get('positions'), list) else None,
        'settlementCount': len(value.get('settlements')) if isinstance(value.get('settlements'), list) else None,
    }


def summarize_shadow_groups(value):
    if not isinstance(value, dict):
        return []
    source = value.get('groups') if isinstance(value.get('groups'), dict) else value
    groups = []
    for name, row in source.items():
        if not isinstance(row, dict):
            continue
        candidate = row.get('candidate') if isinstance(row.get('candidate'), dict) else row
        total = finite_number(row.get('total', row.get('totalCount', row.get('records', row.get('sampleSize')))))
        settled = finite_number(row.get('settled', row.get('settledCount')))
        pending = finite_number(row.get('pending', row.get('pendingCount')))
        prediction_health = candidate.get('predictionHealth') if isinstance(candidate.get('predictionHealth'), dict) else {}
        collapsed = prediction_health.get('collapsed', row.get('collapsed'))
        metrics = candidate.get('metrics') if isinstance(candidate.get('metrics'), dict) else {}
        per_class = candidate.get('perClass') if isinstance(candidate.get('perClass'), dict) else {}
        bullish = per_class.get('bullish') if isinstance(per_class.get('bullish'), dict) else {}
        bearish = per_class.get('bearish') if isinstance(per_class.get('bearish'), dict) else {}
        neutral = per_class.get('neutral') if isinstance(per_class.get('neutral'), dict) else {}
        macro_f1 = finite_number(candidate.get('macroF1', metrics.get('macroF1')))
        balanced = finite_number(candidate.get('balancedAccuracy', metrics.get('balancedAccuracy')))
        bull_recall = finite_number(bullish.get('recall'))
        bear_recall = finite_number(bearish.get('recall'))
        neutral_recall = finite_number(neutral.get('recall'))
        if all(item is None for item in (total, settled, pending, macro_f1, balanced, bull_recall, bear_recall, neutral_recall)) and not isinstance(collapsed, bool):
            continue
        groups.append({
            'name': str(name),
            'total': total,
            'settled': settled,
            'pending': pending,
            'collapsed': collapsed if isinstance(collapsed, bool) else None,
            'macroF1': macro_f1,
            'balancedAccuracy': balanced,
            'bullRecall': bull_recall,
            'bearRecall': bear_recall,
            'neutralRecall': neutral_recall,
        })
    return groups


def count_shadow_records(value):
    total = 0
    settled = 0
    pending = 0
    found_records = False

    def visit(node):
        nonlocal total, settled, pending, found_records
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        records = node.get('records')
        if isinstance(records, list):
            found_records = True
            total += len(records)
            for record in records:
                if isinstance(record, dict) and record.get('status') == 'settled':
                    settled += 1
                if isinstance(record, dict) and record.get('status') == 'pending':
                    pending += 1
        for key, child in node.items():
            if key != 'records':
                visit(child)

    visit(value)
    return {
        'present': value is not None,
        'totalRecords': total if found_records else None,
        'settledRecords': settled if found_records else None,
        'pendingRecords': pending if found_records else None,
    }


def canonical_shadow_handoffs(value):
    if not isinstance(value, dict):
        return []
    groups = value.get('groups') if isinstance(value.get('groups'), dict) else {}
    handoffs = []
    for group in sorted(groups):
        row = groups.get(group)
        canonical = row.get('canonicalEvidence') if isinstance(row, dict) and isinstance(row.get('canonicalEvidence'), dict) else {}
        outer = canonical.get('handoff') if isinstance(canonical.get('handoff'), dict) else {}
        handoff = outer.get('strategyHealthHandoff') if isinstance(outer.get('strategyHealthHandoff'), dict) else None
        if handoff is not None:
            handoffs.append({'group': str(group), 'handoff': handoff})
    return handoffs


def sum_known_cycle_counts(cycles, key):
    present_cycles = [cycle for cycle in cycles if cycle.get('present')]
    if any(cycle.get(key) is None for cycle in present_cycles):
        return None
    return sum(cycle.get(key) or 0 for cycle in present_cycles)


def build_research_overview(state_root=DEFAULT_STATE_ROOT):
    root = Path(state_root).resolve()
    cycles = [summarize_cycle(profile, read_json_optional(root / 'latest' / f'{profile}.json')) for profile in PROFILES]
    paper_runtime = summarize_paper_runtime(read_json_optional(root / 'forward' / 'paper' / 'status' / 'runtime-status.json'))
    paper_ledger = summarize_paper_ledger(read_json_optional(root / 'forward' / 'paper' / 'state' / 'recurring-paper-loop.json'))
    shadow_groups = summarize_shadow_groups(read_json_optional(root / 'forward' / 'shadow-summary.json'))
    shadow_state = read_json_optional(root / 'forward' / 'shadow-state.json')
    shadow_records = count_shadow_records(shadow_state)
    shadow_canonical_handoffs = canonical_shadow_handoffs(shadow_state)
    failed_tasks = sum_known_cycle_counts(cycles, 'failedCount')
    blocked_data_tasks = sum_known_cycle_counts(cycles, 'blockedDataCount')
    authority_evidence_complete = not paper_runtime.get('present') or paper_runtime.get('safetyEvidenceComplete') is True
    forbidden_authority_observed = (
        paper_runtime.get('privateRequestCount') is not None and paper_runtime.get('privateRequestCount') > 0
        or paper_runtime.get('financialMutationCount') is not None and paper_runtime.get('financialMutationCount') > 0
        or paper_runtime.get('orderCount') is not None and paper_runtime.get('orderCount') > 0
        or paper_runtime.get('liveTrading') is True
        or paper_runtime.get('orderAuthority') is True
    )
    timestamps = [finite_number(cycle.get('generatedAt')) or 0 for cycle in cycles]
    latest_cycle_at = max(timestamps) if timestamps and max(timestamps) > 0 else None
    research_status = (
        'safety_block' if forbidden_authority_observed
        else 'safety_evidence_incomplete' if not authority_evidence_complete
        else 'evidence_incomplete' if failed_tasks is None or blocked_data_tasks is None
        else 'attention' if failed_tasks > 0
        else 'collecting'
    )
    return {
        'schemaVersion': 'research-dashboard-overview-v1',
        'generatedAt': int(__import__('time').time() * 1000),
        'state': {
            'present': any(cycle.get('present') for cycle in cycles) or paper_runtime.get('present') or paper_ledger.get('present') or shadow_records.get('present'),
            'latestCycleAt': latest_cycle_at,
        },
        'safety': {
            'readOnlyDashboard': True,
            'liveTrading': False,
            'privateApi': False,
            'orderAuthority': False,
            'authorityEvidenceComplete': authority_evidence_complete,
            'forbiddenAuthorityObserved': forbidden_authority_observed,
        },
        'research': {
            'status': research_status,
            'failedTasks': failed_tasks,
            'blockedDataTasks': blocked_data_tasks,
            'cycles': cycles,
        },
        'paper': {'runtime': paper_runtime, 'ledger': paper_ledger},
        'shadow': {'groups': shadow_groups, 'records': shadow_records, 'canonicalHandoffs': shadow_canonical_handoffs},
        'profitability': {
            'proven': False,
            'status': 'evidence_collection',
            'note': 'Dashboard never promotes profitability by itself; promotion remains evidence-gated in the research pipeline.',
        },
    }


def safe_static_path(public_root, pathname):
    relative = 'index.html' if pathname == '/' else pathname.lstrip('/')
    candidate = (public_root / relative).resolve()
    root = public_root.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


class ResearchDashboardHandler(BaseHTTPRequestHandler):
    server_version = 'InvestmentResearchDashboard/1.0'

    def log_message(self, fmt, *args):
        return

    def _security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

    def _json(self, status, payload, head_only=False):
        body = (json.dumps(payload, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')
        self.send_response(status)
        self._security_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _method_not_allowed(self):
        self.send_response(405)
        self._security_headers()
        self.send_header('Allow', 'GET, HEAD')
        body = b'{"ok":false,"error":"read_only_dashboard"}\n'
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self._method_not_allowed()

    def do_PUT(self):
        self._method_not_allowed()

    def do_PATCH(self):
        self._method_not_allowed()

    def do_DELETE(self):
        self._method_not_allowed()

    def do_OPTIONS(self):
        self._method_not_allowed()

    def do_GET(self):
        self._handle_read(False)

    def do_HEAD(self):
        self._handle_read(True)

    def _handle_read(self, head_only):
        try:
            pathname = unquote(urlsplit(self.path).path)
            if pathname == '/api/health':
                return self._json(200, {
                    'ok': True,
                    'service': 'investment-research-dashboard',
                    'readOnly': True,
                    'liveTrading': False,
                    'privateApi': False,
                    'orderAuthority': False,
                }, head_only)
            if pathname == '/api/research/overview':
                return self._json(200, build_research_overview(self.server.state_root), head_only)
            if pathname.startswith('/api/'):
                return self._json(404, {'ok': False, 'error': 'not_found'}, head_only)

            file_path = safe_static_path(self.server.public_root, pathname)
            if file_path is None or not file_path.is_file():
                return self._json(404, {'ok': False, 'error': 'not_found'}, head_only)
            body = file_path.read_bytes()
            content_type = CONTENT_TYPES.get(file_path.suffix, 'application/octet-stream')
            cache_control = 'no-cache' if file_path.suffix == '.html' or file_path.name == 'sw.js' else 'public, max-age=3600'
            self.send_response(200)
            self._security_headers()
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', cache_control)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
        except Exception as error:
            self._json(500, {'ok': False, 'error': 'research_state_unavailable', 'detail': str(error)[:240]}, head_only)


class ResearchDashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, state_root, public_root):
        super().__init__(address, ResearchDashboardHandler)
        self.state_root = Path(state_root).resolve()
        self.public_root = Path(public_root).resolve()


def main():
    host = os.environ.get('RESEARCH_DASHBOARD_HOST', DEFAULT_HOST)
    try:
        port = int(os.environ.get('RESEARCH_DASHBOARD_PORT', str(DEFAULT_PORT)))
    except ValueError as error:
        raise SystemExit('RESEARCH_DASHBOARD_PORT must be a valid TCP port') from error
    if port < 1 or port > 65535:
        raise SystemExit('RESEARCH_DASHBOARD_PORT must be a valid TCP port')
    state_root = Path(os.environ.get('RESEARCH_STATE_ROOT', str(DEFAULT_STATE_ROOT))).resolve()
    server = ResearchDashboardServer((host, port), state_root, MODULE_DIR / 'public')
    print(json.dumps({
        'service': 'investment-research-dashboard',
        'host': host,
        'port': port,
        'stateRoot': str(state_root),
        'readOnly': True,
        'liveTrading': False,
        'privateApi': False,
        'orderAuthority': False,
        'runtime': f'python-{sys.version_info.major}.{sys.version_info.minor}',
    }, separators=(',', ':')), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
