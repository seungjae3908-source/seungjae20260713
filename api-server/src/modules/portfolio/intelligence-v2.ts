export type PortfolioCurrency = 'KRW' | 'USD' | 'USDT';
export type PortfolioDataQuality = 'LIVE' | 'DELAYED' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';
export type PortfolioAssetBucket = 'CASH' | 'KR_STOCKS' | 'US_STOCKS' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES_EQUITY';

export type FxQuote = {
  currency: Exclude<PortfolioCurrency, 'KRW'>;
  krwRate: number;
  source: string;
  asOf: string;
  quality: PortfolioDataQuality;
};

export type NativeMoney = {
  amount: number;
  currency: PortfolioCurrency;
  source: string;
  asOf: string;
  quality: PortfolioDataQuality;
};

export type NormalizedMoney = NativeMoney & {
  normalizedKRWAmount: number | null;
  fxRate: number | null;
  fxSource: string | null;
  fxAsOf: string | null;
  status: 'READY' | 'FX_UNAVAILABLE';
};

export type PortfolioAssetInput = NativeMoney & {
  bucket: PortfolioAssetBucket;
};

export type PortfolioAssetSummary = {
  status: 'READY' | 'PARTIAL';
  components: Array<PortfolioAssetInput & NormalizedMoney>;
  knownNormalizedKRWAmount: number;
  totalNormalizedKRWAmount: number | null;
  missing: string[];
};

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFresh(asOf: string, now: Date, maxAgeMs: number): boolean {
  const parsed = timestampMs(asOf);
  return parsed != null && parsed <= now.getTime() && now.getTime() - parsed <= maxAgeMs;
}

export function normalizeMoneyToKRW(
  money: NativeMoney,
  fxQuotes: readonly FxQuote[],
  options: { now?: Date; maxFxAgeMs?: number } = {},
): NormalizedMoney {
  const now = options.now ?? new Date();
  const maxFxAgeMs = options.maxFxAgeMs ?? 6 * 60 * 60 * 1000;
  if (!finiteNonNegative(money.amount)) {
    return { ...money, normalizedKRWAmount: null, fxRate: null, fxSource: null, fxAsOf: null, status: 'FX_UNAVAILABLE' };
  }
  if (money.currency === 'KRW') {
    return {
      ...money,
      normalizedKRWAmount: money.quality === 'UNAVAILABLE' ? null : money.amount,
      fxRate: 1,
      fxSource: 'native-krw',
      fxAsOf: money.asOf,
      status: money.quality === 'UNAVAILABLE' ? 'FX_UNAVAILABLE' : 'READY',
    };
  }
  const quote = fxQuotes.find((candidate) => candidate.currency === money.currency);
  const quoteUsable = quote
    && finitePositive(quote.krwRate)
    && quote.quality !== 'STALE'
    && quote.quality !== 'UNAVAILABLE'
    && isFresh(quote.asOf, now, maxFxAgeMs);
  if (!quoteUsable || money.quality === 'UNAVAILABLE') {
    return { ...money, normalizedKRWAmount: null, fxRate: quote?.krwRate ?? null, fxSource: quote?.source ?? null, fxAsOf: quote?.asOf ?? null, status: 'FX_UNAVAILABLE' };
  }
  return {
    ...money,
    normalizedKRWAmount: money.amount * quote.krwRate,
    fxRate: quote.krwRate,
    fxSource: quote.source,
    fxAsOf: quote.asOf,
    status: 'READY',
  };
}

export function buildPortfolioAssetSummary(
  inputs: readonly PortfolioAssetInput[],
  fxQuotes: readonly FxQuote[],
  options: { now?: Date; maxFxAgeMs?: number } = {},
): PortfolioAssetSummary {
  const components = inputs.map((input) => ({
    ...input,
    ...normalizeMoneyToKRW(input, fxQuotes, options),
  }));
  const unavailable = components.filter((component) => component.normalizedKRWAmount == null);
  const knownNormalizedKRWAmount = components.reduce((sum, component) => sum + (component.normalizedKRWAmount ?? 0), 0);
  return {
    status: unavailable.length > 0 ? 'PARTIAL' : 'READY',
    components,
    knownNormalizedKRWAmount,
    totalNormalizedKRWAmount: unavailable.length > 0 ? null : knownNormalizedKRWAmount,
    missing: unavailable.map((component) => `${component.bucket}:${component.currency}:FX_UNAVAILABLE`),
  };
}

export type CashPlan = {
  totalCashKRW: number;
  availableCashKRW: number;
  reservedCashKRW: number;
  minimumCashBufferKRW: number;
  investableCashKRW: number;
  minimumCashBufferRatio: number;
};

export function calculateCashPlan(input: {
  totalCashKRW: number;
  availableCashKRW: number;
  reservedCashKRW?: number;
  minimumCashBufferRatio: number;
}): CashPlan {
  const total = finiteNonNegative(input.totalCashKRW) ? input.totalCashKRW : 0;
  const available = finiteNonNegative(input.availableCashKRW) ? Math.min(input.availableCashKRW, total) : 0;
  const reserved = finiteNonNegative(input.reservedCashKRW ?? 0) ? Math.min(input.reservedCashKRW ?? 0, total) : 0;
  const ratio = Number.isFinite(input.minimumCashBufferRatio)
    ? Math.min(1, Math.max(0, input.minimumCashBufferRatio))
    : 0;
  const minimumCashBufferKRW = total * ratio;
  return {
    totalCashKRW: total,
    availableCashKRW: available,
    reservedCashKRW: reserved,
    minimumCashBufferKRW,
    investableCashKRW: Math.max(0, available - minimumCashBufferKRW),
    minimumCashBufferRatio: ratio,
  };
}

export type AllocationItem = {
  key: string;
  normalizedKRWAmount: number | null;
};

export type AllocationSummary = {
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  knownTotalKRW: number;
  weights: Array<{ key: string; normalizedKRWAmount: number | null; weightPercent: number | null }>;
  top5ConcentrationPercent: number | null;
};

export function calculateAllocation(items: readonly AllocationItem[]): AllocationSummary {
  const knownTotalKRW = items.reduce((sum, item) => sum + (finiteNonNegative(item.normalizedKRWAmount ?? Number.NaN) ? item.normalizedKRWAmount! : 0), 0);
  if (knownTotalKRW <= 0) {
    return {
      status: items.some((item) => item.normalizedKRWAmount == null) ? 'PARTIAL' : 'UNAVAILABLE',
      knownTotalKRW: 0,
      weights: items.map((item) => ({ ...item, weightPercent: null })),
      top5ConcentrationPercent: null,
    };
  }
  const partial = items.some((item) => item.normalizedKRWAmount == null);
  const weights = items.map((item) => ({
    ...item,
    weightPercent: item.normalizedKRWAmount == null ? null : (item.normalizedKRWAmount / knownTotalKRW) * 100,
  }));
  const top5ConcentrationPercent = weights
    .map((item) => item.weightPercent)
    .filter((value): value is number => value != null)
    .sort((left, right) => right - left)
    .slice(0, 5)
    .reduce((sum, value) => sum + value, 0);
  return { status: partial ? 'PARTIAL' : 'READY', knownTotalKRW, weights, top5ConcentrationPercent };
}

export type ReturnPoint = { timestamp: string; value: number };
export type CorrelationResult = {
  status: 'READY' | 'INSUFFICIENT_SAMPLE' | 'PARTIAL_MARKET_DATA';
  sampleSize: number;
  correlation: number | null;
};

export function calculateAlignedCorrelation(
  left: readonly ReturnPoint[],
  right: readonly ReturnPoint[],
  minSampleSize = 30,
): CorrelationResult {
  const rightByTimestamp = new Map(right.filter((point) => Number.isFinite(point.value)).map((point) => [point.timestamp, point.value]));
  const aligned = left
    .filter((point) => Number.isFinite(point.value) && rightByTimestamp.has(point.timestamp))
    .map((point) => [point.value, rightByTimestamp.get(point.timestamp)!] as const);
  if (aligned.length < minSampleSize) {
    const hasEnoughRaw = left.length >= minSampleSize && right.length >= minSampleSize;
    return { status: hasEnoughRaw ? 'PARTIAL_MARKET_DATA' : 'INSUFFICIENT_SAMPLE', sampleSize: aligned.length, correlation: null };
  }
  const leftMean = aligned.reduce((sum, point) => sum + point[0], 0) / aligned.length;
  const rightMean = aligned.reduce((sum, point) => sum + point[1], 0) / aligned.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [leftValue, rightValue] of aligned) {
    const leftDelta = leftValue - leftMean;
    const rightDelta = rightValue - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  if (!(denominator > 0)) return { status: 'PARTIAL_MARKET_DATA', sampleSize: aligned.length, correlation: null };
  return { status: 'READY', sampleSize: aligned.length, correlation: Math.max(-1, Math.min(1, covariance / denominator)) };
}

export type AdditionalInvestmentResult = {
  status: 'READY' | 'UNAVAILABLE';
  additionalQuantity: number | null;
  additionalInvestmentKRW: number | null;
  newAveragePrice: number | null;
  currentWeightPercent: number | null;
  projectedWeightPercent: number | null;
  stopLoss: number | null;
  targets: number[];
  estimatedMaxLossKRW: number | null;
  targetProfitsKRW: Array<number | null>;
  missing: string[];
};

export function simulateAdditionalInvestment(input: {
  currentQuantity: number;
  currentAveragePrice: number;
  currentPrice: number;
  currentPositionValueKRW: number;
  portfolioValueKRW: number;
  additionalAmountKRW?: number;
  additionalQuantity?: number;
  stopLoss?: number | null;
  targets?: readonly number[];
}): AdditionalInvestmentResult {
  const valuesValid = [input.currentQuantity, input.currentAveragePrice, input.currentPrice, input.currentPositionValueKRW, input.portfolioValueKRW]
    .every(finiteNonNegative) && input.currentPrice > 0 && input.portfolioValueKRW > 0;
  const quantity = finitePositive(input.additionalQuantity ?? Number.NaN)
    ? input.additionalQuantity!
    : finitePositive(input.additionalAmountKRW ?? Number.NaN)
      ? input.additionalAmountKRW! / input.currentPrice
      : null;
  if (!valuesValid || quantity == null) {
    return {
      status: 'UNAVAILABLE', additionalQuantity: null, additionalInvestmentKRW: null, newAveragePrice: null,
      currentWeightPercent: null, projectedWeightPercent: null, stopLoss: null, targets: [], estimatedMaxLossKRW: null,
      targetProfitsKRW: [], missing: ['VALID_CURRENT_POSITION_AND_ADDITIONAL_INPUT_REQUIRED'],
    };
  }
  const additionalInvestmentKRW = quantity * input.currentPrice;
  const totalQuantity = input.currentQuantity + quantity;
  const newAveragePrice = totalQuantity > 0
    ? ((input.currentQuantity * input.currentAveragePrice) + additionalInvestmentKRW) / totalQuantity
    : null;
  const projectedPortfolio = input.portfolioValueKRW + additionalInvestmentKRW;
  const projectedPosition = input.currentPositionValueKRW + additionalInvestmentKRW;
  const stopLoss = finitePositive(input.stopLoss ?? Number.NaN) ? input.stopLoss! : null;
  const targets = (input.targets ?? []).filter(finitePositive);
  return {
    status: 'READY',
    additionalQuantity: quantity,
    additionalInvestmentKRW,
    newAveragePrice,
    currentWeightPercent: (input.currentPositionValueKRW / input.portfolioValueKRW) * 100,
    projectedWeightPercent: projectedPortfolio > 0 ? (projectedPosition / projectedPortfolio) * 100 : null,
    stopLoss,
    targets: [...targets],
    estimatedMaxLossKRW: stopLoss != null && newAveragePrice != null && stopLoss < newAveragePrice
      ? (newAveragePrice - stopLoss) * totalQuantity
      : null,
    targetProfitsKRW: targets.map((target) => newAveragePrice != null && target > newAveragePrice ? (target - newAveragePrice) * totalQuantity : null),
    missing: [
      ...(stopLoss == null ? ['STOP_UNAVAILABLE'] : []),
      ...(targets.length === 0 ? ['TARGETS_UNAVAILABLE'] : []),
    ],
  };
}

export type MonthlyInvestmentPlan = {
  monthlyAmountKRW: number;
  months: number;
  cumulativeInvestmentKRW: number;
  allocations: Array<{ key: string; weight: number; cumulativeContributionKRW: number }>;
};

export function buildMonthlyInvestmentPlan(input: {
  monthlyAmountKRW: number;
  months: number;
  allocation: readonly { key: string; weight: number }[];
}): MonthlyInvestmentPlan | null {
  if (!finitePositive(input.monthlyAmountKRW) || !Number.isInteger(input.months) || input.months <= 0) return null;
  if (input.allocation.length === 0 || input.allocation.some((item) => !Number.isFinite(item.weight) || item.weight < 0)) return null;
  const weightTotal = input.allocation.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) return null;
  const cumulativeInvestmentKRW = input.monthlyAmountKRW * input.months;
  return {
    monthlyAmountKRW: input.monthlyAmountKRW,
    months: input.months,
    cumulativeInvestmentKRW,
    allocations: input.allocation.map((item) => ({ ...item, cumulativeContributionKRW: cumulativeInvestmentKRW * item.weight })),
  };
}

export type PortfolioRiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';

export function classifyPortfolioRisk(input: {
  concentrationPercent: number;
  cryptoExposurePercent: number;
  futuresExposurePercent: number;
  staleData: boolean;
  thresholds: {
    concentrationHigh: number;
    cryptoHigh: number;
    futuresHigh: number;
    veryHighMultiplier: number;
  };
}): PortfolioRiskLevel {
  const { thresholds } = input;
  const ratios = [
    input.concentrationPercent / thresholds.concentrationHigh,
    input.cryptoExposurePercent / thresholds.cryptoHigh,
    input.futuresExposurePercent / thresholds.futuresHigh,
  ].filter(Number.isFinite);
  const maxRatio = Math.max(0, ...ratios);
  if (input.staleData || maxRatio >= thresholds.veryHighMultiplier) return 'VERY_HIGH';
  if (maxRatio >= 1) return 'HIGH';
  if (maxRatio >= 0.6) return 'MODERATE';
  return 'LOW';
}