import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveKiwoomRawTargetCandles } from './kiwoom-chart';
import { getKiwoomToken, kiwoomRequest } from './providers/kiwoom';
import { resolveKrInteractiveMaxPages } from './services/market-data.service';

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

test('KR interactive page budgets are deterministic by intraday interval', () => {
  assert.equal(resolveKrInteractiveMaxPages('1m'), 6);
  assert.equal(resolveKrInteractiveMaxPages('3m'), 6);
  assert.equal(resolveKrInteractiveMaxPages('5m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('15m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('30m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('60m'), 10);
  assert.equal(resolveKrInteractiveMaxPages('1H'), 10);
  assert.equal(resolveKrInteractiveMaxPages('4H'), 12);
});

test('caller abort reaches Kiwoom token acquisition before credentials or network work', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getKiwoomToken(controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /호출자에 의해 취소/);
      return true;
    },
  );
});

test('caller abort reaches Kiwoom request queue/transport contract before provider work', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    kiwoomRequest({
      apiId: 'ka10080',
      path: '/api/dostk/chart',
      body: { stk_cd: '005930', tic_scope: '1' },
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /호출자에 의해 취소/);
      return true;
    },
  );
});
