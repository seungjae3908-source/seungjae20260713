import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateScannerDataQuality,
  type ScannerQualityCandle,
} from './scanner-data-quality.service';

const NOW = Date.parse('2026-08-08T03:30:00.000Z');

function candles(count = 40, intervalMs = 5 * 60_000): ScannerQualityCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.05;
    return {
      time: NOW - (count - index) * intervalMs,
      open: close - 0.02,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1_000 + index * 5,
    };
  });
}

function codes(result: ReturnType<typeof evaluateScannerDataQuality>) {
  return new Set(result.issues.map((issue) => issue.code));
}

test('clean candles pass the gate and allow strong signals', () => {
  const result = evaluateScannerDataQuality({
    symbol: 'BTCUSDT',
    timeframe: '5m',
    candles: candles(),
    now: NOW,
  });
  assert.equal(result.state, 'TRUSTED');
  assert.equal(result.strongSignalAllowed, true);
  assert.equal(result.issues.length, 0);
});

test('ISO Z and explicit offsets preserve their instant rather than being parsed as KST', () => {
  for (const format of [(ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z'),
    (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00')]) {
    const rows = candles().map((row) => ({ ...row, time: format(Number(row.time)) }));
    const result = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: rows, now: NOW });
    assert.equal(result.state, 'TRUSTED');
    assert.equal(result.lastTimestamp, new Date(NOW - 5 * 60_000).toISOString());
  }
});

test('future evidence fails closed even if its OHLC and volume are valid', () => {
  const rows = candles();
  rows.at(-1)!.time = NOW + 5 * 60_000;
  const result = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: rows, now: NOW });
  assert.equal(result.state, 'DATA_UNTRUSTED');
  assert.equal(result.strongSignalAllowed, false);
  assert.ok(codes(result).has('FUTURE_TIMESTAMP'));
});

test('one long hole counts missing bars instead of looking like one minor warning', () => {
  const rows = candles(100).map((row, index) => ({
    ...row, time: Number(row.time) - (index < 50 ? 100 * 5 * 60_000 : 0),
  }));
  const result = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: rows, now: NOW });
  assert.equal(result.state, 'DATA_UNTRUSTED');
  assert.equal(result.issues.find((issue) => issue.code === 'MISSING_CANDLE')?.severity, 'blocking');
});

test('sorting inside validation cannot certify a reversed input used by EMA/RSI', () => {
  const result = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: candles().reverse(), now: NOW });
  assert.equal(result.state, 'DATA_UNTRUSTED');
  assert.ok(codes(result).has('OUT_OF_ORDER_CANDLE'));
});

test('a six-hour same-session hole is not excused as an overnight stock closure', () => {
  const rows = candles().map((row, index) => ({ ...row,
    time: Date.parse(index < 20 ? '2026-08-10T00:00:00Z' : '2026-08-10T06:00:00Z') + index * 5 * 60_000,
  }));
  const result = evaluateScannerDataQuality({ symbol: '005930', timeframe: '5m', candles: rows,
    now: Date.parse('2026-08-10T10:00:00Z'), sessionAware: true, sessionTimeZone: 'Asia/Seoul' });
  assert.equal(result.issues.find((issue) => issue.code === 'MISSING_CANDLE')?.severity, 'blocking');
});

test('stale, duplicate, missing, invalid OHLC and volume become DATA_UNTRUSTED', () => {
  const staleRows = candles(20).map((row) => ({ ...row, time: Number(row.time) - 60 * 60_000 }));
  const stale = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: staleRows, now: NOW });
  assert.equal(stale.state, 'DATA_UNTRUSTED');
  assert.ok(codes(stale).has('STALE_TIMESTAMP'));

  const duplicateRows = candles(20);
  duplicateRows[5] = { ...duplicateRows[5], time: duplicateRows[4].time };
  const duplicate = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: duplicateRows, now: NOW });
  assert.equal(duplicate.state, 'DATA_UNTRUSTED');
  assert.ok(codes(duplicate).has('DUPLICATE_CANDLE'));

  const missingRows = candles(12);
  missingRows[6] = { ...missingRows[6], time: Number(missingRows[5].time) + 20 * 60_000 };
  const missing = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: missingRows, now: NOW });
  assert.equal(missing.state, 'DATA_UNTRUSTED');
  assert.ok(codes(missing).has('MISSING_CANDLE'));

  const invalidOhlcRows = candles(20);
  invalidOhlcRows[10] = { ...invalidOhlcRows[10], high: 90 };
  const invalidOhlc = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: invalidOhlcRows, now: NOW });
  assert.equal(invalidOhlc.state, 'DATA_UNTRUSTED');
  assert.ok(codes(invalidOhlc).has('INVALID_OHLC'));

  const invalidVolumeRows = candles(20);
  invalidVolumeRows[10] = { ...invalidVolumeRows[10], volume: -1 };
  const invalidVolume = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: invalidVolumeRows, now: NOW });
  assert.equal(invalidVolume.state, 'DATA_UNTRUSTED');
  assert.ok(codes(invalidVolume).has('INVALID_VOLUME'));
});

test('abnormal spike, symbol mismatch, provider disagreement, closed and halt are checked', () => {
  const spikeRows = candles(20);
  spikeRows[19] = { ...spikeRows[19], close: 190, high: 191 };
  const spike = evaluateScannerDataQuality({ symbol: 'BTC', timeframe: '5m', candles: spikeRows, now: NOW });
  assert.ok(codes(spike).has('ABNORMAL_SPIKE'));
  assert.equal(spike.state, 'DATA_UNTRUSTED');

  const providers = evaluateScannerDataQuality({
    symbol: 'BTC',
    timeframe: '5m',
    candles: candles(),
    now: NOW,
    providerObservations: [
      { provider: 'p1', symbol: 'BTC', price: 100, observedAt: NOW },
      { provider: 'p2', symbol: 'ETH', price: 110, observedAt: NOW },
    ],
  });
  assert.ok(codes(providers).has('SYMBOL_MISMATCH'));
  assert.ok(codes(providers).has('PROVIDER_DISAGREEMENT'));
  assert.equal(providers.strongSignalAllowed, false);

  const closed = evaluateScannerDataQuality({ symbol: '005930', timeframe: '5m', candles: candles(), now: NOW, marketClosed: true });
  assert.ok(codes(closed).has('MARKET_CLOSED'));
  assert.equal(closed.state, 'DATA_UNTRUSTED');

  const halted = evaluateScannerDataQuality({ symbol: '005930', timeframe: '5m', candles: candles(), now: NOW, tradingHalt: true });
  assert.ok(codes(halted).has('TRADING_HALT'));
  assert.equal(halted.state, 'DATA_UNTRUSTED');
});

test('Kiwoom compact timestamp parses and stock session gaps are not treated as missing candles', () => {
  const rows: ScannerQualityCandle[] = [
    { time: '20260807153000', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
    { time: '20260808090000', open: 100, high: 101, low: 99, close: 100.5, volume: 1_100 },
    { time: '20260808090500', open: 100.5, high: 101, low: 100, close: 100.8, volume: 1_200 },
  ];
  const result = evaluateScannerDataQuality({
    symbol: '005930',
    timeframe: '5m',
    candles: rows,
    now: Date.parse('2026-08-08T00:07:00.000Z'),
    sessionAware: true,
  });
  assert.equal(codes(result).has('INVALID_OHLC'), false);
  assert.equal(codes(result).has('MISSING_CANDLE'), false);
  assert.equal(result.lastTimestamp, '2026-08-08T00:05:00.000Z');
});
