export type StrategyRulePackMarket =
  | 'KR_STOCK'
  | 'US_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES';

export type StrategyRulePackId =
  | 'TREND_PULLBACK_REACCEL_V1'
  | 'US_EVENT_RVOL_FIRST_PULLBACK_V1'
  | 'US_STOCKS_IN_PLAY_ORB_RETEST_V1'
  | 'KR_PRESSURE_BREAKOUT_V1'
  | 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1'
  | 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1';

export type StrategyRuleEvidenceKey =
  | 'dataReady'
  | 'formulaReady'
  | 'waveStructureReady'
  | 'indicatorReady'
  | 'entryTriggerReady'
  | 'liquidityReady'
  | 'costEvidenceReady'
  | 'riskReady'
  | 'aiReviewReady'
  | 'trendRegimeReady'
  | 'pullbackReady'
  | 'reaccelerationReady'
  | 'volumeAccelerationReady'
  | 'eventCatalystReady'
  | 'rvolReady'
  | 'firstPullbackReady'
  | 'vwapSupportReady'
  | 'volumeReaccelerationReady'
  | 'pitUniverseReady'
  | 'first5mRvolReady'
  | 'openingRangeReady'
  | 'retestReady'
  | 'microBreakoutReady'
  | 'pressureReady'
  | 'compressionReady'
  | 'volumeExpansionReady'
  | 'breakoutReady'
  | 'orderFlowReady'
  | 'cvdReady'
  | 'takerBuyReady'
  | 'orderbookImbalanceReady'
  | 'mlRankReady'
  | 'modelFrozen'
  | 'oiReady'
  | 'takerFlowReady'
  | 'fundingRiskReady';

export type StrategyPilotProfile = Readonly<{
  mode: 'PAPER_MIRROR_MANUAL_LIVE_CONFIRM';
  totalBudgetKrw: number;
  maxOrderKrw: number;
  maxConcurrentLivePositions: number;
  maxDailyLiveEntries: null;
  maxDailyLosingTrades: number;
  dailyLossStopKrw: number;
  maxConsecutiveLosses: number;
  lossCooldownMinutes: number;
  sameSymbolReentryRequiresFreshSignal: true;
  futuresMaxLeverage: 3;
  paperMirrorRequired: true;
  pairedFillComparisonRequired: true;
  liveOrderRequiresExplicitConfirmation: true;
  automaticLiveExecutionAllowed: false;
}>;

export const RULE_PACK_PILOT_PROFILE: StrategyPilotProfile = Object.freeze({
  mode: 'PAPER_MIRROR_MANUAL_LIVE_CONFIRM',
  totalBudgetKrw: 500_000,
  maxOrderKrw: 50_000,
  maxConcurrentLivePositions: 2,
  maxDailyLiveEntries: null,
  maxDailyLosingTrades: 5,
  dailyLossStopKrw: 25_000,
  maxConsecutiveLosses: 3,
  lossCooldownMinutes: 30,
  sameSymbolReentryRequiresFreshSignal: true,
  futuresMaxLeverage: 3,
  paperMirrorRequired: true,
  pairedFillComparisonRequired: true,
  liveOrderRequiresExplicitConfirmation: true,
  automaticLiveExecutionAllowed: false,
});

export type StrategyRulePackDefinition = Readonly<{
  strategyId: StrategyRulePackId;
  label: string;
  markets: readonly StrategyRulePackMarket[];
  directions: readonly ('BUY' | 'LONG' | 'SHORT')[];
  summary: string;
  rules: readonly string[];
  requiredEvidence: readonly StrategyRuleEvidenceKey[];
  paperResearchAllowedWhenReady: true;
  pilotProfile: StrategyPilotProfile;
  automaticLivePromotionAllowed: false;
  promotionRequirements: readonly string[];
}>;

const COMMON: readonly StrategyRuleEvidenceKey[] = Object.freeze([
  'dataReady',
  'formulaReady',
  'waveStructureReady',
  'indicatorReady',
  'entryTriggerReady',
  'liquidityReady',
  'costEvidenceReady',
  'riskReady',
  'aiReviewReady',
]);

function req(...keys: StrategyRuleEvidenceKey[]) {
  return Object.freeze([...COMMON, ...keys]);
}

function markets(...values: StrategyRulePackMarket[]): readonly StrategyRulePackMarket[] {
  return Object.freeze(values);
}

function directions(...values: ('BUY' | 'LONG' | 'SHORT')[]): readonly ('BUY' | 'LONG' | 'SHORT')[] {
  return Object.freeze(values);
}

export const STRATEGY_RULE_PACKS: readonly StrategyRulePackDefinition[] = Object.freeze([
  Object.freeze({
    strategyId: 'TREND_PULLBACK_REACCEL_V1',
    label: '추세 눌림 재가속',
    markets: markets('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'),
    directions: directions('BUY', 'LONG', 'SHORT'),
    summary: '상위 추세 + 눌림 + 구조 유지 + 거래량 재가속 + 재돌파',
    rules: Object.freeze([
      '1H EMA20/EMA60 추세 방향 일치',
      '15m VWAP 방향 일치',
      '5m HH-HL 또는 선물 SHORT의 LL-LH 구조',
      'EMA20/VWAP 눌림 뒤 구조 미이탈',
      'RSI 중립대 재가속 + MACD histogram 재확대',
      'RVOL/거래량 재가속 후 micro swing 재돌파',
      'AI는 방향결정이 아니라 VETO/ABSTAIN 보조만 수행',
    ]),
    requiredEvidence: req('trendRegimeReady', 'pullbackReady', 'reaccelerationReady', 'volumeAccelerationReady'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
  Object.freeze({
    strategyId: 'US_EVENT_RVOL_FIRST_PULLBACK_V1',
    label: '미국 Event + RVOL 첫 눌림',
    markets: markets('US_STOCK'),
    directions: directions('BUY'),
    summary: '실제 재료 + RVOL + VWAP/EMA20 첫 눌림 + 거래량 재가속',
    rules: Object.freeze([
      '신선한 뉴스/공시/실적/가이던스 등 직접 catalyst 확인',
      'RVOL >= 2 후보 우선',
      '가격 > VWAP 및 단기 추세 상승',
      '첫 impulse 이후 첫 눌림만 인정',
      'VWAP/EMA20 지지 + Higher Low',
      '거래량 재가속과 micro high 재돌파',
      '오래된 뉴스/루머/재료-가격 충돌 시 AI VETO',
    ]),
    requiredEvidence: req('eventCatalystReady', 'rvolReady', 'firstPullbackReady', 'vwapSupportReady', 'volumeReaccelerationReady'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
  Object.freeze({
    strategyId: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
    label: '미국 Stocks-in-Play ORB Retest',
    markets: markets('US_STOCK'),
    directions: directions('BUY'),
    summary: 'Stocks-in-Play + 첫 5분 RVOL + OR 돌파 후 Retest 재돌파',
    rules: Object.freeze([
      '가격 > $5, 최근 유동성/ATR 조건 통과',
      '첫 5분 RVOL >= 1 및 상위 후보',
      'Opening Range High 돌파를 즉시 추격하지 않음',
      'OR High 또는 VWAP Retest 지지',
      'Higher Low 이후 거래량 재가속',
      'micro high 재돌파 시 진입 후보',
      'PIT universe/비용 증거가 없으면 fail-closed',
    ]),
    requiredEvidence: req('pitUniverseReady', 'first5mRvolReady', 'openingRangeReady', 'retestReady', 'microBreakoutReady'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'PIT_UNIVERSE', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
  Object.freeze({
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    label: '국내 PRESSURE → Breakout',
    markets: markets('KR_STOCK'),
    directions: directions('BUY'),
    summary: '고점 인접 압축 + 거래대금 가속 + 저점상승 + 거래량 팽창 돌파',
    rules: Object.freeze([
      '5m EMA20 > EMA60 및 가격 > VWAP',
      '최근 고점까지 거리 제한 + 아직 돌파 전',
      '최근 3~5봉 거래대금 증가 기울기 양수',
      '저점 상승 + 가격 변동폭 압축',
      'RVOL/거래량 팽창',
      '압축 상단 돌파 및 돌파선 위 유지',
      '뉴스/공시 원인이 불명확하거나 충돌하면 AI VETO',
    ]),
    requiredEvidence: req('pressureReady', 'compressionReady', 'volumeExpansionReady', 'breakoutReady'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'PIT_UNIVERSE', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
  Object.freeze({
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    label: '코인현물 Order Flow + ML LONG',
    markets: markets('CRYPTO_SPOT'),
    directions: directions('BUY'),
    summary: '추세 + CVD/Taker/Orderbook + frozen ML ranking, 현물 LONG only',
    rules: Object.freeze([
      '1H EMA20 > EMA60 및 15m 상승 추세',
      'CVD slope 양수',
      'Taker Buy 우세',
      'Orderbook bid imbalance/깊이 정상',
      '5m HH-HL + VWAP reclaim',
      'frozen ML은 후보 순위만 조정하고 Rule Gate를 우회하지 않음',
      'Spread/Depth/BTC regime 충돌 시 NO_TRADE',
    ]),
    requiredEvidence: req('orderFlowReady', 'cvdReady', 'takerBuyReady', 'orderbookImbalanceReady', 'mlRankReady', 'modelFrozen'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'FROZEN_MODEL', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
  Object.freeze({
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    label: '코인선물 Flow + Trend + Wave',
    markets: markets('CRYPTO_FUTURES'),
    directions: directions('LONG', 'SHORT'),
    summary: '추세/파동 + OI/CVD/Taker flow + 눌림/반등 실패 재돌파',
    rules: Object.freeze([
      'LONG: 1H EMA20>EMA60, 15m HH-HL / SHORT는 반대',
      'Price 방향과 OI 증가가 일치',
      'CVD와 Taker flow가 방향 일치',
      'VWAP/EMA20 눌림 또는 반등 실패 후 구조 재확인',
      '전고/전저 재돌파에서만 진입 후보',
      'Funding 극단/비정상 spread/depth/liquidation chase는 VETO',
      'isolated margin, 2~3x 상한은 별도 Risk Engine이 강제',
    ]),
    requiredEvidence: req('orderFlowReady', 'oiReady', 'cvdReady', 'takerFlowReady', 'fundingRiskReady'),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
]);

const BY_ID = new Map(STRATEGY_RULE_PACKS.map((row) => [row.strategyId, row]));

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export type StrategyRulePackGate = Readonly<{
  recognized: boolean;
  strategyId: string;
  state: 'PASS_THROUGH' | 'NO_TRADE' | 'PAPER_CANDIDATE';
  paperAllowed: boolean;
  liveAllowed: false;
  blockers: readonly string[];
  definition: StrategyRulePackDefinition | null;
}>;

export function evaluateStrategyRulePackGate(input: {
  strategyId: string;
  market: string;
  direction: string;
  learningSnapshot?: unknown;
}): StrategyRulePackGate {
  const definition = BY_ID.get(input.strategyId as StrategyRulePackId) ?? null;
  if (!definition) {
    return Object.freeze({
      recognized: false,
      strategyId: input.strategyId,
      state: 'PASS_THROUGH',
      paperAllowed: true,
      liveAllowed: false,
      blockers: Object.freeze([]),
      definition: null,
    });
  }

  const blockers: string[] = [];
  if (!definition.markets.includes(input.market as StrategyRulePackMarket)) {
    blockers.push('STRATEGY_RULE_PACK_MARKET_MISMATCH');
  }
  if (!definition.directions.includes(input.direction as 'BUY' | 'LONG' | 'SHORT')) {
    blockers.push('STRATEGY_RULE_PACK_DIRECTION_FORBIDDEN');
  }

  const learning = record(input.learningSnapshot);
  const evidence = record(learning?.strategyRulePackEvidence);
  if (!evidence) {
    blockers.push('STRATEGY_RULE_PACK_EVIDENCE_REQUIRED');
  } else {
    if (evidence.strategyId !== definition.strategyId) blockers.push('STRATEGY_RULE_PACK_ID_MISMATCH');
    for (const key of definition.requiredEvidence) {
      if (evidence[key] !== true) blockers.push('STRATEGY_RULE_PACK_' + key.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase() + '_REQUIRED');
    }
    const aiDecision = String(evidence.aiDecision ?? '').toUpperCase();
    if (!['PASS', 'ABSTAIN'].includes(aiDecision)) {
      blockers.push(aiDecision === 'VETO'
        ? 'STRATEGY_RULE_PACK_AI_VETO'
        : 'STRATEGY_RULE_PACK_AI_REVIEW_UNUSABLE');
    }
  }

  const unique = [...new Set(blockers)].sort();
  return Object.freeze({
    recognized: true,
    strategyId: definition.strategyId,
    state: unique.length === 0 ? 'PAPER_CANDIDATE' : 'NO_TRADE',
    paperAllowed: unique.length === 0,
    liveAllowed: false,
    blockers: Object.freeze(unique),
    definition,
  });
}

export function evidenceBackedAutoStrategyCatalog() {
  return STRATEGY_RULE_PACKS;
}
