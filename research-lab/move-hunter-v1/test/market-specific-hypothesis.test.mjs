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
  assert.equal(result.markets.US_STOCK.status, 'RESEARCH_HOLD');
  assert.equal(result.markets.CRYPTO_SPOT.status, 'RESEARCH_HOLD');
  assert.ok(result.markets.CRYPTO_SPOT.reasons.includes('MDD_EXPANSION_LIMIT_EXCEEDED'));
  assert.equal(result.markets.CRYPTO_FUTURES.status, 'RESEARCH_HOLD');
  assert.equal(result.safety.observedHistoryMayCountAsOos, false);
  assert.equal(result.safety.automaticScannerAdoptionAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});
