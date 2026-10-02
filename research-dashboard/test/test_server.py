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


def valid_multilane_v3_summary():
    value = valid_v3_summary()
    value.update({
        'targetSlotIndex': 479,
        'genuineScheduledSlotN': 153,
        'rawAcceptedN': 2000,
        'effectiveIndependentN': 159,
        'independentBuyN': 83,
        'independentSellN': 76,
        'frozenSplitCounts': {
            'TRAIN': 159,
            'TRAIN_BUY': 83,
            'TRAIN_SELL': 76,
            'VALIDATION': 0,
            'VALIDATION_BUY': 0,
            'VALIDATION_SELL': 0,
            'OOS': 0,
            'OOS_BUY': 0,
            'OOS_SELL': 0,
        },
        'preCapIndependentN': 159,
        'multiLanePolicyVersion': 'public-forward-liquidity-multi-lane-prospective-policy-v1',
        'multiLanePolicyDigest': '1' * 64,
        'laneRegistryDigest': '2' * 64,
        'dependencyPolicyDigest': '3' * 64,
        'balancingPolicyDigest': '4' * 64,
        'maxCreditPerLanePerSlot': 1,
        'maxTotalCreditPerSlot': 2,
        'maxCreditPerDependencyComponent': 1,
        'laneSlotCapRejectedN': 0,
        'globalSlotCapRejectedN': 0,
        'utc27AdditionalIndependentCredit': 0,
        'retroactiveMultiLaneCreditAllowed': False,
    })
    value['reportDigest'] = canonical_digest(value)
    return value


def valid_candidate_performance():
    candidate_id = f"phase3-candidate:sha256:{'7' * 64}"
    parameter_digest = '8' * 64
    return {
        'schemaVersion': 'frozen-candidate-performance-reader-v1',
        'status': 'PRESENT',
        'FIRST_ZERO': 'FULL_COST_EVIDENCE_NOT_READY',
        'reason': 'FULL_COST_EVIDENCE_NOT_READY',
        'candidateId': candidate_id,
        'strategyId': 'strategy-alpha',
        'freezeTimestamp': '2026-09-13T00:00:00.000Z',
        'identity14Verified': True,
        'identity': {
            'candidateId': candidate_id, 'strategyFamily': 'trend', 'strategyId': 'strategy-alpha',
            'strategyVersion': 'v1', 'parameterHash': parameter_digest, 'parameterDigest': parameter_digest,
            'researchCodeSha': '9' * 40, 'costPolicyVersion': 'cost-v1',
            'executionPolicyVersion': 'paper-v1', 'market': 'CRYPTO_FUTURES', 'provider': 'bitget',
            'symbol': 'BTCUSDT', 'timeframe': '15m', 'sidePolicy': 'LONG', 'accountMode': 'PAPER',
        },
        'provenance': {
            'evidenceClass': 'PRODUCTION_AUTHORITATIVE',
            'sourceOwner': 'phase4-existing-owner-runtime-caller-v1',
            'fixture': False, 'synthetic': False, 'replay': False, 'backfill': False, 'manual': False,
        },
        'fullCostEvidence': {
            'fullCostReady': False,
            'components': {
                key: {'state': 'UNKNOWN', 'valuePercent': None, 'provenance': None}
                for key in ('commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact')
            },
        },
        'effectiveIndependentMarketN': 15,
        'candidateMatchedN': 3,
        'LONG_SIGNAL_N': 1,
        'SHORT_SIGNAL_N': 1,
        'NO_TRADE_N': 1,
        'Entry_N': 1,
        'Position_N': 1,
        'PositionObservation_N': 2,
        'Settlement_N': 1,
        'TRAIN_N': 3,
        'VALIDATION_N': 0,
        'OOS_N': 0,
        'WIN_N': 1,
        'LOSS_N': 0,
        'BREAKEVEN_N': 0,
        'WIN_RATE': 1,
        'AVG_WIN': 12,
        'AVG_LOSS': None,
        'PAYOFF_RATIO': None,
        'GROSS_EXPECTANCY': 12,
        'PF': None,
        'MDD': 0,
        'MFE': 2.1,
        'MAE': -0.4,
        'TIME_TO_EXIT': 60_000,
        'Gross_PnL': 12,
        'Net_PnL': None,
        'FULL_COST_READY': False,
        'NET_ALPHA_PROVEN': False,
        'PROFITABILITY_PROVEN': False,
        'TRAIN_DIAGNOSTIC_ONLY': True,
        'VALIDATION_COMPLETE': False,
        'OOS_COMPLETE': False,
        'sampleCredit': 0,
        'executionRealismCredit': 0,
        'profitabilityCredit': 0,
        'backfillCredit': 0,
        'replayCredit': 0,
        'syntheticCredit': 0,
        'manualEconomicCredit': 0,
        'executionAuthority': 'NONE',
        'LIVE_TRADING': False,
        'AUTO_TRADING': False,
        'REAL_ORDER_ENABLED': False,
        'PRIVATE_TRADING_API_ALLOWED': False,
        'realOrderCount': 0,
        'cancelCount': 0,
        'amendCount': 0,
        'transferCount': 0,
        'withdrawalCount': 0,
    }


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
        write_json(root / 'latest' / 'temporal-crypto-futures.json', {
            'schemaVersion': 'crypto-futures-temporal-public-collection-v1',
            'generatedAt': 1_800_000_000_000,
            'researchSha': 'a' * 40,
            'status': 'complete',
            'failedCount': 0,
            'results': [
                {'symbol': 'BTCUSDT', 'status': 'success', 'observedCount': 3, 'appendedCount': 2},
                {'symbol': 'ETHUSDT', 'status': 'success', 'observedCount': 3, 'appendedCount': 3},
            ],
            'observationCount': 42,
            'ledgerDigest': 'c' * 64,
            'safety': {
                'publicDataOnly': True,
                'privateApi': False,
                'liveTrading': False,
                'realOrders': False,
                'historicalCurrentValueBackfill': False,
                'executionAuthority': 'NONE',
            },
        })
        write_json(root / 'latest' / 'research-factory.json', {
            'schemaVersion': 1,
            'contract': 'research-factory-runtime-status/v1',
            'generatedAt': '2026-09-20T00:00:00.000Z',
            'researchSha': 'a' * 40,
            'status': 'BLOCKED_POLICY_MISSING',
            'firstZero': 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
            'policy': {
                'present': False,
                'valid': False,
                'policyDigest': None,
                'approvalEvidenceId': None,
                'approvedAt': None,
            },
            'dataFactory': {'readyMarketCount': 0, 'blockedMarketCount': 4},
            'canonicalAdaptive': {
                'readyProfileCount': None,
                'blockedProfileCount': None,
                'runtimeStatus': None,
                'nextFirstZero': 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
            },
            'controlPlaneDigest': 'd' * 64,
            'diagnostic': None,
            'safety': {
                'runtimeExecutionAttempted': False,
                'runtimeActivationAllowed': False,
                'scheduleMutationAllowed': False,
                'deploymentAllowed': False,
                'databaseMutationAllowed': False,
                'secretMutationAllowed': False,
                'liveTrading': False,
                'autoTrading': False,
                'privateTradingApi': False,
                'realOrder': False,
                'profitabilityClaim': False,
                'executionAuthority': 'NONE',
            },
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
        self.assertTrue(overview['dataFactory']['temporalCryptoFutures']['present'])
        self.assertEqual(overview['dataFactory']['temporalCryptoFutures']['status'], 'complete')
        self.assertEqual(overview['dataFactory']['temporalCryptoFutures']['observationCount'], 42)
        self.assertEqual(overview['dataFactory']['temporalCryptoFutures']['failedCount'], 0)
        self.assertNotIn('error', overview['dataFactory']['temporalCryptoFutures']['results'][0])
        self.assertTrue(overview['factory']['present'])
        self.assertEqual(overview['factory']['status'], 'BLOCKED_POLICY_MISSING')
        self.assertEqual(overview['factory']['firstZero'], 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING')
        self.assertFalse(overview['factory']['policyPresent'])
        self.assertEqual(overview['factory']['readyMarketCount'], 0)
        self.assertEqual(overview['factory']['blockedMarketCount'], 4)
        self.assertIsNone(overview['factory']['readyProfileCount'])
        self.assertEqual(overview['factory']['controlPlaneDigest'], 'd' * 64)

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

    def test_missing_factory_runtime_is_missing_not_zero(self):
        root = self.fixture()
        (root / 'latest' / 'research-factory.json').unlink()
        factory = build_research_overview(root)['factory']
        self.assertFalse(factory['present'])
        self.assertEqual(factory['status'], 'MISSING')
        self.assertIsNone(factory['policyPresent'])
        self.assertIsNone(factory['readyMarketCount'])
        self.assertIsNone(factory['readyProfileCount'])

    def test_factory_runtime_authority_tamper_fails_closed_without_diagnostic_leak(self):
        root = self.fixture()
        path = root / 'latest' / 'research-factory.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['safety']['runtimeExecutionAttempted'] = True
        value['diagnostic'] = 'secret internal runtime diagnostic'
        write_json(path, value)
        overview = build_research_overview(root)
        factory = overview['factory']
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertTrue(factory['present'])
        self.assertEqual(factory['status'], 'INVALID')
        self.assertIsNone(factory['readyMarketCount'])
        self.assertIsNone(factory['controlPlaneDigest'])
        self.assertNotIn('secret internal runtime diagnostic', json.dumps(overview))

    def test_missing_temporal_summary_is_missing_not_zero(self):
        root = self.fixture()
        (root / 'latest' / 'temporal-crypto-futures.json').unlink()
        temporal = build_research_overview(root)['dataFactory']['temporalCryptoFutures']
        self.assertFalse(temporal['present'])
        self.assertEqual(temporal['status'], 'MISSING')
        self.assertIsNone(temporal['observationCount'])
        self.assertIsNone(temporal['failedCount'])

    def test_temporal_summary_tamper_fails_closed_without_raw_error_leak(self):
        root = self.fixture()
        path = root / 'latest' / 'temporal-crypto-futures.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['safety']['privateApi'] = True
        value['results'][0]['error'] = 'secret provider diagnostic'
        write_json(path, value)
        overview = build_research_overview(root)
        temporal = overview['dataFactory']['temporalCryptoFutures']
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertTrue(temporal['present'])
        self.assertEqual(temporal['status'], 'INVALID')
        self.assertIsNone(temporal['observationCount'])
        self.assertNotIn('secret provider diagnostic', json.dumps(overview))

    def test_temporal_partial_failure_preserves_good_symbols_and_hides_errors(self):
        root = self.fixture()
        path = root / 'latest' / 'temporal-crypto-futures.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['status'] = 'partial_failure'
        value['failedCount'] = 1
        value['results'][1] = {
            'symbol': 'ETHUSDT', 'status': 'failed', 'observedCount': 0, 'appendedCount': 0,
            'error': 'temporary upstream failure',
        }
        write_json(path, value)
        overview = build_research_overview(root)
        temporal = overview['dataFactory']['temporalCryptoFutures']
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertEqual(temporal['status'], 'partial_failure')
        self.assertEqual(temporal['failedCount'], 1)
        self.assertEqual(temporal['results'][0]['symbol'], 'BTCUSDT')
        self.assertNotIn('temporary upstream failure', json.dumps(overview))

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

    def test_python_runtime_accepts_frozen_phase2_multilane_independence(self):
        root = self.fixture()
        write_json(root / 'forward' / 'liquidity' / 'v3-authoritative-independence-summary.json',
                   valid_multilane_v3_summary())
        overview = build_research_overview(root)
        liquidity = overview['research']['liquidityIndependence']
        self.assertTrue(liquidity['present'])
        self.assertEqual(liquidity['status'], 'PRESENT')
        self.assertEqual(liquidity['genuineScheduledSlotN'], 153)
        self.assertEqual(liquidity['effectiveIndependentN'], 159)
        self.assertEqual(liquidity['independentBuyN'], 83)
        self.assertEqual(liquidity['independentSellN'], 76)
        self.assertEqual(liquidity['frozenSplitCounts']['TRAIN'], 159)
        self.assertFalse(overview['profitability']['proven'])

    def test_python_runtime_rejects_multilane_capacity_or_policy_weakening(self):
        for field, value in (
            ('genuineScheduledSlotN', 79),
            ('maxTotalCreditPerSlot', 3),
            ('maxCreditPerLanePerSlot', 2),
            ('maxCreditPerDependencyComponent', 2),
            ('utc27AdditionalIndependentCredit', 1),
            ('retroactiveMultiLaneCreditAllowed', True),
        ):
            with self.subTest(field=field):
                root = self.fixture()
                summary = valid_multilane_v3_summary()
                summary[field] = value
                summary['reportDigest'] = canonical_digest(summary)
                write_json(root / 'forward' / 'liquidity' / 'v3-authoritative-independence-summary.json', summary)
                liquidity = build_research_overview(root)['research']['liquidityIndependence']
                self.assertTrue(liquidity['present'])
                self.assertEqual(liquidity['status'], 'INVALID')
                self.assertIsNone(liquidity['effectiveIndependentN'])

    def test_missing_v3_independence_is_missing_not_zero(self):
        overview = build_research_overview(self.fixture())
        liquidity = overview['research']['liquidityIndependence']
        self.assertFalse(liquidity['present'])
        self.assertEqual(liquidity['status'], 'MISSING')
        self.assertIsNone(liquidity['effectiveIndependentN'])
        self.assertIsNone(liquidity['frozenSplitCounts']['TRAIN'])
        self.assertIsNone(liquidity['frozenSplitCounts']['OOS'])
        self.assertFalse(overview['profitability']['proven'])

    def test_candidate_performance_is_candidate_bound_and_missing_stays_unknown(self):
        root = self.fixture()
        write_json(root / 'forward' / 'paper' / 'status' / 'candidate-performance.json', valid_candidate_performance())
        present = build_research_overview(root)['paper']['candidatePerformance']
        self.assertEqual(present['status'], 'PRESENT')
        self.assertEqual(present['candidateMatchedN'], 3)
        self.assertEqual(present['Settlement_N'], 1)
        self.assertEqual(present['VALIDATION_N'], 0)
        self.assertIsNone(present['Net_PnL'])
        self.assertFalse(present['PROFITABILITY_PROVEN'])
        self.assertEqual(present['promotionIdentity'], {
            'candidateId': f"phase3-candidate:sha256:{'7' * 64}",
            'strategyId': 'strategy-alpha',
            'strategyVersion': 'v1',
            'parameterHash': '8' * 64,
            'researchCodeSha': '9' * 40,
            'market': 'CRYPTO_FUTURES',
            'timeframe': '15m',
            'sidePolicy': 'LONG',
            'accountMode': 'PAPER',
            'costPolicyVersion': 'cost-v1',
            'executionPolicyVersion': 'paper-v1',
        })
        self.assertNotIn('provider', present['promotionIdentity'])
        self.assertNotIn('symbol', present['promotionIdentity'])

        (root / 'forward' / 'paper' / 'status' / 'candidate-performance.json').unlink()
        missing = build_research_overview(root)['paper']['candidatePerformance']
        self.assertEqual(missing['status'], 'MISSING')
        self.assertIsNone(missing['candidateMatchedN'])
        self.assertIsNone(missing['Entry_N'])
        self.assertIsNone(missing['Gross_PnL'])

    def test_candidate_performance_tamper_fails_closed(self):
        root = self.fixture()
        value = valid_candidate_performance()
        value['PROFITABILITY_PROVEN'] = True
        write_json(root / 'forward' / 'paper' / 'status' / 'candidate-performance.json', value)
        overview = build_research_overview(root)
        candidate = overview['paper']['candidatePerformance']
        self.assertEqual(overview['research']['status'], 'attention')
        self.assertEqual(candidate['status'], 'INVALID')
        self.assertIsNone(candidate['candidateMatchedN'])
        self.assertIsNone(candidate['Gross_PnL'])
        self.assertFalse(candidate['PROFITABILITY_PROVEN'])

    def test_candidate_performance_fixture_provenance_and_lifecycle_fail_closed(self):
        root = self.fixture()
        path = root / 'forward' / 'paper' / 'status' / 'candidate-performance.json'
        impossible = valid_candidate_performance()
        impossible['Position_N'] = 2
        write_json(path, impossible)
        candidate = build_research_overview(root)['paper']['candidatePerformance']
        self.assertEqual(candidate['status'], 'INVALID')
        self.assertIsNone(candidate['Position_N'])

        fixture_source = valid_candidate_performance()
        fixture_source['provenance']['sourceOwner'] = 'test-fixture-loader'
        write_json(path, fixture_source)
        candidate = build_research_overview(root)['paper']['candidatePerformance']
        self.assertEqual(candidate['status'], 'INVALID')
        self.assertIsNone(candidate['candidateMatchedN'])

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

def test_development_diagnostic_blocker_is_visible_without_raw_diagnostic(self):
        root = self.fixture()
        path = root / 'latest' / 'research-factory.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['status'] = 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID'
        value['firstZero'] = 'DEVELOPMENT_DIAGNOSTIC_INVALID'
        value['controlPlaneDigest'] = None
        value['diagnostic'] = 'HINDSIGHT_FEEDBACK_FORBIDDEN: secret internal detail'
        value['policy']['present'] = True
        value['policy']['valid'] = True
        value['policy']['policyDigest'] = 'e' * 64
        value['canonicalAdaptive']['readyProfileCount'] = 1
        value['canonicalAdaptive']['blockedProfileCount'] = 11
        value['canonicalAdaptive']['runtimeStatus'] = 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID'
        value['canonicalAdaptive']['nextFirstZero'] = 'DEVELOPMENT_DIAGNOSTIC_INVALID'
        write_json(path, value)
        overview = build_research_overview(root)
        factory = overview['factory']
        self.assertEqual(factory['status'], 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID')
        self.assertEqual(factory['firstZero'], 'DEVELOPMENT_DIAGNOSTIC_INVALID')
        self.assertEqual(factory['readyProfileCount'], 1)
        self.assertEqual(factory['blockedProfileCount'], 11)
        self.assertNotIn('HINDSIGHT_FEEDBACK_FORBIDDEN', json.dumps(overview))
        self.assertNotIn('secret internal detail', json.dumps(overview))
