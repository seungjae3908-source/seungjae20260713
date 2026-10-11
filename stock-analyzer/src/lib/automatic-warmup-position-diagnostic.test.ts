import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAutomaticWarmupPositions } from '../../e2e/production-account-readonly-live-qa-diagnostic';

test('automatic warmup diagnostic distinguishes settlement cash, held exposure and unknown quantities without recording account values', () => {
  assert.deepEqual(summarizeAutomaticWarmupPositions(undefined), {
    positionsPresent: false, nonCashPositionCount: null, unknownPositionQuantityCount: null,
  });
  assert.deepEqual(summarizeAutomaticWarmupPositions({ provider: 'upbit', positions: [
    { symbol: 'KRW', quantity: null }, { symbol: 'BTC', quantity: 0.2 },
    { symbol: 'ETH', quantity: null }, { symbol: 'XRP', quantity: 0 },
  ] }), { positionsPresent: true, nonCashPositionCount: 1, unknownPositionQuantityCount: 1 });
  assert.deepEqual(summarizeAutomaticWarmupPositions({ provider: 'bitget', positions: [
    { symbol: 'BTCUSDT', quantity: -1 }, { symbol: 'ETHUSDT', quantity: NaN },
  ] }), { positionsPresent: true, nonCashPositionCount: 1, unknownPositionQuantityCount: 1 });
  assert.deepEqual(summarizeAutomaticWarmupPositions({ provider: 'toss', positions: [] }), {
    positionsPresent: true, nonCashPositionCount: 0, unknownPositionQuantityCount: 0,
  });
});
