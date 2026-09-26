import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import tradingRiskRouter from './trading-risk';

const validInput = {
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  side: 'long',
  accountBalance: 10_000,
  entryPrice: 100,
  stopLossPrice: 99,
  targetPrice1: 103,
  targetPrice2: 105,
  leverage: 2,
  riskPercent: 0.5,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  estimatedFundingRate: 0.0001,
  quantityStep: 0.001,
  minimumQuantity: 0.001,
  minimumNotional: 5,
  dailyRealizedPnl: 0,
  weeklyRealizedPnl: 0,
  consecutiveLosses: 0,
  openExposure: 0,
  sameDirectionExposure: 0,
  dataStatus: 'live',
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', tradingRiskRouter);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readSafeJson(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  assert.match(contentType, /application\/json/i);
  const text = await response.text();
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|authorization|bearer|crypto-auto)/i);
  return JSON.parse(text) as Record<string, unknown>;
}

test('risk preview route returns preview-only result without order submission', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/trading/risk/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validInput),
    });
    assert.equal(response.status, 200);
    const body = await readSafeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'preview-only');
    assert.equal(body.orderSubmitted, false);
    const result = body.result as Record<string, unknown>;
    assert.equal(result.allowed, true);
    assert.ok(Number(result.recommendedQuantity) > 0);
    assert.ok(Number(result.estimatedMaximumLoss) <= Number(result.maximumRiskAmount));
  });
});

test('risk preview route returns 400 for malformed numeric input', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/trading/risk/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validInput, entryPrice: '100' }),
    });
    assert.equal(response.status, 400);
    const body = await readSafeJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.mode, 'preview-only');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.error, 'INVALID_RISK_INPUT');
  });
});

test('non-live data returns a safe 200 preview with entry assessment blocked', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/trading/risk/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validInput, dataStatus: 'cached' }),
    });
    assert.equal(response.status, 200);
    const body = await readSafeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.orderSubmitted, false);
    const result = body.result as { allowed?: boolean; blockCodes?: string[] };
    assert.equal(result.allowed, false);
    assert.ok(result.blockCodes?.includes('DATA_NOT_LIVE'));
  });
});
