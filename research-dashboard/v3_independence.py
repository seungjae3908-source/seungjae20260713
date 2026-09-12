import hashlib
import json
import math
import re
from pathlib import Path

V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH = Path('forward/liquidity/v3-authoritative-independence-summary.json')
V3_INDEPENDENCE_SUMMARY_SCHEMA = 'public-forward-liquidity-v3-authoritative-independence-summary-v1'
SHA_PATTERN = re.compile(r'^[0-9a-f]{40}$')
DIGEST_PATTERN = re.compile(r'^[0-9a-f]{64}$')
ID_PATTERN = re.compile(r'^[0-9]{6,20}$')
SPLIT_COUNT_KEYS = (
    'TRAIN',
    'TRAIN_BUY',
    'TRAIN_SELL',
    'VALIDATION',
    'VALIDATION_BUY',
    'VALIDATION_SELL',
    'OOS',
    'OOS_BUY',
    'OOS_SELL',
)


def _optional_integer_count(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or not number.is_integer() or number < 0:
        return None
    return int(number)


def _canonical_digest(value):
    body = dict(value)
    body.pop('reportDigest', None)
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def _empty_v3_independence(status, present):
    return {
        'present': present,
        'status': status,
        'schemaVersion': None,
        'producerSha': None,
        'upstreamIngestRunId': None,
        'upstreamIngestArtifactId': None,
        'upstreamIngestArtifactDigest': None,
        'sourceInventoryDigest': None,
        'targetSlotIndex': None,
        'genuineScheduledSlotN': None,
        'rawAcceptedN': None,
        'effectiveIndependentN': None,
        'independentBuyN': None,
        'independentSellN': None,
        'independenceAuditDigest': None,
        'independentSplitSourceDigest': None,
        'v3IndependentSplitIndexDigest': None,
        'frozenSplitCounts': {key: None for key in SPLIT_COUNT_KEYS},
        'oosOutcomeCredit': None,
        'calibrationArtifactProduced': None,
        'liquidityImpactStatus': None,
        'fullCostReady': None,
        'evidenceComplete': None,
        'executionAuthority': None,
        'reportDigest': None,
    }


def summarize_v3_independence(value, read_failed=False):
    if read_failed:
        return _empty_v3_independence('INVALID', True)
    if value is None:
        return _empty_v3_independence('MISSING', False)
    if not isinstance(value, dict):
        return _empty_v3_independence('INVALID', True)

    split_counts = value.get('frozenSplitCounts') if isinstance(value.get('frozenSplitCounts'), dict) else {}
    counts = {key: _optional_integer_count(split_counts.get(key)) for key in SPLIT_COUNT_KEYS}
    target_slot_index = _optional_integer_count(value.get('targetSlotIndex'))
    genuine_scheduled_slot_n = _optional_integer_count(value.get('genuineScheduledSlotN'))
    raw_accepted_n = _optional_integer_count(value.get('rawAcceptedN'))
    effective_independent_n = _optional_integer_count(value.get('effectiveIndependentN'))
    independent_buy_n = _optional_integer_count(value.get('independentBuyN'))
    independent_sell_n = _optional_integer_count(value.get('independentSellN'))
    oos_outcome_credit = _optional_integer_count(value.get('oosOutcomeCredit'))
    evidence_complete = _optional_integer_count(value.get('evidenceComplete'))

    required_digests = (
        value.get('upstreamIngestArtifactDigest'),
        value.get('sourceInventoryDigest'),
        value.get('independenceAuditDigest'),
        value.get('independentSplitSourceDigest'),
        value.get('v3IndependentSplitIndexDigest'),
        value.get('reportDigest'),
    )

    shape_valid = (
        value.get('schemaVersion') == V3_INDEPENDENCE_SUMMARY_SCHEMA
        and isinstance(value.get('producerSha'), str)
        and bool(SHA_PATTERN.fullmatch(value['producerSha']))
        and bool(ID_PATTERN.fullmatch(str(value.get('upstreamIngestRunId', ''))))
        and bool(ID_PATTERN.fullmatch(str(value.get('upstreamIngestArtifactId', ''))))
        and all(isinstance(item, str) and bool(DIGEST_PATTERN.fullmatch(item)) for item in required_digests)
        and target_slot_index is not None
        and genuine_scheduled_slot_n is not None
        and raw_accepted_n is not None
        and effective_independent_n is not None
        and independent_buy_n is not None
        and independent_sell_n is not None
        and all(counts[key] is not None for key in SPLIT_COUNT_KEYS)
        and oos_outcome_credit == 0
        and value.get('calibrationArtifactProduced') is False
        and value.get('liquidityImpactStatus') == 'BLOCKED_DATA'
        and value.get('fullCostReady') is False
        and evidence_complete == 0
        and value.get('executionAuthority') == 'NONE'
        and value.get('frozenV3SplitIndexPresent') is True
        and value.get('v2SplitReceiptPresent') is False
        and raw_accepted_n >= effective_independent_n
        and genuine_scheduled_slot_n >= effective_independent_n
        and effective_independent_n == independent_buy_n + independent_sell_n
        and counts['TRAIN'] == counts['TRAIN_BUY'] + counts['TRAIN_SELL']
        and counts['VALIDATION'] == counts['VALIDATION_BUY'] + counts['VALIDATION_SELL']
        and counts['OOS'] == counts['OOS_BUY'] + counts['OOS_SELL']
        and effective_independent_n == counts['TRAIN'] + counts['VALIDATION'] + counts['OOS']
        and independent_buy_n == counts['TRAIN_BUY'] + counts['VALIDATION_BUY'] + counts['OOS_BUY']
        and independent_sell_n == counts['TRAIN_SELL'] + counts['VALIDATION_SELL'] + counts['OOS_SELL']
        and _canonical_digest(value) == value.get('reportDigest')
    )
    if not shape_valid:
        return _empty_v3_independence('INVALID', True)

    return {
        'present': True,
        'status': 'PRESENT',
        'schemaVersion': value['schemaVersion'],
        'producerSha': value['producerSha'],
        'upstreamIngestRunId': value['upstreamIngestRunId'],
        'upstreamIngestArtifactId': value['upstreamIngestArtifactId'],
        'upstreamIngestArtifactDigest': value['upstreamIngestArtifactDigest'],
        'sourceInventoryDigest': value['sourceInventoryDigest'],
        'targetSlotIndex': target_slot_index,
        'genuineScheduledSlotN': genuine_scheduled_slot_n,
        'rawAcceptedN': raw_accepted_n,
        'effectiveIndependentN': effective_independent_n,
        'independentBuyN': independent_buy_n,
        'independentSellN': independent_sell_n,
        'independenceAuditDigest': value['independenceAuditDigest'],
        'independentSplitSourceDigest': value['independentSplitSourceDigest'],
        'v3IndependentSplitIndexDigest': value['v3IndependentSplitIndexDigest'],
        'frozenSplitCounts': counts,
        'oosOutcomeCredit': 0,
        'calibrationArtifactProduced': False,
        'liquidityImpactStatus': 'BLOCKED_DATA',
        'fullCostReady': False,
        'evidenceComplete': 0,
        'executionAuthority': 'NONE',
        'reportDigest': value['reportDigest'],
    }


def read_v3_independence_summary(root, read_json_optional):
    path = Path(root) / V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH
    try:
        return summarize_v3_independence(read_json_optional(path))
    except Exception:
        return summarize_v3_independence(None, read_failed=True)
