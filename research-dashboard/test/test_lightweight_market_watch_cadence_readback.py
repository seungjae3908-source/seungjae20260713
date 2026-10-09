import hashlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lightweight_market_watch_cadence_readback import (  # noqa: E402
    CONTRACT, RAW_CONTRACT, WINDOW_MS, read_watch_cadence, validate_entry,
)

SHA = 'a' * 40
OTHER = 'b' * 40
NOW = int(datetime(2026, 10, 10, 03, 30, tzinfo=timezone.utc).timestamp() * 1000)
START = NOW - WINDOW_MS + 30_000
MARKETS = ('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES')


def record(at, sha=SHA, budget='RUN', all_ready=False):
    if budget == 'RUN':
        status = 'OBSERVING_ALL_FOUR' if all_ready else 'PARTIAL_MARKET_COVERAGE'
    else:
        status = budget
    markets = []
    for i, market in enumerate(MARKETS):
        ready = budget == 'RUN' and (all_ready or i >= 2)
        markets.append({
            'market': market,
            'status': 'READY' if ready else ('BLOCKED_HOST_' + budget if budget != 'RUN'
                                             else 'BLOCKED_PUBLIC_STOCK_FEED_MISSING'),
            'observedCount': 100 if ready else 0,
        })
    stamp = datetime.fromtimestamp(at / 1000, tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    raw = {
        'schemaVersion': RAW_CONTRACT, 'researchSha': sha,
        'observedAt': stamp, 'cycleStatus': status,
        'resourceBudget': budget, 'markets': markets,
        'publicPriceObservationOnly': True,
        'economicEvidenceCredit': 0, 'oosCredit': 0, 'paperCredit': 0,
        'executionAuthority': 'NONE',
    }
    canonical = [sha, stamp, status, budget, markets]
    raw['eventId'] = hashlib.sha256(
        (RAW_CONTRACT + ':' + json.dumps(canonical, separators=(',', ':'), ensure_ascii=False)).encode('utf-8')
    ).hexdigest()
    return raw


def write_log(root, records):
    folder = Path(root) / 'watch' / 'cadence'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    grouped = {}
    for row in records:
        day = row['observedAt'][:10]
        grouped.setdefault(day, []).append(json.dumps(row, ensure_ascii=False, separators=(',', ':')))
    for day, lines in grouped.items():
        path = folder / (day + '.jsonl')
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        os.chmod(path, 0o600)
    return folder


class CadenceReadbackTest(unittest.TestCase):
    def test_missing_is_not_proof_and_unbound_existing_file_is_invalid(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(read_watch_cadence(root, SHA, NOW)['status'], 'MISSING')
            write_log(root, [record(START)])
            self.assertEqual(read_watch_cadence(root, None, NOW)['status'], 'INVALID')
            self.assertEqual(read_watch_cadence(root, OTHER, NOW)['status'], 'MISSING')

    def test_same_release_full_fixture_window_is_only_a_local_observation(self):
        with tempfile.TemporaryDirectory() as root:
            rows = [record(START + i * 120_000) for i in range(720)]
            rows[0]['privatePath'] = '/private/do-not-leak'
            write_log(root, rows)
            result = read_watch_cadence(root, SHA, NOW)
            self.assertEqual(result['contract'], CONTRACT)
            self.assertEqual(result['status'], 'PUBLIC_CADENCE_OBSERVED')
            self.assertTrue(result['cadenceWindowObserved'])
            self.assertEqual(result['sampleCount'], 720)
            self.assertEqual(result['maxGapMs'], 120_000)
            self.assertEqual(result['allFourMarketReadyCycles'], 0)
            self.assertFalse(result['continuous24hProven'])
            self.assertFalse(result['completeFourMarketCoverageProven'])
            self.assertEqual(result['oosCredit'], 0)
            self.assertEqual(result['paperCredit'], 0)
            self.assertEqual(result['economicEvidenceCredit'], 0)
            self.assertEqual(result['executionAuthority'], 'NONE')
            self.assertNotIn('/private', json.dumps(result))
            self.assertNotIn('BTCUSDT', json.dumps(result))

    def test_gapped_cycle_or_host_pressure_is_not_complete_24h(self):
        with tempfile.TemporaryDirectory() as root:
            rows = [record(START + i * 120_000 + (20 * 60_000 if i > 300 else 0))
                    for i in range(710) if START + i * 120_000 + (20 * 60_000 if i > 300 else 0) <= NOW]
            write_log(root, rows)
            report = read_watch_cadence(root, SHA, NOW)
            self.assertEqual(report['status'], 'INCOMPLETE_OR_INTERRUPTED')
            self.assertGreater(report['maxGapMs'], 6 * 60_000)
            self.assertFalse(report['cadenceWindowObserved'])
        with tempfile.TemporaryDirectory() as root:
            rows = [record(START + i * 120_000, budget='HOLD' if i == 100 else 'RUN') for i in range(720)]
            write_log(root, rows)
            report = read_watch_cadence(root, SHA, NOW)
            self.assertEqual(report['hostHoldCycles'], 1)
            self.assertFalse(report['cadenceWindowObserved'])
            self.assertFalse(report['continuous24hProven'])

    def test_replayed_same_event_deduplicates_and_timestamp_conflict_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            first = record(START)
            write_log(root, [first, dict(first)])
            report = read_watch_cadence(root, SHA, NOW)
            self.assertEqual(report['sampleCount'], 1)
            self.assertEqual(report['duplicateRows'], 1)
            different = record(START, all_ready=True)
            write_log(root, [first, different])
            bad = read_watch_cadence(root, SHA, NOW)
            self.assertEqual(bad['status'], 'INVALID')
            self.assertIsNone(bad['sampleCount'])

    def test_forged_identity_authority_counts_and_raw_status_are_rejected(self):
        base = record(START)
        for mutation in (
            lambda x: x.update({'eventId': 'f' * 64}),
            lambda x: x.update({'paperCredit': 1}),
            lambda x: x.update({'oosCredit': 1}),
            lambda x: x.update({'economicEvidenceCredit': True}),
            lambda x: x.update({'executionAuthority': 'LIVE'}),
            lambda x: x['markets'][0].update({'status': 'READY', 'observedCount': 0}),
            lambda x: x.update({'cycleStatus': {'object': 'RUN'}}),
            lambda x: x.update({'markets': []}),
        ):
            row = json.loads(json.dumps(base))
            mutation(row)
            self.assertFalse(validate_entry(row), msg=str(row.get('cycleStatus')))

    def test_future_release_file_symlinks_and_corrupt_input_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            folder = write_log(root, [record(START)])
            path = folder / (record(START)['observedAt'][:10] + '.jsonl')
            path.unlink()
            path.symlink_to(Path(root) / 'secret.jsonl')
            self.assertEqual(read_watch_cadence(root, SHA, NOW)['status'], 'INVALID')
            path.unlink()
            path.write_text('{"truncated"', encoding='utf8')
            os.chmod(path, 0o600)
            self.assertEqual(read_watch_cadence(root, SHA, NOW)['status'], 'INVALID')
            path.write_text(json.dumps(record(START)) + '\n', encoding='utf8')
            os.chmod(path, 0o666)
            self.assertEqual(read_watch_cadence(root, SHA, NOW)['status'], 'INVALID')
            os.chmod(path, 0o600)
            row = record(NOW + 6_000)
            write_log(root, [row])
            self.assertEqual(read_watch_cadence(root, SHA, NOW)['status'], 'INVALID')

    def test_integrated_loopback_research_overview_contains_only_safe_cadence_aggregates(self):
        from server import build_research_overview
        with tempfile.TemporaryDirectory() as root:
            result = read_watch_cadence(root, SHA, NOW)
            with patch('server.read_active_research_sha', return_value=SHA), \
                 patch('server.read_watch_cadence', return_value=result):
                response = build_research_overview(root)
            self.assertEqual(response['dataFactory']['lightweightMarketWatchCadence']['status'], 'MISSING')
            self.assertFalse(response['profitability']['proven'])
            self.assertFalse(response['safety']['orderAuthority'])
            self.assertNotIn('/tmp', json.dumps(response['dataFactory']['lightweightMarketWatchCadence']))


if __name__ == '__main__':
    unittest.main()
