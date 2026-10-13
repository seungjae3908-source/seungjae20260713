import test from 'node:test';
import assert from 'node:assert/strict';
import { ScannerAiEvidenceReviewer } from './scanner-ai-evidence-review.service';
import { MarketIntelligenceAiAnalyzer } from './market-intelligence-ai-analysis.service';
import type { ScannerSignalCard } from './scanner-signal.types';

export function reviewCard(assetClass: ScannerSignalCard['assetClass'] = 'stock', market = 'KR'): ScannerSignalCard {
  return { signalId: `test-${assetClass}-${market}`, assetClass, market, exchange: null, symbol: 'TEST', name: 'TEST',
    currency: 'KRW', assetType: 'STOCK', listingStatus: 'LISTED', price: 100, changePercent: null, direction: 'LONG',
    signalState: 'WATCHING', score: 60, confidence: 60, dataCompleteness: 100, riskScore: 30, riskLevel: 'MEDIUM',
    liquidity: null, volume: null, tradingValue: null, spreadPercent: null, volatilityPercent: null,
    matched: ['공개 추세 근거'], notMatched: [], unverified: ['OOS 검증 필요'], evidence: [],
    pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    dataState: 'complete', dataSources: ['public-candles'], observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), strongSignalEligible: false, warnings: [], signalGrade: 'B',
    dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: false, issues: [] } };
}

function analyzer(counter: () => void = () => {}) {
  return new MarketIntelligenceAiAnalyzer({ answerAiChatImpl: async () => {
    counter();
    return { kind: 'answer', model: 'offline-fixture', provider: 'google-gemini', fallbackUsed: false,
      providerLatencyMs: 0, generatedAt: new Date().toISOString(),
      data: { status: 'not_requested', asOf: null, basis: 'server_collection_time', sources: [], missing: [] },
      answer: JSON.stringify({ schemaVersion: 'MarketIntelAiAnalysisV1', summaryShort: '공개 후보 근거이며 검증이 더 필요합니다.',
        sentiment: 'NEUTRAL', importanceScore: 50, confidenceScore: 50, impactHorizon: 'UNKNOWN', factEvidenceRefs: [0],
        inferences: ['후보의 실제 수익성은 확인되지 않았습니다.'], uncertainty: ['비용 반영 OOS 검증이 필요합니다.'], riskFlags: [], catalystFlags: [] }) };
  } });
}

test('capture never invokes AI; four markets review public facts without changing scores or granting orders', async () => {
  let calls = 0;
  const reviewer = new ScannerAiEvidenceReviewer(analyzer(() => calls++));
  for (const [asset, market] of [['stock', 'KR'], ['stock', 'US'], ['coin_spot', 'UPBIT'], ['coin_futures', 'BITGET']] as const) {
    const source = reviewCard(asset, market);
    const before = calls;
    const captured = reviewer.capture('owner', { cards: [source], dataState: 'complete' });
    assert.equal(calls, before);
    assert.equal(source.score, captured.cards[0].score);
    assert.equal('aiReviewEvidenceKey' in source, false);
    assert.ok(captured.cards[0].aiReviewEvidenceKey);
    const result = await reviewer.review('owner', source.signalId, captured.cards[0].aiReviewEvidenceKey!, new AbortController().signal);
    assert.equal(result.status, 'REVIEWED');
    assert.equal(result.safety.profitProbability, null); assert.equal(result.safety.orderAllowed, false);
    assert.equal(result.safety.profitabilityPass, false); assert.equal(result.safety.scoreImpact, 0);
    assert.ok(!JSON.stringify(result.facts).includes('owner'));
  }
  assert.equal(calls, 4);
});

test('ownership, exact evidence revision and current membership grade are enforced before AI', async () => {
  let calls = 0;
  const reviewer = new ScannerAiEvidenceReviewer(analyzer(() => calls++));
  const card = reviewCard();
  const key = reviewer.capture('owner', { cards: [card] }).cards[0].aiReviewEvidenceKey;
  assert.ok(key);
  const signal = new AbortController().signal;
  await assert.rejects(reviewer.review('other', card.signalId, key!, signal), /AI_REVIEW_SOURCE_EXPIRED/);
  await assert.rejects(reviewer.review('owner', card.signalId, 'a'.repeat(64), signal), /AI_REVIEW_SOURCE_EXPIRED/);
  await assert.rejects(reviewer.review('owner', card.signalId, key!, signal, () => false), /SCANNER_GRADE_FORBIDDEN/);
  const revised = reviewer.capture('owner', { cards: [{ ...card, price: 101 }] }).cards[0].aiReviewEvidenceKey;
  assert.notEqual(revised, key); assert.equal(calls, 0);
});

test('untrusted data is blocked without AI; expiry during a response cannot revive a stale signal', async () => {
  let calls = 0; let now = Date.now();
  const reviewer = new ScannerAiEvidenceReviewer(analyzer(() => { calls++; now += 120_000; }), () => now);
  const card = reviewCard();
  const captured = reviewer.capture('owner', { cards: [{ ...card, dataState: 'partial' as const }] }).cards[0];
  const blocked = await reviewer.review('owner', captured.signalId, captured.aiReviewEvidenceKey!, new AbortController().signal);
  assert.equal(blocked.status, 'BLOCKED_DATA'); assert.equal(calls, 0);
  const current = reviewer.capture('owner', { cards: [card] }).cards[0];
  await assert.rejects(reviewer.review('owner', current.signalId, current.aiReviewEvidenceKey!, new AbortController().signal), /AI_REVIEW_SOURCE_EXPIRED/);
});

test('malformed legacy cards do not crash the scan or receive an AI evidence reference', () => {
  const reviewer = new ScannerAiEvidenceReviewer(analyzer(() => { throw new Error('must-not-call'); }));
  const result = reviewer.capture('owner', { cards: [{ ...reviewCard(), currency: undefined } as unknown as ScannerSignalCard] });
  assert.equal(result.cards[0].aiReviewEvidenceKey, undefined);
});
