#!/usr/bin/env python3
import hashlib
import json
import os
import re
import shlex
import urllib.request
from pathlib import Path

DEFAULT_ROOT = '/var/lib/investment-research-production'
RELATIVE_PATH = Path('forward/liquidity/v3-authoritative-independence-summary.json')
EXPECTED_SCHEMA = 'public-forward-liquidity-v3-authoritative-independence-summary-v1'
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
DIGEST_RE = re.compile(r'^[0-9a-f]{64}$')
SPLIT_KEYS = (
    'TRAIN', 'TRAIN_BUY', 'TRAIN_SELL',
    'VALIDATION', 'VALIDATION_BUY', 'VALIDATION_SELL',
    'OOS', 'OOS_BUY', 'OOS_SELL',
)


def nonnegative_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_proc_env(pid):
    values = {}
    for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
        if not item or b'=' not in item:
            continue
        key, value = item.split(b'=', 1)
        values[key.decode('utf-8', 'replace')] = value.decode('utf-8', 'replace')
    return values


def parse_systemd_env(raw):
    values = {}
    for token in shlex.split(raw or ''):
        if '=' not in token:
            continue
        key, value = token.split('=', 1)
        values[key] = value
    return values


def runtime_command(pid, fallback):
    try:
        parts = [
            part.decode('utf-8', 'replace')
            for part in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if part
        ]
        if parts:
            return ' '.join(parts)
    except Exception:
        pass
    return fallback or ''


def canonical_digest(value):
    body = dict(value)
    body.pop('reportDigest', None)
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def validate_v3(value):
    if not isinstance(value, dict):
        return False, False, False, {}

    schema_valid = value.get('schemaVersion') == EXPECTED_SCHEMA
    report_digest = value.get('reportDigest')
    report_digest_valid = (
        isinstance(report_digest, str)
        and bool(DIGEST_RE.fullmatch(report_digest))
        and canonical_digest(value) == report_digest
    )
    frozen = value.get('frozenSplitCounts') if isinstance(value.get('frozenSplitCounts'), dict) else {}
    counts = {key: frozen.get(key) for key in SPLIT_KEYS}
    numeric = {
        'targetSlotIndex': value.get('targetSlotIndex'),
        'genuineScheduledSlotN': value.get('genuineScheduledSlotN'),
        'rawAcceptedN': value.get('rawAcceptedN'),
        'effectiveIndependentN': value.get('effectiveIndependentN'),
        'independentBuyN': value.get('independentBuyN'),
        'independentSellN': value.get('independentSellN'),
        'oosOutcomeCredit': value.get('oosOutcomeCredit'),
        'evidenceComplete': value.get('evidenceComplete'),
    }
    required_digests = (
        value.get('upstreamIngestArtifactDigest'),
        value.get('sourceInventoryDigest'),
        value.get('independenceAuditDigest'),
        value.get('independentSplitSourceDigest'),
        value.get('v3IndependentSplitIndexDigest'),
        value.get('reportDigest'),
    )

    shape_valid = (
        schema_valid
        and isinstance(value.get('producerSha'), str)
        and bool(SHA_RE.fullmatch(value['producerSha']))
        and bool(re.fullmatch(r'[0-9]{6,20}', str(value.get('upstreamIngestRunId', ''))))
        and bool(re.fullmatch(r'[0-9]{6,20}', str(value.get('upstreamIngestArtifactId', ''))))
        and all(isinstance(item, str) and bool(DIGEST_RE.fullmatch(item)) for item in required_digests)
        and all(nonnegative_int(item) for item in numeric.values())
        and all(nonnegative_int(counts.get(key)) for key in SPLIT_KEYS)
        and numeric['oosOutcomeCredit'] == 0
        and value.get('calibrationArtifactProduced') is False
        and value.get('liquidityImpactStatus') == 'BLOCKED_DATA'
        and value.get('fullCostReady') is False
        and numeric['evidenceComplete'] == 0
        and value.get('executionAuthority') == 'NONE'
        and value.get('frozenV3SplitIndexPresent') is True
        and value.get('v2SplitReceiptPresent') is False
        and numeric['rawAcceptedN'] >= numeric['effectiveIndependentN']
        and numeric['genuineScheduledSlotN'] >= numeric['effectiveIndependentN']
        and numeric['effectiveIndependentN'] == numeric['independentBuyN'] + numeric['independentSellN']
        and counts['TRAIN'] == counts['TRAIN_BUY'] + counts['TRAIN_SELL']
        and counts['VALIDATION'] == counts['VALIDATION_BUY'] + counts['VALIDATION_SELL']
        and counts['OOS'] == counts['OOS_BUY'] + counts['OOS_SELL']
        and numeric['effectiveIndependentN'] == counts['TRAIN'] + counts['VALIDATION'] + counts['OOS']
        and numeric['independentBuyN'] == counts['TRAIN_BUY'] + counts['VALIDATION_BUY'] + counts['OOS_BUY']
        and numeric['independentSellN'] == counts['TRAIN_SELL'] + counts['VALIDATION_SELL'] + counts['OOS_SELL']
        and report_digest_valid
    )

    observed = {
        'genuineScheduledSlotN': numeric['genuineScheduledSlotN'],
        'effectiveIndependentN': numeric['effectiveIndependentN'],
        'independentBuyN': numeric['independentBuyN'],
        'independentSellN': numeric['independentSellN'],
        'TRAIN': counts.get('TRAIN'),
        'TRAIN_BUY': counts.get('TRAIN_BUY'),
        'TRAIN_SELL': counts.get('TRAIN_SELL'),
        'VALIDATION': counts.get('VALIDATION'),
        'OOS': counts.get('OOS'),
        'oosOutcomeCredit': numeric['oosOutcomeCredit'],
        'fullCostReady': value.get('fullCostReady'),
        'evidenceComplete': numeric['evidenceComplete'],
        'executionAuthority': value.get('executionAuthority'),
    }
    expected_truth_match = observed == {
        'genuineScheduledSlotN': 15,
        'effectiveIndependentN': 15,
        'independentBuyN': 10,
        'independentSellN': 5,
        'TRAIN': 15,
        'TRAIN_BUY': 10,
        'TRAIN_SELL': 5,
        'VALIDATION': 0,
        'OOS': 0,
        'oosOutcomeCredit': 0,
        'fullCostReady': False,
        'evidenceComplete': 0,
        'executionAuthority': 'NONE',
    }
    return schema_valid, report_digest_valid, shape_valid, observed, expected_truth_match


def main():
    pid = int(os.environ['RESEARCH_DIAG_MAIN_PID'])
    state_root = None
    state_root_source = None
    try:
        proc_env = parse_proc_env(pid)
        if proc_env.get('RESEARCH_STATE_ROOT'):
            state_root = proc_env['RESEARCH_STATE_ROOT']
            state_root_source = 'PROC_ENV'
    except Exception:
        pass

    if state_root is None:
        unit_env = parse_systemd_env(os.environ.get('RESEARCH_DIAG_UNIT_ENV', ''))
        if unit_env.get('RESEARCH_STATE_ROOT'):
            state_root = unit_env['RESEARCH_STATE_ROOT']
            state_root_source = 'SYSTEMD_ENV'

    if state_root is None:
        state_root = DEFAULT_ROOT
        state_root_source = 'DEFAULT_FALLBACK'

    command = runtime_command(pid, os.environ.get('RESEARCH_DIAG_EXEC_START', ''))
    if 'server.py' in command:
        runtime_kind = 'PYTHON_SERVER'
    elif 'server.mjs' in command:
        runtime_kind = 'NODE_SERVER'
    else:
        runtime_kind = 'UNKNOWN'

    root = Path(state_root).resolve()
    expected_path = root / RELATIVE_PATH
    file_exists = expected_path.exists()
    file_is_file = expected_path.is_file() if file_exists else False
    file_size = expected_path.stat().st_size if file_is_file else None
    file_readable = False
    json_parse_ok = False
    value = None
    read_error_class = None

    if file_is_file:
        try:
            value = json.loads(expected_path.read_text(encoding='utf-8'))
            file_readable = True
            json_parse_ok = True
        except PermissionError:
            read_error_class = 'PERMISSION_DENIED'
        except json.JSONDecodeError:
            file_readable = True
            read_error_class = 'JSON_PARSE_ERROR'
        except Exception:
            read_error_class = 'READ_ERROR'

    schema_valid, report_digest_valid, shape_valid, observed, expected_truth_match = validate_v3(value)

    if not file_exists:
        file_classification = 'MISSING'
    elif not file_is_file:
        file_classification = 'NOT_REGULAR_FILE'
    elif not file_readable:
        file_classification = read_error_class or 'UNREADABLE'
    elif not json_parse_ok:
        file_classification = read_error_class or 'INVALID_JSON'
    elif not shape_valid:
        file_classification = 'INVALID'
    elif not expected_truth_match:
        file_classification = 'VALID_UNEXPECTED_TRUTH'
    else:
        file_classification = 'VALID_EXPECTED_TRUTH'

    endpoint = None
    endpoint_error = None
    try:
        with urllib.request.urlopen('http://127.0.0.1:18090/api/research/overview', timeout=8) as response:
            endpoint = json.loads(response.read().decode('utf-8'))
    except Exception as error:
        endpoint_error = type(error).__name__

    research = endpoint.get('research') if isinstance(endpoint, dict) and isinstance(endpoint.get('research'), dict) else {}
    liquidity = research.get('liquidityIndependence')
    endpoint_li_field_present = isinstance(liquidity, dict)
    endpoint_li_present = liquidity.get('present') if endpoint_li_field_present else None
    endpoint_li_status = liquidity.get('status') if endpoint_li_field_present else None
    endpoint_safety = endpoint.get('safety') if isinstance(endpoint, dict) and isinstance(endpoint.get('safety'), dict) else {}

    if file_classification == 'MISSING':
        root_cause = 'RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_MISSING'
    elif file_classification in {'NOT_REGULAR_FILE', 'PERMISSION_DENIED', 'UNREADABLE', 'JSON_PARSE_ERROR', 'INVALID_JSON', 'READ_ERROR', 'INVALID'}:
        root_cause = 'RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_INVALID'
    elif endpoint_error is not None:
        root_cause = 'RESEARCH_OVERVIEW_ENDPOINT_READ_FAILED'
    elif not endpoint_li_field_present and runtime_kind == 'PYTHON_SERVER':
        root_cause = 'RESEARCH_DASHBOARD_PYTHON_RUNTIME_V3_CONSUMER_MISSING'
    elif not endpoint_li_field_present:
        root_cause = 'RESEARCH_DASHBOARD_RUNTIME_V3_CONSUMER_MISSING'
    elif endpoint_li_present is not True or endpoint_li_status != 'PRESENT':
        root_cause = 'RESEARCH_DASHBOARD_RUNTIME_V3_CONSUMER_REJECTED'
    elif file_classification == 'VALID_UNEXPECTED_TRUTH':
        root_cause = 'RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_STALE_OR_UNEXPECTED'
    else:
        root_cause = 'NO_V3_STATE_ROOT_DEFECT_OBSERVED'

    print(json.dumps({
        'stateRoot': str(root),
        'stateRootSource': state_root_source,
        'filePath': str(expected_path),
        'fileExists': file_exists,
        'fileIsFile': file_is_file,
        'fileSize': file_size,
        'fileReadable': file_readable,
        'jsonParseOk': json_parse_ok,
        'schemaValid': schema_valid,
        'reportDigestValid': report_digest_valid,
        'shapeValid': shape_valid,
        'expectedTruthMatch': expected_truth_match,
        'fileClassification': file_classification,
        'runtimeKind': runtime_kind,
        'endpointSchema': endpoint.get('schemaVersion') if isinstance(endpoint, dict) else None,
        'endpointLiquidityFieldPresent': endpoint_li_field_present,
        'endpointLiquidityPresent': endpoint_li_present,
        'endpointLiquidityStatus': endpoint_li_status,
        'endpointReadErrorClass': endpoint_error,
        'endpointReadOnly': endpoint_safety.get('readOnlyDashboard'),
        'endpointLiveTrading': endpoint_safety.get('liveTrading'),
        'endpointPrivateApi': endpoint_safety.get('privateApi'),
        'endpointOrderAuthority': endpoint_safety.get('orderAuthority'),
        'observed': observed,
        'rootCause': root_cause,
    }, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
