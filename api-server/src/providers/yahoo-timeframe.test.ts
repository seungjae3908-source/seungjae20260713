import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateYahooDerivedTimeframe,
  yahooChartParams,
  getCandles,
  getQuote,
  resetYahooProviderRuntimeForTests,
} from './yahoo';

test.beforeEach(() => resetYahooProviderRuntimeForTests({
  minimumStartIntervalMs: 0,
  transportFallbackDelayMs: 150,
}));
test.afterEach(() => resetYahooProviderRuntimeForTests());

function publicChart(symbol = 'AAPL') {
  return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol, regularMarketTime: 1_700_000_000 }, timestamp: [1_700_000_000],
    indicators: { quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [10] }] } }] } }));
}

test('scanner bounds history without changing long-history chart requests', async t => {
  const reads: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => { reads.push(new URL(String(input))); return publicChart(); });
  await getCandles('AAPL', '1D', { purpose: 'scanner' });
  await getCandles('AAPL', '60m', { purpose: 'scanner' });
  await getCandles('AAPL', '1D');
  assert.deepEqual(reads.map(url => url.searchParams.get('range')), ['1y', '6mo', '10y']);
});

test('a fast successful chart does not start a redundant late hedge', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return publicChart(); });
  await getQuote('AAPL');
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal(calls, 1);
});

test('Korean scanner uses the roster exchange, never a guessed KOSPI alias', async t => {
  const symbols: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const symbol = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
    symbols.push(symbol); return publicChart(symbol);
  });
  await getCandles('247540', '1D', { purpose: 'scanner', exchange: 'KOSDAQ' });
  await getCandles('005930', '1D', { purpose: 'scanner', exchange: 'KOSPI' });
  await getCandles('000020', '1D', { purpose: 'scanner', exchange: '유가증권' });
  await assert.rejects(getCandles('247540', '1D', { purpose: 'scanner', exchange: 'KONEX' }), /EXCHANGE_MAPPING_UNAVAILABLE/);
  assert.deepEqual(symbols, ['247540.KQ', '005930.KS', '000020.KS']);
});

test('Yahoo rejects cross-symbol evidence and never invents missing prices', async t => {
  t.mock.method(globalThis, 'fetch', async () => publicChart('MSFT'));
  await assert.rejects(getCandles('AAPL', '1D'), /YAHOO_PROVIDER_SYMBOL_MISMATCH/);
});

test('pre-abort makes zero public calls and active abort terminates non-cooperative fetch', async t => {
  let calls = 0;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    markStarted();
    return new Promise(() => {});
  });
  const early = new AbortController(); early.abort(new Error('EARLY_ABORT'));
  await assert.rejects(getCandles('AAPL', '1D', { signal: early.signal }), /EARLY_ABORT/);
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = getCandles('AAPL', '1D', { signal: active.signal });
  await started;
  active.abort(new Error('ACTIVE_ABORT'));
  await assert.rejects(pending, /ACTIVE_ABORT/);
  assert.equal(calls, 1);
});

test('bounded sequential transports settle even when both fetches ignore abort', async t => {
  resetYahooProviderRuntimeForTests({
    minimumStartIntervalMs: 0,
    transportFallbackDelayMs: 0,
    requestTimeoutMs: 10,
  });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return new Promise(() => {}); });
  const pending = getCandles('AAPL', '1D');
  await assert.rejects(pending, /YAHOO_CHART_BUDGET_EXCEEDED/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

function candle(time: string, open: number, high: number, low: number, close: number, volume: number) {
  return { time, open, high, low, close, volume };
}

test('Yahoo intraday requests preserve the requested supported interval', () => {
  assert.deepEqual(yahooChartParams('1m'), { range: '7d', interval: '1m' });
  assert.deepEqual(yahooChartParams('5m'), { range: '1mo', interval: '5m' });
  assert.deepEqual(yahooChartParams('15m'), { range: '1mo', interval: '15m' });
  assert.deepEqual(yahooChartParams('30m'), { range: '1mo', interval: '30m' });
  assert.deepEqual(yahooChartParams('1H'), { range: '2y', interval: '60m' });
});

test('Yahoo direct requests reject unsupported intervals instead of returning mislabeled candles', () => {
  assert.throws(() => yahooChartParams('3m'), /YAHOO_UNSUPPORTED_TIMEFRAME:3m/);
  assert.throws(() => yahooChartParams('4H'), /YAHOO_UNSUPPORTED_TIMEFRAME:4H/);
  assert.throws(() => yahooChartParams('unknown'), /YAHOO_UNSUPPORTED_TIMEFRAME:unknown/);
});

test('Yahoo derives a real 3m candle from three contiguous observed 1m candles', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 102, 99, 101, 10),
    candle('2026-08-18T14:31:00.000Z', 101, 104, 100, 103, 20),
    candle('2026-08-18T14:32:00.000Z', 103, 105, 102, 104, 30),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('3m', rows), [
    candle('2026-08-18T14:30:00.000Z', 100, 105, 99, 104, 60),
  ]);
});

test('Yahoo derives a real 4H candle from four contiguous observed 60m candles', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 102, 99, 101, 10),
    candle('2026-08-18T15:30:00.000Z', 101, 104, 100, 103, 20),
    candle('2026-08-18T16:30:00.000Z', 103, 106, 102, 105, 30),
    candle('2026-08-18T17:30:00.000Z', 105, 108, 104, 107, 40),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('4H', rows), [
    candle('2026-08-18T14:30:00.000Z', 100, 108, 99, 107, 100),
  ]);
});

test('Yahoo derived timeframes never bridge an overnight or missing-data gap', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 101, 99, 100, 10),
    candle('2026-08-18T14:31:00.000Z', 100, 101, 99, 100, 10),
    candle('2026-08-19T14:30:00.000Z', 110, 111, 109, 110, 10),
    candle('2026-08-19T14:31:00.000Z', 110, 111, 109, 110, 10),
    candle('2026-08-19T14:32:00.000Z', 110, 112, 109, 111, 10),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('3m', rows), [
    candle('2026-08-19T14:30:00.000Z', 110, 112, 109, 111, 30),
  ]);
});
