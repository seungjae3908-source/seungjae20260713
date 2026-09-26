import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledMomentumFormula } from './research-bundle-formula-fixture.js';
import { buildEvidenceBackedFormulaExecutionParametersV1, createEvidenceBackedFormulaSignalEvaluatorV1 } from '../src/evidence-backed-formula-entry-evaluator-v1.js';
import { runOnePassCandidateBacktestV1 } from '../src/research-tournament-engine-v1.js';

function input() {
  const { formula: formulaCandidate, generated: generatedCandidate } = compiledMomentumFormula();
  const start = Date.UTC(2020, 0, 2), step = 900000;
  return { formulaCandidate, generatedCandidate, datasetIdentity: 'TEST_ONLY_TRAIN',
    ...createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate, generatedCandidate }),
    executionParameters: buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate, generatedCandidate }),
    period: { startTime: start, endTime: start + 9 * step, includeFinalHoldout: false }, finalHoldout: false,
    backtestInput: { market: 'US_STOCK', symbol: 'AAPL', timeframe: '15m', side: 'long', initialCapital: 10000,
      candles: Array.from({ length: 10 }, (_, i) => ({ timestamp: start + i * step,
        open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 100 + i })),
      riskModel: { riskPerTrade: 0.005, maximumCapitalFraction: 1, leverage: 1, quantityStep: 1 },
      costModel: { entryFeeRate: 0.0006, exitFeeRate: 0.0006, taxRate: 0.001, slippageRate: 0.0005,
        spreadRate: 0.0001, latencyBars: 0, latencyDriftRate: 0 }, fundingRates: [] },
  };
}
test('bundle canonical training entrypoint cannot inspect poisoned post-period bars', () => {
  const clean = input(), poisoned = input();
  poisoned.backtestInput.candles.push({ timestamp: clean.period.endTime + 900000,
    open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN });
  const expected = runOnePassCandidateBacktestV1(clean), actual = runOnePassCandidateBacktestV1(poisoned);
  assert.deepEqual(actual, expected);
  assert.equal(actual.canonicalBacktestOwner, '#690');
  assert.equal(actual.executionEngine, 'runIndependentSignalBacktest');
  assert.equal(actual.safety.executionAuthority, 'NONE');
});
test('existing one-pass evidence cannot be mistaken for complete empirical Full Cost', () => {
  const actual = runOnePassCandidateBacktestV1(input());
  assert.equal(actual.costEvidence.liquidityImpact, null);
  assert.equal(actual.costEvidence.partialFillImpact, undefined);
  assert.equal(actual.safety.profitabilityClaimAllowed, false);
});
