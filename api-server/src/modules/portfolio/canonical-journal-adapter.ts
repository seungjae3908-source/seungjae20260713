import type {
  TradeCurrency,
  TradeMarket,
  UnifiedTradeCycle,
  UnifiedTradeJournalResult,
} from '../../services/unified-trade-journal.service.ts';
import { analyzePortfolio } from './analytics.ts';
import { buildPortfolioAdvisorContext, buildPortfolioAdvisorEnvelope } from './advisor-context.ts';
import { buildPortfolioScenario } from './scenario.ts';
import type { Metric, PortfolioMarket, Position } from './types.ts';

export const CANONICAL_PORTFOLIO_PRICE_MAX_AGE_MS = 2 * 60 * 1000;

const available = <T>(value: T): Metric<T> => ({ status: 'available', value });
const insufficient = <T>(reason: string, missing?: string[]): Metric<T> => ({
  status: 'insufficient',
  reason,
  ...(missing?.length ? { missing } : {}),
});

function portfolioMarket(market: TradeMarket): PortfolioMarket {
  if (market === 'KR_STOCK') return 'KR';
  if (market === 'US_STOCK') return 'US';
  if (market === 'CRYPTO_SPOT') return 'UPBIT';
  return 'BITGET';
}

function assetKey(cycle: UnifiedTradeCycle): string {
  return `${portfolioMarket(cycle.market)}:${cycle.symbol.trim().toUpperCase()}:${cycle.positionSide}:${cycle.currency}`;
}

function freshSnapshotPrice(cycle: UnifiedTradeCycle, nowMs: number): { price: number; capturedAt: string } | null {
  const snapshot = cycle.technicalSnapshot;
  if (snapshot.contextSource !== 'PRE_TRADE_SNAPSHOT') return null;
  if (snapshot.price == null || !Number.isFinite(snapshot.price) || snapshot.price <= 0) return null;
  if (!snapshot.capturedAt || !Number.isFinite(Date.parse(snapshot.capturedAt))) return null;
  const capturedMs = Date.parse(snapshot.capturedAt);
  const age = nowMs - capturedMs;
  if (age < 0 || age > CANONICAL_PORTFOLIO_PRICE_MAX_AGE_MS) return null;
  return { price: snapshot.price, capturedAt: snapshot.capturedAt };
}

type Group = {
  assetId: string;
  market: PortfolioMarket;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  currency: TradeCurrency;
  quantity: number;
  costNumerator: number;
  cycles: UnifiedTradeCycle[];
};

function canonicalPositions(journal: UnifiedTradeJournalResult, now: Date) {
  const groups = new Map<string, Group>();
  for (const cycle of journal.trades) {
    if (cycle.status !== 'OPEN' || !Number.isFinite(cycle.remainingQuantity) || cycle.remainingQuantity <= 0) continue;
    const key = assetKey(cycle);
    const existing = groups.get(key) ?? {
      assetId: key,
      market: portfolioMarket(cycle.market),
      symbol: cycle.symbol.trim().toUpperCase(),
      positionSide: cycle.positionSide,
      currency: cycle.currency,
      quantity: 0,
      costNumerator: 0,
      cycles: [],
    };
    existing.quantity += cycle.remainingQuantity;
    existing.costNumerator += cycle.remainingQuantity * cycle.entryPrice;
    existing.cycles.push(cycle);
    groups.set(key, existing);
  }

  const nowMs = now.getTime();
  const priceEvidence: Array<{
    assetId: string;
    status: 'fresh' | 'insufficient';
    price: number | null;
    capturedAt: string | null;
    reason: string | null;
  }> = [];
  const positions: Position[] = [];
  const groupEntries: Array<{ group: Group; currentPrice: number | null }> = [];

  for (const group of groups.values()) {
    const fresh = group.cycles
      .map((cycle) => freshSnapshotPrice(cycle, nowMs))
      .filter((value): value is { price: number; capturedAt: string } => value != null)
      .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0] ?? null;
    const currentPrice = fresh?.price ?? null;
    positions.push({
      assetId: group.assetId,
      market: group.market,
      symbol: group.symbol,
      positionSide: group.positionSide,
      quantity: group.quantity,
      averageCost: group.quantity > 0 ? group.costNumerator / group.quantity : null,
      currentPrice,
      currency: group.currency,
      sector: null,
    });
    priceEvidence.push({
      assetId: group.assetId,
      status: fresh ? 'fresh' : 'insufficient',
      price: currentPrice,
      capturedAt: fresh?.capturedAt ?? null,
      reason: fresh ? null : 'NO_FRESH_CANONICAL_PRICE_EVIDENCE',
    });
    groupEntries.push({ group, currentPrice });
  }

  return { positions, priceEvidence, groupEntries };
}

function openRiskByCurrency(
  groups: Array<{ group: Group; currentPrice: number | null }>,
): Metric<Record<string, number>> {
  const missing: string[] = [];
  const values: Record<string, number> = {};
  for (const { group, currentPrice } of groups) {
    if (currentPrice == null) {
      missing.push(`${group.assetId}:currentPrice`);
      continue;
    }
    for (const cycle of group.cycles) {
      const stop = cycle.stopLossPrice;
      if (stop == null || !Number.isFinite(stop) || stop <= 0) {
        missing.push(`${group.assetId}:stopLossPrice`);
        continue;
      }
      const perUnitRisk = cycle.positionSide === 'SHORT'
        ? Math.max(0, stop - currentPrice)
        : Math.max(0, currentPrice - stop);
      values[cycle.currency] = (values[cycle.currency] ?? 0) + perUnitRisk * cycle.remainingQuantity;
    }
  }
  return missing.length
    ? insufficient('OPEN_RISK_EVIDENCE_INCOMPLETE', [...new Set(missing)])
    : available(values);
}

function futuresGrossExposure(
  positions: Position[],
): Metric<number> {
  const futures = positions.filter((position) => position.market === 'BITGET');
  if (!futures.length) return available(0);
  const missing = futures.filter((position) => position.currentPrice == null).map((position) => `${position.assetId}:price`);
  if (missing.length) return insufficient('FUTURES_PRICE_EVIDENCE_INCOMPLETE', missing);
  return available(futures.reduce((sum, position) => sum + position.quantity * (position.currentPrice as number), 0));
}

export function buildCanonicalJournalPortfolioAdvisor(
  journal: UnifiedTradeJournalResult,
  now: Date,
) {
  const { positions, priceEvidence, groupEntries } = canonicalPositions(journal, now);
  const currencies = [...new Set(positions.map((position) => position.currency))];
  const analytics = analyzePortfolio({
    positions,
    cash: null,
    baseCurrency: currencies.length === 1 ? currencies[0] : 'MIXED',
  });

  const missing = [
    'cashEvidence',
    'annualizedVolatilityEvidence',
    'correlationEvidence',
    'sectorEvidence',
    'backtestScenarioEvidence',
    ...priceEvidence.filter((row) => row.status !== 'fresh').map((row) => `${row.assetId}:freshPrice`),
  ];
  const context = buildPortfolioAdvisorContext(analytics, positions, {
    backtestEvidence: { status: 'insufficient', reason: 'BACKTEST_EVIDENCE_NOT_IN_CANONICAL_JOURNAL' },
    marketContext: { priceEvidence },
    missing,
  });
  const scenario = buildPortfolioScenario({
    strategyVersion: 'CANONICAL_JOURNAL_NO_BACKTEST_EVIDENCE',
    sampleSize: null,
    oosPassed: null,
    walkForwardPassed: null,
    maxDrawdownPercent: null,
    expectancy: null,
    profitFactor: null,
    confidence: null,
    costStressPassed: null,
    validatedScenarioReturnsPercent: null,
  }, {
    minSampleSize: 1,
    requireOos: true,
    requireWalkForward: true,
    requireCostStress: true,
  });

  return {
    sourceOfTruth: 'PAPER_JOURNAL_UNIFIED_LEDGER' as const,
    canonicalJournalSource: true as const,
    independentPortfolioStorage: false as const,
    duplicatePortfolioEngine: false as const,
    duplicateAiRoute: false as const,
    positions,
    analytics,
    stateEvidence: {
      cash: analytics.cashValue,
      realizedPnlByCurrency: available(journal.analytics.netPnlByCurrency),
      openRiskByCurrency: openRiskByCurrency(groupEntries),
      futuresGrossExposure: futuresGrossExposure(positions),
      leverageExposure: insufficient<number>('LEVERAGE_EVIDENCE_NOT_IN_CANONICAL_JOURNAL'),
      priceEvidence,
      journalIntegrityIssues: journal.integrityIssues,
    },
    scenario,
    deterministicProposal: {
      status: 'INSUFFICIENT' as const,
      action: 'INSUFFICIENT' as const,
      reason: 'CANONICAL_CANDIDATE_AND_POLICY_EVIDENCE_NOT_AVAILABLE',
    },
    advisor: buildPortfolioAdvisorEnvelope(context, false),
    safety: {
      actualOrderRequests: 0 as const,
      cancelRequests: 0 as const,
      amendRequests: 0 as const,
      privateTradingApiRequests: 0 as const,
      orderAuthority: 'none' as const,
    },
  };
}