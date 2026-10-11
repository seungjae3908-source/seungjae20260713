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
