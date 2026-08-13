import type {
  TradeMarket,
  TradeSource,
  UnifiedTradeCycle,
  UnifiedTradeJournalResult,
} from '../../services/unified-trade-journal.service.ts';

export const AUTONOMOUS_CAPITAL_LAB_MODE = 'autonomous-paper-shadow-capital-lab' as const;
export const AUTONOMOUS_CAPITAL_LAB_INITIAL_KRW = 1_000_000 as const;

export const CAPITAL_LAB_RESEARCH_SOURCES = ['APP_PAPER', 'APP_SHADOW'] as const satisfies readonly TradeSource[];
export const CAPITAL_LAB_MARKETS = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const satisfies readonly TradeMarket[];

export type CapitalLabMarket = typeof CAPITAL_LAB_MARKETS[number];
export type CapitalLabEvidenceStatus = 'INSUFFICIENT' | 'EARLY' | 'VALIDATING' | 'EVIDENCE_READY';
export type CapitalLabStrategyStatus = 'INSUFFICIENT' | 'RESEARCH' | 'CANDIDATE' | 'CHAMPION_ELIGIBLE';

type LaneMetrics = {
  sampleSize: number;
  paperTrades: number;
  shadowTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageReturnPercent: number | null;
  profitFactor: number | null;
  maximumDrawdownPercent: number | null;
  ruleViolationRate: number | null;
  preTradeContextRate: number | null;
};

export type CapitalLabLane = LaneMetrics & {
  market: CapitalLabMarket;
  evidenceStatus: CapitalLabEvidenceStatus;
  confidence: number;
  researchScore: number;
  allocationWeight: number;
  allocationKrw: number;
  activeStrategies: string[];
  warnings: string[];
};

export type CapitalLabStrategyRow = LaneMetrics & {
  market: CapitalLabMarket;
  strategy: string;
  status: CapitalLabStrategyStatus;
  confidence: number;
  researchScore: number;
  promotionAuthority: 'none';
};

const EPSILON = 1e-9;
const RESEARCH_SOURCES = new Set<TradeSource>(CAPITAL_LAB_RESEARCH_SOURCES);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteReturn(cycle: UnifiedTradeCycle): number | null {
  return cycle.netReturnPercent != null && Number.isFinite(cycle.netReturnPercent)
    ? cycle.netReturnPercent
    : null;
}

function closedResearchCycles(journal: UnifiedTradeJournalResult): UnifiedTradeCycle[] {
  return journal.trades.filter((cycle) => (
    cycle.status === 'CLOSED'
    && RESEARCH_SOURCES.has(cycle.source)
    && finiteReturn(cycle) != null
  ));
}

function maximumDrawdownPercent(cycles: UnifiedTradeCycle[]): number | null {
  const returns = [...cycles]
    .sort((left, right) => Date.parse(left.closedAt ?? left.openedAt) - Date.parse(right.closedAt ?? right.openedAt))
    .map(finiteReturn)
    .filter((value): value is number => value != null);
  if (!returns.length) return null;

  let equityIndex = 1;
  let peak = 1;
  let maximumDrawdown = 0;
  for (const value of returns) {
    const boundedReturn = clamp(value, -99, 500);
    equityIndex *= 1 + boundedReturn / 100;
    peak = Math.max(peak, equityIndex);
    if (peak > 0) maximumDrawdown = Math.max(maximumDrawdown, ((peak - equityIndex) / peak) * 100);
  }
  return maximumDrawdown;
}

function laneMetrics(cycles: UnifiedTradeCycle[]): LaneMetrics {
  const returns = cycles.map(finiteReturn).filter((value): value is number => value != null);
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  const gains = positive.reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(negative.reduce((sum, value) => sum + value, 0));
  const ruleViolations = cycles.filter((cycle) => cycle.ruleViolation).length;
  const preTradeContext = cycles.filter((cycle) => cycle.technicalSnapshot.contextSource === 'PRE_TRADE_SNAPSHOT').length;

  return {
    sampleSize: returns.length,
    paperTrades: cycles.filter((cycle) => cycle.source === 'APP_PAPER').length,
    shadowTrades: cycles.filter((cycle) => cycle.source === 'APP_SHADOW').length,
    wins: positive.length,
    losses: negative.length,
    winRate: returns.length ? positive.length / returns.length : null,
    averageReturnPercent: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    profitFactor: losses > EPSILON ? gains / losses : gains > EPSILON ? null : null,
    maximumDrawdownPercent: maximumDrawdownPercent(cycles),
    ruleViolationRate: returns.length ? ruleViolations / returns.length : null,
    preTradeContextRate: returns.length ? preTradeContext / returns.length : null,
  };
}

function evidenceStatus(sampleSize: number): CapitalLabEvidenceStatus {
  if (sampleSize < 5) return 'INSUFFICIENT';
  if (sampleSize < 15) return 'EARLY';
  if (sampleSize < 30) return 'VALIDATING';
  return 'EVIDENCE_READY';
}

function confidence(sampleSize: number): number {
  return clamp(sampleSize / 30, 0, 1);
}

function researchScore(metrics: LaneMetrics): number {
  if (!metrics.sampleSize) return 0.5;
  const sampleConfidence = confidence(metrics.sampleSize);
  const averageReturn = metrics.averageReturnPercent ?? 0;
  const winRate = metrics.winRate ?? 0.5;
  const profitFactor = metrics.profitFactor ?? (metrics.losses === 0 && metrics.wins > 0 ? 2 : 1);
  const drawdown = metrics.maximumDrawdownPercent ?? 0;
  const violationRate = metrics.ruleViolationRate ?? 0;
  const contextRate = metrics.preTradeContextRate ?? 0;

  const raw = 0.5
    + clamp(averageReturn / 20, -0.2, 0.2)
    + clamp((winRate - 0.5) * 0.35, -0.15, 0.15)
    + clamp((profitFactor - 1) * 0.08, -0.12, 0.12)
    - clamp(drawdown / 100, 0, 0.2)
    - clamp(violationRate * 0.25, 0, 0.15)
    + clamp((contextRate - 0.5) * 0.08, -0.04, 0.04);

  return clamp(0.5 + (clamp(raw, 0.05, 0.95) - 0.5) * sampleConfidence, 0.05, 0.95);
}

function reserveRate(cycles: UnifiedTradeCycle[], laneScores: number[]): number {
  if (cycles.length < 10) return 0.30;
  if (cycles.length < 30) return 0.25;
  const averageScore = laneScores.reduce((sum, value) => sum + value, 0) / Math.max(1, laneScores.length);
  const overallDrawdown = maximumDrawdownPercent(cycles) ?? 0;
  if (averageScore >= 0.62 && overallDrawdown <= 10) return 0.15;
  if (averageScore < 0.48 || overallDrawdown >= 20) return 0.30;
  return 0.20;
}

const LANE_FLOORS: Record<CapitalLabMarket, number> = {
  KR_STOCK: 0.15,
  US_STOCK: 0.15,
  CRYPTO_SPOT: 0.15,
  CRYPTO_FUTURES: 0.10,
};

const LANE_CAPS: Record<CapitalLabMarket, number> = {
  KR_STOCK: 0.35,
  US_STOCK: 0.35,
  CRYPTO_SPOT: 0.35,
  CRYPTO_FUTURES: 0.25,
};

function boundedLaneWeights(scores: Record<CapitalLabMarket, number>): Record<CapitalLabMarket, number> {
  const weights = Object.fromEntries(CAPITAL_LAB_MARKETS.map((market) => [market, LANE_FLOORS[market]])) as Record<CapitalLabMarket, number>;
  let remaining = 1 - CAPITAL_LAB_MARKETS.reduce((sum, market) => sum + weights[market], 0);
  let eligible = [...CAPITAL_LAB_MARKETS];

  for (let pass = 0; pass < CAPITAL_LAB_MARKETS.length + 2 && remaining > EPSILON && eligible.length; pass += 1) {
    const scoreTotal = eligible.reduce((sum, market) => sum + Math.max(0.05, scores[market]), 0);
    let distributed = 0;
    const nextEligible: CapitalLabMarket[] = [];
    for (const market of eligible) {
      const share = remaining * (Math.max(0.05, scores[market]) / scoreTotal);
      const capacity = Math.max(0, LANE_CAPS[market] - weights[market]);
      const addition = Math.min(share, capacity);
      weights[market] += addition;
      distributed += addition;
      if (capacity - addition > EPSILON) nextEligible.push(market);
    }
    remaining -= distributed;
    eligible = nextEligible;
    if (distributed <= EPSILON) break;
  }

  if (remaining > EPSILON) {
    for (const market of CAPITAL_LAB_MARKETS) {
      const capacity = LANE_CAPS[market] - weights[market];
      const addition = Math.min(remaining, Math.max(0, capacity));
      weights[market] += addition;
      remaining -= addition;
      if (remaining <= EPSILON) break;
    }
  }

  const total = CAPITAL_LAB_MARKETS.reduce((sum, market) => sum + weights[market], 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error('CAPITAL_LAB_WEIGHT_INVARIANT');
  return weights;
}

function allocateWon(deployableKrw: number, weights: Record<CapitalLabMarket, number>): Record<CapitalLabMarket, number> {
  const allocation = Object.fromEntries(CAPITAL_LAB_MARKETS.map((market) => [market, Math.floor(deployableKrw * weights[market])])) as Record<CapitalLabMarket, number>;
  const used = CAPITAL_LAB_MARKETS.reduce((sum, market) => sum + allocation[market], 0);
  allocation[CAPITAL_LAB_MARKETS[0]] += deployableKrw - used;
  return allocation;
}

function strategyStatus(metrics: LaneMetrics): CapitalLabStrategyStatus {
  if (metrics.sampleSize < 5) return 'INSUFFICIENT';
  const positive = (metrics.averageReturnPercent ?? 0) > 0 && (metrics.profitFactor ?? 0) >= 1;
  if (metrics.sampleSize < 15 || !positive) return 'RESEARCH';
  const championEvidence = metrics.sampleSize >= 30
    && metrics.paperTrades >= 10
    && metrics.shadowTrades >= 10
    && (metrics.profitFactor ?? 0) >= 1.2
    && (metrics.maximumDrawdownPercent ?? Number.POSITIVE_INFINITY) <= 15
    && (metrics.ruleViolationRate ?? 1) <= 0.05;
  return championEvidence ? 'CHAMPION_ELIGIBLE' : 'CANDIDATE';
}

function strategyLeaderboard(cycles: UnifiedTradeCycle[]): CapitalLabStrategyRow[] {
  const groups = new Map<string, { market: CapitalLabMarket; strategy: string; cycles: UnifiedTradeCycle[] }>();
  for (const cycle of cycles) {
    const market = cycle.market as CapitalLabMarket;
    const strategy = cycle.strategy?.trim() || 'UNSPECIFIED';
    const key = `${market}:${strategy}`;
    const group = groups.get(key) ?? { market, strategy, cycles: [] };
    group.cycles.push(cycle);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const metrics = laneMetrics(group.cycles);
      return {
        market: group.market,
        strategy: group.strategy,
        ...metrics,
        status: strategyStatus(metrics),
        confidence: confidence(metrics.sampleSize),
        researchScore: researchScore(metrics),
        promotionAuthority: 'none' as const,
      };
    })
    .sort((left, right) => right.researchScore - left.researchScore || right.sampleSize - left.sampleSize || left.strategy.localeCompare(right.strategy));
}

function laneWarnings(metrics: LaneMetrics): string[] {
  const warnings: string[] = [];
  if (metrics.sampleSize < 5) warnings.push('INSUFFICIENT_RESEARCH_SAMPLE');
  if (metrics.paperTrades === 0) warnings.push('NO_PAPER_EVIDENCE');
  if (metrics.shadowTrades === 0) warnings.push('NO_SHADOW_EVIDENCE');
  if ((metrics.preTradeContextRate ?? 0) < 0.8 && metrics.sampleSize > 0) warnings.push('PRE_TRADE_CONTEXT_COVERAGE_LOW');
  if ((metrics.ruleViolationRate ?? 0) > 0.05) warnings.push('RULE_VIOLATION_RATE_HIGH');
  if ((metrics.maximumDrawdownPercent ?? 0) > 20) warnings.push('RESEARCH_DRAWDOWN_HIGH');
  return warnings;
}

export function buildAutonomousCapitalLab(journal: UnifiedTradeJournalResult, now: Date) {
  const researchCycles = closedResearchCycles(journal);
  const openResearchTrades = journal.trades.filter((cycle) => cycle.status === 'OPEN' && RESEARCH_SOURCES.has(cycle.source)).length;
  const ignoredNonResearchTrades = journal.trades.filter((cycle) => !RESEARCH_SOURCES.has(cycle.source)).length;

  const metricsByMarket = Object.fromEntries(CAPITAL_LAB_MARKETS.map((market) => {
    const metrics = laneMetrics(researchCycles.filter((cycle) => cycle.market === market));
    return [market, metrics];
  })) as Record<CapitalLabMarket, LaneMetrics>;
  const scores = Object.fromEntries(CAPITAL_LAB_MARKETS.map((market) => [market, researchScore(metricsByMarket[market])])) as Record<CapitalLabMarket, number>;
  const reservePercent = reserveRate(researchCycles, Object.values(scores));
  const reserveKrw = Math.round(AUTONOMOUS_CAPITAL_LAB_INITIAL_KRW * reservePercent);
  const deployableKrw = AUTONOMOUS_CAPITAL_LAB_INITIAL_KRW - reserveKrw;
  const weights = boundedLaneWeights(scores);
  const allocations = allocateWon(deployableKrw, weights);
  const leaderboard = strategyLeaderboard(researchCycles);

  const lanes: CapitalLabLane[] = CAPITAL_LAB_MARKETS.map((market) => {
    const metrics = metricsByMarket[market];
    return {
      market,
      ...metrics,
      evidenceStatus: evidenceStatus(metrics.sampleSize),
      confidence: confidence(metrics.sampleSize),
      researchScore: scores[market],
      allocationWeight: weights[market],
      allocationKrw: allocations[market],
      activeStrategies: leaderboard.filter((row) => row.market === market).slice(0, 5).map((row) => row.strategy),
      warnings: laneWarnings(metrics),
    };
  });

  const allocatedKrw = lanes.reduce((sum, lane) => sum + lane.allocationKrw, 0);
  const eligibleChampions = leaderboard.filter((row) => row.status === 'CHAMPION_ELIGIBLE');

  return {
    mode: AUTONOMOUS_CAPITAL_LAB_MODE,
    generatedAt: now.toISOString(),
    sourceOfTruth: 'PAPER_JOURNAL_UNIFIED_LEDGER' as const,
    researchOnly: true as const,
    fixedInitialCapital: true as const,
    capital: {
      currency: 'KRW' as const,
      initialCapitalKrw: AUTONOMOUS_CAPITAL_LAB_INITIAL_KRW,
      reserveRate: reservePercent,
      reserveKrw,
      deployableKrw,
      allocatedKrw,
      invariantKrw: reserveKrw + allocatedKrw,
    },
    journalCoverage: {
      acceptedSources: [...CAPITAL_LAB_RESEARCH_SOURCES],
      closedResearchTrades: researchCycles.length,
      openResearchTrades,
      ignoredNonResearchTrades,
      integrityIssues: journal.integrityIssues.length,
    },
    lanes,
    strategyLeaderboard: leaderboard,
    championCandidates: eligibleChampions,
    autonomousPolicy: {
      objective: 'MAXIMIZE_COST_ADJUSTED_RESEARCH_CAPITAL_WITH_DRAWDOWN_CONTROL' as const,
      rebalanceInput: 'CLOSED_PAPER_AND_SHADOW_JOURNAL_ONLY' as const,
      adaptiveAllocation: true as const,
      minimumEvidenceForEarlySignal: 5 as const,
      minimumEvidenceForCandidate: 15 as const,
      minimumEvidenceForChampionEligibility: 30 as const,
      championRequiresPaperAndShadow: true as const,
      livePromotionAllowed: false as const,
      strategyMutationAllowed: false as const,
      orderAuthority: 'none' as const,
    },
    safety: {
      actualOrderRequests: 0 as const,
      cancelRequests: 0 as const,
      amendRequests: 0 as const,
      transferRequests: 0 as const,
      withdrawalRequests: 0 as const,
      privateBrokerRequests: 0 as const,
      privateTradingApiRequests: 0 as const,
      externalAiCalled: false as const,
      orderSubmitted: false as const,
      exchangeRequestSent: false as const,
      orderAuthority: 'none' as const,
    },
  };
}
