import { createHash } from 'node:crypto';

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
  mode: 'PAPER_MIRROR_AUTOMATIC_LIVE_DISCOVERY';
  initialOperatingCapitalKrw: number;
  profitCompoundShare: 0.5;
  profitReserveShare: 0.5;
  maxEntryTracksOperatingCapital: true;
  reserveAutoWithdrawalAllowed: false;
  highWaterMarkRequired: true;
  riskPerTradePercentCeiling: 0.5;
  maxConcurrentLivePositions: number;
  maxDailyLiveEntries: null;
  maxDailyLosingTrades: number;
  dailyLossStopPercent: 3;
  maxConsecutiveLosses: number;
  lossCooldownMinutes: number;
  sameSymbolReentryRequiresFreshSignal: true;
  futuresMaxLeverage: 7;
  paperMirrorRequired: true;
  pairedFillComparisonRequired: true;
  liveOrderRequiresExplicitConfirmation: false;
  automaticLiveExecutionAllowed: true;
}>;

export type ExternalStrategySource = Readonly<{
  url: string;
  author: string;
  publishedAt: string | null;
  evidenceKind: 'PEER_REVIEWED_PAPER' | 'WORKING_PAPER' | 'PUBLIC_IMPLEMENTATION' | 'PROVIDER_DOCUMENTATION';
  supports: string;
  performanceBasis: 'NOT_REPORTED' | 'BACKTEST' | 'LIVE_CASE_STUDY' | 'MIXED';
  reportedReturn: number | null;
  reportedWinRate: number | null;
  reportedMaxDrawdown: number | null;
  feesIncluded: boolean | null;
  slippageIncluded: boolean | null;
  adoptionCaveat: string;
}>;

export const RULE_PACK_PILOT_PROFILE: StrategyPilotProfile = Object.freeze({
  mode: 'PAPER_MIRROR_AUTOMATIC_LIVE_DISCOVERY',
  initialOperatingCapitalKrw: 500_000,
  profitCompoundShare: 0.5,
  profitReserveShare: 0.5,
  maxEntryTracksOperatingCapital: true,
  reserveAutoWithdrawalAllowed: false,
  highWaterMarkRequired: true,
  riskPerTradePercentCeiling: 0.5,
  maxConcurrentLivePositions: 2,
  maxDailyLiveEntries: null,
  maxDailyLosingTrades: 5,
  dailyLossStopPercent: 3,
  maxConsecutiveLosses: 3,
  lossCooldownMinutes: 30,
  sameSymbolReentryRequiresFreshSignal: true,
  futuresMaxLeverage: 7,
  paperMirrorRequired: true,
  pairedFillComparisonRequired: true,
  liveOrderRequiresExplicitConfirmation: false,
  automaticLiveExecutionAllowed: true,
});

export type StrategyRulePackDefinition = Readonly<{
  strategyId: StrategyRulePackId;
  label: string;
  markets: readonly StrategyRulePackMarket[];
  directions: readonly ('BUY' | 'LONG' | 'SHORT')[];
  summary: string;
  rules: readonly string[];
  requiredEvidence: readonly StrategyRuleEvidenceKey[];
  externalStrategyPilotAllowed: boolean;
  externalSources: readonly ExternalStrategySource[];
  reproducibilityNotes: readonly string[];
  paperResearchAllowedWhenReady: true;
  pilotProfile: StrategyPilotProfile;
  automaticLivePromotionAllowed: false;
  promotionRequirements: readonly string[];
}>;

const source = (value: ExternalStrategySource): ExternalStrategySource => Object.freeze(value);

const NO_EXTERNAL_PERFORMANCE = Object.freeze({
  reportedReturn: null,
  reportedWinRate: null,
  reportedMaxDrawdown: null,
});

const TREND_SOURCES = Object.freeze([
  source({
    url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461',
    author: 'Mebane T. Faber',
    publishedAt: '2007-05-01',
    evidenceKind: 'WORKING_PAPER',
    supports: '장기 추세 필터와 규칙 기반 위험회피의 공개 원형',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '논문의 자산배분 결과를 이 앱의 종목별 실시간 매매 성과로 이전하지 않는다.',
  }),
  source({
    url: 'https://doi.org/10.1016/j.jfineco.2011.11.003',
    author: 'Tobias J. Moskowitz, Yao Hua Ooi, Lasse Heje Pedersen',
    publishedAt: '2012-05-01',
    evidenceKind: 'PEER_REVIEWED_PAPER',
    supports: '시계열 모멘텀과 방향별 추세 정의',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '학술 표본과 현재 거래소·주문의 차이를 별도 실시간 비용 검증으로 보완해야 한다.',
  }),
]);

const US_ORB_SOURCES = Object.freeze([
  source({
    url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866',
    author: 'Lei Gao, Yufeng Han, Sophia Zhengzi Li, Guofu Zhou',
    publishedAt: '2014-05-01',
    evidenceKind: 'WORKING_PAPER',
    supports: '미국 주식 장중 모멘텀과 시초·종가 정보의 공개 연구 근거',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '연구 결과는 ORB Retest 구현의 앱 수익성 증명이 아니며 PIT universe와 실비용 검증이 필요하다.',
  }),
  source({
    url: 'https://concretumgroup.com/backtesting-the-opening-range-breakout-orb-strategy-using-polygon-io/',
    author: 'Concretum Group',
    publishedAt: null,
    evidenceKind: 'PUBLIC_IMPLEMENTATION',
    supports: 'Opening Range 산출과 공개 백테스트 구현 사례',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '블로그 성과 수치는 채택하지 않고 진입 규칙 재현 참고로만 사용한다.',
  }),
]);

const KR_BREAKOUT_SOURCES = Object.freeze([
  source({
    url: 'https://doi.org/10.1111/j.1540-6261.1992.tb04681.x',
    author: 'William Brock, Josef Lakonishok, Blake LeBaron',
    publishedAt: '1992-12-01',
    evidenceKind: 'PEER_REVIEWED_PAPER',
    supports: '이동평균·거래범위 돌파 규칙의 공개 학술 근거',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '오래된 미국 표본 결과를 국내주식 성과로 간주하지 않는다.',
  }),
  source({
    url: 'https://doi.org/10.1111/0022-1082.00265',
    author: 'Andrew W. Lo, Harry Mamaysky, Jiang Wang',
    publishedAt: '2000-08-01',
    evidenceKind: 'PEER_REVIEWED_PAPER',
    supports: '기술적 가격 패턴의 체계적·비미래참조 표현',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '압축·돌파의 구현 참고일 뿐 현재 KRX 체결 가능성은 브로커 실데이터로 따로 확인한다.',
  }),
  source({
    url: 'https://data.krx.co.kr/',
    author: '한국거래소',
    publishedAt: null,
    evidenceKind: 'PROVIDER_DOCUMENTATION',
    supports: '국내 상장종목·시장 데이터의 공식 확인 경로',
    performanceBasis: 'NOT_REPORTED',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '공식 시장정보 경로는 실시간 브로커 Candle·호가 권한을 대신하지 않는다.',
  }),
]);

const SPOT_FLOW_SOURCES = Object.freeze([
  source({
    url: 'https://arxiv.org/abs/1808.03668',
    author: 'Zihao Zhang, Stefan Zohren, Stephen Roberts',
    publishedAt: '2018-08-11',
    evidenceKind: 'WORKING_PAPER',
    supports: '호가 잔량 기반 표현과 동결 모델 검증의 공개 연구 근거',
    performanceBasis: 'BACKTEST',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: 'DeepLOB 분류 정확도는 거래 수익률이 아니며 이 앱에 검증된 현물 모델도 아니다.',
  }),
  source({
    url: 'https://global-docs.upbit.com/reference/list-orderbooks',
    author: 'Upbit',
    publishedAt: null,
    evidenceKind: 'PROVIDER_DOCUMENTATION',
    supports: '공개 호가의 bid/ask 가격·수량 필드',
    performanceBasis: 'NOT_REPORTED',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '현재 스냅샷만으로 과거 CVD·Taker·ML 증거를 만들 수 없다.',
  }),
]);

const FUTURES_FLOW_SOURCES = Object.freeze([
  TREND_SOURCES[1],
  source({
    url: 'https://www.bitget.com/api-doc/contract/market/Get-All-Symbol-Ticker',
    author: 'Bitget',
    publishedAt: null,
    evidenceKind: 'PROVIDER_DOCUMENTATION',
    supports: '선물 시장의 공개 ticker·funding·OI 필드 확인 경로',
    performanceBasis: 'NOT_REPORTED',
    ...NO_EXTERNAL_PERFORMANCE,
    feesIncluded: null,
    slippageIncluded: null,
    adoptionCaveat: '현재 OI 한 점은 OI 증가 추세가 아니며 체결 CVD/Taker flow를 대체하지 않는다.',
  }),
]);

const COMMON: readonly StrategyRuleEvidenceKey[] = Object.freeze([
  'dataReady',
  'formulaReady',
  'waveStructureReady',
  'indicatorReady',
  'entryTriggerReady',
  'liquidityReady',
  'costEvidenceReady',
  'riskReady',
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
    externalStrategyPilotAllowed: true,
    externalSources: TREND_SOURCES,
    reproducibilityNotes: Object.freeze(['실시간 Candle·VWAP·비미래참조 확정 피벗이 모두 있어야 한다.', '공개 연구의 성과 수치는 앱 성과로 채택하지 않는다.']),
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
    externalStrategyPilotAllowed: false,
    externalSources: US_ORB_SOURCES,
    reproducibilityNotes: Object.freeze(['이 전략은 요청된 LIVE Pilot allowlist 밖이며 Research/Paper 전용이다.']),
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
    externalStrategyPilotAllowed: true,
    externalSources: US_ORB_SOURCES,
    reproducibilityNotes: Object.freeze(['승인된 5분봉·정규장 시각·PIT universe·실시간 호가 없으면 차단한다.']),
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
    externalStrategyPilotAllowed: true,
    externalSources: KR_BREAKOUT_SOURCES,
    reproducibilityNotes: Object.freeze(['승인된 국내 브로커 5분봉·거래대금·실시간 호가 payload가 없으면 차단한다.']),
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
    externalStrategyPilotAllowed: true,
    externalSources: SPOT_FLOW_SOURCES,
    reproducibilityNotes: Object.freeze(['실제 체결 방향 CVD·Taker·호가 수량·검증된 동결 현물 모델 중 하나라도 없으면 차단한다.']),
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
      'isolated margin, 2~7x 상한은 별도 Risk Engine이 강제',
    ]),
    requiredEvidence: req('orderFlowReady', 'oiReady', 'cvdReady', 'takerFlowReady', 'fundingRiskReady'),
    externalStrategyPilotAllowed: true,
    externalSources: FUTURES_FLOW_SOURCES,
    reproducibilityNotes: Object.freeze(['OI 변화열·실제 체결 방향 CVD/Taker flow·funding·호가가 시점 정합해야 한다.']),
    paperResearchAllowedWhenReady: true,
    pilotProfile: RULE_PACK_PILOT_PROFILE,
    automaticLivePromotionAllowed: false,
    promotionRequirements: Object.freeze(['OOS', 'WALK_FORWARD', 'FULL_COST', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION']),
  }),
]);

const BY_ID = new Map(STRATEGY_RULE_PACKS.map((row) => [row.strategyId, row]));

export const EXTERNAL_STRATEGY_PILOT_IDS = Object.freeze(
  STRATEGY_RULE_PACKS.filter((row) => row.externalStrategyPilotAllowed).map((row) => row.strategyId),
);

export const EXTERNAL_STRATEGY_SOURCE_SET_DIGEST = createHash('sha256')
  .update(JSON.stringify(STRATEGY_RULE_PACKS
    .filter((row) => row.externalStrategyPilotAllowed)
    .map((row) => ({
      strategyId: row.strategyId,
      markets: row.markets,
      directions: row.directions,
      rules: row.rules,
      requiredEvidence: row.requiredEvidence,
      sources: row.externalSources,
    }))))
  .digest('hex');

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export const STRATEGY_RULE_PACK_AI_REVIEW_SCHEMA = 'trade-rule-pack-ai-review-v1' as const;
export const STRATEGY_RULE_PACK_AI_REVIEW_PROMPT_VERSION = 'trade-rule-pack-ai-review-v1' as const;
export const STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS = 120_000;
const AI_REVIEW_CLOCK_SKEW_MS = 5_000;
const AI_REVIEW_FORBIDDEN_KEY = /(?:credential|secret|token|authorization|password|account|balance|equity|api[_-]?key|private[_-]?key)/i;

function safeProjection(value: unknown, depth = 0): unknown {
  if (depth > 3) return null;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => safeProjection(item, depth + 1));
  const row = record(value);
  if (!row) return null;
  const entries = Object.entries(row)
    .filter(([key]) => !AI_REVIEW_FORBIDDEN_KEY.test(key) && key !== 'aiDecision' && key !== 'aiReviewReady')
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 64)
    .map(([key, nested]) => [key, safeProjection(nested, depth + 1)] as const);
  return Object.fromEntries(entries);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const row = record(value);
  if (row) {
    return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export type StrategyRulePackGateInput = {
  strategyId: string;
  market: string;
  direction: string;
  signalId?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  learningSnapshot?: unknown;
  dataEvidence?: unknown;
  publicQuote?: unknown;
  aiReview?: unknown;
  expectedAiEvidenceDigest?: string | null;
  nowMs?: number;
};

export type StrategyRulePackAiEvidenceProjection = Readonly<{
  strategyId: string;
  signalId: string | null;
  market: string;
  direction: string;
  symbol: string | null;
  timeframe: string | null;
  ruleEvidence: unknown;
  dataEvidence: unknown;
  publicQuote: unknown;
}>;

export function buildStrategyRulePackAiEvidenceProjection(
  input: Omit<StrategyRulePackGateInput, 'aiReview' | 'expectedAiEvidenceDigest' | 'nowMs'>,
): StrategyRulePackAiEvidenceProjection {
  const learning = record(input.learningSnapshot);
  const evidence = record(learning?.strategyRulePackEvidence);
  return Object.freeze({
    strategyId: input.strategyId,
    signalId: input.signalId?.trim() || null,
    market: input.market,
    direction: input.direction,
    symbol: input.symbol?.trim() || null,
    timeframe: input.timeframe?.trim() || null,
    ruleEvidence: safeProjection(evidence),
    dataEvidence: safeProjection(input.dataEvidence),
    publicQuote: safeProjection(input.publicQuote),
  });
}

export function strategyRulePackAiEvidenceDigest(
  input: Omit<StrategyRulePackGateInput, 'aiReview' | 'expectedAiEvidenceDigest' | 'nowMs'>,
): string {
  return createHash('sha256')
    .update(stableStringify(buildStrategyRulePackAiEvidenceProjection(input)))
    .digest('hex');
}

export type StrategyRulePackGate = Readonly<{
  recognized: boolean;
  strategyId: string;
  state: 'PASS_THROUGH' | 'NO_TRADE' | 'PAPER_CANDIDATE';
  paperAllowed: boolean;
  liveAiEligible: boolean;
  liveAllowed: false;
  blockers: readonly string[];
  definition: StrategyRulePackDefinition | null;
}>;

export type StrategyRulePackDeterministicGate = Readonly<{
  recognized: boolean;
  strategyId: string;
  readyForAiReview: boolean;
  blockers: readonly string[];
  definition: StrategyRulePackDefinition | null;
}>;

function directionAllowedForMarket(market: string, direction: string) {
  if (market === 'KR_STOCK' || market === 'US_STOCK' || market === 'CRYPTO_SPOT') {
    return direction === 'BUY';
  }
  if (market === 'CRYPTO_FUTURES') {
    return direction === 'LONG' || direction === 'SHORT';
  }
  return false;
}

function deterministicBlockers(input: StrategyRulePackGateInput, definition: StrategyRulePackDefinition): string[] {
  const blockers: string[] = [];
  if (!definition.markets.includes(input.market as StrategyRulePackMarket)) {
    blockers.push('STRATEGY_RULE_PACK_MARKET_MISMATCH');
  }
  if (!directionAllowedForMarket(input.market, input.direction)
    || !definition.directions.includes(input.direction as 'BUY' | 'LONG' | 'SHORT')) {
    blockers.push('STRATEGY_RULE_PACK_DIRECTION_FORBIDDEN');
  }

  const learning = record(input.learningSnapshot);
  const evidence = record(learning?.strategyRulePackEvidence);
  if (!evidence) {
    blockers.push('STRATEGY_RULE_PACK_EVIDENCE_REQUIRED');
    return blockers;
  }
  if (evidence.strategyId !== definition.strategyId) blockers.push('STRATEGY_RULE_PACK_ID_MISMATCH');
  for (const key of definition.requiredEvidence) {
    if (evidence[key] !== true) {
      blockers.push('STRATEGY_RULE_PACK_' + key.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase() + '_REQUIRED');
    }
  }
  return blockers;
}

export function evaluateStrategyRulePackDeterministicGate(
  input: StrategyRulePackGateInput,
): StrategyRulePackDeterministicGate {
  const definition = BY_ID.get(input.strategyId as StrategyRulePackId) ?? null;
  if (!definition) {
    return Object.freeze({
      recognized: false,
      strategyId: input.strategyId,
      readyForAiReview: true,
      blockers: Object.freeze([]),
      definition: null,
    });
  }
  const blockers = [...new Set(deterministicBlockers(input, definition))].sort();
  return Object.freeze({
    recognized: true,
    strategyId: definition.strategyId,
    readyForAiReview: blockers.length === 0,
    blockers: Object.freeze(blockers),
    definition,
  });
}

function reviewBlockers(input: StrategyRulePackGateInput): string[] {
  const blockers: string[] = [];
  const review = record(input.aiReview);
  if (!review) return ['STRATEGY_RULE_PACK_AI_REVIEW_REQUIRED'];
  if (review.schemaVersion !== STRATEGY_RULE_PACK_AI_REVIEW_SCHEMA) blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_SCHEMA_INVALID');
  if (review.status !== 'READY') blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_UNAVAILABLE');
  if (review.strategyId !== input.strategyId) blockers.push('STRATEGY_RULE_PACK_AI_STRATEGY_MISMATCH');
  if (input.signalId && review.signalId !== input.signalId) blockers.push('STRATEGY_RULE_PACK_AI_SIGNAL_MISMATCH');
  if (review.market !== input.market) blockers.push('STRATEGY_RULE_PACK_AI_MARKET_MISMATCH');
  if (review.direction !== input.direction) blockers.push('STRATEGY_RULE_PACK_AI_DIRECTION_MISMATCH');
  if (input.symbol && review.symbol !== input.symbol) blockers.push('STRATEGY_RULE_PACK_AI_SYMBOL_MISMATCH');
  if (input.timeframe && review.timeframe !== input.timeframe) blockers.push('STRATEGY_RULE_PACK_AI_TIMEFRAME_MISMATCH');
  if (review.promptVersion !== STRATEGY_RULE_PACK_AI_REVIEW_PROMPT_VERSION) blockers.push('STRATEGY_RULE_PACK_AI_PROMPT_VERSION_MISMATCH');

  const expectedDigest = String(input.expectedAiEvidenceDigest ?? '').toLowerCase();
  const actualDigest = String(review.evidenceDigest ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) blockers.push('STRATEGY_RULE_PACK_AI_EVIDENCE_DIGEST_REQUIRED');
  else if (actualDigest !== expectedDigest) blockers.push('STRATEGY_RULE_PACK_AI_EVIDENCE_DIGEST_MISMATCH');

  const generatedAtMs = typeof review.generatedAt === 'string' ? Date.parse(review.generatedAt) : NaN;
  const expiresAtMs = typeof review.expiresAt === 'string' ? Date.parse(review.expiresAt) : NaN;
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= generatedAtMs) {
    blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_TIME_INVALID');
  } else {
    if (generatedAtMs > nowMs + AI_REVIEW_CLOCK_SKEW_MS) blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_FUTURE');
    if (expiresAtMs <= nowMs) blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_STALE');
    if (expiresAtMs - generatedAtMs > STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS) blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_TTL_INVALID');
  }

  if (typeof review.provider !== 'string' || !review.provider.trim()
    || typeof review.model !== 'string' || !review.model.trim()) {
    blockers.push('STRATEGY_RULE_PACK_AI_PROVIDER_IDENTITY_REQUIRED');
  }

  const safety = record(review.safety);
  if (!safety
    || safety.executionAuthority !== 'NONE'
    || safety.orderAllowed !== false
    || safety.riskOverrideAllowed !== false
    || safety.positionSizeAuthority !== false
    || safety.leverageAuthority !== false) {
    blockers.push('STRATEGY_RULE_PACK_AI_SAFETY_INVALID');
  }

  const decision = String(review.decision ?? '').toUpperCase();
  if (decision === 'VETO') blockers.push('STRATEGY_RULE_PACK_AI_VETO');
  else if (decision !== 'PASS' && decision !== 'ABSTAIN') blockers.push('STRATEGY_RULE_PACK_AI_REVIEW_UNUSABLE');
  return blockers;
}

export function evaluateStrategyRulePackGate(input: StrategyRulePackGateInput): StrategyRulePackGate {
  const deterministic = evaluateStrategyRulePackDeterministicGate(input);
  if (!deterministic.recognized) {
    return Object.freeze({
      recognized: false,
      strategyId: input.strategyId,
      state: 'PASS_THROUGH',
      paperAllowed: true,
      liveAiEligible: false,
      liveAllowed: false,
      blockers: Object.freeze([]),
      definition: null,
    });
  }

  const blockers = [
    ...deterministic.blockers,
    ...(deterministic.readyForAiReview ? reviewBlockers(input) : []),
  ];
  const unique = [...new Set(blockers)].sort();
  const review = record(input.aiReview);
  const liveAiEligible = unique.length === 0
    && review?.status === 'READY'
    && String(review?.decision ?? '').toUpperCase() === 'PASS';
  return Object.freeze({
    recognized: true,
    strategyId: deterministic.strategyId,
    state: unique.length === 0 ? 'PAPER_CANDIDATE' : 'NO_TRADE',
    paperAllowed: unique.length === 0,
    liveAiEligible,
    liveAllowed: false,
    blockers: Object.freeze(unique),
    definition: deterministic.definition,
  });
}

export function isEvidenceBackedAutoStrategyId(value: string): value is StrategyRulePackId {
  return BY_ID.has(value as StrategyRulePackId);
}

export function evidenceBackedAutoStrategyCatalog() {
  return STRATEGY_RULE_PACKS;
}
