import type {
  CorrelationPair,
  Metric,
  PortfolioAnalyticsInput,
  PortfolioAnalyticsResult,
  Position,
  PositionAnalytics,
  RiskScorePolicy,
} from './types.ts';

export class PortfolioValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PortfolioValidationError';
  }
}

const available = <T>(value: T): Metric<T> => ({ status: 'available', value });
const insufficient = <T>(reason: string, missing?: string[]): Metric<T> => ({
  status: 'insufficient',
  reason,
  ...(missing?.length ? { missing } : {}),
});

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positionValue(position: Position): number | null {
  if (position.currentPrice == null || !Number.isFinite(position.currentPrice) || position.currentPrice <= 0) return null;
  return position.quantity * position.currentPrice;
}

function pnlDirection(position: Position): 1 | -1 {
  return position.positionSide === 'SHORT' ? -1 : 1;
}

function normalizeKey(value: string): string {
  return value.trim().toUpperCase();
}

function exposure(
  positions: Position[],
  totalValue: number,
  selector: (position: Position) => string | null,
): Metric<Record<string, number>> {
  const missing: string[] = [];
  const values: Record<string, number> = {};
  for (const position of positions) {
    const marketValue = positionValue(position);
    const key = selector(position);
    if (marketValue == null) missing.push(`${position.assetId}:price`);
    if (!key) missing.push(`${position.assetId}:classification`);
    if (marketValue == null || !key) continue;
    values[key] = (values[key] ?? 0) + (marketValue / totalValue) * 100;
  }
  return missing.length
    ? insufficient('EXPOSURE_INPUT_INCOMPLETE', missing)
    : available(values);
}

function correlationLookup(pairs: CorrelationPair[] | undefined): Map<string, number> {
  const result = new Map<string, number>();
  for (const pair of pairs ?? []) {
    if (!Number.isFinite(pair.correlation) || pair.correlation < -1 || pair.correlation > 1) continue;
    const left = normalizeKey(pair.leftAssetId);
    const right = normalizeKey(pair.rightAssetId);
    result.set(`${left}|${right}`, pair.correlation);
    result.set(`${right}|${left}`, pair.correlation);
  }
  return result;
}

function riskScoreFromPolicy(volatilityPercent: number, policy: RiskScorePolicy | undefined): Metric<number> {
  if (!policy?.bands?.length) return insufficient('RISK_SCORE_POLICY_NOT_SUPPLIED');
  const bands = [...policy.bands]
    .filter((band) => Number.isFinite(band.maxVolatilityPercent) && Number.isFinite(band.score))
    .sort((left, right) => left.maxVolatilityPercent - right.maxVolatilityPercent);
  if (!bands.length) return insufficient('RISK_SCORE_POLICY_INVALID');
  const matched = bands.find((band) => volatilityPercent <= band.maxVolatilityPercent) ?? bands[bands.length - 1];
  return available(matched.score);
}

function calculateRisk(
  positions: Position[],
  totalValue: number,
  input: PortfolioAnalyticsInput,
): {
  volatilityPercent: Metric<number>;
  correlation: Metric<number>;
  contributions: Map<string, Metric<number>>;
  portfolioRiskScore: Metric<number>;
} {
  const contributions = new Map<string, Metric<number>>();
  if (positions.length === 0) {
    return {
      volatilityPercent: insufficient('NO_POSITIONS'),
      correlation: insufficient('REQUIRES_AT_LEAST_TWO_POSITIONS'),
      contributions,
      portfolioRiskScore: insufficient('NO_POSITIONS'),
    };
  }

  const volMap = input.riskEvidence?.annualizedVolatilityByAssetId ?? {};
  const corrMap = correlationLookup(input.riskEvidence?.correlations);
  const missing: string[] = [];
  const weights = new Map<string, number>();
  const vols = new Map<string, number>();

  for (const position of positions) {
    const value = positionValue(position);
    if (value == null) missing.push(`${position.assetId}:price`);
    const volatility = volMap[position.assetId];
    if (volatility == null || !Number.isFinite(volatility) || volatility < 0) missing.push(`${position.assetId}:volatility`);
    if (value != null) weights.set(position.assetId, value / totalValue);
    if (volatility != null && Number.isFinite(volatility) && volatility >= 0) vols.set(position.assetId, volatility);
  }

  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const left = positions[i].assetId;
      const right = positions[j].assetId;
      if (!corrMap.has(`${normalizeKey(left)}|${normalizeKey(right)}`)) missing.push(`${left}<->${right}:correlation`);
    }
  }

  if (missing.length) {
    for (const position of positions) contributions.set(position.assetId, insufficient('RISK_EVIDENCE_INCOMPLETE', missing));
    return {
      volatilityPercent: insufficient('RISK_EVIDENCE_INCOMPLETE', missing),
      correlation: insufficient('RISK_EVIDENCE_INCOMPLETE', missing),
      contributions,
      portfolioRiskScore: insufficient('RISK_EVIDENCE_INCOMPLETE', missing),
    };
  }

  let variance = 0;
  const covarianceContribution = new Map<string, number>();
  for (const left of positions) {
    const leftWeight = weights.get(left.assetId) ?? 0;
    const leftVol = vols.get(left.assetId) ?? 0;
    let marginal = 0;
    for (const right of positions) {
      const rightWeight = weights.get(right.assetId) ?? 0;
      const rightVol = vols.get(right.assetId) ?? 0;
      const corr = left.assetId === right.assetId
        ? 1
        : corrMap.get(`${normalizeKey(left.assetId)}|${normalizeKey(right.assetId)}`) ?? 0;
      marginal += rightWeight * leftVol * rightVol * corr;
    }
    const component = leftWeight * marginal;
    covarianceContribution.set(left.assetId, component);
    variance += component;
  }

  const volatility = Math.sqrt(Math.max(0, variance));
  if (variance > 0) {
    for (const position of positions) {
      contributions.set(
        position.assetId,
        available(((covarianceContribution.get(position.assetId) ?? 0) / variance) * 100),
      );
    }
  } else {
    for (const position of positions) contributions.set(position.assetId, insufficient('ZERO_PORTFOLIO_VARIANCE'));
  }

  let weightedPairCorrelation = 0;
  let pairWeight = 0;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const left = positions[i];
      const right = positions[j];
      const weight = (weights.get(left.assetId) ?? 0) * (weights.get(right.assetId) ?? 0);
      weightedPairCorrelation += weight * (corrMap.get(`${normalizeKey(left.assetId)}|${normalizeKey(right.assetId)}`) ?? 0);
      pairWeight += weight;
    }
  }
  const correlation = positions.length < 2 || pairWeight === 0
    ? insufficient<number>('REQUIRES_AT_LEAST_TWO_POSITIONS')
    : available(weightedPairCorrelation / pairWeight);
  const volatilityPercent = volatility * 100;
  return {
    volatilityPercent: available(volatilityPercent),
    correlation,
    contributions,
    portfolioRiskScore: riskScoreFromPolicy(volatilityPercent, input.riskScorePolicy),
  };
}

export function analyzePortfolio(input: PortfolioAnalyticsInput): PortfolioAnalyticsResult {
  if (input.cash != null && !finiteNonNegative(input.cash)) {
    throw new PortfolioValidationError('INVALID_CASH', 'cash must be null or a finite non-negative number');
  }
  for (const position of input.positions) {
    if (!position.assetId.trim() || !position.symbol.trim()) throw new PortfolioValidationError('INVALID_POSITION_IDENTITY', 'position identity is required');
    if (!finiteNonNegative(position.quantity)) throw new PortfolioValidationError('INVALID_QUANTITY', `invalid quantity for ${position.assetId}`);
  }

  const missingPrice = input.positions.filter((position) => positionValue(position) == null).map((position) => `${position.assetId}:price`);
  const missingCash = input.cash == null ? ['cash'] : [];
  const totalMissing = [...new Set([...missingPrice, ...missingCash])];
  const knownPositionValue = input.positions.reduce((sum, position) => sum + (positionValue(position) ?? 0), 0);
  const knownValue = (input.cash ?? 0) + knownPositionValue;
  const totalValue = totalMissing.length
    ? insufficient<number>(
        missingPrice.length && missingCash.length
          ? 'PORTFOLIO_VALUE_INPUT_INCOMPLETE'
          : missingPrice.length
            ? 'MISSING_CURRENT_PRICE'
            : 'MISSING_CASH_BALANCE',
        totalMissing,
      )
    : available(knownValue);

  const totalForWeights = totalValue.status === 'available' && totalValue.value > 0 ? totalValue.value : null;
  const cashValue = input.cash == null
    ? insufficient<number>('MISSING_CASH_BALANCE', ['cash'])
    : available(input.cash);
  const cashWeight = input.cash == null
    ? insufficient<number>('MISSING_CASH_BALANCE', ['cash'])
    : totalForWeights == null
      ? insufficient<number>(totalValue.status === 'insufficient' ? totalValue.reason : 'ZERO_TOTAL_VALUE', totalMissing)
      : available((input.cash / totalForWeights) * 100);

  const missingAverageCost = input.positions
    .filter((position) => position.averageCost == null || !Number.isFinite(position.averageCost) || position.averageCost < 0)
    .map((position) => `${position.assetId}:averageCost`);
  let aggregatePnl = 0;
  let aggregateCost = 0;
  for (const position of input.positions) {
    if (position.currentPrice == null || position.averageCost == null) continue;
    if (!Number.isFinite(position.currentPrice) || !Number.isFinite(position.averageCost)) continue;
    aggregatePnl += pnlDirection(position) * position.quantity * (position.currentPrice - position.averageCost);
    aggregateCost += position.quantity * position.averageCost;
  }
  const pnlMissing = [...new Set([...missingPrice, ...missingAverageCost])];
  const unrealizedPnl = pnlMissing.length
    ? insufficient<number>('PNL_INPUT_INCOMPLETE', pnlMissing)
    : available(aggregatePnl);
  const returnPercent = pnlMissing.length
    ? insufficient<number>('RETURN_INPUT_INCOMPLETE', pnlMissing)
    : aggregateCost > 0
      ? available((aggregatePnl / aggregateCost) * 100)
      : insufficient<number>('ZERO_COST_BASIS');

  const risk = totalForWeights == null
    ? {
        volatilityPercent: insufficient<number>('TOTAL_VALUE_UNAVAILABLE', totalMissing),
        correlation: insufficient<number>('TOTAL_VALUE_UNAVAILABLE', totalMissing),
        contributions: new Map<string, Metric<number>>(),
        portfolioRiskScore: insufficient<number>('TOTAL_VALUE_UNAVAILABLE', totalMissing),
      }
    : calculateRisk(input.positions, totalForWeights, input);

  const positionResults: PositionAnalytics[] = input.positions.map((position) => {
    const value = positionValue(position);
    const costReady = position.averageCost != null && Number.isFinite(position.averageCost) && position.averageCost >= 0;
    const pnlReady = value != null && costReady;
    const pnl = pnlReady
      ? pnlDirection(position) * position.quantity * ((position.currentPrice as number) - (position.averageCost as number))
      : null;
    const cost = costReady ? position.quantity * (position.averageCost as number) : null;
    return {
      assetId: position.assetId,
      symbol: position.symbol,
      marketValue: value == null ? insufficient('MISSING_CURRENT_PRICE', [`${position.assetId}:price`]) : available(value),
      weight: value == null || totalForWeights == null
        ? insufficient('WEIGHT_INPUT_INCOMPLETE', [...new Set([`${position.assetId}:price`, ...missingCash])])
        : available((value / totalForWeights) * 100),
      unrealizedPnl: pnl == null ? insufficient('PNL_INPUT_INCOMPLETE') : available(pnl),
      returnPercent: pnl == null || cost == null || cost <= 0
        ? insufficient('RETURN_INPUT_INCOMPLETE')
        : available((pnl / cost) * 100),
      riskContributionPercent: risk.contributions.get(position.assetId) ?? insufficient('RISK_EVIDENCE_INCOMPLETE'),
    };
  });

  const concentration = missingPrice.length
    ? insufficient<number>('CONCENTRATION_INPUT_INCOMPLETE', missingPrice)
    : knownPositionValue <= 0
      ? insufficient<number>('NO_INVESTED_POSITIONS')
      : available(input.positions.reduce((sum, position) => {
          const value = positionValue(position) ?? 0;
          const investedWeight = value / knownPositionValue;
          return sum + investedWeight * investedWeight;
        }, 0));

  return {
    totalValue,
    knownValue,
    cashValue,
    cashWeight,
    marketExposure: totalForWeights == null
      ? insufficient('TOTAL_VALUE_UNAVAILABLE', totalMissing)
      : exposure(input.positions, totalForWeights, (position) => position.market),
    sectorExposure: totalForWeights == null
      ? insufficient('TOTAL_VALUE_UNAVAILABLE', totalMissing)
      : exposure(input.positions, totalForWeights, (position) => position.sector?.trim() || null),
    currencyExposure: totalForWeights == null
      ? insufficient('TOTAL_VALUE_UNAVAILABLE', totalMissing)
      : exposure(input.positions, totalForWeights, (position) => position.currency.trim().toUpperCase() || null),
    concentration,
    unrealizedPnl,
    returnPercent,
    volatilityPercent: risk.volatilityPercent,
    correlation: risk.correlation,
    portfolioRiskScore: risk.portfolioRiskScore,
    positions: positionResults,
    missing: [...new Set([...totalMissing, ...missingAverageCost])],
  };
}