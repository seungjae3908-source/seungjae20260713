import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveAutoResearchFeedback,
  UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_SAFETY,
} from './unified-trade-journal-live-research-feedback.service';
import type { UnifiedTradeCycle } from './unified-trade-journal.service';

const LINEAGE = Object.freeze({
  schemaVersion: 'trading-research-lineage-v1' as const,
  candidateId: 'paper-candidate-v1:' + 'a'.repeat(64),
  market: 'CRYPTO_FUTURES' as const,
  symbol: 'BTCUSDT',
  timeframe: '15m',
  direction: 'LONG' as const,
  strategyId: 'strategy-v1',
  strategyVersion: 'v1',
  parameterHash: 'params-v1',
  researchCodeSha: 'b'.repeat(40),
  costPolicyVersion: 'cost-v1',
  handoffId: 'paper-auto-handoff:sha256:' + 'c'.repeat(64),
  source: 'MEMBER_AUTO_TRADING_PAPER_HANDOFF' as const,
  executionAuthority: 'NONE' as const,
  profitabilityCredit: 0 as const,
});

const COST = Object.freeze({
  status: 'READY' as const,
  reasons: Object.freeze([] as string[]),
  fees: Object.freeze({ status: 'READY' as const, source: 'CANONICAL_ORDER_RECORD' as const, reason: null }),
  tax: Object.freeze({ status: 'READY' as const, source: 'CANONICAL_ORDER_RECORD' as const, reason: null }),
});

function cycle(overrides: Partial<UnifiedTradeCycle> = {}): UnifiedTradeCycle {
  return {
    id: 'cycle-live-1',
    source: 'APP_AUTO',
    broker: 'APP',
    accountIdMasked: 'APP-****-fixture',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    positionSide: 'LONG',
    currency: 'USDT',
    status: 'CLOSED',
    openedAt: '2026-10-05T00:00:00.000Z',
    closedAt: '2026-10-05T00:05:00.000Z',
    entryPrice: 100,
    exitPrice: 105,
    initialEntry: { orderId:'entry',at:'2026-10-05T00:00:00.000Z',price:100,quantity:1,fees:0.1,tax:0,costEvidence:COST },
    additions: [],
    partialExits: [],
    finalExit: { orderId:'exit',at:'2026-10-05T00:05:00.000Z',price:105,quantity:1,fees:0.1,tax:0,costEvidence:COST },
    totalQuantity: 1,
    closedQuantity: 1,
    remainingQuantity: 0,
    holdingTimeMs: 300_000,
    grossPnl: 5,
    fees: 0.2,
    tax: 0,
    costEvidence: COST,
    netPnl: 4.8,
    netReturnPercent: 4.8,
    strategy: 'strategy-v1',
    timeframe: '15m',
    stopLossPrice: 95,
    targetPrice: 105,
    ruleViolation: false,
    warnings: [],
    technicalSnapshot: {
      snapshotId:'snapshot',contextSource:'PRE_TRADE_SNAPSHOT',capturedAt:'2026-10-05T00:00:00.000Z',
      timeframe:'15m',price:100,rsi:null,macd:null,macdSignal:null,movingAverageFast:null,movingAverageSlow:null,
      support:null,resistance:null,volumeRatio:null,volatilityPercent:null,signalScore:null,marketRegime:null,marketStructure:null,signalReasons:[],
    },
    researchLineage: LINEAGE,
    review: {
      performanceScore: 74,qualityScore:90,grade:'A',good:[],bad:[],improvements:[],mistakes:[],deterministic:true,externalAiCalled:false,
    },
    ...overrides,
  } as UnifiedTradeCycle;
}

test('verified APP_AUTO lineage becomes observation-only Research feedback with zero credit', () => {
  const result = buildLiveAutoResearchFeedback({ trades: [cycle()] });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.autoTradeCount, 1);
  assert.equal(result.lineageVerifiedCount, 1);
  assert.equal(result.closedObservedCount, 1);
  assert.equal(result.records[0]?.candidateId, LINEAGE.candidateId);
  assert.equal(result.records[0]?.researchCodeSha, LINEAGE.researchCodeSha);
  assert.equal(result.records[0]?.netPnlObserved, 4.8);
  assert.equal(result.records[0]?.transactionCostEvidenceReady, true);
  assert.equal(result.records[0]?.observationOnly, true);
  assert.equal(result.records[0]?.researchMutationAllowed, false);
  assert.equal(result.records[0]?.promotionAuthority, false);
  assert.equal(result.records[0]?.executionAuthority, 'NONE');
  assert.equal(result.records[0]?.profitabilityCredit, 0);
});

test('missing candidate lineage remains unavailable and never creates credit', () => {
  const result = buildLiveAutoResearchFeedback({ trades: [cycle({ researchLineage: undefined })] });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.unavailableTradeCount, 1);
  assert.equal(result.records[0]?.reason, 'APP_AUTO_RESEARCH_LINEAGE_NOT_PRESENT');
  assert.equal(result.profitabilityCredit, 0);
});

test('conflicted or trade-mismatched lineage fails closed', () => {
  const conflicted = buildLiveAutoResearchFeedback({ trades: [cycle({ researchLineage: null })] });
  assert.equal(conflicted.records[0]?.status, 'MISMATCH');
  assert.equal(conflicted.records[0]?.reason, 'APP_AUTO_RESEARCH_LINEAGE_CONFLICT');

  const mismatch = buildLiveAutoResearchFeedback({
    trades: [cycle({ researchLineage: { ...LINEAGE, symbol: 'ETHUSDT' } })],
  });
  assert.equal(mismatch.records[0]?.status, 'MISMATCH');
  assert.equal(mismatch.records[0]?.reason, 'APP_AUTO_RESEARCH_LINEAGE_TRADE_MISMATCH');
  assert.equal(mismatch.records[0]?.profitabilityCredit, 0);
});

test('non-auto journal sources do not enter live Research feedback', () => {
  const result = buildLiveAutoResearchFeedback({ trades: [cycle({ source: 'APP_PAPER' })] });
  assert.equal(result.autoTradeCount, 0);
  assert.equal(result.records.length, 0);
  assert.equal(result.status, 'NOT_AVAILABLE');
});

test('safety contract is permanently read-only and zero-authority', () => {
  assert.deepEqual(UNIFIED_JOURNAL_LIVE_RESEARCH_FEEDBACK_SAFETY, {
    readOnly: true,
    journalObservationOnly: true,
    researchMutationAllowed: false,
    promotionAuthority: false,
    executionAuthority: 'NONE',
    profitabilityCredit: 0,
    liveOrderAuthority: false,
    privateTradingApiAuthority: false,
  });
});
