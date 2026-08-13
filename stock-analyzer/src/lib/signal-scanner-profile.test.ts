import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getScannerUiProfile,
  SCANNER_STRATEGY_OPTIONS,
  toAiChartStrategyMode,
} from './signal-scanner-profile';

describe('unified scanner UI profile', () => {
  it('exposes only the three investment styles', () => {
    assert.deepEqual(SCANNER_STRATEGY_OPTIONS.map((item) => item.label), ['단타', '스윙', '중장기']);
  });

  it('resolves all four markets for every style', () => {
    const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
    const strategies = ['scalping', 'swing', 'position'] as const;
    for (const market of markets) for (const strategy of strategies) {
      const profile = getScannerUiProfile(market, strategy);
      assert.ok(profile.timeframe);
      assert.ok(profile.conditions.length > 0);
      assert.ok(profile.indicators.length > 0);
    }
  });

  it('maps scanner horizons to the canonical AI Chart strategy modes', () => {
    assert.equal(toAiChartStrategyMode('scalping'), 'SCALPING');
    assert.equal(toAiChartStrategyMode('swing'), 'SWING');
    assert.equal(toAiChartStrategyMode('position'), 'MID_LONG');
  });
});