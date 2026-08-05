import type {
  ScannerExecutionIntent,
  ScannerMarketClass,
  ScannerMarketRegime,
  ScannerSignalCard,
  ScannerStrategy,
  ScannerTradeAction,
} from './scanner-signal.types';

export const SCANNER_MARKET_MODEL_VERSION = 'market-action-v1';

type MarketApprovalProfile = Readonly<{
  minScore: number;
  minConfidence: number;
  minDataCompleteness: number;
  maxRiskScore: number;
  maxSpreadPercent: number | null;
  maxVolatilityPercent: number | null;
  requiredEvidenceKeys: readonly string[];
}>;

export const SCANNER_MARKET_APPROVAL_PROFILES: Readonly<Record<ScannerMarketClass, MarketApprovalProfile>> = Object.freeze({
  KR_STOCK: Object.freeze({
    minScore: 75,
    minConfidence: 70,
    minDataCompleteness: 80,
    maxRiskScore: 45,
    maxSpreadPercent: null,
    maxVolatilityPercent: 8,
    requiredEvidenceKeys: Object.freeze(['liquidity', 'risk']),
  }),
  US_STOCK: Object.freeze({
    minScore: 78,
    minConfidence: 72,
    minDataCompleteness: 80,
    maxRiskScore: 40,
    maxSpreadPercent: null,
    maxVolatilityPercent: 12,
    requiredEvidenceKeys: Object.freeze(['liquidity', 'risk']),
  }),
  CRYPTO_SPOT: Object.freeze({
    minScore: 76,
    minConfidence: 72,
    minDataCompleteness: 85,
    maxRiskScore: 40,
    maxSpreadPercent: 0.25,
    maxVolatilityPercent: 8,
    requiredEvidenceKeys: Object.freeze(['liquidity', 'spread', 'risk']),
  }),
  CRYPTO_FUTURES: Object.freeze({
    minScore: 80,
    minConfidence: 75,
    minDataCompleteness: 90,
    maxRiskScore: 35,
    maxSpreadPercent: 0.15,
    maxVolatilityPercent: 6,
    requiredEvidenceKeys: Object.freeze(['liquidity', 'spread', 'risk', 'funding-open-interest']),
  }),
});

const BREAKOUT_TOKENS = ['breakout', '돌파', '신고가', '저항'];
const PULLBACK_TOKENS = ['pullback', '눌림', '지지선 반등', '박스권 하단'];
const MEAN_REVERSION_TOKENS = ['rsi', '과매도', '과열', '신저가 반등', 'box_lower'];

function includesToken(values: string[], tokens: string[]): boolean {
  const normalized = values.map((value) => value.toLowerCase());
  return normalized.some((value) => tokens.some((token) => value.includes(token.toLowerCase())));
}

export function classifyScannerMarket(card: Pick<ScannerSignalCard, 'assetClass' | 'market'>): ScannerMarketClass {
  if (card.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (card.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return String(card.market).toUpperCase().includes('US') ? 'US_STOCK' : 'KR_STOCK';
}

export function resolveScannerTradeAction(
  marketClass: ScannerMarketClass,
  direction: ScannerSignalCard['direction'],
): ScannerTradeAction {
  if (direction === 'NEUTRAL') return 'NONE';
  if (marketClass === 'CRYPTO_FUTURES') return direction === 'LONG' ? 'LONG' : 'SHORT';
  return direction === 'LONG' ? 'BUY' : 'SELL';
}

export function resolveScannerExecutionIntent(action: ScannerTradeAction): ScannerExecutionIntent {
  if (action === 'NONE') return 'NO_ACTION';
  if (action === 'SELL') return 'REDUCE_OR_EXIT';
  return 'OPEN_OR_ADD';
}

export function isScannerActionAllowed(marketClass: ScannerMarketClass, action: ScannerTradeAction): boolean {
  if (action === 'NONE') return false;
  if (marketClass === 'CRYPTO_FUTURES') return action === 'LONG' || action === 'SHORT';
  return action === 'BUY' || action === 'SELL';
}

export function inferScannerStrategy(card: Pick<ScannerSignalCard, 'evidence' | 'matched'>): ScannerStrategy {
  const keysAndLabels = [
    ...card.matched,
    ...card.evidence.flatMap((item) => [item.key, item.label]),
  ];
  if (includesToken(keysAndLabels, BREAKOUT_TOKENS)) return 'BREAKOUT';
  if (includesToken(keysAndLabels, PULLBACK_TOKENS)) return 'PULLBACK';
  if (includesToken(keysAndLabels, MEAN_REVERSION_TOKENS)) return 'MEAN_REVERSION';
  return 'TREND';
}

export function inferScannerRegime(
  card: Pick<ScannerSignalCard, 'changePercent' | 'direction' | 'volatilityPercent'>,
  marketClass: ScannerMarketClass,
): ScannerMarketRegime {
  const volatileThreshold = marketClass === 'CRYPTO_FUTURES'
    ? 4
    : marketClass === 'CRYPTO_SPOT'
      ? 6
      : 8;
  if (card.volatilityPercent != null && card.volatilityPercent >= volatileThreshold) return 'VOLATILE';
  const change = card.changePercent ?? 0;
  if (card.direction === 'LONG' && change >= -0.5) return 'BULL';
  if (card.direction === 'SHORT' && change <= 0.5) return 'BEAR';
  if (Math.abs(change) < 1) return 'SIDEWAYS';
  return 'UNCLASSIFIED';
}

export function inferScannerTimeframe(card: Pick<ScannerSignalCard, 'observedAt' | 'expiresAt'>): string {
  const observed = Date.parse(card.observedAt);
  const expires = Date.parse(card.expiresAt);
  const ttl = expires - observed;
  if (!Number.isFinite(ttl) || ttl <= 0) return 'UNSPECIFIED';
  if (ttl <= 20 * 60_000) return '5m';
  if (ttl <= 60 * 60_000) return '15m';
  if (ttl <= 4 * 60 * 60_000) return '60m';
  if (ttl <= 16 * 60 * 60_000) return '4H';
  return '1D';
}

export function buildScannerPerformanceKey(input: {
  marketClass: ScannerMarketClass;
  strategy: ScannerStrategy;
  timeframe: string;
  action: ScannerTradeAction;
  regime: ScannerMarketRegime;
  modelVersion?: string;
}): string {
  return [
    input.marketClass,
    input.strategy,
    input.timeframe || 'UNSPECIFIED',
    input.action,
    input.regime,
    input.modelVersion ?? SCANNER_MARKET_MODEL_VERSION,
  ].join('|');
}

export function evaluateScannerMarketApproval(
  card: ScannerSignalCard,
  marketClass: ScannerMarketClass,
  action: ScannerTradeAction,
): { eligible: boolean; failures: string[] } {
  const profile = SCANNER_MARKET_APPROVAL_PROFILES[marketClass];
  const failures: string[] = [];
  if (!card.strongSignalEligible) failures.push('기본 강신호 기준 미충족');
  if (!isScannerActionAllowed(marketClass, action)) failures.push('시장과 주문 방향 조합 불일치');
  if (card.score < profile.minScore) failures.push(`점수 ${profile.minScore} 미만`);
  if (card.confidence < profile.minConfidence) failures.push(`신뢰도 ${profile.minConfidence} 미만`);
  if (card.dataCompleteness < profile.minDataCompleteness) failures.push(`데이터 완성도 ${profile.minDataCompleteness} 미만`);
  if (card.riskScore == null) failures.push('위험 점수 미확인');
  else if (card.riskScore > profile.maxRiskScore) failures.push(`위험 점수 ${profile.maxRiskScore} 초과`);
  if (
    profile.maxSpreadPercent != null
    && (card.spreadPercent == null || card.spreadPercent > profile.maxSpreadPercent)
  ) failures.push(`스프레드 ${profile.maxSpreadPercent}% 기준 미충족`);
  if (
    profile.maxVolatilityPercent != null
    && card.volatilityPercent != null
    && card.volatilityPercent > profile.maxVolatilityPercent
  ) failures.push(`ATR 변동성 ${profile.maxVolatilityPercent}% 초과`);
  for (const key of profile.requiredEvidenceKeys) {
    const evidence = card.evidence.find((item) => item.key === key);
    if (!evidence || evidence.status !== 'matched') failures.push(`필수 근거 ${key} 미확인`);
  }
  if (action === 'SELL' && card.assetClass !== 'stock' && card.assetClass !== 'coin_spot') {
    failures.push('SELL은 주식·현물 보유분 축소 전용');
  }
  return { eligible: failures.length === 0, failures };
}

export function enrichScannerMarketAction(card: ScannerSignalCard): ScannerSignalCard {
  const marketClass = classifyScannerMarket(card);
  const action = resolveScannerTradeAction(marketClass, card.direction);
  const executionIntent = resolveScannerExecutionIntent(action);
  const strategy = inferScannerStrategy(card);
  const regime = inferScannerRegime(card, marketClass);
  const timeframe = inferScannerTimeframe(card);
  const performanceKey = buildScannerPerformanceKey({
    marketClass,
    strategy,
    timeframe,
    action,
    regime,
  });
  const approval = evaluateScannerMarketApproval(card, marketClass, action);
  const policyWarnings = approval.failures.map((failure) => `시장별 승인 차단: ${failure}`);
  return {
    ...card,
    marketClass,
    action,
    executionIntent,
    strategy,
    regime,
    modelVersion: SCANNER_MARKET_MODEL_VERSION,
    performanceKey,
    marketApprovalEligible: approval.eligible,
    warnings: [...new Set([...card.warnings, ...policyWarnings])],
  };
}
