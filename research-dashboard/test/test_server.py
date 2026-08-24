import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import build_research_overview  # noqa: E402


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


class ResearchDashboardPythonRuntimeTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        write_json(root / 'latest' / 'forward.json', {
            'status': 'complete', 'taskCount': 1, 'successCount': 1,
            'blockedDataCount': 0, 'failedCount': 0,
            'results': [{'id': 'shadow-forward', 'status': 'success'}],
        })
        write_json(root / 'forward' / 'paper' / 'status' / 'runtime-status.json', {
            'status': 'running', 'privateRequestCount': 0, 'financialMutationCount': 0,
            'orderCount': 0, 'liveTrading': False, 'orderAuthority': False,
        })
        write_json(root / 'forward' / 'paper' / 'state' / 'recurring-paper-loop.json', {
            'cycles': [{'cycleId': '1'}], 'samples': [], 'positions': [], 'settlements': [],
        })
        write_json(root / 'forward' / 'shadow-summary.json', {'groups': {
            '15m': {
                'candidate': {
                    'predictionHealth': {'collapsed': True},
                    'macroF1': 0.31,
                    'balancedAccuracy': 0.34,
                    'perClass': {
                        'bullish': {'recall': 0.8},
                        'bearish': {'recall': 0},
                        'neutral': {'recall': 0.22},
                    },
                },
            },
        }})
        write_json(root / 'forward' / 'shadow-state.json', {'groups': {'15m': {'records': []}}})
        return root

    def test_runtime_read_model_preserves_measured_zero_and_directional_recall(self):
        overview = build_research_overview(self.fixture())
        self.assertEqual(overview['paper']['ledger']['sampleCount'], 0)
        self.assertEqual(overview['paper']['ledger']['settlementCount'], 0)
        self.assertEqual(overview['shadow']['groups'][0]['bearRecall'], 0)
        self.assertTrue(overview['shadow']['groups'][0]['collapsed'])
        self.assertEqual(overview['shadow']['records']['totalRecords'], 0)
        self.assertTrue(overview['safety']['authorityEvidenceComplete'])

    def test_missing_runtime_values_remain_null_instead_of_becoming_zero_or_false(self):
        root = self.fixture()
        write_json(root / 'forward' / 'paper' / 'status' / 'runtime-status.json', {'status': 'running'})
        write_json(root / 'forward' / 'paper' / 'state' / 'recurring-paper-loop.json', {'schemaVersion': 'recurring-paper-loop-v1'})
        write_json(root / 'forward' / 'shadow-state.json', {'groups': {'15m': {'status': 'unknown'}}})
        overview = build_research_overview(root)
        runtime = overview['paper']['runtime']
        self.assertIsNone(runtime['privateRequestCount'])
        self.assertIsNone(runtime['liveTrading'])
        self.assertFalse(runtime['safetyEvidenceComplete'])
        self.assertFalse(overview['safety']['authorityEvidenceComplete'])
        self.assertEqual(overview['research']['status'], 'safety_evidence_incomplete')
        self.assertIsNone(overview['paper']['ledger']['cycleCount'])
        self.assertIsNone(overview['paper']['ledger']['sampleCount'])
        self.assertIsNone(overview['paper']['ledger']['settlementCount'])
        self.assertIsNone(overview['shadow']['records']['totalRecords'])


if __name__ == '__main__':
    unittest.main()
