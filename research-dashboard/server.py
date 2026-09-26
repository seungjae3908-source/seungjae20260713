#!/usr/bin/env python3
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from v3_independence import read_v3_independence_summary

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
CANDIDATE_PERFORMANCE_SCHEMA = 'frozen-candidate-performance-reader-v1'
TEMPORAL_CRYPTO_SUMMARY_SCHEMA = 'crypto-futures-temporal-public-collection-v1'
TEMPORAL_COLLECTION_STATUSES = frozenset(('complete', 'partial_failure'))
TEMPORAL_SYMBOL_STATUSES = frozenset(('success', 'failed'))
FACTORY_RUNTIME_CONTRACT = 'research-factory-runtime-status/v1'
FACTORY_RUNTIME_STATUSES = frozenset((
    'BLOCKED_POLICY_MISSING',
    'BLOCKED_POLICY_INVALID',
    'BLOCKED_NO_READY_PROFILES',
    'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
    'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID',
    'BLOCKED_RUNTIME_BINDINGS',
    'READY_NON_ACTIVATING',
))
SHA40_PATTERN = __import__('re').compile(r'^[0-9a-f]{40}$')
DIGEST64_PATTERN = __import__('re').compile(r'^[0-9a-f]{64}$')
TEMPORAL_SYMBOL_PATTERN = __import__('re').compile(r'^[A-Z0-9]{3,30}$')
CANDIDATE_ID_PATTERN = __import__('re').compile(r'^(?:phase3-candidate:sha256:|paper-candidate-v1:)[0-9a-f]{64}$')
SAFE_ID_PATTERN = __import__('re').compile(r'^[A-Za-z0-9._:-]{1,160}$')
CANDIDATE_COUNT_KEYS = (
    'effectiveIndependentMarketN', 'candidateMatchedN', 'LONG_SIGNAL_N', 'SHORT_SIGNAL_N', 'NO_TRADE_N',
    'Entry_N', 'Position_N', 'PositionObservation_N', 'Settlement_N',
    'TRAIN_N', 'VALIDATION_N', 'OOS_N', 'WIN_N', 'LOSS_N', 'BREAKEVEN_N',
)
CANDIDATE_METRIC_KEYS = (
    'WIN_RATE', 'AVG_WIN', 'AVG_LOSS', 'PAYOFF_RATIO', 'GROSS_EXPECTANCY',
    'PF', 'MDD', 'MFE', 'MAE', 'TIME_TO_EXIT', 'Gross_PnL', 'Net_PnL',
)
CANDIDATE_IDENTITY_KEYS = (
    'candidateId', 'strategyId', 'strategyVersion', 'parameterHash', 'researchCodeSha',
    'market', 'provider', 'symbol', 'timeframe', 'sidePolicy', 'accountMode',
    'costPolicyVersion', 'executionPolicyVersion',
)
FULL_COST_KEYS = (
    'commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
)
FULL_COST_STATES = frozenset(('MEASURED', 'MODELED', 'UNKNOWN', 'BLOCKED_DATA'))
FORBIDDEN_EVIDENCE_KEY = __import__('re').compile(r'(?:secret|token|password|credential|private.?key|api.?key)', __import__('re').I)
FORBIDDEN_PROVENANCE = __import__('re').compile(r'(?:^|[^a-z])(fixture|fake|example|tests?)(?:[^a-z]|$)', __import__('re').I)
ABSOLUTE_PATH = __import__('re').compile(r'^(?:[a-z]:[\\/]|/)', __import__('re').I)
CANDIDATE_VALUE_INVALID = object()


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


def candidate_count(value):
    if value is None:
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else CANDIDATE_VALUE_INVALID


def candidate_metric(value):
    if value is None:
        return None
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else CANDIDATE_VALUE_INVALID


def unknown_full_cost_evidence():
    return {
        'fullCostReady': False,
        'components': {
            key: {'state': 'UNKNOWN', 'valuePercent': None, 'provenance': None}
            for key in FULL_COST_KEYS
        },
    }


def unsafe_browser_evidence(value, key=''):
    if value is None:
        return False
    if FORBIDDEN_EVIDENCE_KEY.search(key):
        return True
    if isinstance(value, str):
        return bool(('path' in key.lower() and ABSOLUTE_PATH.search(value))
                    or (key.lower() in ('provenance', 'sourceowner') and FORBIDDEN_PROVENANCE.search(value)))
    if isinstance(value, list):
        return any(unsafe_browser_evidence(item, key) for item in value)
    if isinstance(value, dict):
        return any(unsafe_browser_evidence(child, child_key) for child_key, child in value.items())
    return False


def summarize_full_cost_evidence(value):
    if not isinstance(value, dict) or value.get('fullCostReady') is not False or not isinstance(value.get('components'), dict):
        return None
    components = {}
    for key in FULL_COST_KEYS:
        component = value['components'].get(key)
        if not isinstance(component, dict) or component.get('state') not in FULL_COST_STATES:
            return None
        value_ready = component['state'] in ('MEASURED', 'MODELED')
        value_percent = candidate_metric(component.get('valuePercent'))
        provenance = component.get('provenance')
        if ((value_ready and (value_percent in (None, CANDIDATE_VALUE_INVALID) or value_percent < 0))
                or (not value_ready and value_percent is not None)
                or (provenance is not None and (
                    not isinstance(provenance, str)
                    or not SAFE_ID_PATTERN.fullmatch(provenance)
                    or FORBIDDEN_PROVENANCE.search(provenance)
                ))):
            return None
        components[key] = {
            'state': component['state'],
            'valuePercent': value_percent,
            'provenance': provenance,
        }
    return {'fullCostReady': False, 'components': components}


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


def empty_candidate_performance(status, present, reason=None):
    return {
        'present': present,
        'status': status,
        'schemaVersion': None,
        'FIRST_ZERO': reason,
        'reason': reason,
        'candidateId': None,
        'strategyId': None,
        'freezeTimestamp': None,
        'identity14Verified': False,
        'fullCostEvidence': unknown_full_cost_evidence(),
        **{key: None for key in CANDIDATE_COUNT_KEYS},
        **{key: None for key in CANDIDATE_METRIC_KEYS},
        'FULL_COST_READY': False,
        'NET_ALPHA_PROVEN': False,
        'PROFITABILITY_PROVEN': False,
        'TRAIN_DIAGNOSTIC_ONLY': True,
        'VALIDATION_COMPLETE': False,
        'OOS_COMPLETE': False,
        'executionAuthority': 'NONE',
    }


def safe_candidate_promotion_identity(value):
    if not isinstance(value, dict):
        return None
    required = (
        'candidateId', 'strategyId', 'strategyVersion', 'parameterHash', 'researchCodeSha',
        'market', 'timeframe', 'sidePolicy', 'accountMode', 'costPolicyVersion', 'executionPolicyVersion',
    )
    if not all(isinstance(value.get(key), str) and value.get(key) for key in required):
        return None
    if (
        not CANDIDATE_ID_PATTERN.fullmatch(value['candidateId'])
        or not SAFE_ID_PATTERN.fullmatch(value['strategyId'])
        or not SAFE_ID_PATTERN.fullmatch(value['strategyVersion'])
        or not DIGEST64_PATTERN.fullmatch(value['parameterHash'])
        or not SHA40_PATTERN.fullmatch(value['researchCodeSha'])
        or not SAFE_ID_PATTERN.fullmatch(value['market'])
        or not SAFE_ID_PATTERN.fullmatch(value['timeframe'])
        or not SAFE_ID_PATTERN.fullmatch(value['sidePolicy'])
        or value['accountMode'] != 'PAPER'
        or not SAFE_ID_PATTERN.fullmatch(value['costPolicyVersion'])
        or not SAFE_ID_PATTERN.fullmatch(value['executionPolicyVersion'])
    ):
        return None
    return {
        'candidateId': value['candidateId'],
        'strategyId': value['strategyId'],
        'strategyVersion': value['strategyVersion'],
        'parameterHash': value['parameterHash'].lower(),
        'researchCodeSha': value['researchCodeSha'].lower(),
        'market': value['market'],
        'timeframe': value['timeframe'],
        'sidePolicy': value['sidePolicy'],
        'accountMode': 'PAPER',
        'costPolicyVersion': value['costPolicyVersion'],
        'executionPolicyVersion': value['executionPolicyVersion'],
    }


def summarize_candidate_performance(value, read_failed=False):
    if read_failed:
        return empty_candidate_performance('INVALID', True, 'CANDIDATE_PERFORMANCE_READ_FAILED')
    if value is None:
        return empty_candidate_performance('MISSING', False, 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING')
    if not isinstance(value, dict) or value.get('schemaVersion') != CANDIDATE_PERFORMANCE_SCHEMA:
        return empty_candidate_performance('INVALID', True, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID')
    if unsafe_browser_evidence(value):
        return empty_candidate_performance('INVALID', True, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID')
    reason = value.get('reason') if isinstance(value.get('reason'), str) and SAFE_ID_PATTERN.fullmatch(value.get('reason')) else None
    counts = {key: candidate_count(value.get(key)) for key in CANDIDATE_COUNT_KEYS}
    metrics = {key: candidate_metric(value.get(key)) for key in CANDIDATE_METRIC_KEYS}
    safety_valid = (
        value.get('FULL_COST_READY') is False
        and value.get('NET_ALPHA_PROVEN') is False
        and value.get('PROFITABILITY_PROVEN') is False
        and value.get('TRAIN_DIAGNOSTIC_ONLY') is True
        and value.get('VALIDATION_COMPLETE') is False
        and value.get('OOS_COMPLETE') is False
        and all(value.get(key) == 0 for key in (
            'sampleCredit', 'executionRealismCredit', 'profitabilityCredit', 'backfillCredit',
            'replayCredit', 'syntheticCredit', 'manualEconomicCredit', 'realOrderCount',
            'cancelCount', 'amendCount', 'transferCount', 'withdrawalCount',
        ))
        and value.get('executionAuthority') == 'NONE'
        and value.get('LIVE_TRADING') is False
        and value.get('AUTO_TRADING') is False
        and value.get('REAL_ORDER_ENABLED') is False
        and value.get('PRIVATE_TRADING_API_ALLOWED') is False
        and value.get('Net_PnL') is None
    )
    full_cost_evidence = summarize_full_cost_evidence(value.get('fullCostEvidence'))
    if (not safety_valid or reason is None or full_cost_evidence is None
            or CANDIDATE_VALUE_INVALID in counts.values()
            or CANDIDATE_VALUE_INVALID in metrics.values()):
        return empty_candidate_performance('INVALID', True, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID')
    if value.get('status') == 'BLOCKED':
        unavailable = all(item is None for item in (
            value.get('candidateId'), value.get('strategyId'), value.get('freezeTimestamp'),
            *counts.values(), *metrics.values(),
        ))
        return empty_candidate_performance(
            'BLOCKED' if unavailable else 'INVALID',
            True,
            reason if unavailable else 'CANDIDATE_PERFORMANCE_BLOCKED_PARTIAL_EVIDENCE',
        )
    try:
        freeze_timestamp = __import__('datetime').datetime.fromisoformat(str(value.get('freezeTimestamp')).replace('Z', '+00:00'))
        freeze_valid = freeze_timestamp.tzinfo is not None and freeze_timestamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value.get('freezeTimestamp')
    except (TypeError, ValueError):
        freeze_valid = False
    identity_valid = (
        value.get('status') == 'PRESENT'
        and isinstance(value.get('candidateId'), str) and CANDIDATE_ID_PATTERN.fullmatch(value.get('candidateId'))
        and isinstance(value.get('strategyId'), str) and SAFE_ID_PATTERN.fullmatch(value.get('strategyId'))
        and freeze_valid
        and value.get('identity14Verified') is True
        and isinstance(value.get('identity'), dict)
        and all(isinstance(value['identity'].get(key), str) and value['identity'][key] for key in CANDIDATE_IDENTITY_KEYS)
        and value['identity'].get('candidateId') == value.get('candidateId')
        and value['identity'].get('strategyId') == value.get('strategyId')
        and value['identity'].get('accountMode') == 'PAPER'
        and bool(__import__('re').fullmatch(r'[0-9a-fA-F]{40}', value['identity'].get('researchCodeSha', '')))
        and bool(__import__('re').fullmatch(r'[0-9a-fA-F]{64}', value['identity'].get('parameterHash', '')))
        and value['identity'].get('parameterHash') == value['identity'].get('parameterDigest')
        and isinstance(value.get('provenance'), dict)
        and value['provenance'].get('evidenceClass') == 'PRODUCTION_AUTHORITATIVE'
        and isinstance(value['provenance'].get('sourceOwner'), str) and bool(value['provenance']['sourceOwner'])
        and value['provenance'].get('fixture') is False
        and value['provenance'].get('synthetic') is False
        and value['provenance'].get('replay') is False
        and value['provenance'].get('backfill') is False
        and value['provenance'].get('manual') is False
    )
    promotion_identity = safe_candidate_promotion_identity(value.get('identity'))
    matched = counts['candidateMatchedN']
    direction_counts = [counts[key] for key in ('LONG_SIGNAL_N', 'SHORT_SIGNAL_N', 'NO_TRADE_N')]
    split_counts = [counts[key] for key in ('TRAIN_N', 'VALIDATION_N', 'OOS_N')]
    match_valid = (
        all(item is None for item in (*direction_counts, *split_counts)) if matched is None
        else all(item is not None for item in (*direction_counts, *split_counts))
        and sum(direction_counts) == matched and sum(split_counts) == matched
    )
    settlement = counts['Settlement_N']
    settlement_counts = [counts[key] for key in ('WIN_N', 'LOSS_N', 'BREAKEVEN_N')]
    settlement_valid = (
        all(item is None for item in settlement_counts) and metrics['Gross_PnL'] is None if settlement is None
        else all(item is not None for item in settlement_counts)
        and sum(settlement_counts) == settlement and metrics['Gross_PnL'] is not None
    )
    lifecycle_valid = (
        (counts['Entry_N'] is None or counts['Position_N'] is None or counts['Position_N'] <= counts['Entry_N'])
        and (counts['Position_N'] is None or counts['Settlement_N'] is None or counts['Settlement_N'] <= counts['Position_N'])
    )
    if not identity_valid or not match_valid or not settlement_valid or not lifecycle_valid:
        return empty_candidate_performance('INVALID', True, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID')
    return {
        'present': True,
        'status': 'PRESENT',
        'schemaVersion': CANDIDATE_PERFORMANCE_SCHEMA,
        'FIRST_ZERO': reason,
        'reason': reason,
        'candidateId': value.get('candidateId'),
        'strategyId': value.get('strategyId'),
        'freezeTimestamp': value.get('freezeTimestamp'),
        'identity14Verified': True,
        'promotionIdentity': promotion_identity,
        'fullCostEvidence': full_cost_evidence,
        **counts,
        **metrics,
        'FULL_COST_READY': False,
        'NET_ALPHA_PROVEN': False,
        'PROFITABILITY_PROVEN': False,
        'TRAIN_DIAGNOSTIC_ONLY': True,
        'VALIDATION_COMPLETE': False,
        'OOS_COMPLETE': False,
        'executionAuthority': 'NONE',
    }


def read_candidate_performance(root):
    path = root / 'forward' / 'paper' / 'status' / 'candidate-performance.json'
    try:
        return summarize_candidate_performance(read_json_optional(path))
    except RuntimeError:
        return summarize_candidate_performance(None, read_failed=True)


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


def empty_temporal_crypto_summary(status='MISSING', present=False):
    return {
        'present': present,
        'status': status,
        'generatedAt': None,
        'researchSha': None,
        'failedCount': None,
        'observationCount': None,
        'ledgerDigest': None,
        'results': [],
    }


def summarize_temporal_crypto_summary(value, read_failed=False):
    if read_failed:
        return empty_temporal_crypto_summary('INVALID', True)
    if value is None:
        return empty_temporal_crypto_summary()
    if not isinstance(value, dict):
        return empty_temporal_crypto_summary('INVALID', True)
    if (
        value.get('schemaVersion') != TEMPORAL_CRYPTO_SUMMARY_SCHEMA
        or value.get('status') not in TEMPORAL_COLLECTION_STATUSES
        or not isinstance(value.get('generatedAt'), int) or isinstance(value.get('generatedAt'), bool) or value.get('generatedAt') <= 0
        or not isinstance(value.get('researchSha'), str) or not SHA40_PATTERN.fullmatch(value.get('researchSha'))
        or not isinstance(value.get('failedCount'), int) or isinstance(value.get('failedCount'), bool) or value.get('failedCount') < 0
        or not isinstance(value.get('observationCount'), int) or isinstance(value.get('observationCount'), bool) or value.get('observationCount') < 0
        or not isinstance(value.get('ledgerDigest'), str) or not DIGEST64_PATTERN.fullmatch(value.get('ledgerDigest'))
        or not isinstance(value.get('results'), list) or len(value.get('results')) > 50
    ):
        return empty_temporal_crypto_summary('INVALID', True)
    safety = value.get('safety')
    if not isinstance(safety, dict) or not (
        safety.get('publicDataOnly') is True
        and safety.get('privateApi') is False
        and safety.get('liveTrading') is False
        and safety.get('realOrders') is False
        and safety.get('historicalCurrentValueBackfill') is False
        and safety.get('executionAuthority') == 'NONE'
    ):
        return empty_temporal_crypto_summary('INVALID', True)
    results = []
    for raw in value.get('results'):
        if not isinstance(raw, dict):
            return empty_temporal_crypto_summary('INVALID', True)
        symbol = raw.get('symbol')
        status = raw.get('status')
        observed_count = raw.get('observedCount')
        appended_count = raw.get('appendedCount')
        if (
            not isinstance(symbol, str) or not TEMPORAL_SYMBOL_PATTERN.fullmatch(symbol)
            or status not in TEMPORAL_SYMBOL_STATUSES
            or not isinstance(observed_count, int) or isinstance(observed_count, bool) or observed_count < 0
            or not isinstance(appended_count, int) or isinstance(appended_count, bool) or appended_count < 0
            or appended_count > observed_count
        ):
            return empty_temporal_crypto_summary('INVALID', True)
        results.append({
            'symbol': symbol,
            'status': status,
            'observedCount': observed_count,
            'appendedCount': appended_count,
        })
    if sum(1 for row in results if row.get('status') == 'failed') != value.get('failedCount'):
        return empty_temporal_crypto_summary('INVALID', True)
    return {
        'present': True,
        'status': value.get('status'),
        'generatedAt': value.get('generatedAt'),
        'researchSha': value.get('researchSha').lower(),
        'failedCount': value.get('failedCount'),
        'observationCount': value.get('observationCount'),
        'ledgerDigest': value.get('ledgerDigest').lower(),
        'results': results,
    }


def read_temporal_crypto_summary(root):
    try:
        return summarize_temporal_crypto_summary(read_json_optional(root / 'latest' / 'temporal-crypto-futures.json'))
    except (OSError, ValueError, json.JSONDecodeError):
        return empty_temporal_crypto_summary('INVALID', True)


def empty_factory_runtime_summary(status='MISSING', present=False):
    return {
        'present': present,
        'status': status,
        'generatedAt': None,
        'researchSha': None,
        'firstZero': None,
        'policyPresent': None,
        'policyValid': None,
        'policyDigest': None,
        'readyMarketCount': None,
        'blockedMarketCount': None,
        'readyProfileCount': None,
        'blockedProfileCount': None,
        'runtimeStatus': None,
        'nextFirstZero': None,
        'controlPlaneDigest': None,
    }


def summarize_factory_runtime_status(value, read_failed=False):
    if read_failed:
        return empty_factory_runtime_summary('INVALID', True)
    if value is None:
        return empty_factory_runtime_summary()
    if not isinstance(value, dict) or value.get('contract') != FACTORY_RUNTIME_CONTRACT:
        return empty_factory_runtime_summary('INVALID', True)
    if value.get('status') not in FACTORY_RUNTIME_STATUSES:
        return empty_factory_runtime_summary('INVALID', True)
    try:
        generated_at = int(__import__('datetime').datetime.fromisoformat(
            str(value.get('generatedAt')).replace('Z', '+00:00')
        ).timestamp() * 1000)
    except (TypeError, ValueError):
        return empty_factory_runtime_summary('INVALID', True)
    research_sha = value.get('researchSha')
    first_zero = value.get('firstZero')
    policy = value.get('policy')
    data_factory = value.get('dataFactory')
    adaptive = value.get('canonicalAdaptive')
    safety = value.get('safety')
    if (
        not isinstance(research_sha, str) or not SHA40_PATTERN.fullmatch(research_sha)
        or not isinstance(first_zero, str) or not SAFE_ID_PATTERN.fullmatch(first_zero)
        or not isinstance(policy, dict)
        or not isinstance(data_factory, dict)
        or not isinstance(adaptive, dict)
        or not isinstance(safety, dict)
    ):
        return empty_factory_runtime_summary('INVALID', True)
    if not (
        safety.get('runtimeExecutionAttempted') is False
        and safety.get('runtimeActivationAllowed') is False
        and safety.get('scheduleMutationAllowed') is False
        and safety.get('deploymentAllowed') is False
        and safety.get('databaseMutationAllowed') is False
        and safety.get('secretMutationAllowed') is False
        and safety.get('liveTrading') is False
        and safety.get('autoTrading') is False
        and safety.get('privateTradingApi') is False
        and safety.get('realOrder') is False
        and safety.get('profitabilityClaim') is False
        and safety.get('executionAuthority') == 'NONE'
    ):
        return empty_factory_runtime_summary('INVALID', True)

    def nullable_count(raw):
        if raw is None:
            return None
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
            raise ValueError('invalid count')
        return raw

    try:
        ready_market = nullable_count(data_factory.get('readyMarketCount'))
        blocked_market = nullable_count(data_factory.get('blockedMarketCount'))
        ready_profile = nullable_count(adaptive.get('readyProfileCount'))
        blocked_profile = nullable_count(adaptive.get('blockedProfileCount'))
    except ValueError:
        return empty_factory_runtime_summary('INVALID', True)

    policy_present = policy.get('present')
    policy_valid = policy.get('valid')
    if not isinstance(policy_present, bool) or not isinstance(policy_valid, bool):
        return empty_factory_runtime_summary('INVALID', True)
    policy_digest = policy.get('policyDigest')
    control_digest = value.get('controlPlaneDigest')
    if policy_digest is not None and (not isinstance(policy_digest, str) or not DIGEST64_PATTERN.fullmatch(policy_digest)):
        return empty_factory_runtime_summary('INVALID', True)
    if control_digest is not None and (not isinstance(control_digest, str) or not DIGEST64_PATTERN.fullmatch(control_digest)):
        return empty_factory_runtime_summary('INVALID', True)
    if not policy_present and (policy_valid or policy_digest is not None):
        return empty_factory_runtime_summary('INVALID', True)

    runtime_status = adaptive.get('runtimeStatus')
    next_first_zero = adaptive.get('nextFirstZero')
    if runtime_status is not None and (not isinstance(runtime_status, str) or not SAFE_ID_PATTERN.fullmatch(runtime_status)):
        return empty_factory_runtime_summary('INVALID', True)
    if next_first_zero is not None and (not isinstance(next_first_zero, str) or not SAFE_ID_PATTERN.fullmatch(next_first_zero)):
        return empty_factory_runtime_summary('INVALID', True)

    return {
        'present': True,
        'status': value.get('status'),
        'generatedAt': generated_at,
        'researchSha': research_sha.lower(),
        'firstZero': first_zero,
        'policyPresent': policy_present,
        'policyValid': policy_valid,
        'policyDigest': policy_digest.lower() if isinstance(policy_digest, str) else None,
        'readyMarketCount': ready_market,
        'blockedMarketCount': blocked_market,
        'readyProfileCount': ready_profile,
        'blockedProfileCount': blocked_profile,
        'runtimeStatus': runtime_status,
        'nextFirstZero': next_first_zero,
        'controlPlaneDigest': control_digest.lower() if isinstance(control_digest, str) else None,
    }


def read_factory_runtime_summary(root):
    try:
        return summarize_factory_runtime_status(read_json_optional(root / 'latest' / 'research-factory.json'))
    except (OSError, ValueError, json.JSONDecodeError):
        return empty_factory_runtime_summary('INVALID', True)


def build_research_overview(state_root=DEFAULT_STATE_ROOT):
    root = Path(state_root).resolve()
    cycles = [summarize_cycle(profile, read_json_optional(root / 'latest' / f'{profile}.json')) for profile in PROFILES]
    paper_runtime = summarize_paper_runtime(read_json_optional(root / 'forward' / 'paper' / 'status' / 'runtime-status.json'))
    paper_ledger = summarize_paper_ledger(read_json_optional(root / 'forward' / 'paper' / 'state' / 'recurring-paper-loop.json'))
    shadow_groups = summarize_shadow_groups(read_json_optional(root / 'forward' / 'shadow-summary.json'))
    shadow_state = read_json_optional(root / 'forward' / 'shadow-state.json')
    shadow_records = count_shadow_records(shadow_state)
    shadow_canonical_handoffs = canonical_shadow_handoffs(shadow_state)
    liquidity_independence = read_v3_independence_summary(root, read_json_optional)
    candidate_performance = read_candidate_performance(root)
    temporal_crypto = read_temporal_crypto_summary(root)
    factory_runtime = read_factory_runtime_summary(root)
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
        else 'attention' if (
            liquidity_independence.get('status') == 'INVALID'
            or candidate_performance.get('status') == 'INVALID'
            or temporal_crypto.get('status') in ('INVALID', 'partial_failure')
            or factory_runtime.get('status') in ('INVALID', 'BLOCKED_POLICY_INVALID')
        )
        else 'evidence_incomplete' if failed_tasks is None or blocked_data_tasks is None
        else 'attention' if failed_tasks > 0
        else 'collecting'
    )
    return {
        'schemaVersion': 'research-dashboard-overview-v1',
        'generatedAt': int(__import__('time').time() * 1000),
        'state': {
            'present': any(cycle.get('present') for cycle in cycles) or paper_runtime.get('present') or paper_ledger.get('present') or shadow_records.get('present') or liquidity_independence.get('present') or candidate_performance.get('present') or temporal_crypto.get('present') or factory_runtime.get('present'),
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
            'liquidityIndependence': liquidity_independence,
        },
        'dataFactory': {'temporalCryptoFutures': temporal_crypto},
        'factory': factory_runtime,
        'paper': {'runtime': paper_runtime, 'ledger': paper_ledger, 'candidatePerformance': candidate_performance},
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
