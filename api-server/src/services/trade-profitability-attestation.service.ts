import {
  createDefaultStrategyPromotionService,
  type PromotionStageEvidence,
  type StrategyPromotionRecord,
  type StrategyPromotionService,
} from './strategy-promotion.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingEconomics,
  type TradingMarketRegime,
  type TradingPlanInput,
} from './trade-automation.types';

const SHA40 = /^[0-9a-f]{40}$/i;
const HASH64 = /^[0-9a-f]{64}$/i;
const REGIMES = new Set<TradingMarketRegime>(['bull', 'bear', 'sideways', 'stress', 'unknown']);

type PromotionReader = Pick<StrategyPromotionService, 'get'>;

type ProfitabilityEvidenceFreshness = {
  now: number;
  maxEvidenceAgeHours: number;
};

export type TradeProfitabilityAttestation = {
  required: boolean;
  allowed: boolean;
  blockCodes: string[];
  source: 'SERVER_STRATEGY_PROMOTION';
  strategyId: string;
  promotionState: string | null;
  researchCodeSha: string | null;
  parameterHash: string | null;
  costPolicyVersion: string | null;
  clientEconomicsTrusted: false;
  serverEconomics: TradingEconomics | null;
  orderAuthorityGranted: false;
};

function expectedMarket(input: TradingPlanInput) {
  if (input.exchange === 'bitget') return 'CRYPTO_FUTURES';
  if (input.exchange === 'upbit') return 'CRYPTO_SPOT';
  const normalized = `${input.market} ${input.symbol}`.toUpperCase();
  return normalized.includes('US') ? 'US_STOCK' : 'KR_STOCK';
}

function expectedDirection(input: TradingPlanInput) {
  if (input.side === 'long') return 'LONG';
  if (input.side === 'short') return 'SHORT';
  if (input.side === 'buy') return 'BUY';
  return 'SELL';
}

function stage(record: StrategyPromotionRecord, name: PromotionStageEvidence['stage']) {
  return record.stages.find((item) => item.stage === name) ?? null;
}

function finiteMetric(stages: Array<PromotionStageEvidence | null>, key: string) {
  for (const item of stages) {
    const value = item?.metrics?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function textMetric(stages: Array<PromotionStageEvidence | null>, key: string) {
  for (const item of stages) {
    const value = item?.metrics?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function projectedEconomics(
  record: StrategyPromotionRecord,
  freshness: ProfitabilityEvidenceFreshness,
) {
  const outcomes = stage(record, 'RECOMMENDATION_OUTCOMES');
  const paper = stage(record, 'PAPER');
  const regime = stage(record, 'REGIME');
  const sources = [outcomes, paper, regime];
  const sampleSize = outcomes?.sampleCount ?? outcomes?.sampleSize ?? outcomes?.tradeCount
    ?? paper?.sampleCount ?? paper?.sampleSize ?? paper?.tradeCount ?? null;
  const winProbability = finiteMetric(sources, 'hitRate') ?? finiteMetric(sources, 'winProbability');
  const averageWinR = finiteMetric(sources, 'averageWinR');
  const averageLossR = finiteMetric(sources, 'averageLossR');
  const estimatedCostsR = finiteMetric(sources, 'estimatedCostsR');
  const profitFactor = finiteMetric(sources, 'profitFactor');
  const maxDrawdownPercent = finiteMetric(sources, 'maxDrawdownPercent');
  const rawRegime = textMetric(sources, 'marketRegime') as TradingMarketRegime | null;
  const marketRegime = rawRegime && REGIMES.has(rawRegime) ? rawRegime : null;
  const calibratedAt = outcomes?.validatedAt ?? outcomes?.completedAt ?? paper?.validatedAt ?? paper?.completedAt ?? null;
  const calibratedAtMs = calibratedAt ? Date.parse(calibratedAt) : Number.NaN;

  const missing: string[] = [];
  if (!Number.isInteger(sampleSize) || Number(sampleSize) <= 0) missing.push('SERVER_SAMPLE_SIZE_REQUIRED');
  if (winProbability == null || winProbability < 0 || winProbability > 1) missing.push('SERVER_WIN_PROBABILITY_REQUIRED');
  if (averageWinR == null || averageWinR <= 0) missing.push('SERVER_AVERAGE_WIN_R_REQUIRED');
  if (averageLossR == null || averageLossR <= 0) missing.push('SERVER_AVERAGE_LOSS_R_REQUIRED');
  if (estimatedCostsR == null || estimatedCostsR < 0) missing.push('SERVER_ESTIMATED_COSTS_R_REQUIRED');
  if (profitFactor == null || profitFactor <= 0) missing.push('SERVER_PROFIT_FACTOR_REQUIRED');
  if (maxDrawdownPercent == null || maxDrawdownPercent < 0) missing.push('SERVER_MAX_DRAWDOWN_REQUIRED');
  if (!marketRegime) missing.push('SERVER_MARKET_REGIME_REQUIRED');
  if (!calibratedAt || !Number.isFinite(calibratedAtMs)) {
    missing.push('SERVER_CALIBRATED_AT_REQUIRED');
  } else if (
    freshness.now - calibratedAtMs
      > freshness.maxEvidenceAgeHours * 60 * 60_000
  ) {
    missing.push('PROFITABILITY_EVIDENCE_STALE');
  }
  if (missing.length) return { economics: null, missing };

  const economics: TradingEconomics = {
    sampleSize: Number(sampleSize),
    winProbability: winProbability!,
    averageWinR: averageWinR!,
    averageLossR: averageLossR!,
    estimatedCostsR: estimatedCostsR!,
    profitFactor: profitFactor!,
    maxDrawdownPercent: maxDrawdownPercent!,
    marketRegime: marketRegime!,
    calibratedAt: calibratedAt!,
  };
  return { economics, missing };
}

export function attestLiveTradingProfitability(
  input: TradingPlanInput,
  promotion: PromotionReader = createDefaultStrategyPromotionService(),
  freshness: Partial<ProfitabilityEvidenceFreshness> = {},
): TradeProfitabilityAttestation {
  const base: TradeProfitabilityAttestation = {
    required: input.accountMode === 'live',
    allowed: input.accountMode !== 'live',
    blockCodes: [],
    source: 'SERVER_STRATEGY_PROMOTION',
    strategyId: input.strategyId,
    promotionState: null,
    researchCodeSha: null,
    parameterHash: null,
    costPolicyVersion: null,
    clientEconomicsTrusted: false,
    serverEconomics: null,
    orderAuthorityGranted: false,
  };
  if (input.accountMode !== 'live') return base;

  const record = promotion.get(input.strategyId);
  if (!record) {
    return { ...base, blockCodes: ['SERVER_STRATEGY_PROMOTION_NOT_FOUND'] };
  }

  const blockCodes: string[] = [];
  if (!record.promotionEligible || record.promotionState !== 'PROMOTION_CANDIDATE') {
    blockCodes.push('SERVER_STRATEGY_NOT_PROMOTION_READY');
  }
  if (record.identity.market !== expectedMarket(input)) blockCodes.push('SERVER_STRATEGY_MARKET_MISMATCH');
  if (record.identity.direction !== expectedDirection(input)) blockCodes.push('SERVER_STRATEGY_DIRECTION_MISMATCH');
  if (!SHA40.test(record.identity.researchCodeSha)) blockCodes.push('SERVER_RESEARCH_SHA_INVALID');
  if (!HASH64.test(record.identity.parameterHash)) blockCodes.push('SERVER_PARAMETER_HASH_INVALID');
  if (!record.identity.costPolicyVersion.trim()) blockCodes.push('SERVER_COST_POLICY_VERSION_REQUIRED');
  if (record.executionAuthority !== 'NONE' || record.liveTradingAuthority !== false) {
    blockCodes.push('SERVER_PROMOTION_AUTHORITY_CONTRACT_INVALID');
  }

  const projection = projectedEconomics(record, {
    now: freshness.now ?? Date.now(),
    maxEvidenceAgeHours: freshness.maxEvidenceAgeHours ?? DEFAULT_TRADING_POLICY.maxEconomicsAgeHours,
  });
  blockCodes.push(...projection.missing);
  const unique = [...new Set(blockCodes)];
  return {
    ...base,
    allowed: unique.length === 0,
    blockCodes: unique,
    promotionState: record.promotionState,
    researchCodeSha: record.identity.researchCodeSha,
    parameterHash: record.identity.parameterHash,
    costPolicyVersion: record.identity.costPolicyVersion,
    serverEconomics: unique.length === 0 ? projection.economics : null,
  };
}
