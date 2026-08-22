export type PaperMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PaperDirection = 'BUY' | 'SELL' | 'EXIT' | 'LONG' | 'SHORT';
export type PaperProvider = 'toss' | 'upbit' | 'bitget';
export type PaperPartialFillModel = 'NONE' | 'PRO_RATA' | 'ORDER_BOOK';

type CommonPaperReadinessEvidence = {
  market: PaperMarket;
  provider: PaperProvider;
  providerProvenance: string;
  direction: PaperDirection;
  isReducing?: boolean;
  observedAtMs: number;
  costPolicyVersion: string;
  feePercent: number;
  spreadPercent: number;
  slippagePercent: number;
  tickSize: number;
  liquidity: number;
  partialFillModel: PaperPartialFillModel;
};

export type StockPaperReadinessEvidence = CommonPaperReadinessEvidence & {
  market: 'KR_STOCK' | 'US_STOCK';
  provider: 'toss';
  sessionCalendarVersion: string;
  marketStatus: 'OPEN' | 'CLOSED' | 'HALTED' | 'UNKNOWN';
  taxPolicyVersion: string;
  taxPercent: number;
};

export type CryptoSpotPaperReadinessEvidence = CommonPaperReadinessEvidence & {
  market: 'CRYPTO_SPOT';
  provider: 'upbit';
  minimumOrderNotional: number;
};

export type CryptoFuturesPaperReadinessEvidence = CommonPaperReadinessEvidence & {
  market: 'CRYPTO_FUTURES';
  provider: 'bitget';
  minimumOrderQuantity: number;
  quantityStep: number;
  quantityPrecision: number;
  markPrice: number;
  fundingRate: number;
  leverage: number;
  marginMode: 'isolated' | 'cross';
  liquidationDistancePercent: number;
};

export type PaperReadinessEvidence =
  | StockPaperReadinessEvidence
  | CryptoSpotPaperReadinessEvidence
  | CryptoFuturesPaperReadinessEvidence;

export type PaperReadinessBlocker =
  | 'EVIDENCE_INVALID'
  | 'MARKET_UNSUPPORTED'
  | 'PROVIDER_MISMATCH'
  | 'PROVIDER_PROVENANCE_REQUIRED'
  | 'DIRECTION_UNSUPPORTED'
  | 'REDUCING_EXIT_REQUIRED'
  | 'EVIDENCE_TIMESTAMP_INVALID'
  | 'EVIDENCE_FROM_FUTURE'
  | 'EVIDENCE_STALE'
  | 'COST_POLICY_VERSION_REQUIRED'
  | 'FEE_PERCENT_INVALID'
  | 'SPREAD_PERCENT_INVALID'
  | 'SLIPPAGE_PERCENT_INVALID'
  | 'TICK_SIZE_INVALID'
  | 'LIQUIDITY_INVALID'
  | 'PARTIAL_FILL_MODEL_REQUIRED'
  | 'SESSION_CALENDAR_VERSION_REQUIRED'
  | 'MARKET_NOT_OPEN'
  | 'TAX_POLICY_VERSION_REQUIRED'
  | 'TAX_PERCENT_INVALID'
  | 'MINIMUM_ORDER_NOTIONAL_INVALID'
  | 'MINIMUM_ORDER_QUANTITY_INVALID'
  | 'QUANTITY_STEP_INVALID'
  | 'QUANTITY_PRECISION_INVALID'
  | 'MARK_PRICE_INVALID'
  | 'FUNDING_RATE_INVALID'
  | 'LEVERAGE_INVALID'
  | 'MARGIN_MODE_INVALID'
  | 'LIQUIDATION_DISTANCE_INVALID';

export type PaperReadinessResult = Readonly<{
  ready: boolean;
  status: 'READY' | 'BLOCKED';
  blockers: readonly PaperReadinessBlocker[];
  simulatedOnly: true;
  liveOrderAllowed: false;
  orderSubmitted: false;
  privateTradingApiAllowed: false;
  privateProviderRequests: 0;
  liveAuthority: false;
}>;

const EXPECTED_PROVIDER: Readonly<Record<PaperMarket, PaperProvider>> = Object.freeze({
  KR_STOCK: 'toss',
  US_STOCK: 'toss',
  CRYPTO_SPOT: 'upbit',
  CRYPTO_FUTURES: 'bitget',
});

const MARKETS = new Set<PaperMarket>(Object.keys(EXPECTED_PROVIDER) as PaperMarket[]);
const DIRECTIONS = new Set<PaperDirection>(['BUY', 'SELL', 'EXIT', 'LONG', 'SHORT']);
const PARTIAL_FILL_MODELS = new Set<PaperPartialFillModel>(['NONE', 'PRO_RATA', 'ORDER_BOOK']);
const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function add(blockers: PaperReadinessBlocker[], blocker: PaperReadinessBlocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function result(blockers: PaperReadinessBlocker[]): PaperReadinessResult {
  const frozenBlockers = Object.freeze([...blockers]);
  return Object.freeze({
    ready: frozenBlockers.length === 0,
    status: frozenBlockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers: frozenBlockers,
    simulatedOnly: true,
    liveOrderAllowed: false,
    orderSubmitted: false,
    privateTradingApiAllowed: false,
    privateProviderRequests: 0,
    liveAuthority: false,
  });
}

export function validatePaperReadiness(
  evidence: unknown,
  nowMs = Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
): PaperReadinessResult {
  const blockers: PaperReadinessBlocker[] = [];
  if (!isRecord(evidence)) return result(['EVIDENCE_INVALID']);

  const market = evidence.market;
  if (typeof market !== 'string' || !MARKETS.has(market as PaperMarket)) {
    add(blockers, 'MARKET_UNSUPPORTED');
    return result(blockers);
  }
  const canonicalMarket = market as PaperMarket;

  if (evidence.provider !== EXPECTED_PROVIDER[canonicalMarket]) add(blockers, 'PROVIDER_MISMATCH');
  if (!nonEmptyString(evidence.providerProvenance)) add(blockers, 'PROVIDER_PROVENANCE_REQUIRED');

  const direction = evidence.direction;
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction as PaperDirection)) {
    add(blockers, 'DIRECTION_UNSUPPORTED');
  } else if (canonicalMarket === 'CRYPTO_FUTURES') {
    if (direction !== 'LONG' && direction !== 'SHORT') add(blockers, 'DIRECTION_UNSUPPORTED');
  } else if (direction === 'LONG' || direction === 'SHORT') {
    add(blockers, 'DIRECTION_UNSUPPORTED');
  } else if ((direction === 'SELL' || direction === 'EXIT') && evidence.isReducing !== true) {
    add(blockers, 'REDUCING_EXIT_REQUIRED');
  }

  const observedAtMs = evidence.observedAtMs;
  if (!finitePositive(observedAtMs) || !finitePositive(nowMs) || !finitePositive(maxEvidenceAgeMs)) {
    add(blockers, 'EVIDENCE_TIMESTAMP_INVALID');
  } else if (observedAtMs > nowMs) {
    add(blockers, 'EVIDENCE_FROM_FUTURE');
  } else if (nowMs - observedAtMs > maxEvidenceAgeMs) {
    add(blockers, 'EVIDENCE_STALE');
  }

  if (!nonEmptyString(evidence.costPolicyVersion)) add(blockers, 'COST_POLICY_VERSION_REQUIRED');
  if (!finiteNonNegative(evidence.feePercent)) add(blockers, 'FEE_PERCENT_INVALID');
  if (!finiteNonNegative(evidence.spreadPercent)) add(blockers, 'SPREAD_PERCENT_INVALID');
  if (!finiteNonNegative(evidence.slippagePercent)) add(blockers, 'SLIPPAGE_PERCENT_INVALID');
  if (!finitePositive(evidence.tickSize)) add(blockers, 'TICK_SIZE_INVALID');
  if (!finitePositive(evidence.liquidity)) add(blockers, 'LIQUIDITY_INVALID');
  if (typeof evidence.partialFillModel !== 'string'
    || !PARTIAL_FILL_MODELS.has(evidence.partialFillModel as PaperPartialFillModel)) {
    add(blockers, 'PARTIAL_FILL_MODEL_REQUIRED');
  }

  if (canonicalMarket === 'KR_STOCK' || canonicalMarket === 'US_STOCK') {
    if (!nonEmptyString(evidence.sessionCalendarVersion)) add(blockers, 'SESSION_CALENDAR_VERSION_REQUIRED');
    if (evidence.marketStatus !== 'OPEN') add(blockers, 'MARKET_NOT_OPEN');
    if (!nonEmptyString(evidence.taxPolicyVersion)) add(blockers, 'TAX_POLICY_VERSION_REQUIRED');
    if (!finiteNonNegative(evidence.taxPercent)) add(blockers, 'TAX_PERCENT_INVALID');
  } else if (canonicalMarket === 'CRYPTO_SPOT') {
    if (!finitePositive(evidence.minimumOrderNotional)) add(blockers, 'MINIMUM_ORDER_NOTIONAL_INVALID');
  } else {
    if (!finitePositive(evidence.minimumOrderQuantity)) add(blockers, 'MINIMUM_ORDER_QUANTITY_INVALID');
    if (!finitePositive(evidence.quantityStep)) add(blockers, 'QUANTITY_STEP_INVALID');
    if (!Number.isInteger(evidence.quantityPrecision) || Number(evidence.quantityPrecision) < 0) {
      add(blockers, 'QUANTITY_PRECISION_INVALID');
    }
    if (!finitePositive(evidence.markPrice)) add(blockers, 'MARK_PRICE_INVALID');
    if (typeof evidence.fundingRate !== 'number' || !Number.isFinite(evidence.fundingRate)) {
      add(blockers, 'FUNDING_RATE_INVALID');
    }
    if (!finitePositive(evidence.leverage)) add(blockers, 'LEVERAGE_INVALID');
    if (evidence.marginMode !== 'isolated' && evidence.marginMode !== 'cross') add(blockers, 'MARGIN_MODE_INVALID');
    if (!finitePositive(evidence.liquidationDistancePercent)) add(blockers, 'LIQUIDATION_DISTANCE_INVALID');
  }

  return result(blockers);
}
