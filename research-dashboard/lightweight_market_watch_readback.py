"""Fail-closed readback for the isolated two-vCPU public watch.

Only projects safe aggregate fields into the existing loopback Research
Dashboard overview. Never exposes raw tickers, event logs, private keys,
a stock feed path, or any trading/economic attestation.
"""
import json
import os
import re
import stat
import time
from datetime import datetime, timezone
from pathlib import Path

CONTRACT = 'lightweight-market-watch-readback/v1'
SOURCE_CONTRACT = 'lightweight-market-opportunity-watch-v1'
MARKETS = ('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES')
SOURCE_STATUSES = frozenset(('READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE'))
RAW_STATUSES = frozenset(('OBSERVING_ALL_FOUR', 'PARTIAL_MARKET_COVERAGE',
                          'BLOCKED_DATA', 'THROTTLED', 'HOLD'))
SHA = re.compile(r'^[a-f0-9]{40}$')
SAFE_SOURCE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
BLOCKED_SOURCE = re.compile(r'^BLOCKED_[A-Z0-9_]{1,100}$')
MAX_BYTES = 64 * 1024
STALE_AFTER_MS = 6 * 60_000


def blank(status='MISSING', present=False):
    return {
        'contract': CONTRACT, 'status': status, 'present': present,
        'researchSha': None, 'observedAt': None, 'ageMs': None,
        'marketCoverageCount': None, 'markets': [],
        'cyclesToday': None, 'candidatesToday': None,
        'cyclesSinceRelease': None,
        'continuous24hProven': False, 'formulaCandidateProduced': False,
        'oosProven': False, 'paperExecutionProven': False,
        'profitabilityProven': False, 'executionAuthority': 'NONE',
    }


def bounded_count(value, maximum=1_000_000_000_000):
    return type(value) is int and 0 <= value < maximum


def time_ms(value, now_ms):
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            return None
        n = int(dt.timestamp() * 1000)
        return n if 0 < n <= now_ms + 5000 else None
    except (OverflowError, ValueError, TypeError):
        return None


def summarize_watch(raw, now_ms=None, expected_sha=None):
    """Validate a single persisted watch snapshot; return an allowlisted DTO."""
    if raw is None:
        return blank()
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if not isinstance(raw, dict) or raw.get('schemaVersion') != SOURCE_CONTRACT \
            or not isinstance(raw.get('researchSha'), str) \
            or not SHA.fullmatch(raw['researchSha']) \
            or raw.get('status') not in RAW_STATUSES \
            or (expected_sha is not None and raw['researchSha'] != expected_sha):
        return blank('INVALID', True)
    observed_at = time_ms(raw.get('observedAt'), now_ms)
    if observed_at is None:
        return blank('INVALID', True)
    budget = raw.get('resourceBudget')
    if not isinstance(budget, dict) \
            or budget.get('status') not in ('RUN', 'THROTTLED', 'HOLD') \
            or not isinstance(budget.get('reason'), str) \
            or not SAFE_SOURCE.fullmatch(budget['reason']) \
            or (raw['status'] == 'HOLD' and budget['status'] != 'HOLD') \
            or (raw['status'] == 'THROTTLED' and budget['status'] != 'THROTTLED') \
            or (budget['status'] == 'RUN' and raw['status'] in ('THROTTLED', 'HOLD')):
        return blank('INVALID', True)
    safety = raw.get('safety')
    if not isinstance(safety, dict) or safety.get('researchOnly') is not True \
            or safety.get('orderAuthority') != 'NONE' \
            or safety.get('liveTrading') is not False \
            or safety.get('privateProviderApi') is not False \
            or safety.get('paperAdmissionAllowed') is not False \
            or safety.get('profitabilityProven') is not False \
            or safety.get('aiPassInvented') is not False:
        return blank('INVALID', True)
    rows = raw.get('markets')
    if not isinstance(rows, list) or len(rows) != len(MARKETS) \
            or not bounded_count(raw.get('newCandidateCount'), 49):
        return blank('INVALID', True)
    markets = []
    total_candidates = 0
    for market, row in zip(MARKETS, rows):
        if not isinstance(row, dict) or row.get('market') != market:
            return blank('INVALID', True)
        status = row.get('status')
        source = row.get('source')
        blocked = isinstance(status, str) and BLOCKED_SOURCE.fullmatch(status)
        healthy = status in SOURCE_STATUSES
        if not (blocked or healthy) \
                or not isinstance(source, str) or not SAFE_SOURCE.fullmatch(source) \
                or (blocked and source != 'NONE') \
                or (healthy and source == 'NONE'):
            return blank('INVALID', True)
        listed = row.get('listedCount')
        observed = row.get('observedCount')
        candidates = row.get('newCandidates')
        if not bounded_count(listed, 30001) \
                or not bounded_count(observed, 8001) \
                or not bounded_count(candidates, 13) \
                or observed > listed or candidates > observed \
                or (status == 'READY' and observed != listed) \
                or (blocked and (observed != 0 or candidates != 0)) \
                or row.get('executionAuthority') != 'NONE':
            return blank('INVALID', True)
        total_candidates += candidates
        markets.append({
            'market': market, 'source': source, 'status': status,
            'listedCount': listed, 'observedCount': observed,
            'newCandidates': candidates,
        })
    if total_candidates != raw['newCandidateCount']:
        return blank('INVALID', True)
    stats = raw.get('statistics')
    if not isinstance(stats, dict) or stats.get('dayUtc') != raw['observedAt'][:10] \
            or not bounded_count(stats.get('cyclesToday')) \
            or stats['cyclesToday'] < 1 \
            or not bounded_count(stats.get('candidatesToday')) \
            or not bounded_count(stats.get('cyclesSinceRelease')) \
            or stats['cyclesSinceRelease'] < stats['cyclesToday']:
        return blank('INVALID', True)
    coverage = sum(m['status'] == 'READY' for m in markets)
    if raw['status'] == 'OBSERVING_ALL_FOUR' and coverage != 4:
        return blank('INVALID', True)
    if budget['status'] != 'RUN' \
            and any(m['status'] in SOURCE_STATUSES for m in markets):
        return blank('INVALID', True)
    age_ms = max(0, now_ms - observed_at)
    if age_ms > STALE_AFTER_MS:
        state = 'STALE'
    elif raw['status'] in ('HOLD', 'THROTTLED', 'BLOCKED_DATA'):
        state = raw['status']
    elif coverage == 4:
        state = 'OBSERVING'
    else:
        state = 'PARTIAL'
    return {
        **blank(state, True),
        'researchSha': raw['researchSha'], 'observedAt': observed_at,
        'ageMs': age_ms, 'marketCoverageCount': coverage, 'markets': markets,
        'cyclesToday': stats['cyclesToday'],
        'candidatesToday': stats['candidatesToday'],
        'cyclesSinceRelease': stats['cyclesSinceRelease'],
    }


def read_watch_status(root, now_ms=None, expected_sha=None):
    """Read one bounded regular private file with O_NOFOLLOW; never create it."""
    path = Path(root) / 'latest' / 'lightweight-market-watch.json'
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 \
                or meta.st_size < 1 or meta.st_size > MAX_BYTES \
                or meta.st_mode & 0o022:
            return blank('INVALID', True)
        data = os.read(fd, MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            return blank('INVALID', True)
        value = json.loads(data)
        return summarize_watch(value, now_ms=now_ms, expected_sha=expected_sha)
    except FileNotFoundError:
        return blank()
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        return blank('INVALID', True)
    finally:
        if fd is not None:
            os.close(fd)
