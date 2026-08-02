import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createBacktestsRouter, resetBacktestRouteStateForTests } from './backtests';
import type { NormalizedCandle } from '../services/futures-market-data.service';
import type { BacktestResult } from '../services/backtest-engine.service';

const START = Date.UTC(2026, 0, 1);
const STEP = 15 * 60_000;
const candles: NormalizedCandle[] = Array.from({ length: 80 }, (_, index) => ({
  timestamp: START + index * STEP,
  open: 100,
  high: index === 60 ? 105 : 101,
  low: 99,
  close: index === 60 ? 104 : 100,
  volume: index === 60 ? 1_000 : 100,
  quoteVolume: 10_000,
  timeframe: '15m',
  symbol: 'BTCUSDT',
  market: 'crypto-futures',
  source: 'fixture',
  isClosed: true,
  isDelayed: false,
  updatedAt: new Date(START + index * STEP).toISOString(),
}));

const validBody = {
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  startTime: START,
  endTime: START + 79 * STEP,
  initialCapital: 10_000,
  strategy: 'breakout',
  side: 'both',
  parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
  riskPercent: 0.5,
  leverage: 2,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  fundingRatePerInterval: 0,
  fundingIntervalHours: 8,
  stopLossMode: 'percent',
  stopLossValue: 1,
  takeProfitMode: 'risk_multiple',
  takeProfitValue: 2,
  trailingStop: { enabled: false },
  maximumConcurrentPositions: 1,
  maximumTradesPerDay: 10,
  intrabarPriority: 'stop_first',
};

async function withServer(execute?: (request: any, rows: readonly NormalizedCandle[]) => BacktestResult) {
  resetBacktestRouteStateForTests();
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', createBacktestsRouter({
    loadCandles: async () => ({ candles, warnings: [], requestCount: 1 }),
    loadContractRules: async () => ({
      symbol: 'BTCUSDT',
      source: 'bitget',
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 5,
      quantityPrecision: 3,
      pricePrecision: 1,
      priceStep: 0.1,
      minimumLeverage: 1,
      maximumLeverage: 125,
      maintenanceMarginRate: null,
      contractSize: null,
      status: 'live',
      updatedAt: new Date().toISOString(),
      warnings: [],
    }),
    execute,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function safeJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|authorization|bearer|crypto-auto|place-order)/i);
  return JSON.parse(text) as Record<string, any>;
}

test('backtest route returns backtest-only result and never submits an order', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'backtest-only');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.result.mode, 'backtest-only');
    assert.equal(body.result.orderSubmitted, false);
    assert.equal('order' in body, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('backtest route rejects invalid periods with safe 400', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, startTime: validBody.endTime }),
    });
    assert.equal(response.status, 400);
    const body = await safeJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.mode, 'backtest-only');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.code, 'INVALID_PERIOD');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('backtest route rejects unsupported strategies', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, strategy: 'arbitrary_javascript' }),
    });
    assert.equal(response.status, 400);
    const body = await safeJson(response);
    assert.equal(body.code, 'UNSUPPORTED_STRATEGY');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('backtest route generalizes unexpected errors without stack traces', async () => {
  const { server, baseUrl } = await withServer(() => {
    throw new Error('internal database secret and stack detail');
  });
  try {
    const response = await fetch(`${baseUrl}/api/backtests/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 500);
    const body = await safeJson(response);
    assert.equal(body.code, 'BACKTEST_EXECUTION_FAILED');
    assert.doesNotMatch(String(body.message), /internal|database/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('backtest route rejects oversized request bodies before execution', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, padding: 'x'.repeat(70_000) }),
    });
    assert.equal(response.status, 413);
    const body = await safeJson(response);
    assert.equal(body.code, 'REQUEST_TOO_LARGE');
    assert.equal(body.orderSubmitted, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
