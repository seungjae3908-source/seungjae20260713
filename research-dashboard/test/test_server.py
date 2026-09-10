import hashlib
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


def canonical_digest(value):
    body = dict(value)
    body.pop('reportDigest', None)
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def valid_v3_summary():
    value = {
        'schemaVersion': 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
        'producerSha': 'a' * 40,
        'upstreamIngestRunId': 33935881010,
        'upstreamIngestArtifactId': 9960137408,
        'upstreamIngestArtifactDigest': 'b' * 64,
        'sourceInventoryDigest': 'c' * 64,
        'targetSlotIndex': 48,
        'genuineScheduledSlotN': 15,
        'rawAcceptedN': 120,
        'effectiveIndependentN': 15,
        'independentBuyN': 10,
        'independentSellN': 5,
        'independenceAuditDigest': 'd' * 64,
        'independentSplitSourceDigest': 'e' * 64,
        'v3IndependentSplitIndexDigest': 'f' * 64,
        'frozenSplitCounts': {
            'TRAIN': 15,
            'TRAIN_BUY': 10,
            'TRAIN_SELL': 5,
            'VALIDATION': 0,
            'VALIDATION_BUY': 0,
            'VALIDATION_SELL': 0,
            'OOS': 0,
            'OOS_BUY': 0,
            'OOS_SELL': 0,
        },
        'oosOutcomeCredit': 0,
        'calibrationArtifactProduced': False,
        'liquidityImpactStatus': 'BLOCKED_DATA',
        'fullCostReady': False,
        'evidenceComplete': 0,
        'executionAuthority': 'NONE',
        'frozenV3SplitIndexPresent': True,
        'v2SplitReceiptPresent': False,
    }
    value['reportDigest'] = canonical_digest(value)
    return value


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
        write_json(root / 'forward' / 'shadow-state.json', {'groups': {'15m': {
            'records': [],
            'canonicalEvidence': {'handoff': {'strategyHealthHandoff': {
                'schemaVersion': 'prediction-lab-strategy-health-shadow-handoff-v1',
                'strategyIdentityDigest': 'a' * 64,
                'evidenceDigest': 'b' * 64,
                'executionAuthority': 'NONE',
            }}},
        }}})
        return root

    def test_runtime_read_model_preserves_measured_zero_and_directional_recall(self):
        overview = build_research_overview(self.fixture())
        self.assertEqual(overview['paper']['ledger']['sampleCount'], 0)
        self.assertEqual(overview['paper']['ledger']['settlementCount'], 0)
        self.assertEqual(overview['shadow']['groups'][0]['bearRecall'], 0)
        self.assertTrue(overview['shadow']['groups'][0]['collapsed'])
        self.assertEqual(overview['shadow']['records']['totalRecords'], 0)
        self.assertTrue(overview['safety']['authorityEvidenceComplete'])
        self.assertEqual(len(overview['shadow']['canonicalHandoffs']), 1)
        self.assertEqual(overview['shadow']['canonicalHandoffs'][0]['group'], '15m')
        self.assertEqual(overview['shadow']['canonicalHandoffs'][0]['handoff']['evidenceDigest'], 'b' * 64)

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

    def test_python_runtime_exposes_authenticated_v3_independence_without_economic_promotion(self):
        root = self.fixture()
        write_json(root / 'forward' / 'liquidity' / 'v3-authoritative-independence-summary.json', valid_v3_summary())
        overview = build_research_overview(root)
        liquidity = overview['research']['liquidityIndependence']
        self.assertTrue(liquidity['present'])
        self.assertEqual(liquidity['status'], 'PRESENT')
        self.assertEqual(liquidity['effectiveIndependentN'], 15)
        self.assertEqual(liquidity['independentBuyN'], 10)
        self.assertEqual(liquidity['independentSellN'], 5)
        self.assertEqual(liquidity['frozenSplitCounts']['TRAIN'], 15)
        self.assertEqual(liquidity['frozenSplitCounts']['VALIDATION'], 0)
        self.assertEqual(liquidity['frozenSplitCounts']['OOS'], 0)
        self.assertEqual(liquidity['oosOutcomeCredit'], 0)
        self.assertFalse(liquidity['calibrationArtifactProduced'])
        self.assertEqual(liquidity['liquidityImpactStatus'], 'BLOCKED_DATA')
        self.assertFalse(liquidity['fullCostReady'])
        self.assertEqual(liquidity['evidenceComplete'], 0)
        self.assertEqual(liquidity['executionAuthority'], 'NONE')
        self.assertFalse(overview['profitability']['proven'])

    def test_missing_v3_independence_is_missing_not_zero(self):
        overview = build_research_overview(self.fixture())
        liquidity = overview['research']['liquidityIndependence']
        self.assertFalse(liquidity['present'])
        self.assertEqual(liquidity['status'], 'MISSING')
        self.assertIsNone(liquidity['effectiveIndependentN'])
        self.assertIsNone(liquidity['frozenSplitCounts']['TRAIN'])
        self.assertIsNone(liquidity['frozenSplitCounts']['OOS'])
        self.assertFalse(overview['profitability']['proven'])

    def test_v3_authority_escalation_fails_closed_and_hides_partial_counts(self):
        root = self.fixture()
        summary = valid_v3_summary()
        summary['executionAuthority'] = 'LIVE'
        summary['reportDigest'] = canonical_digest(summary)
        write_json(root / 'forward' / 'liquidity' / 'v3-authoritative-independence-summary.json', summary)
        overview = build_research_overview(root)
        liquidity = overview['research']['liquidityIndependence']
        self.assertTrue(liquidity['present'])
        self.assertEqual(liquidity['status'], 'INVALID')
        self.assertIsNone(liquidity['effectiveIndependentN'])
        self.assertIsNone(liquidity['frozenSplitCounts']['TRAIN'])
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertFalse(overview['profitability']['proven'])

    def test_v3_read_error_fails_closed_without_fabricating_zero(self):
        root = self.fixture()
        path = root / 'forward' / 'liquidity' / 'v3-authoritative-independence-summary.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{not-json', encoding='utf-8')
        overview = build_research_overview(root)
        liquidity = overview['research']['liquidityIndependence']
        self.assertTrue(liquidity['present'])
        self.assertEqual(liquidity['status'], 'INVALID')
        self.assertIsNone(liquidity['effectiveIndependentN'])
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertFalse(overview['profitability']['proven'])


if __name__ == '__main__':
    unittest.main()
