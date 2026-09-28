import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeMarketSpecificHypotheses,
} from '../src/market-specific-hypothesis.mjs';

function metric(totalReturn, maximumDrawdown, profitFactor, tradeCount) {
  return { totalReturn, maximumDrawdown, profitFactor, tradeCount };
}

test('market-specific freezer only freezes candidates that beat baseline/full without risk expansion', () => {
  const ablation = {
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    markets: {
      KR_STOCK: {
        sourceTimeframes: ['1D'],
        variants: {
          BASELINE: metric(0.1199, 0.0330, 3.216, 24),
          FULL: metric(0.5157, 0.0329, 9.649, 30),
          NO_TREND: metric(0.2989, 0.0324, 7.799, 24),
          NO_MOMENTUM: metric(0.4581, 0.0329, 8.455, 32),
          NO_STRUCTURE: metric(0.2370, 0.0324, 6.173, 26),
          NO_VOLUME: metric(0.5672, 0.0267, 15.325, 23),
          NO_VOLATILITY: metric(0.2524, 0.0377, 6.514, 25),
        },
      },
      US_STOCK: {
        sourceTimeframes: ['1D'],
        variants: {
          BASELINE: metric(-0.0011, 0.0445, 0.964, 24),
          FULL: metric(-0.0229, 0.0557, 0.532, 29),
          NO_TREND: metric(-0.0250, 0.0557, 0.511, 29),
          NO_MOMENTUM: metric(-0.0134, 0.0334, 0.665, 24),
          NO_STRUCTURE: metric(-0.0106, 0.0414, 0.744, 27),
          NO_VOLUME: metric(-0.0201, 0.0505, 0.565, 27),
          NO_VOLATILITY: metric(-0.0039, 0.0281, 0.891, 22),
        },
      },
      CRYPTO_SPOT: {
        sourceTimeframes: ['4H'],
        variants: {
          BASELINE: metric(0.0092, 0.0511, 1.079, 93),
          FULL: metric(0.0052, 0.1173, 1.044, 115),
          NO_TREND: metric(0.0011, 0.1067, 1.026, 107),
          NO_MOMENTUM: metric(0.0260, 0.0973, 1.162, 105),
          NO_STRUCTURE: metric(-0.0085, 0.0993, 0.972, 106),
          NO_VOLUME: metric(0.0047, 0.0981, 1.043, 111),
          NO_VOLATILITY: metric(0.0140, 0.0900, 1.101, 99),
        },
      },
      CRYPTO_FUTURES: {
        sourceTimeframes: ['4H'],
        variants: {
          BASELINE: metric(0.0992, 0.0747, 1.551, 229),
          FULL: metric(0.0313, 0.1181, 1.169, 276),
          NO_TREND: metric(0.0363, 0.1018, 1.214, 252),
          NO_MOMENTUM: metric(0.0486, 0.1114, 1.270, 253),
          NO_STRUCTURE: metric(0.0507, 0.1159, 1.292, 249),
          NO_VOLUME: metric(0.0278, 0.1153, 1.155, 272),
          NO_VOLATILITY: metric(0.0626, 0.0917, 1.399, 227),
        },
      },
    },
  };

  const result = freezeMarketSpecificHypotheses(ablation);
  assert.equal(result.markets.KR_STOCK.status, 'FROZEN_HYPOTHESIS');
  assert.equal(result.markets.KR_STOCK.selectedVariant, 'NO_VOLUME');
  assert.equal(result.markets.KR_STOCK.futureValidation.sourceTimeframe, '1D');
  assert.equal(result.markets.KR_STOCK.futureValidation.targetForwardTimeframe, '60M');
  assert.equal(result.markets.KR_STOCK.futureValidation.timeframeMatch, false);
  assert.equal(result.markets.KR_STOCK.futureValidation.forwardAdmissionStatus, 'BLOCKED_TIMEFRAME_IDENTITY');
  assert.ok(result.markets.KR_STOCK.futureValidation.forwardAdmissionReasons.includes('SOURCE_FORWARD_TIMEFRAME_MISMATCH'));
  assert.equal(result.markets.KR_STOCK.futureValidation.crossTimeframeCreditAllowed, false);
  assert.equal(result.markets.US_STOCK.status, 'RESEARCH_HOLD');
  assert.equal(result.markets.CRYPTO_SPOT.status, 'RESEARCH_HOLD');
  assert.equal(result.markets.CRYPTO_SPOT.futureValidation.timeframeMatch, true);
  assert.ok(result.markets.CRYPTO_SPOT.reasons.includes('MDD_EXPANSION_LIMIT_EXCEEDED'));
  assert.equal(result.markets.CRYPTO_FUTURES.status, 'RESEARCH_HOLD');
  assert.equal(result.safety.observedHistoryMayCountAsOos, false);
  assert.equal(result.safety.crossTimeframeCreditAllowed, false);
  assert.equal(result.safety.automaticScannerAdoptionAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});


test('matching 60m hypothesis only opens unused Forward observation, never execution authority', () => {
  const result = freezeMarketSpecificHypotheses({
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    markets: {
      KR_STOCK: {
        sourceTimeframes: ['60M'],
        variants: {
          BASELINE: metric(0.10, 0.05, 1.5, 40),
          FULL: metric(0.12, 0.045, 1.6, 38),
          NO_TREND: metric(0.11, 0.045, 1.55, 37),
          NO_MOMENTUM: metric(0.115, 0.044, 1.57, 36),
          NO_STRUCTURE: metric(0.105, 0.046, 1.52, 39),
          NO_VOLUME: metric(0.15, 0.043, 1.8, 35),
          NO_VOLATILITY: metric(0.13, 0.044, 1.65, 34),
        },
      },
    },
  });
  const kr = result.markets.KR_STOCK;
  assert.equal(kr.status, 'FROZEN_HYPOTHESIS');
  assert.equal(kr.selectedVariant, 'NO_VOLUME');
  assert.equal(kr.futureValidation.timeframeMatch, true);
  assert.equal(kr.futureValidation.forwardAdmissionStatus, 'ELIGIBLE_FOR_UNUSED_FORWARD_OBSERVATION');
  assert.equal(kr.futureValidation.allowedUse, 'UNUSED_OOS_OR_FORWARD_ONLY');
  assert.equal(kr.futureValidation.observedHistoryMayCountAsForward, false);
  assert.equal(kr.futureValidation.crossTimeframeCreditAllowed, false);
  assert.equal(kr.futureValidation.automaticScannerAdoptionAllowed, false);
  assert.equal(kr.futureValidation.automaticPromotionAllowed, false);
  assert.equal(kr.futureValidation.executionAuthority, 'NONE');
});


test('freezer selects the best gate-passing candidate instead of rejecting market when raw return leader fails risk', () => {
  const result = freezeMarketSpecificHypotheses({
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    markets: {
      KR_STOCK: {
        sourceTimeframes: ['60M'],
        variants: {
          BASELINE: metric(0.10, 0.05, 1.40, 40),
          FULL: metric(0.11, 0.05, 1.45, 40),
          NO_TREND: metric(0.20, 0.08, 1.70, 35),
          NO_MOMENTUM: metric(0.16, 0.052, 1.60, 34),
          NO_STRUCTURE: metric(0.12, 0.05, 1.46, 33),
          NO_VOLUME: metric(0.14, 0.049, 1.55, 32),
          NO_VOLATILITY: metric(0.13, 0.05, 1.50, 31),
        },
      },
    },
  });
  const kr = result.markets.KR_STOCK;
  assert.equal(kr.descriptiveBestVariant, 'NO_TREND');
  assert.ok(kr.candidateDiagnostics.find((row) => row.id === 'NO_TREND').reasons.includes('MDD_EXPANSION_LIMIT_EXCEEDED'));
  assert.equal(kr.status, 'FROZEN_HYPOTHESIS');
  assert.equal(kr.selectedVariant, 'NO_MOMENTUM');
  assert.equal(kr.eligibleCandidateCount >= 1, true);
});


test('loss-making variants cannot be frozen merely because they lose less than baseline', () => {
  const result = freezeMarketSpecificHypotheses({
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    markets: {
      US_STOCK: {
        sourceTimeframes: ['60M'],
        variants: {
          BASELINE: metric(-0.06, 0.12, 0.71, 100),
          FULL: metric(-0.065, 0.14, 0.72, 120),
          NO_TREND: metric(-0.041, 0.12, 0.80, 110),
          NO_MOMENTUM: metric(-0.047, 0.12, 0.78, 115),
          NO_STRUCTURE: metric(-0.042, 0.11, 0.79, 112),
          NO_VOLUME: metric(-0.068, 0.16, 0.69, 118),
          NO_VOLATILITY: metric(-0.039, 0.12, 0.79, 108),
        },
      },
    },
  });
  const us = result.markets.US_STOCK;
  assert.equal(us.status, 'RESEARCH_HOLD');
  assert.equal(us.selectedVariant, null);
  assert.equal(us.eligibleCandidateCount, 0);
  assert.equal(us.futureValidation.forwardAdmissionStatus, 'NONE');
  assert.equal(us.futureValidation.executionAuthority, 'NONE');
  assert.ok(us.candidateDiagnostics.every((row) =>
    row.reasons.includes('CANDIDATE_RETURN_NOT_POSITIVE')
    || row.reasons.includes('PROFIT_FACTOR_BELOW_MINIMUM')));
});


test('relative improvement cannot freeze a still-losing candidate', () => {
  const result = freezeMarketSpecificHypotheses({
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    markets: {
      US_STOCK: {
        sourceTimeframes: ['60M'],
        variants: {
          BASELINE: metric(-0.10, 0.10, 0.70, 80),
          FULL: metric(-0.08, 0.09, 0.75, 75),
          NO_TREND: metric(-0.05, 0.08, 0.90, 70),
          NO_MOMENTUM: metric(-0.04, 0.08, 0.95, 70),
          NO_STRUCTURE: metric(-0.03, 0.07, 0.98, 70),
          NO_VOLUME: metric(-0.02, 0.07, 0.99, 70),
          NO_VOLATILITY: metric(-0.01, 0.06, 0.995, 70),
        },
      },
    },
  });
  const us = result.markets.US_STOCK;
  assert.equal(us.status, 'RESEARCH_HOLD');
  assert.equal(us.selectedVariant, null);
  const leader = us.candidateDiagnostics.find((row) => row.id === 'NO_VOLATILITY');
  assert.ok(leader.reasons.includes('NON_POSITIVE_TOTAL_RETURN'));
  assert.ok(leader.reasons.includes('PROFIT_FACTOR_NOT_ABOVE_ONE'));
  assert.equal(us.futureValidation.forwardAdmissionStatus, 'NONE');
});
