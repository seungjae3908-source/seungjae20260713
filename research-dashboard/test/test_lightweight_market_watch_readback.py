import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lightweight_market_watch_readback import (  # noqa: E402
    read_watch_status,
    summarize_watch,
)
from server import build_research_overview  # noqa: E402

SHA = 'a' * 40
BASE_TIME = datetime(2026, 10, 9, 12, 30, tzinfo=timezone.utc)
NOW_MS = int(BASE_TIME.timestamp() * 1000)
MARKETS = ('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES')


def valid_snapshot():
    stamp = (BASE_TIME - timedelta(seconds=30)).isoformat().replace('+00:00', 'Z')
    rows = []
    for i, market in enumerate(MARKETS):
        ready = i >= 2
        rows.append({
            'market': market,
            'status': 'READY' if ready else 'BLOCKED_PUBLIC_STOCK_FEED_MISSING',
            'source': ('UPBIT_PUBLIC_TICKERS' if i == 2 else
                       'BITGET_PUBLIC_TICKERS' if i == 3 else 'NONE'),
            'listedCount': 10 if ready else 0,
            'observedCount': 10 if ready else 0,
            'newCandidates': (1 if i == 2 else 2) if ready else 0,
            'executionAuthority': 'NONE',
        })
    return {
        'schemaVersion': 'lightweight-market-opportunity-watch-v1',
        'researchSha': SHA, 'observedAt': stamp,
        'status': 'PARTIAL_MARKET_COVERAGE',
        'resourceBudget': {'status': 'RUN', 'reason': 'WITHIN_BUDGET'},
        'markets': rows, 'newCandidateCount': 3,
        'statistics': {
            'dayUtc': stamp[:10],
            'cyclesToday': 100,
            'candidatesToday': 18,
            'cyclesSinceRelease': 101,
        },
        'safety': {
            'researchOnly': True, 'orderAuthority': 'NONE',
            'liveTrading': False, 'privateProviderApi': False,
            'paperAdmissionAllowed': False, 'profitabilityProven': False,
            'aiPassInvented': False,
        },
    }


class MarketWatchReadbackTest(unittest.TestCase):
    def test_missing_and_valid_projection(self):
        self.assertEqual(summarize_watch(None, NOW_MS)['status'], 'MISSING')
        raw = valid_snapshot()
        raw['secretApiKey'] = 'PRIVATE'
        raw['markets'][2]['privateSourcePath'] = '/root/secret'
        projection = summarize_watch(raw, NOW_MS, SHA)
        self.assertEqual(projection['status'], 'PARTIAL')
        self.assertEqual(projection['marketCoverageCount'], 2)
        self.assertEqual(projection['cyclesToday'], 100)
        self.assertEqual(projection['candidatesToday'], 18)
        self.assertFalse(projection['continuous24hProven'])
        self.assertFalse(projection['formulaCandidateProduced'])
        self.assertFalse(projection['oosProven'])
        self.assertFalse(projection['paperExecutionProven'])
        self.assertFalse(projection['profitabilityProven'])
        self.assertEqual(projection['executionAuthority'], 'NONE')
        self.assertNotIn('PRIVATE', json.dumps(projection))
        self.assertNotIn('/root', json.dumps(projection))

    def test_forged_economic_authority_and_count_are_rejected(self):
        variants = []
        raw = valid_snapshot()
        raw['safety']['orderAuthority'] = 'LIVE'
        variants.append(raw)
        raw = valid_snapshot()
        raw['markets'][2]['newCandidates'] = 80
        variants.append(raw)
        raw = valid_snapshot()
        raw['researchSha'] = 'invalid'
        variants.append(raw)
        raw = valid_snapshot()
        raw['statistics']['candidatesToday'] = -1
        variants.append(raw)
        raw = valid_snapshot()
        raw['markets'][0]['source'] = '/root/token'
        variants.append(raw)
        raw = valid_snapshot()
        raw['status'] = 'OBSERVING_ALL_FOUR'
        variants.append(raw)
        for raw in variants:
            with self.subTest(raw=raw.get('status')):
                self.assertEqual(summarize_watch(raw, NOW_MS)['status'], 'INVALID')

    def test_stale_future_and_wrong_release(self):
        raw = valid_snapshot()
        raw['observedAt'] = (BASE_TIME - timedelta(minutes=8)).isoformat()
        raw['statistics']['dayUtc'] = raw['observedAt'][:10]
        self.assertEqual(summarize_watch(raw, NOW_MS)['status'], 'STALE')
        raw = valid_snapshot()
        raw['observedAt'] = (BASE_TIME + timedelta(seconds=8)).isoformat()
        self.assertEqual(summarize_watch(raw, NOW_MS)['status'], 'INVALID')
        self.assertEqual(summarize_watch(valid_snapshot(), NOW_MS, 'f' * 40)['status'], 'INVALID')

    def test_private_file_and_integrated_loopback_overview(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'latest' / 'lightweight-market-watch.json'
            path.parent.mkdir(mode=0o700)
            self.assertEqual(read_watch_status(root, NOW_MS)['status'], 'MISSING')
            path.write_text(json.dumps(valid_snapshot()), encoding='utf-8')
            os.chmod(path, 0o600)
            self.assertEqual(read_watch_status(root, NOW_MS, SHA)['status'], 'PARTIAL')
            readback = build_research_overview(root)
            # Python production overview must include the new optional watch
            # projection, but it must not set profitability or order authority.
            self.assertIn('lightweightMarketWatch', readback['dataFactory'])
            self.assertFalse(readback['profitability']['proven'])
            self.assertFalse(readback['safety']['orderAuthority'])
            path.unlink()
            outside = root / 'private.json'
            outside.write_text(json.dumps(valid_snapshot()), encoding='utf-8')
            path.symlink_to(outside)
            self.assertEqual(read_watch_status(root, NOW_MS)['status'], 'INVALID')

    def test_oversize_hardlink_and_malformed_do_not_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'latest' / 'lightweight-market-watch.json'
            path.parent.mkdir(mode=0o700)
            path.write_text('{invalid', encoding='utf-8')
            os.chmod(path, 0o600)
            self.assertEqual(read_watch_status(root, NOW_MS)['status'], 'INVALID')
            path.write_text('x' * 70000, encoding='utf-8')
            self.assertEqual(read_watch_status(root, NOW_MS)['status'], 'INVALID')
            path.write_text(json.dumps(valid_snapshot()), encoding='utf-8')
            hardlink = root / 'copy.json'
            os.link(path, hardlink)
            self.assertEqual(read_watch_status(root, NOW_MS)['status'], 'INVALID')

    def test_blocked_and_throttled_are_not_counted_as_healthy(self):
        raw = valid_snapshot()
        raw['status'] = 'BLOCKED_DATA'
        raw['markets'] = [{
            'market': m, 'source': 'NONE', 'status': 'BLOCKED_NO_PUBLIC_DATA',
            'listedCount': 0, 'observedCount': 0,
            'newCandidates': 0, 'executionAuthority': 'NONE',
        } for m in MARKETS]
        raw['newCandidateCount'] = 0
        x = summarize_watch(raw, NOW_MS)
        self.assertEqual(x['status'], 'BLOCKED_DATA')
        self.assertEqual(x['marketCoverageCount'], 0)
        raw['status'] = 'HOLD'
        raw['resourceBudget'] = {'status': 'HOLD', 'reason': 'MEMORY_PRESSURE'}
        self.assertEqual(summarize_watch(raw, NOW_MS)['status'], 'HOLD')


if __name__ == '__main__':
    unittest.main()
