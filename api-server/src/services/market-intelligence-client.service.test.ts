import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketIntelligence,
  marketIntelligenceNotAvailable,
  marketIntelligenceTradeDecision,
  scannerDirectionalAdjustment,
} from './market-intelligence-client.service';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readyPayload(input: {
  mode?: 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE';
  adjustment?: number;
  hardBlockReason?: string | null;
} = {}) {
  return {
    ok: true,
    serviceSha: 'sidecar-sha',
    result: {
      safety: {
        executionAuthority: 'NONE',
        privateTradingApiAllowed: false,
        realOrderAllowed: false,
        orderSubmissionAllowed: false,
      },
      scanner: {
        mode: 'SOFT_INTELLIGENCE_LAYER',
        adjustment: input.adjustment ?? 8,
        intelligenceScore: 68,
        bullishScore: 68,
        bearishScore: 32,
        hardBlockReason: input.hardBlockReason ?? null,
        candidateDeletionAllowed: false,
      },
      autoTrading: {
        mode: input.mode ?? 'PAPER_ONLY',
        orderAllowed: false,
        evidenceReady: input.mode === 'ELIGIBLE_FOR_PARENT_GATE',
        parentEligibilityReady: input.mode === 'ELIGIBLE_FOR_PARENT_GATE',
        hardBlockReason: input.hardBlockReason ?? null,
      },
      warnings: input.mode === 'PAPER_ONLY' ? ['AUTO_TRADING_FORWARD_EVIDENCE_INSUFFICIENT'] : [],
    },
  };
}

test('canonical client uses loopback public-only endpoint and preserves zero order authority', async () => {
  const requested: string[] = [];
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return response(readyPayload());
    },
  });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^http:\/\/127\.0\.0\.1:8791\/v1\/public\/crypto\/futures\/BTCUSDT$/);
  assert.equal(intelligence.status, 'READY');
  assert.equal(intelligence.serviceSha, 'sidecar-sha');
  assert.equal(intelligence.autoTrading.orderAllowed, false);
  assert.equal(intelligence.scanner.candidateDeletionAllowed, false);
});

test('canonical client rejects non-loopback Market Intelligence configuration', async () => {
  await assert.rejects(
    () => fetchMarketIntelligence('CRYPTO_SPOT', 'KRW-BTC', {
      baseUrl: 'https://example.com',
      fetchImpl: async () => response(readyPayload()),
    }),
    /MARKET_INTELLIGENCE_LOOPBACK_ONLY/,
  );
});

test('scanner directional adjustment rewards matching direction and reverses for short', () => {
  const intelligence = marketIntelligenceNotAvailable('CRYPTO_FUTURES', 'BTCUSDT');
  const ready = {
    ...intelligence,
    status: 'READY' as const,
    scanner: { ...intelligence.scanner, adjustment: 12 },
  };
  assert.equal(scannerDirectionalAdjustment({ direction: 'LONG' }, ready), 12);
  assert.equal(scannerDirectionalAdjustment({ direction: 'SHORT' }, ready), -12);
});

test('PAPER_ONLY intelligence allows paper but fail-closes live trading', async () => {
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async () => response(readyPayload({ mode: 'PAPER_ONLY' })),
  });
  const paper = marketIntelligenceTradeDecision(intelligence, 'paper');
  const live = marketIntelligenceTradeDecision(intelligence, 'live');
  assert.equal(paper.allowed, true);
  assert.ok(paper.warnings.includes('MARKET_INTELLIGENCE_PAPER_ONLY'));
  assert.equal(live.allowed, false);
  assert.equal(live.blockCode, 'MARKET_INTELLIGENCE_FORWARD_EVIDENCE_REQUIRED');
});

test('BLOCKED_RISK intelligence blocks every new entry without granting order authority', async () => {
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async () => response(readyPayload({ mode: 'BLOCKED_RISK', hardBlockReason: 'STALE_INTELLIGENCE_DATA' })),
  });
  for (const accountMode of ['paper', 'mock', 'live'] as const) {
    const decision = marketIntelligenceTradeDecision(intelligence, accountMode);
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockCode, 'STALE_INTELLIGENCE_DATA');
    assert.equal(decision.intelligence.autoTrading.orderAllowed, false);
  }
});

test('unavailable intelligence is fail-soft for paper/mock and fail-closed for live', () => {
  const intelligence = marketIntelligenceNotAvailable('CRYPTO_SPOT', 'KRW-BTC', 'INTELLIGENCE_DOWN');
  assert.equal(marketIntelligenceTradeDecision(intelligence, 'paper').allowed, true);
  assert.equal(marketIntelligenceTradeDecision(intelligence, 'mock').allowed, true);
  const live = marketIntelligenceTradeDecision(intelligence, 'live');
  assert.equal(live.allowed, false);
  assert.equal(live.blockCode, 'MARKET_INTELLIGENCE_NOT_AVAILABLE');
});
