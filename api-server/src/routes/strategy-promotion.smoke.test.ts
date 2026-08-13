import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createStrategyPromotionRouter } from './strategy-promotion';
import { StrategyPromotionService } from '../services/strategy-promotion.service';

const SHA = '2222222222222222222222222222222222222222';

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use('/api', createStrategyPromotionRouter(new StrategyPromotionService({ sourceSha: SHA, now: () => new Date('2026-08-13T00:00:00.000Z') })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('strategy promotion APIs are GET-only, evidence-backed and fail closed', async () => withServer(async (baseUrl) => {
  const list = await fetch(`${baseUrl}/api/strategy-promotion`);
  assert.equal(list.status, 200);
  const body = await list.json() as { items: Array<{ identity: { strategyId: string } }>; promotionCandidates: number; privateTradingApiCount: number };
  assert.equal(body.items.length, 24);
  assert.equal(body.promotionCandidates, 0);
  assert.equal(body.privateTradingApiCount, 0);
  const strategyId = body.items[0]!.identity.strategyId;

  const filtered = await fetch(`${baseUrl}/api/strategy-promotion?market=CRYPTO_FUTURES&strategyHorizon=SCALP&direction=LONG&status=RESEARCH`);
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json() as { items: Array<{ identity: { market: string; strategyHorizon: string; direction: string }; promotionState: string }> };
  assert.equal(filteredBody.items.length, 1);
  assert.deepEqual(filteredBody.items.map((item) => [item.identity.market, item.identity.strategyHorizon, item.identity.direction, item.promotionState]), [['CRYPTO_FUTURES', 'SCALP', 'LONG', 'RESEARCH']]);

  for (const suffix of ['', '/history', '/evidence']) {
    const response = await fetch(`${baseUrl}/api/strategy-promotion/${encodeURIComponent(strategyId)}${suffix}`);
    assert.equal(response.status, 200);
    const result = await response.json() as { executionAuthority?: string; item?: { executionAuthority: string } };
    assert.equal(result.executionAuthority ?? result.item?.executionAuthority, 'NONE');
  }
  assert.equal((await fetch(`${baseUrl}/api/strategy-promotion/${strategyId}`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/strategy-promotion/UNKNOWN`)).status, 404);
}));
