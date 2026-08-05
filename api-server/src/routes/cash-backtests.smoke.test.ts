import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createCashBacktestsRouter, resetCashBacktestRouteStateForTests } from './cash-backtests';

const START = Date.UTC(2026, 0, 1);
const validBody = {
  market: 'crypto-spot',
  symbol: 'KRW-BTC',
  timeframe: '15m',
  startTime: START,
  endTime: START + 90 * 24 * 60 * 60_000,
  initialCapital: 1_000_000,
  strategy: 'breakout',
  parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
  riskPercent: 0.2,
  entryFeeRate: 0.0005,
  exitFeeRate: 0.0005,
  slippageRate: 0.0002,
  stopLossPercent: 1,
  takeProfitR: 1.5,
  maximumTradesPerDay: 10,
  intrabarPriority: 'stop_first',
};

async function withServer() {
  resetCashBacktestRouteStateForTests();
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', createCashBacktestsRouter({
    execute: async (request) => ({
      ok: true,
      mode: 'backtest-only',
      orderSubmitted: false,
      provider: 'upbit',
      result: {
        ok: true,
        mode: 'backtest-only',
        orderSubmitted: false,
        market: request.market,
        symbol: request.symbol,
        strategy: request.strategy,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        winRate: 100,
        averageWinR: 1.5,
        averageLossR: 0,
        averageRMultiple: 1.5,
        expectancy: 1.5,
        profitFactor: null,
        initialCapital: request.initialCapital,
        finalCapital: request.initialCapital + 1000,
        totalReturnPercent: 0.1,
        maximumDrawdown: 0,
        maximumDrawdownPercent: 0,
        totalFees: 10,
        totalSlippage: 5,
        trades: [],
        warnings: [],
      },
    }),
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
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|authorization|bearer|place-order)/i);
  return JSON.parse(text) as Record<string, any>;
}

test('cash backtest route returns backtest-only result without orders', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/cash/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'backtest-only');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.result.orderSubmitted, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cash backtest route rejects futures market', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/cash/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, market: 'crypto-futures', symbol: 'BTCUSDT' }),
    });
    assert.equal(response.status, 400);
    const body = await safeJson(response);
    assert.equal(body.code, 'INVALID_CASH_MARKET');
    assert.equal(body.orderSubmitted, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cash backtest route rejects inverted periods', async () => {
  const { server, baseUrl } = await withServer();
  try {
    const response = await fetch(`${baseUrl}/api/backtests/cash/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, startTime: validBody.endTime }),
    });
    assert.equal(response.status, 400);
    const body = await safeJson(response);
    assert.equal(body.code, 'INVALID_PERIOD');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
