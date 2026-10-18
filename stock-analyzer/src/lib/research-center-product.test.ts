import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchCenterOverview } from './research-center';
import type { ResearchPipelineCard, ResearchPipelineKey, ResearchProductStatus } from './research-center-product.ts';
import type { PromotionStageStatus, StrategyPromotionItem, StrategyPromotionResponse } from './strategy-promotion';
import {
  answerCanonicalResearchQuestion,
  buildPaperScorecard,
  buildSourceReadiness,
  evaluatePaperPromotion,
  type PaperTradeResult,
  buildFullCostRows,
  buildResearchPipeline,
  classifyFunnelStage,
  explainResearchBlocker,
  summarizeResearchFunnel,
  summarizePromotionDrops,
  buildPromotionChecklist,
  pickLeadingPromotionItem,
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

function funnelCard(key: ResearchPipelineKey, label: string, status: ResearchProductStatus, blocker: string | null): ResearchPipelineCard {
  return { key, label, status, metrics: [], updatedAt: null, blocker, evidenceState: blocker ? 'MISSING' : 'PRESENT', records: [] };
}

test('explainResearchBlocker maps known codes, patterns and empty input without throwing', () => {
  assert.match(explainResearchBlocker('SHADOW_RUNTIME_PROOF_MISSING'), /관찰 검증/u);
  assert.match(explainResearchBlocker('SOURCE_UNLINKED'), /출처/u);
  assert.match(explainResearchBlocker('SOMETHING_NEW_INVALID'), /형식 검증/u);
  assert.match(explainResearchBlocker('SOMETHING_NEW_MISSING'), /수집되지/u);
  assert.match(explainResearchBlocker('SOMETHING_UNKNOWN'), /보완/u);
  assert.match(explainResearchBlocker(null), /없습니다/u);
  assert.match(explainResearchBlocker('   '), /없습니다/u);
});

test('summarizeResearchFunnel reports the first stage that has not passed', () => {
  const summary = summarizeResearchFunnel([
    funnelCard('backtest', '백테스트', 'verified', null),
    funnelCard('oos', '표본 외 검증', 'verified', null),
    funnelCard('final-holdout', '최종 검증', 'attention', 'PRE_HOLDOUT_GATE_FAILED'),
    funnelCard('paper', '모의매매', 'inactive', 'PAPER_RUNTIME_INACTIVE'),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.passedCount, 2);
  assert.equal(summary.firstUnpassed?.key, 'final-holdout');
  assert.equal(summary.firstUnpassed?.state, 'blocked');
  assert.match(summary.headline, /4단계 중 2단계 통과/u);
  assert.match(summary.headline, /최종 검증/u);
  assert.equal(summary.stages[0]?.reason, null);
  assert.match(summary.stages[3]?.reason ?? '', /모의매매/u);
});

test('summarizeResearchFunnel handles running, unknown, all-passed and empty inputs', () => {
  assert.equal(classifyFunnelStage(funnelCard('shadow', '관찰 검증', 'accumulating', null)), 'running');
  assert.equal(classifyFunnelStage(funnelCard('champion', '대표 전략', 'unmeasured', null)), 'unknown');
  assert.equal(classifyFunnelStage(funnelCard('backtest', '백테스트', 'verified', 'X_MISSING')), 'blocked');
  const allPassed = summarizeResearchFunnel([funnelCard('backtest', '백테스트', 'normal', null)]);
  assert.equal(allPassed.firstUnpassed, null);
  assert.match(allPassed.headline, /모두 통과/u);
  const empty = summarizeResearchFunnel([]);
  assert.equal(empty.total, 0);
  assert.match(empty.headline, /불러오지 못했습니다/u);
});

function promoItem(stages: Array<[string, PromotionStageStatus, number | null, string[]?]>, overrides: Partial<StrategyPromotionItem> = {}): StrategyPromotionItem {
  return {
    identity: {} as StrategyPromotionItem['identity'],
    promotionState: 'RESEARCH',
    stages: stages.map(([stage, status, tradeCount, reasons]) => ({
      stage, status, tradeCount, failureReasons: reasons ?? [], failureReason: null,
    })) as unknown as StrategyPromotionItem['stages'],
    drift: { classification: null, status: 'INSUFFICIENT_SAMPLE', reason: '표본 부족', observedSampleSize: null },
    killState: 'NONE',
    blockers: [],
    promotionEligible: false,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
    ...overrides,
  };
}

test('summarizePromotionDrops tallies stages and ranks reasons', () => {
  const summary = summarizePromotionDrops([
    promoItem([['backtest', 'PASS', 10], ['oos', 'FAIL', 4, ['OOS_TOO_SMALL']]], { blockers: ['RESEARCH_BRIDGE_NOT_REVIEWABLE'] }),
    promoItem([['backtest', 'PASS', 12], ['oos', 'INSUFFICIENT_SAMPLE', 2, ['OOS_TOO_SMALL']]], { blockers: ['RESEARCH_BRIDGE_NOT_REVIEWABLE'] }),
    promoItem([['backtest', 'NOT_STARTED', null]]),
  ]);
  assert.equal(summary.strategyCount, 3);
  assert.deepEqual(summary.stages.map((row) => row.stage), ['backtest', 'oos']);
  assert.deepEqual(summary.stages[0], { stage: 'backtest', total: 3, passed: 2, failed: 0, blocked: 0, waiting: 1 });
  assert.deepEqual(summary.stages[1], { stage: 'oos', total: 2, passed: 0, failed: 1, blocked: 1, waiting: 0 });
  assert.equal(summary.topReasons[0]?.count, 2);
  assert.ok(summary.topReasons.some((row) => row.code === 'RESEARCH_BRIDGE_NOT_REVIEWABLE' && row.count === 2));
  assert.equal(summarizePromotionDrops([]).stages.length, 0);
  assert.equal(summarizePromotionDrops([promoItem([['a', 'FAIL', 1, ['X_INVALID']]])], 0).topReasons.length, 0);
});

test('buildPromotionChecklist reports met, unmet and unmeasured conditions truthfully', () => {
  assert.deepEqual(buildPromotionChecklist(null), []);
  const lead = pickLeadingPromotionItem([
    promoItem([['a', 'NOT_STARTED', null]]),
    promoItem([['a', 'PASS', 31], ['b', 'PASS', 12]]),
  ]);
  assert.equal(lead?.stages.length, 2);
  const rows = Object.fromEntries(buildPromotionChecklist(lead).map((row) => [row.key, row.state]));
  assert.equal(rows.stages, 'met');
  assert.equal(rows.trades, 'met');
  assert.equal(rows.drift, 'unmeasured');
  assert.equal(rows.kill, 'met');
  assert.equal(rows.eligible, 'unmet');
  assert.equal(rows.authority, 'met');
  const weak = Object.fromEntries(buildPromotionChecklist(promoItem([['a', 'PASS', 5], ['b', 'FAIL', null]], { killState: 'SUSPEND_RECOMMENDED' })).map((row) => [row.key, row.state]));
  assert.equal(weak.stages, 'unmet');
  assert.equal(weak.trades, 'unmet');
  assert.equal(weak.kill, 'unmet');
  assert.equal(pickLeadingPromotionItem([]), null);
});

test('paper scorecard returns empty metrics without dividing by zero', () => {
  const card = buildPaperScorecard([]);
  assert.equal(card.trades, 0);
  assert.equal(card.winRate, null);
  assert.equal(card.lowerBound95Pct, null);
  assert.equal(buildPaperScorecard(undefined).trades, 0);
});

test('paper scorecard ignores invalid rows and needs two trades for a lower bound', () => {
  const card = buildPaperScorecard([
    { symbol: 'A', netReturnPct: 1 },
    { symbol: '', netReturnPct: 1 },
    { symbol: 'B', netReturnPct: Number.NaN },
  ] as PaperTradeResult[]);
  assert.equal(card.trades, 1);
  assert.equal(card.droppedInvalid, 2);
  assert.equal(card.lowerBound95Pct, null);
});

test('paper scorecard computes mean, win rate, symbols and the 95% lower bound', () => {
  const card = buildPaperScorecard([
    { symbol: 'A', netReturnPct: 1 }, { symbol: 'B', netReturnPct: 3 },
    { symbol: 'C', netReturnPct: -1 }, { symbol: 'A', netReturnPct: 1 },
  ]);
  const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(card.meanPct, 1);
  close(card.winRate, 0.75);
  assert.equal(card.distinctSymbols, 3);
  close(card.standardErrorPct, Math.sqrt(8 / 3) / 2);
  close(card.lowerBound95Pct, 1 - 1.96 * (Math.sqrt(8 / 3) / 2));
});

test('paper promotion conditions are unmeasured with no trades and unmet below thresholds', () => {
  assert.ok(evaluatePaperPromotion(buildPaperScorecard([])).every((row) => row.state === 'unmeasured'));
  const few = evaluatePaperPromotion(buildPaperScorecard([
    { symbol: 'A', netReturnPct: 1 }, { symbol: 'A', netReturnPct: 1.2 },
  ]));
  assert.equal(few.find((row) => row.key === 'paper-trades')?.state, 'unmet');
  assert.equal(few.find((row) => row.key === 'paper-symbols')?.state, 'unmet');
  assert.equal(few.find((row) => row.key === 'paper-lower-bound')?.state, 'met');
});

test('source readiness lists what each market lacks and keeps unknown unknown', () => {
  const rows = buildSourceReadiness([
    { market: 'CRYPTO_SPOT', rightsAttestationPinned: true, archiveSessionsPresent: true, holidayListPresent: null },
    { market: 'KR_STOCK', rightsAttestationPinned: true, archiveSessionsPresent: true, holidayListPresent: false },
    { market: 'US_STOCK', rightsAttestationPinned: null, archiveSessionsPresent: true, holidayListPresent: true },
  ]);
  assert.equal(rows[0].state, 'ready');
  assert.equal(rows[1].state, 'missing');
  assert.deepEqual(rows[1].missing, ['휴장일 목록']);
  assert.equal(rows[2].state, 'unknown');
});
