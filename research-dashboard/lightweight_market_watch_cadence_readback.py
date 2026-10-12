"""Bounded public cadence diagnostics for the existing admin-only Research overview.

Reads at most two UTC-day private JSONL files; no subprocess/network/API,
new endpoint, execution rights, raw ticker or PnL/economic credit.
"""
import hashlib
import json
import os
import re
import stat
import time
from datetime import datetime, timezone
from pathlib import Path

CONTRACT = 'public-watch-cadence-admin-readback-v1'
RAW_CONTRACT = 'public-watch-cadence-observation-v1'
MARKETS = ('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES')
GOOD = frozenset(('READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE'))
RESOURCE = frozenset(('RUN', 'HOLD', 'THROTTLED'))
STATES = frozenset(('OBSERVING_ALL_FOUR', 'PARTIAL_MARKET_COVERAGE', 'BLOCKED_DATA',
                    'HOLD', 'THROTTLED'))
BLOCKED = re.compile(r'^BLOCKED_[A-Z0-9_]{1,100}$')
SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
UTC_TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
WINDOW_MS = 24 * 60 * 60_000
MAX_GAP_MS = 6 * 60_000
MIN_CYCLES = 600
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_LINE_BYTES = 16 * 1024
MAX_LINES = 2_000


def blank(status='MISSING', present=False):
    return {
        'contract': CONTRACT, 'status': status, 'present': present,
        'sampleCount': None, 'duplicateRows': None, 'maxGapMs': None,
        'latestAgeMs': None, 'hostHoldCycles': None,
        'hostThrottledCycles': None, 'blockedDataCycles': None,
        'allFourMarketReadyCycles': None, 'filesRead': None,
        'cadenceWindowObserved': False,
        'continuous24hProven': False,
        'completeFourMarketCoverageProven': False,
        'economicEvidenceCredit': 0, 'oosCredit': 0, 'paperCredit': 0,
        'profitabilityProven': False, 'formulaCandidateProduced': False,
        'executionAuthority': 'NONE',
    }


def timestamp_ms(value):
    if not isinstance(value, str) or not UTC_TIME.fullmatch(value):
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        ms = int(dt.timestamp() * 1000)
        return ms if ms > 0 and dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value else None
    except (ValueError, OverflowError, TypeError):
        return None


def validate_entry(value):
    if not isinstance(value, dict):
        return False
    if (value.get('schemaVersion') != RAW_CONTRACT
            or not isinstance(value.get('researchSha'), str)
            or not SHA.fullmatch(value['researchSha'])
            or timestamp_ms(value.get('observedAt')) is None
            or not isinstance(value.get('cycleStatus'), str)
            or value['cycleStatus'] not in STATES):
        return False
    budget = value.get('resourceBudget')
    if not isinstance(budget, str) or budget not in RESOURCE:
        return False
    if (value.get('executionAuthority') != 'NONE'
            or value.get('publicPriceObservationOnly') is not True
            or type(value.get('economicEvidenceCredit')) is not int or value['economicEvidenceCredit'] != 0
            or type(value.get('oosCredit')) is not int or value['oosCredit'] != 0
            or type(value.get('paperCredit')) is not int or value['paperCredit'] != 0):
        return False
    markets = value.get('markets')
    if not isinstance(markets, list) or len(markets) != 4:
        return False
    comparable = []
    ready = partial = 0
    for market, raw in zip(MARKETS, markets):
        if not isinstance(raw, dict) or raw.get('market') != market:
            return False
        status = raw.get('status')
        n = raw.get('observedCount')
        if (not isinstance(status, str) or (status not in GOOD and not BLOCKED.fullmatch(status))
                or type(n) is not int or not 0 <= n <= 8_000
                or (status == 'READY' and n == 0)
                or (BLOCKED.fullmatch(status) and n != 0)):
            return False
        ready += status == 'READY'
        partial += status in GOOD and status != 'READY'
        comparable.append({'market': market, 'status': status, 'observedCount': n})
    state = value['cycleStatus']
    if budget != 'RUN':
        if state != budget or ready + partial:
            return False
    elif ready == 4:
        if state != 'OBSERVING_ALL_FOUR':
            return False
    elif ready + partial:
        if state != 'PARTIAL_MARKET_COVERAGE':
            return False
    elif state != 'BLOCKED_DATA':
        return False
    expected = hashlib.sha256(
        (RAW_CONTRACT + ':' + json.dumps(
            [value['researchSha'], value['observedAt'], state, budget, comparable],
            ensure_ascii=False, separators=(',', ':'),
        )).encode('utf-8'),
    ).hexdigest()
    return isinstance(value.get('eventId'), str) and DIGEST.fullmatch(value['eventId']) is not None and expected == value['eventId']


def safe_directory(path, allow_missing=False):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if allow_missing:
            return False
        raise ValueError('WATCH_CADENCE_DIRECTORY_MISSING')
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        raise ValueError('WATCH_CADENCE_DIRECTORY_UNSAFE')
    return True


def read_day(root, day, expected_sha, now_ms, seen, counters):
    path = Path(root) / 'watch' / 'cadence' / (day + '.jsonl')
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        return
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size < 1 or before.st_size > MAX_FILE_BYTES
            or before.st_mode & 0o022):
        raise ValueError('WATCH_CADENCE_FILE_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        during = os.fstat(fd)
        if (not stat.S_ISREG(during.st_mode) or during.st_dev != before.st_dev
                or during.st_ino != before.st_ino or during.st_size != before.st_size
                or during.st_nlink != 1 or during.st_mode & 0o022):
            raise ValueError('WATCH_CADENCE_FILE_CHANGED')
        chunks = []
        remaining = MAX_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 64 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        contents = b''.join(chunks)
        if len(contents) != before.st_size or not contents.endswith(b'\n'):
            raise ValueError('WATCH_CADENCE_FILE_TRUNCATED')
        data = contents.decode('utf-8')
        lines = data[:-1].split('\n')
        if len(lines) > MAX_LINES:
            raise ValueError('WATCH_CADENCE_LINES_LIMIT')
        for line in lines:
            if not line or len(line.encode('utf-8')) > MAX_LINE_BYTES:
                raise ValueError('WATCH_CADENCE_ROW_UNSAFE')
            value = json.loads(line)
            if not validate_entry(value) or value['observedAt'][:10] != day:
                raise ValueError('WATCH_CADENCE_RECORD_INVALID')
            at = timestamp_ms(value['observedAt'])
            if at > now_ms + 5_000:
                raise ValueError('WATCH_CADENCE_FUTURE_RECORD')
            if value['researchSha'] != expected_sha:
                continue
            if at < now_ms - WINDOW_MS or at > now_ms:
                continue
            previous = seen.get(at)
            if previous:
                if previous['eventId'] != value['eventId']:
                    raise ValueError('WATCH_CADENCE_DUPLICATE_CONFLICT')
                counters['duplicateRows'] += 1
            else:
                seen[at] = value
                if len(seen) > MAX_LINES:
                    raise ValueError('WATCH_CADENCE_TOO_MANY_CYCLES')
        after = os.fstat(fd)
        if (after.st_ino != before.st_ino or after.st_dev != before.st_dev
                or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns):
            raise ValueError('WATCH_CADENCE_FILE_MUTATED_DURING_READ')
        counters['filesRead'] += 1
    finally:
        os.close(fd)


def read_watch_cadence(root, expected_sha=None, now_ms=None, require_exact_sha=True):
    """Always return bounded allowlisted, non-economic, read-only aggregates."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        if type(now_ms) is not int or now_ms <= WINDOW_MS:
            raise ValueError('WATCH_CADENCE_NOW_INVALID')
        if not safe_directory(root, allow_missing=True):
            return blank()
        if not safe_directory(Path(root) / 'watch', allow_missing=True):
            return blank()
        if not safe_directory(Path(root) / 'watch' / 'cadence', allow_missing=True):
            return blank()
        if require_exact_sha and (not isinstance(expected_sha, str)
                                  or not SHA.fullmatch(expected_sha)):
            return blank('INVALID', True)
        if not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha):
            return blank('INVALID', True)
        first_day = datetime.fromtimestamp((now_ms - WINDOW_MS) / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
        last_day = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
        seen = {}
        counters = {'filesRead': 0, 'duplicateRows': 0}
        for day in dict.fromkeys((first_day, last_day)):
            read_day(root, day, expected_sha, now_ms, seen, counters)
        if not seen:
            return blank('MISSING', False)
        times = sorted(seen)
        values = [seen[at] for at in times]
        max_gap = max((b - a for a, b in zip(times, times[1:])), default=0)
        hold = sum(v['resourceBudget'] == 'HOLD' for v in values)
        throttle = sum(v['resourceBudget'] == 'THROTTLED' for v in values)
        blocked = sum(v['cycleStatus'] == 'BLOCKED_DATA' for v in values)
        all_four = sum(v['cycleStatus'] == 'OBSERVING_ALL_FOUR' for v in values)
        recent_age = now_ms - times[-1]
        healthy_window = (
            len(times) >= 600 and times[0] - (now_ms - WINDOW_MS) <= MAX_GAP_MS
            and recent_age <= MAX_GAP_MS and max_gap <= MAX_GAP_MS
            and hold == 0 and throttle == 0
        )
        return {
            **blank('PUBLIC_CADENCE_OBSERVED' if healthy_window else 'INCOMPLETE_OR_INTERRUPTED', True),
            'sampleCount': len(times), 'duplicateRows': counters['duplicateRows'],
            'maxGapMs': max_gap, 'latestAgeMs': recent_age,
            'hostHoldCycles': hold, 'hostThrottledCycles': throttle,
            'blockedDataCycles': blocked, 'allFourMarketReadyCycles': all_four,
            'filesRead': counters['filesRead'],
            'cadenceWindowObserved': healthy_window,
        }
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError, OverflowError):
        return blank('INVALID', True)
