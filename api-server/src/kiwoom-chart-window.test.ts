import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveKiwoomRawTargetCandles } from './kiwoom-chart';

test('Kiwoom deep-history remains unbounded when no visible-window limit is requested', () => {
  assert.equal(resolveKiwoomRawTargetCandles(undefined, 1), undefined);
  assert.equal(resolveKiwoomRawTargetCandles(0, 1), undefined);
  assert.equal(resolveKiwoomRawTargetCandles(Number.NaN, 1), undefined);
});

test('KR intraday visible-window limit bounds raw Kiwoom continuation work', () => {
  assert.equal(resolveKiwoomRawTargetCandles(300, 1), 300);
  assert.equal(resolveKiwoomRawTargetCandles(300, 4), 1_200);
});

test('visible-window target is normalized without weakening minimum candle evidence', () => {
  assert.equal(resolveKiwoomRawTargetCandles(1, 1), 2);
  assert.equal(resolveKiwoomRawTargetCandles(300.9, 1), 300);
});
