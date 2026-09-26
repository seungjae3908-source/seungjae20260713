import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isScannerRecommendationDirectionAllowed,
  resolveScannerTradeAction,
  withScannerCanonicalActions,
} from './scanner-market-action.service';
import type { ScannerResponse } from './scanner-signal.types';

test('internal canonical actions preserve BUY/SELL for cash and LONG/SHORT for futures', () => {
  assert.equal(resolveScannerTradeAction('stock', 'LONG'), 'BUY');
  assert.equal(resolveScannerTradeAction('stock', 'SHORT'), 'SELL');
  assert.equal(resolveScannerTradeAction('coin_spot', 'LONG'), 'BUY');
  assert.equal(resolveScannerTradeAction('coin_spot', 'SHORT'), 'SELL');
  assert.equal(resolveScannerTradeAction('coin_futures', 'LONG'), 'LONG');
  assert.equal(resolveScannerTradeAction('coin_futures', 'SHORT'), 'SHORT');
  assert.equal(resolveScannerTradeAction('coin_futures', 'NEUTRAL'), 'NONE');
});

test('recommendation surface allows only stock/spot BUY and futures LONG/SHORT', () => {
  assert.equal(isScannerRecommendationDirectionAllowed('stock', 'LONG'), true);
  assert.equal(isScannerRecommendationDirectionAllowed('stock', 'SHORT'), false);
  assert.equal(isScannerRecommendationDirectionAllowed('stock', 'NEUTRAL'), false);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_spot', 'LONG'), true);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_spot', 'SHORT'), false);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_spot', 'NEUTRAL'), false);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_futures', 'LONG'), true);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_futures', 'SHORT'), true);
  assert.equal(isScannerRecommendationDirectionAllowed('coin_futures', 'NEUTRAL'), false);
});

test('canonical recommendation response removes cash SELL while preserving internal SELL semantics', () => {
  const response = {
    cards: [
      { signalId: 'stock-buy', assetClass: 'stock', direction: 'LONG', signalGrade: 'S' },
      { signalId: 'stock-sell', assetClass: 'stock', direction: 'SHORT', signalGrade: 'A' },
      { signalId: 'spot-buy', assetClass: 'coin_spot', direction: 'LONG', signalGrade: 'A' },
      { signalId: 'spot-sell', assetClass: 'coin_spot', direction: 'SHORT', signalGrade: 'B' },
      { signalId: 'futures-long', assetClass: 'coin_futures', direction: 'LONG', signalGrade: 'S' },
      { signalId: 'futures-short', assetClass: 'coin_futures', direction: 'SHORT', signalGrade: 'B' },
    ],
    alerts: [
      { signalId: 'stock-buy', assetClass: 'stock', direction: 'LONG' },
      { signalId: 'stock-sell', assetClass: 'stock', direction: 'SHORT' },
      { signalId: 'spot-buy', assetClass: 'coin_spot', direction: 'LONG' },
      { signalId: 'spot-sell', assetClass: 'coin_spot', direction: 'SHORT' },
      { signalId: 'futures-long', assetClass: 'coin_futures', direction: 'LONG' },
      { signalId: 'futures-short', assetClass: 'coin_futures', direction: 'SHORT' },
    ],
    execution: {
      excludedCount: 3,
      finalDisplayedCount: 6,
      sGradeCount: 2,
      aGradeCount: 2,
      bGradeCount: 2,
    },
  } as unknown as ScannerResponse;

  const result = withScannerCanonicalActions(response);

  assert.deepEqual(
    result.cards.map((card) => [card.signalId, card.action]),
    [
      ['stock-buy', 'BUY'],
      ['spot-buy', 'BUY'],
      ['futures-long', 'LONG'],
      ['futures-short', 'SHORT'],
    ],
  );
  assert.deepEqual(
    result.alerts.map((alert) => [alert.signalId, alert.action]),
    [
      ['stock-buy', 'BUY'],
      ['spot-buy', 'BUY'],
      ['futures-long', 'LONG'],
      ['futures-short', 'SHORT'],
    ],
  );
  assert.equal(result.execution.excludedCount, 5);
  assert.equal(result.execution.finalDisplayedCount, 4);
  assert.equal(result.execution.sGradeCount, 2);
  assert.equal(result.execution.aGradeCount, 1);
  assert.equal(result.execution.bGradeCount, 1);
});
