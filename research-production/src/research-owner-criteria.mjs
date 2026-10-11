/** Human-approved research/Paper criteria. Not market evidence or deployment authority. */
export const RESEARCH_OWNER_CRITERIA_VERSION = 'research-owner-criteria-v1';
const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);

export function researchOwnerMarketCriteria(market, direction) {
  const futures = market === 'CRYPTO_FUTURES';
  if ((!futures && !CASH_MARKETS.has(market)) || !['LONG', 'SHORT'].includes(direction)
    || (!futures && direction !== 'LONG')) throw new Error('OWNER_RESEARCH_DIRECTION_NOT_APPROVED');
  return Object.freeze({
    contract: RESEARCH_OWNER_CRITERIA_VERSION,
    market, direction,
    requestedLeverage: futures ? 7 : 1,
    maximumLeverage: futures ? 7 : 1,
    initialCapitalKrwForNewAccountOnly: 1_000_000,
    maximumMarginCapitalFraction: 0.25,
    maximumCapitalRiskFraction: 0.005,
    maximumConcurrentPositions: 1,
    stopPriceDistanceFraction: 0.01,
    timeframe: '15m', fastEmaPeriod: 20, slowEmaPeriod: 60, timeExitBars: 4,
    entryOperator: direction === 'SHORT' ? 'CROSSUNDER' : 'CROSSOVER',
    parameterSearchAllowed: false,
    researchOnly: true, liveTrading: false, privateApi: false, orderAllowed: false,
    executionAuthority: 'NONE', economicEvidenceCredit: 0,
    canonicalRuntimeAdmissionRequired: true,
  });
}

/** A bound for planning, never an executable quantity or risk-sizing receipt.
 * The canonical sizing owner must additionally check fees, FX, lot sizes,
 * margin/contract rules, current account state and stricter existing limits. */
export function researchOwnerExposureBounds(market, direction, capitalKrw) {
  const criteria = researchOwnerMarketCriteria(market, direction);
  if (!Number.isFinite(capitalKrw) || capitalKrw <= 0) throw new Error('OWNER_RESEARCH_CAPITAL_INVALID');
  const maximumRiskKrw = capitalKrw * criteria.maximumCapitalRiskFraction;
  const maximumNotionalKrw = Math.min(
    capitalKrw * criteria.maximumMarginCapitalFraction * criteria.requestedLeverage,
    maximumRiskKrw / criteria.stopPriceDistanceFraction,
  );
  return Object.freeze({
    criteriaVersion: RESEARCH_OWNER_CRITERIA_VERSION,
    maximumRiskKrw,
    maximumNotionalKrw,
    maximumMarginKrw: maximumNotionalKrw / criteria.requestedLeverage,
    feesAndSlippageNotIncluded: true,
    isExecutableSizingReceipt: false,
    executionAuthority: 'NONE',
  });
}

/** Exact approved reference input for the existing DSL validator. This does not
 * mint a FormulaCandidate, data/cost receipt, backtest result or Paper admission. */
export function buildOwnerApprovedReferenceDsl(market, direction) {
  const criteria = researchOwnerMarketCriteria(market, direction);
  const fixed = (name, domain, value, valueType = 'INTEGER') => ({
    name, domain, valueType, min: value, max: value, step: valueType === 'INTEGER' ? 1 : value,
  });
  return {
    market, timeframe: criteria.timeframe, direction, availableDataFields: ['close'],
    entryDsl: { action: direction, rules: [{ kind: 'OPERATOR', operator: criteria.entryOperator, operands: [
      { kind: 'INDICATOR', name: 'EMA', input: 'close', parameters: { period: 'fast' } },
      { kind: 'INDICATOR', name: 'EMA', input: 'close', parameters: { period: 'slow' } },
    ] }] },
    exitDsl: { rules: [
      { type: 'FIXED_STOP', distanceParameter: 'stop' },
      { type: 'TIME_EXIT', barsParameter: 'holding' },
    ] },
    parameterSpace: [fixed('fast', 'PERIOD', criteria.fastEmaPeriod), fixed('slow', 'PERIOD', criteria.slowEmaPeriod),
      fixed('holding', 'BAR_COUNT', criteria.timeExitBars), fixed('stop', 'PRICE_FRACTION', criteria.stopPriceDistanceFraction, 'NUMBER')],
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
}
