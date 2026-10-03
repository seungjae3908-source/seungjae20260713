import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemberAutoTradingPaperHandoffEntry } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import {
  TradeRulePackAiReviewer,
  buildTradeRulePackAiEvidenceDigest,
  tradeRulePackAiReviewRuntimeStatus,
} from './trade-rule-pack-ai-review.service';
import type { AiChatResult } from './ai-chat.service';

const NOW = Date.parse('2026-10-03T15:00:00.000Z');

function entry(options: { stale?: boolean; signalId?: string; symbol?: string } = {}): MemberAutoTradingPaperHandoffEntry {
  const asOfMs = NOW - (options.stale ? 60_000 : 1_000);
  return {
    identity: {
      strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
      signalId: options.signalId ?? 'signal-ai-review-1',
      market: 'CRYPTO_SPOT',
      direction: 'BUY',
      symbol: options.symbol ?? 'BTC',
      timeframe: '15m',
    },
    signal: {
      signalId: options.signalId ?? 'signal-ai-review-1',
      market: 'CRYPTO_SPOT',
      symbol: options.symbol ?? 'BTC',
      timestampMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      timeframe: '15m',
      direction: 'BUY',
      learningSnapshot: {
        strategyRulePackEvidence: {
          strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
          dataReady: true,
          formulaReady: true,
          waveStructureReady: true,
          indicatorReady: true,
          entryTriggerReady: true,
          liquidityReady: true,
          costEvidenceReady: true,
          riskReady: true,
          orderFlowReady: true,
          cvdReady: true,
          takerBuyReady: true,
          orderbookImbalanceReady: true,
          mlRankReady: true,
          modelFrozen: true,
        },
      },
    },
    execution: {
      dataEvidence: {
        publicOnly: true,
        dataQuality: 'READY',
        provider: 'upbit-public',
        asOfMs,
        maxAgeMs: 30_000,
      },
    },
    publicQuote: {
      bid: 100,
      ask: 101,
      asOfMs,
      maxAgeMs: 30_000,
    },
  } as unknown as MemberAutoTradingPaperHandoffEntry;
}

function answer(decision: 'PASS' | 'ABSTAIN' | 'VETO'): AiChatResult {
  return {
    answer: JSON.stringify({ decision, reasons: ['evidence coherence reviewed'] }),
    kind: 'answer',
    model: 'gemini-test-model',
    provider: 'google-gemini',
    fallbackUsed: false,
    providerLatencyMs: 12,
    generatedAt: new Date(NOW).toISOString(),
    data: {
      status: 'not_requested',
      asOf: null,
      basis: 'server_collection_time',
      sources: [],
      missing: [],
    },
  };
}

function env(): NodeJS.ProcessEnv {
  return {
    AI_CHAT_PROVIDER: 'gemini',
    AI_CHAT_API_KEY: 'test-provider-key',
    AI_CHAT_MODEL: 'gemini-test-model',
    TRADE_RULE_PACK_AI_REVIEW_TTL_MS: '60000',
    TRADE_RULE_PACK_AI_REVIEW_CACHE_MAX_ENTRIES: '10',
  };
}

test('runtime status exposes provider identity and safety state without credential value', () => {
  const status = tradeRulePackAiReviewRuntimeStatus(env());
  assert.equal(status.configured, true);
  assert.equal(status.provider, 'google-gemini');
  assert.equal(status.model, 'gemini-test-model');
  assert.equal(status.producer, 'BOUNDED_AI_JSON_PROVIDER');
  assert.equal(status.failClosed, true);
  assert.equal(status.executionAuthority, 'NONE');
  assert.equal(status.orderAllowed, false);
  assert.equal(status.riskOverrideAllowed, false);
  assert.equal(status.cacheMaxEntries, 500);
  assert.equal(JSON.stringify(status).includes('test-provider-key'), false);
});

test('fresh public evidence produces bound PASS review with digest and bounded prompt', async () => {
  let calls = 0;
  let promptText = '';
  const reviewer = new TradeRulePackAiReviewer(async (input) => {
    calls += 1;
    promptText = String(input.message ?? '');
    return answer('PASS');
  }, env());
  const candidate = entry();
  const result = await reviewer.review(candidate, NOW);

  assert.equal(calls, 1);
  assert.equal(result.status, 'READY');
  assert.equal(result.decision, 'PASS');
  assert.equal(result.strategyId, candidate.identity.strategyId);
  assert.equal(result.signalId, candidate.identity.signalId);
  assert.equal(result.evidenceDigest, buildTradeRulePackAiEvidenceDigest(candidate));
  assert.ok(promptText.length > 0 && promptText.length <= 1_900);
  assert.ok(promptText.includes('evidenceDigest=' + result.evidenceDigest));
  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.model, 'gemini-test-model');
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.equal(result.safety.riskOverrideAllowed, false);
  assert.ok(Date.parse(result.expiresAt) <= NOW + 29_000);
});

test('same evidence digest reuses cached AI review without a second provider call', async () => {
  let calls = 0;
  const reviewer = new TradeRulePackAiReviewer(async () => {
    calls += 1;
    return answer('ABSTAIN');
  }, env());
  const candidate = entry();

  const first = await reviewer.review(candidate, NOW);
  const second = await reviewer.review(candidate, NOW + 1_000);

  assert.equal(first.decision, 'ABSTAIN');
  assert.equal(second.decision, 'ABSTAIN');
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('stale public evidence blocks before provider invocation', async () => {
  let calls = 0;
  const reviewer = new TradeRulePackAiReviewer(async () => {
    calls += 1;
    return answer('PASS');
  }, env());

  const result = await reviewer.review(entry({ stale: true }), NOW);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.decision, null);
  assert.equal(result.reasons[0], 'AI_REVIEW_PUBLIC_EVIDENCE_NOT_FRESH');
  assert.equal(calls, 0);
});

test('provider failure and malformed output fail closed instead of synthesizing PASS or ABSTAIN', async () => {
  const failed = new TradeRulePackAiReviewer(async () => {
    throw new Error('provider down');
  }, env());
  const failedResult = await failed.review(entry(), NOW);
  assert.equal(failedResult.status, 'UNAVAILABLE');
  assert.equal(failedResult.decision, null);

  const malformed = new TradeRulePackAiReviewer(async () => ({
    ...answer('PASS'),
    answer: 'PASS',
  }), env());
  const malformedResult = await malformed.review(entry(), NOW);
  assert.equal(malformedResult.status, 'UNAVAILABLE');
  assert.equal(malformedResult.decision, null);
  assert.equal(malformedResult.reasons[0], 'AI_REVIEW_INVALID_RESPONSE');
});

test('VETO is preserved as a review decision with zero trading authority', async () => {
  const reviewer = new TradeRulePackAiReviewer(async () => answer('VETO'), env());
  const result = await reviewer.review(entry(), NOW);
  assert.equal(result.status, 'READY');
  assert.equal(result.decision, 'VETO');
  assert.equal(result.safety.positionSizeAuthority, false);
  assert.equal(result.safety.leverageAuthority, false);
});


test('review cache is bounded, evicts LRU entries, and reports live health counters', async () => {
  let calls = 0;
  const reviewer = new TradeRulePackAiReviewer(async () => {
    calls += 1;
    return answer('PASS');
  }, env());

  for (let index = 0; index < 11; index += 1) {
    const result = await reviewer.review(entry({
      signalId: 'signal-cache-' + index,
      symbol: 'BTC' + index,
    }), NOW + index);
    assert.equal(result.status, 'READY');
  }

  const status = reviewer.runtimeStatus();
  assert.equal(calls, 11);
  assert.equal(status.cacheMaxEntries, 10);
  assert.equal(status.cacheSize, 10);
  assert.equal(status.cacheEvictions, 1);
  assert.equal(status.reviewCalls, 11);
  assert.equal(status.pass, 11);
  assert.equal(status.abstain, 0);
  assert.equal(status.veto, 0);
  assert.ok(status.lastDecisionAt);
});

test('cache hit moves entry to MRU and increments cache hit counter without provider reinvocation', async () => {
  let calls = 0;
  const reviewer = new TradeRulePackAiReviewer(async () => {
    calls += 1;
    return answer('PASS');
  }, env());
  const first = entry({ signalId: 'signal-mru-1', symbol: 'BTC-MRU-1' });
  const second = entry({ signalId: 'signal-mru-2', symbol: 'BTC-MRU-2' });

  await reviewer.review(first, NOW);
  await reviewer.review(second, NOW + 1);
  const cached = await reviewer.review(first, NOW + 2);

  assert.equal(cached.cacheHit, true);
  assert.equal(calls, 2);
  const status = reviewer.runtimeStatus();
  assert.equal(status.cacheHits, 1);
  assert.equal(status.reviewCalls, 3);
  assert.equal(status.pass, 3);
});
