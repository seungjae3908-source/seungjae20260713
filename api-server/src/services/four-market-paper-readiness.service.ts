export type PaperMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PaperProvider = 'TOSS' | 'UPBIT' | 'BITGET';
export type PaperDirection = 'BUY' | 'SELL_EXIT' | 'LONG' | 'SHORT';
export type PaperDataStatus = 'ready' | 'partial' | 'stale' | 'unavailable' | 'invalid';

export interface PaperCostPolicyEvidence {
  version: string;
  commissionRate: number;
  taxRate: number | null;
  spreadRate: number;
  slippageRate: number;
  fundingRate: number | null;
  latencyMs: number;
}

export interface FourMarketPaperReadinessEvidence {
  market: PaperMarket;
  provider: PaperProvider;
  direction: PaperDirection;
  reducing: boolean;
  observedAt: string;
  dataStatus: PaperDataStatus;
  costPolicy: PaperCostPolicyEvidence;
  session: {
    id: string | null;
    isOpen: boolean;
    halted: boolean;
  };
  marketRules: {
    tickSize: number;
    quantityStep: number;
    minimumQuantity: number | null;
    minimumNotional: number;
    maximumLeverage: number | null;
    maintenanceMarginRate: number | null;
  };
  futures?: {
    markPrice: number | null;
    openInterest: number | null;
    marginMode: 'isolated' | 'cross' | null;
  };
}

export interface FourMarketPaperReadinessResult {
  ready: boolean;
  blockCodes: string[];
  orderSubmitted: false;
  exchangeRequestSent: false;
}

const PROVIDER_BY_MARKET: Readonly<Record<PaperMarket, PaperProvider>> = {
  KR_STOCK: 'TOSS',
  US_STOCK: 'TOSS',
  CRYPTO_SPOT: 'UPBIT',
  CRYPTO_FUTURES: 'BITGET',
};

const MAX_EVIDENCE_AGE_MS = 5_000;

function isFiniteNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function evaluateFourMarketPaperReadiness(
  evidence: FourMarketPaperReadinessEvidence,
  now = Date.now(),
): FourMarketPaperReadinessResult {
  const blockCodes: string[] = [];
  const expectedProvider = PROVIDER_BY_MARKET[evidence.market];
  if (evidence.provider !== expectedProvider) blockCodes.push('PAPER_PROVIDER_MISMATCH');

  const observedAt = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_EVIDENCE_AGE_MS) {
    blockCodes.push('PAPER_EVIDENCE_STALE_OR_INVALID');
  }
  if (evidence.dataStatus !== 'ready') blockCodes.push('PAPER_DATA_NOT_READY');

  if (!evidence.costPolicy.version.trim()) blockCodes.push('PAPER_COST_POLICY_VERSION_MISSING');
  if (!isFiniteNonNegative(evidence.costPolicy.commissionRate)) blockCodes.push('PAPER_COMMISSION_INVALID');
  if (!isFiniteNonNegative(evidence.costPolicy.spreadRate)) blockCodes.push('PAPER_SPREAD_INVALID');
  if (!isFiniteNonNegative(evidence.costPolicy.slippageRate)) blockCodes.push('PAPER_SLIPPAGE_INVALID');
  if (!isFiniteNonNegative(evidence.costPolicy.latencyMs)) blockCodes.push('PAPER_LATENCY_INVALID');

  if (!isFinitePositive(evidence.marketRules.tickSize)) blockCodes.push('PAPER_TICK_SIZE_INVALID');
  if (!isFinitePositive(evidence.marketRules.quantityStep)) blockCodes.push('PAPER_QUANTITY_STEP_INVALID');
  if (!isFinitePositive(evidence.marketRules.minimumNotional)) blockCodes.push('PAPER_MIN_NOTIONAL_INVALID');

  if (evidence.market === 'KR_STOCK' || evidence.market === 'US_STOCK') {
    if (evidence.direction === 'LONG' || evidence.direction === 'SHORT') blockCodes.push('PAPER_CASH_DIRECTION_INVALID');
    if (evidence.direction === 'SELL_EXIT' && !evidence.reducing) blockCodes.push('PAPER_CASH_EXIT_MUST_REDUCE');
    if (!evidence.session.id || !evidence.session.isOpen || evidence.session.halted) blockCodes.push('PAPER_STOCK_SESSION_NOT_TRADABLE');
    if (!isFiniteNonNegative(evidence.costPolicy.taxRate)) blockCodes.push('PAPER_STOCK_TAX_POLICY_MISSING');
    if (evidence.costPolicy.fundingRate !== null) blockCodes.push('PAPER_STOCK_FUNDING_FORBIDDEN');
    if (evidence.marketRules.maximumLeverage !== null || evidence.marketRules.maintenanceMarginRate !== null) {
      blockCodes.push('PAPER_STOCK_FUTURES_RULES_FORBIDDEN');
    }
  }

  if (evidence.market === 'CRYPTO_SPOT') {
    if (evidence.direction === 'LONG' || evidence.direction === 'SHORT') blockCodes.push('PAPER_SPOT_DIRECTION_INVALID');
    if (evidence.direction === 'SELL_EXIT' && !evidence.reducing) blockCodes.push('PAPER_SPOT_EXIT_MUST_REDUCE');
    if (evidence.costPolicy.taxRate !== null) blockCodes.push('PAPER_SPOT_TAX_POLICY_FORBIDDEN');
    if (evidence.costPolicy.fundingRate !== null) blockCodes.push('PAPER_SPOT_FUNDING_FORBIDDEN');
    if (evidence.marketRules.maximumLeverage !== null || evidence.marketRules.maintenanceMarginRate !== null) {
      blockCodes.push('PAPER_SPOT_FUTURES_RULES_FORBIDDEN');
    }
  }

  if (evidence.market === 'CRYPTO_FUTURES') {
    if (evidence.direction !== 'LONG' && evidence.direction !== 'SHORT') blockCodes.push('PAPER_FUTURES_DIRECTION_INVALID');
    if (!isFiniteNonNegative(evidence.costPolicy.fundingRate)) blockCodes.push('PAPER_FUTURES_FUNDING_MISSING');
    if (!isFinitePositive(evidence.marketRules.minimumQuantity)) blockCodes.push('PAPER_FUTURES_MIN_QTY_INVALID');
    if (!isFinitePositive(evidence.marketRules.maximumLeverage)) blockCodes.push('PAPER_FUTURES_MAX_LEVERAGE_INVALID');
    if (!isFinitePositive(evidence.marketRules.maintenanceMarginRate)) blockCodes.push('PAPER_FUTURES_MMR_INVALID');
    if (!evidence.futures || !isFinitePositive(evidence.futures.markPrice) || !isFiniteNonNegative(evidence.futures.openInterest)) {
      blockCodes.push('PAPER_FUTURES_MARK_OI_MISSING');
    }
    if (!evidence.futures?.marginMode) blockCodes.push('PAPER_FUTURES_MARGIN_MODE_MISSING');
  }

  return {
    ready: blockCodes.length === 0,
    blockCodes: [...new Set(blockCodes)],
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}
