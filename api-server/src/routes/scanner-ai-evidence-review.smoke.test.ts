import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createBoundedMarketScanRouter } from './bounded-market-scan';
import { ScannerAiEvidenceReviewer } from '../services/scanner-ai-evidence-review.service';
import { MarketIntelligenceAiAnalyzer } from '../services/market-intelligence-ai-analysis.service';
import { ScannerRequestGuard } from '../services/scanner-request-guard.service';
import type { ScannerSignalCard } from '../services/scanner-signal.types';

const card: ScannerSignalCard = { signalId: 'visible-source', assetClass: 'stock', market: 'KR', symbol: 'TEST', currency: 'KRW', price: 100,
  exchange: null, name: 'TEST', assetType: 'STOCK', listingStatus: 'LISTED', changePercent: null, signalState: 'WATCHING',
  confidence: 60, dataCompleteness: 100, riskScore: null, riskLevel: 'UNAVAILABLE', liquidity: null, volume: null,
  tradingValue: null, spreadPercent: null, volatilityPercent: null, notMatched: [], evidence: [], strongSignalEligible: false,
  pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
  direction: 'LONG', score: 60, dataState: 'complete', dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: false, issues: [] }, signalGrade: 'B',
  dataSources: ['public'], matched: [], unverified: [], warnings: [], observedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString() };

async function server(authenticated: boolean, run: (url: string, reviewer: ScannerAiEvidenceReviewer, calls: () => number) => Promise<void>) {
  let calls = 0;
  const reviewer = new ScannerAiEvidenceReviewer(new MarketIntelligenceAiAnalyzer({ answerAiChatImpl: async () => {
    calls++; throw new Error('offline-provider-unavailable');
  } }));
  const app = express(); app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    (req as AuthenticatedRequest).member = { id: 'owner', login_name: 'test', display_name: 'test', role: 'member',
      status: 'approved', membership_level: 'regular', is_active: true };
    (req as AuthenticatedRequest).accessToken = 'offline-test-token';
    next();
  });
  app.use('/api/market/scan', createBoundedMarketScanRouter({ aiReviewer: reviewer, guard: new ScannerRequestGuard() }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise<void>(r => listener.once('listening', r));
  try { await run(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`, reviewer, () => calls); }
  finally { await new Promise<void>(r => listener.close(() => r())); }
}
function post(url: string, body: unknown) { return fetch(`${url}/api/market/scan/ai-review`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

test('AI review requires a session and rejects client-supplied facts before any provider call', async () => {
  await server(false, async url => { assert.equal((await post(url, {})).status, 401); });
  await server(true, async (url, reviewer, calls) => {
    const source = reviewer.capture('owner', { cards: [card] }).cards[0];
    const body = { signalId: source.signalId, evidenceKey: source.aiReviewEvidenceKey };
    assert.equal((await post(url, { ...body, price: 999, facts: ['fake'] })).status, 400);
    assert.equal(calls(), 0);
    assert.equal((await post(url, { ...body, evidenceKey: 'b'.repeat(64) })).status, 409);
    assert.equal(calls(), 0);
    const response = await post(url, body); assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.analysis, null);
    assert.equal(result.safety.orderAllowed, false); assert.equal(result.safety.paperOrderAllowed, false);
    assert.equal(result.safety.profitProbability, null); assert.equal(calls(), 1);
  });
});

test('another member source cannot authorize AI review', async () => {
  await server(true, async (url, reviewer, calls) => {
    const other = reviewer.capture('other', { cards: [card] }).cards[0];
    assert.equal((await post(url, { signalId: other.signalId, evidenceKey: other.aiReviewEvidenceKey })).status, 409);
    assert.equal(calls(), 0);
  });
});
