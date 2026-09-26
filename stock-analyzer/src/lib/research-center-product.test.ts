import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchCenterOverview } from './research-center';
import type { StrategyPromotionResponse } from './strategy-promotion';
import {
  answerCanonicalResearchQuestion,
  buildFullCostRows,
  buildResearchPipeline,
  classifySha,
  formatCanonicalMetric,
  isFullCostReady,
  mapResearchProductStatus,
  metricAvailability,
} from './research-center-product.ts';

const SHA = '1111111111111111111111111111111111111111';

function overview(overrides: Partial<ResearchCenterOverview> = {}): ResearchCenterOverview {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: 1_800_000_000_000,
    state: { present: true, latestCycleAt: 1_799_999_999_000 },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: true,
      forbiddenAuthorityObserved: false,
    },
    research: { status: 'collecting', failedTasks: 0, blockedDataTasks: 0, cycles: [] },
    paper: {
      runtime: {
        present: true,
        status: 'not_started',
        scheduleActive: false,
        privateRequestCount: 0,
        financialMutationCount: 0,
        orderCount: 0,
        liveTrading: false,
        orderAuthority: false,
        safetyEvidenceComplete: true,
        lanes: [],
      },
      ledger: { present: true, cycleCount: 0, sampleCount: 0, positionCount: 0, settlementCount: 0 },
    },
    shadow: { groups: [], records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null } },
    profitability: { proven: false, status: 'evidence_collection', note: 'not proven' },
    champion: { currentValidatedChampion: null },
    ...overrides,
  };
}

function promotion(stageStatus: string = 'NOT_STARTED', stageSha: string | null = null): StrategyPromotionResponse {
  const stages = [
    'RESEARCH_DESIGN', 'HISTORICAL_BACKTEST', 'OUT_OF_SAMPLE', 'PURGED_WALK_FORWARD',
    'COST_STRESS', 'REGIME', 'FINAL_HOLDOUT', 'PAPER', 'SHADOW', 'RECOMMENDATION_OUTCOMES',
  ].map((stage) => ({
    stage,
    status: stage === 'HISTORICAL_BACKTEST' ? stageStatus : 'NOT_STARTED',
    startedAt: null,
    completedAt: null,
    observedAt: '2026-09-02T00:00:00.000Z',
    source: 'canonical-owner',
    provider: null,
    sourceSha: stage === 'HISTORICAL_BACKTEST' ? stageSha : null,
    datasetId: null,
    dataRange: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: null,
    gate: `${stage}_EVIDENCE_REQUIRED`,
    gateResult: 'EVIDENCE_REQUIRED',
    failureReason: null,
    failureReasons: [],
    provenance: [],
    costAssumptions: null,
    costPolicy: null,
    dataQuality: 'UNLINKED',
    fetchedAt: null,
    validatedAt: null,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: [],
  }));
  return {
    ok: true,
    generatedAt: '2026-09-02T00:00:00.000Z',
    sourceSha: SHA,
    policyVersion: 'test-policy',
    items: [{
      identity: {
        strategyFamily: 'TEST', strategyId: 'strategy-1', strategyVersion: 'v1', version: 'v1',
        parameterHash: 'parameter', market: 'CRYPTO_FUTURES', assetClass: 'CRYPTO_FUTURES', symbol: null,
        universe: 'TEST', timeframe: '15m', strategyHorizon: 'SCALP', horizon: 'SCALP', direction: 'LONG',
        researchCodeSha: SHA, costPolicyVersion: 'cost-v1', riskPolicyVersion: 'risk-v1',
      },
      promotionState: 'RESEARCH',
      stages: stages as never,
      drift: { classification: null, status: 'INSUFFICIENT_SAMPLE', reason: 'missing', observedSampleSize: null },
      killState: 'NONE', blockers: [], promotionEligible: false, executionAuthority: 'NONE',
      liveTradingAuthority: false, privateTradingApiCount: 0,
    }],
    counts: {} as StrategyPromotionResponse['counts'],
    evidenceSources: [],
    promotionCandidates: 0,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
  };
}

test('status mapping and missing/zero format semantics are explicit', () => {
  assert.equal(mapResearchProductStatus('success'), 'normal');
  assert.equal(mapResearchProductStatus('stale'), 'stale');
  assert.equal(mapResearchProductStatus('blocked_data'), 'attention');
  assert.equal(formatCanonicalMetric(null), '미측정');
  assert.equal(formatCanonicalMetric(0), '0');
  assert.equal(metricAvailability(null), 'MISSING');
  assert.equal(metricAvailability(0), 'ZERO_MEASURED');
});

test('wrong and missing source SHA fail closed', () => {
  assert.equal(classifySha(SHA, SHA), 'PRESENT');
  assert.equal(classifySha(SHA, '2222222222222222222222222222222222222222'), 'WRONG_SHA');
  assert.equal(classifySha(SHA, null), 'MISSING');
  const wrong = buildResearchPipeline(overview(), promotion('PASS', '2222222222222222222222222222222222222222'));
  assert.equal(wrong.find((card) => card.key === 'backtest')?.status, 'attention');
  assert.equal(wrong.find((card) => card.key === 'backtest')?.evidenceState, 'WRONG_SHA');
  const stale = buildResearchPipeline(overview(), promotion('STALE', SHA));
  assert.equal(stale.find((card) => card.key === 'backtest')?.status, 'stale');
});

test('profitability false, Champion NONE, inactive Paper, and empty Paper stay truthful', () => {
  const cards = buildResearchPipeline(overview(), promotion());
  assert.equal(cards.find((card) => card.key === 'paper')?.status, 'inactive');
  assert.equal(cards.find((card) => card.key === 'settlement')?.evidenceState, 'ZERO_MEASURED');
  assert.equal(cards.find((card) => card.key === 'profitability')?.status, 'waiting');
  assert.equal(cards.find((card) => card.key === 'champion')?.metrics[0]?.value, '현재 검증된 Champion 없음');
});

test('sanitized Strategy Health summary preserves explicit Champion evidence', () => {
  const withoutRawChampion = overview({
    champion: undefined,
    strategyHealth: {
      status: 'MISSING_EVIDENCE',
      evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth',
      canonicalCoreStatus: null,
      inputs: {
        champion: {
          status: 'MISSING_EVIDENCE',
          reason: 'CURRENT_VALIDATED_CHAMPION_NONE',
          source: 'champion',
          observedCount: null,
        },
      },
      reasons: ['champion:CURRENT_VALIDATED_CHAMPION_NONE'],
      executionAuthority: 'NONE',
    },
  });
  const cards = buildResearchPipeline(withoutRawChampion, promotion());
  assert.equal(cards.find((card) => card.key === 'champion')?.status, 'waiting');
  assert.equal(cards.find((card) => card.key === 'champion')?.metrics[0]?.value, '현재 검증된 Champion 없음');
});

test('genuine canonical Paper counts are displayed while unavailable PnL is not invented', () => {
  const canonical = overview({
    paper: {
      runtime: { ...overview().paper.runtime, status: 'running', scheduleActive: true },
      ledger: { present: true, cycleCount: 12, sampleCount: 7, positionCount: 2, settlementCount: 5 },
    },
  });
  const cards = buildResearchPipeline(canonical, promotion());
  const paper = cards.find((card) => card.key === 'paper')!;
  assert.equal(paper.status, 'running');
  assert.deepEqual(paper.metrics.map((item) => item.value), ['12', '2', '5']);
  assert.equal(cards.find((card) => card.key === 'settlement')?.status, 'accumulating');
  assert.match(answerCanonicalResearchQuestion('수익률과 PF는?', canonical, cards), /임의 생성하지 않습니다/);
});

test('Full Cost partial/missing does not convert unavailable components to zero', () => {
  const partial = {
    fullCostReady: false,
    components: {
      commission: { status: 'PRESENT', valuePercent: 0.025, quality: 'DOCUMENTED' },
      tax: { status: 'PRESENT', valuePercent: 0, quality: 'NOT_APPLICABLE' },
      spread: { status: 'MISSING', valuePercent: null, quality: null },
    },
  };
  const rows = buildFullCostRows(partial);
  assert.equal(rows.find((row) => row.key === 'commission')?.state, 'measured');
  assert.equal(rows.find((row) => row.key === 'tax')?.state, 'not-applicable');
  assert.equal(rows.find((row) => row.key === 'spread')?.value, '미측정');
  assert.equal(rows.find((row) => row.key === 'latency')?.value, '자료 부족');
  assert.equal(isFullCostReady(partial), false);
});

test('Full Cost complete requires all eight explicit components', () => {
  const components = Object.fromEntries([
    'commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
  ].map((key) => [key, { status: 'PRESENT', valuePercent: key === 'tax' ? 0 : 0.01, quality: key === 'tax' ? 'NOT_APPLICABLE' : 'OBSERVED' }]));
  assert.equal(isFullCostReady({ fullCostReady: true, components }), true);
});
