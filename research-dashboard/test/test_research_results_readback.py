import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research_results_readback import read_research_results  # noqa: E402
from server import build_research_overview, read_json_optional  # noqa: E402


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def combination():
    return {
        'contract': 'combination-search-lane/v1',
        'observedAt': '2026-10-18T11:00:00.000Z',
        'researchCodeSha': 'E' * 40,
        'safety': {'researchOnly': True, 'paperActivationAllowed': False, 'liveTrading': False,
                   'realOrder': False, 'executionAuthority': 'NONE'},
        'lanes': [
            {'laneId': 'KR_STOCK_LONG', 'status': 'SEARCHING', 'cumulativeTrials': 1240, 'survivors': 1,
             'watch': 101, 'rejected': 1114, 'holdoutUsed': 2, 'holdoutBudget': 10,
             'paperCandidates': [{'trialId': 't1', 'labels': ['20봉 평균 > 50봉 평균'], 'exitId': 'X1',
                                  'holdout': {'pass': True, 'result': {'trades': 31, 'meanReturn': 0.004}}}],
             'top': [{'trialId': 't1', 'finalStatus': 'SURVIVOR', 'labels': ['A', 'B'], 'exitId': 'X1',
                      'qValue': 0.03, 'validation': {'trades': 60, 'meanReturn': 0.00686, 'winRate': 0.67},
                      'beatsBaseline': True, 'holdout': {'pass': True}, 'secret': 'drop-me'}]},
            {'laneId': 'CRYPTO_FUTURES_SHORT', 'status': 'WAITING_FOR_DATA'},
            {'laneId': 'bad lane', 'status': 'SEARCHING'},
        ],
    }


class ResearchResultsReadbackTest(unittest.TestCase):
    def test_missing_files_stay_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = read_research_results(Path(tmp), read_json_optional)
        self.assertFalse(result['combination']['present'])
        self.assertEqual(result['combination']['status'], 'MISSING')
        self.assertEqual(result['exploratory']['status'], 'MISSING')
        self.assertEqual(result['executionAuthority'], 'NONE')

    def test_combination_is_whitelisted_and_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / 'latest' / 'combination-research-v1.json', combination())
            result = read_research_results(root, read_json_optional)['combination']
        self.assertTrue(result['present'])
        self.assertEqual(result['researchSha'], 'e' * 40)
        self.assertEqual([lane['laneId'] for lane in result['lanes']], ['KR_STOCK_LONG', 'CRYPTO_FUTURES_SHORT'])
        lane = result['lanes'][0]
        self.assertEqual(lane['survivors'], 1)
        self.assertEqual(lane['paperCandidates'][0]['holdoutTrades'], 31)
        self.assertNotIn('secret', lane['top'][0])
        self.assertTrue(lane['top'][0]['holdoutPass'])

    def test_unsafe_or_wrong_contract_is_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unsafe = combination()
            unsafe['safety']['realOrder'] = True
            write_json(root / 'latest' / 'combination-research-v1.json', unsafe)
            write_json(root / 'latest' / 'exploratory-paper-ledger-v1.json', {'contract': 'other'})
            (root / 'latest' / 'exit-strategy-comparison-v1.json').write_text('{broken', encoding='utf-8')
            result = read_research_results(root, read_json_optional)
        self.assertEqual(result['combination']['status'], 'INVALID')
        self.assertEqual(result['exploratory']['status'], 'INVALID')
        self.assertEqual(result['exitComparison']['status'], 'INVALID')

    def test_exploratory_and_exit_comparison_summaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / 'latest' / 'exploratory-paper-ledger-v1.json', {
                'contract': 'exploratory-paper-ledger/v1', 'observedAt': '2026-10-18T11:00:00.000Z',
                'safety': {'paperOnly': True, 'formalCandidate': False, 'automaticLiveFeed': False,
                           'realOrder': False, 'executionAuthority': 'NONE'},
                'totals': {'trades': 12, 'closed': 9, 'open': 3, 'promotionEligibleRules': 1, 'demotedRules': 0},
                'rules': [
                    {'ruleId': 'r2', 'laneId': 'US_STOCK_LONG', 'lifecycle': 'ACTIVE', 'labels': ['MACD'],
                     'forwardStrict': {'n': 3, 'mean': 0.1}, 'promotionEligible': False,
                     'promotionGap': {'tradesNeeded': 27, 'symbolsNeeded': 2}},
                    {'ruleId': 'r1', 'laneId': 'KR_STOCK_LONG', 'lifecycle': 'ACTIVE', 'labels': ['돌파'],
                     'forwardStrict': {'n': 31, 'mean': 0.3, 'lower95': 0.05}, 'promotionEligible': True},
                ],
            })
            write_json(root / 'latest' / 'exit-strategy-comparison-v1.json', {
                'contract': 'exit-strategy-comparison/v1', 'observedAt': '2026-10-18T11:00:00.000Z',
                'lanes': [{'laneId': 'US_STOCK_LONG', 'status': 'COMPLETE', 'signalSets': [
                    {'signalSetId': 's1', 'label': 'VWAP + MACD', 'winner': {'status': 'WINNER', 'variantId': 'TRAIL', 'validationMeanR': 0.21}},
                    {'signalSetId': 's2', 'label': 'NR7', 'winner': {'status': 'NO_WINNER'}},
                ]}],
            })
            result = read_research_results(root, read_json_optional)
        self.assertEqual(result['exploratory']['totals']['open'], 3)
        self.assertEqual(result['exploratory']['rules'][0]['ruleId'], 'r1')
        self.assertEqual(result['exploratory']['rules'][1]['tradesNeeded'], 27)
        lane = result['exitComparison']['lanes'][0]
        self.assertEqual(lane['signalSetCount'], 2)
        self.assertEqual(lane['winners'][0]['variantId'], 'TRAIL')

    def test_overview_carries_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / 'latest' / 'combination-research-v1.json', combination())
            overview = build_research_overview(root)
        self.assertTrue(overview['research']['results']['combination']['present'])


if __name__ == '__main__':
    unittest.main()
