import type { Intelligence, AdditionalBuyResponse, MonthlyResponse } from '../pages/portfolio-v2';
import { evidenceInstant, evidenceNumber, evidenceRecord } from './server-evidence';

const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const nullableNumber = (value: unknown) => value === null || evidenceNumber(value);
const numberFields: Record<string, string[]> = {
  totalAssets: ['normalizedKRW', 'knownNormalizedKRW'], investmentPrincipal: ['normalizedKRW', 'knownNormalizedKRW'],
  valuationPnl: ['normalizedKRW', 'returnPercent'], cash: ['totalKRW'], minimumCashBuffer: ['normalizedKRW'],
  investableCash: ['normalizedKRW'], top5Concentration: ['percent'],
};

export function parsePortfolioIntelligence(value: unknown, now = Date.now()): Intelligence {
  if (!evidenceRecord(value) || value.ok !== true || !evidenceRecord(value.portfolio)) throw new Error('PORTFOLIO_RESPONSE_INVALID');
  const data = value.portfolio;
  if (typeof data.status !== 'string' || !['READY', 'PARTIAL', 'UNAVAILABLE'].includes(data.status) || !evidenceInstant(data.asOf, now)
    || now - Date.parse(data.asOf) > 120_000) throw new Error('PORTFOLIO_EVIDENCE_STALE_OR_INVALID');
  for (const [key, fields] of Object.entries(numberFields)) {
    const group = data[key];
    if (!evidenceRecord(group) || !text(group.status) || !fields.every((field) => nullableNumber(group[field]))) throw new Error('PORTFOLIO_METRICS_INVALID');
  }
  const assets = data.assets;
  if (!evidenceRecord(assets) || !['krStocks', 'usStocks', 'cryptoSpot', 'cryptoFuturesEquity', 'cash'].every((key) => nullableNumber(assets[key]))
    || !evidenceRecord(data.allocation) || !nullableNumber(data.allocation.knownTotalKRW) || !evidenceRecord(data.allocation.buckets)
    || !Object.values(data.allocation.buckets).every(nullableNumber)) throw new Error('PORTFOLIO_ALLOCATION_INVALID');
  const validateHolding = (row: unknown) => evidenceRecord(row) && text(row.id) && text(row.ticker) && text(row.name)
    && typeof row.market === 'string' && ['KR', 'US'].includes(row.market) && row.currency === (row.market === 'KR' ? 'KRW' : 'USD')
    && ['quantity', 'averagePrice', 'currentPrice', 'nativeValue'].every((key) => evidenceNumber(row[key]) && row[key] > 0)
    && nullableNumber(row.normalizedKRW) && evidenceInstant(row.asOf, now) && now - Date.parse(row.asOf) <= 300_000 && text(row.source);
  if (!Array.isArray(data.holdings) || !data.holdings.every(validateHolding) || !Array.isArray(data.topHoldings) || !data.topHoldings.every(validateHolding)) throw new Error('PORTFOLIO_HOLDINGS_INVALID');
  const holdings = data.holdings as Array<Record<string, unknown>>;
  if (new Set(holdings.map((row) => row.id)).size !== holdings.length
    || !(data.topHoldings as Array<Record<string, unknown>>).every((row) => holdings.some((known) => known.id === row.id && known.ticker === row.ticker && known.normalizedKRW === row.normalizedKRW))) throw new Error('PORTFOLIO_IDENTITY_INVALID');
  const quality = data.dataQuality;
  if (!evidenceRecord(quality) || !text(quality.status) || !['providerCount', 'includedProviderCount', 'invalidHoldingRows'].every((key) => evidenceNumber(quality[key]) && Number.isInteger(quality[key]) && quality[key] >= 0)
    || Number(quality.includedProviderCount) > Number(quality.providerCount)) throw new Error('PORTFOLIO_DATA_QUALITY_INVALID');
  const correlation = data.correlation;
  const risk = data.riskClassification;
  const policy = data.allocationPolicy;
  if (!evidenceRecord(correlation) || !text(correlation.status) || !evidenceNumber(correlation.sampleSize) || !nullableNumber(correlation.correlation)
    || !Array.isArray(correlation.pair) || !correlation.pair.every(text)
    || !evidenceRecord(risk) || !text(risk.status) || !text(risk.reason) || !(risk.level === null || text(risk.level))
    || !evidenceRecord(policy) || !text(policy.status) || !text(policy.profile) || !Array.isArray(policy.comparison)
    || !policy.comparison.every((row) => evidenceRecord(row) && text(row.assetClass) && text(row.state)
      && nullableNumber(row.currentPercent) && evidenceNumber(row.minPercent) && evidenceNumber(row.maxPercent))) throw new Error('PORTFOLIO_ANALYSIS_INVALID');
  const fx = data.fx;
  if (!evidenceRecord(fx) || !text(fx.status) || !Array.isArray(fx.quotes) || !fx.quotes.every((row) => evidenceRecord(row)
    && evidenceNumber(row.rate) && row.rate > 0 && typeof row.pair === 'string' && ['USD/KRW', 'USDT/KRW'].includes(row.pair) && text(row.source)
    && text(row.quality) && evidenceInstant(row.asOf, now))
    || !Array.isArray(data.missingSources) || !data.missingSources.every(text)) throw new Error('PORTFOLIO_SOURCES_INVALID');
  return data as unknown as Intelligence;
}

function simulationEnvelope(value: unknown): asserts value is Record<string, unknown> {
  if (!evidenceRecord(value) || value.ok !== true || !text(value.status)
    || !evidenceInstant(value.asOf, Date.now()) || Date.now() - Date.parse(value.asOf) > 120_000) throw new Error('SIMULATION_RESPONSE_INVALID');
}

export function parseMonthlyPlan(value: unknown, input: { monthlyAmountKRW: number; months: number; profile: string }): MonthlyResponse {
  simulationEnvelope(value);
  if (value.assumption !== 'NO_VALIDATED_RETURN_ASSUMPTION' || value.allocationBasis !== 'CURRENT_KNOWN_ALLOCATION'
    || value.profileForPolicyComparison !== input.profile || value.profileUsedForAllocation !== false
    || !nullableNumber(value.allocationKnownTotalKRW) || !Array.isArray(value.unavailableOutputs) || !value.unavailableOutputs.every(text)) throw new Error('SIMULATION_AUTHORITY_INVALID');
  const plan = value.plan;
  if (plan !== null && (!evidenceRecord(plan) || plan.monthlyAmountKRW !== input.monthlyAmountKRW || plan.months !== input.months
    || plan.cumulativeInvestmentKRW !== input.monthlyAmountKRW * input.months || !evidenceNumber(plan.cumulativeInvestmentKRW)
    || !Array.isArray(plan.allocations) || !plan.allocations.every((row) => evidenceRecord(row) && text(row.key)
      && evidenceNumber(row.weight) && row.weight >= 0 && row.weight <= 1 && evidenceNumber(row.cumulativeContributionKRW)))) throw new Error('SIMULATION_PLAN_INVALID');
  if (evidenceRecord(plan) && Array.isArray(plan.allocations)) {
    const rows = plan.allocations as Array<{ key: string; weight: number; cumulativeContributionKRW: number }>;
    const total = input.monthlyAmountKRW * input.months;
    if (!rows.length || new Set(rows.map((row) => row.key)).size !== rows.length
      || Math.abs(rows.reduce((sum, row) => sum + row.weight, 0) - 1) > 1e-8
      || rows.some((row) => Math.abs(row.cumulativeContributionKRW - total * row.weight) > Math.max(1e-6, total * 1e-10))) throw new Error('SIMULATION_ALLOCATION_INVALID');
  }
  return value as unknown as MonthlyResponse;
}

export function parseAdditionalBuy(value: unknown, holding: { ticker: string; market: string; currency: string }): AdditionalBuyResponse {
  simulationEnvelope(value);
  const facts = value.holding;
  const result = value.result;
  const evidence = value.evidence;
  if (value.priceBasis !== 'NORMALIZED_KRW' || !evidenceRecord(facts) || facts.ticker !== holding.ticker
    || facts.market !== holding.market || facts.nativeCurrency !== holding.currency
    || !['currentAveragePriceNative', 'currentPriceNative'].every((key) => evidenceNumber(facts[key]) && facts[key] > 0)
    || !nullableNumber(facts.currentPositionValueKRW) || !evidenceRecord(result)
    || !['additionalQuantity', 'additionalInvestmentKRW', 'newAveragePrice', 'currentWeightPercent', 'projectedWeightPercent'].every((key) => nullableNumber(result[key]))
    || result.stopLoss !== null || result.estimatedMaxLossKRW !== null || !Array.isArray(result.targets) || result.targets.length !== 0
    || !Array.isArray(result.targetProfitsKRW) || result.targetProfitsKRW.length !== 0
    || !Array.isArray(result.missing) || !result.missing.every(text)
    || !evidenceRecord(evidence) || evidence.stopLoss !== 'UNAVAILABLE' || evidence.targets !== 'UNAVAILABLE' || evidence.source !== null) throw new Error('SIMULATION_EVIDENCE_INVALID');
  return value as unknown as AdditionalBuyResponse;
}
