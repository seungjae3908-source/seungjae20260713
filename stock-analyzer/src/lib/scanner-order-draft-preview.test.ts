import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnalysisSelection } from './analysis-selection';
import { buildScannerOrderDraftPreview } from './scanner-order-draft-preview';

function selection(action: AnalysisSelection['action'] = 'BUY'): AnalysisSelection {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '15m',
    action,
    pricePlan: {
      entryZone: { from: 68_000, to: 70_000 },
      invalidation: 66_500,
      stopLoss: 66_500,
      targets: [72_000, 74_000],
      riskReward: 1.8,
    },
    selectedAt: '2026-09-25T05:00:00.000Z',
  };
}

test('builds a 60/40 staged draft from the current scanner price plan without submitting an order', () => {
  const draft = buildScannerOrderDraftPreview(selection('BUY'), 1_000_000);
  assert.ok(draft);
  assert.equal(draft?.firstEntry.price, 70_000);
  assert.equal(draft?.firstEntry.amount, 600_000);
  assert.equal(draft?.secondEntry.price, 68_000);
  assert.equal(draft?.secondEntry.amount, 400_000);
  assert.equal(draft?.target1, 72_000);
  assert.equal(draft?.target2, 74_000);
  assert.equal(draft?.stopLoss, 66_500);
  assert.equal(draft?.executionAuthority, 'NONE');
  assert.equal(draft?.orderSubmitted, false);
});

test('SHORT draft preserves directional entry ordering', () => {
  const draft = buildScannerOrderDraftPreview(selection('SHORT'), 2_000);
  assert.ok(draft);
  assert.equal(draft?.firstEntry.price, 68_000);
  assert.equal(draft?.secondEntry.price, 70_000);
});

test('fails closed without a valid budget, direction, or server price plan', () => {
  assert.equal(buildScannerOrderDraftPreview(selection('BUY'), 0), null);
  assert.equal(buildScannerOrderDraftPreview(selection('SELL'), 1_000_000), null);
  const missing = selection('BUY');
  missing.pricePlan = undefined;
  assert.equal(buildScannerOrderDraftPreview(missing, 1_000_000), null);
});
