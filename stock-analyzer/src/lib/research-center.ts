import { authorizedFetch } from '@/lib/auth-fetch';

export type ResearchCycleProfile = 'forward' | 'fast-historical' | 'long-history';

export interface ResearchCycleTask {
  id: string;
  status: string;
  durationMs: number | null;
  startedAt: number | null;
  endedAt: number | null;
  timedOut: boolean;
}

export interface ResearchCycleSummary {
  profile: ResearchCycleProfile;
  present: boolean;
  status: string;
  cycleId?: string | null;
  researchSha?: string | null;
  generatedAt?: number | null;
  concurrency?: number | null;
  taskCount: number | null;
  successCount: number | null;
  blockedDataCount: number | null;
  failedCount: number | null;
  tasks: ResearchCycleTask[];
}

export interface ResearchTemporalCryptoSummary {
  present: boolean;
  status: 'MISSING' | 'INVALID' | 'complete' | 'partial_failure';
  generatedAt: number | null;
  researchSha: string | null;
  failedCount: number | null;
  observationCount: number | null;
  ledgerDigest: string | null;
  results: Array<{
    symbol: string;
    status: 'success' | 'failed';
    observedCount: number;
    appendedCount: number;
  }>;
}

export interface ResearchPaperRuntime {
  present: boolean;
  status: string;
  cycleId?: string | null;
  scheduleActive?: boolean | null;
  allProvidersReady?: boolean | null;
  publicForwardEvidenceAccumulating?: boolean | null;
  paperTradeOutcomeAccumulating?: boolean | null;
  privateRequestCount: number | null;
  financialMutationCount: number | null;
  orderCount: number | null;
  liveTrading: boolean | null;
  orderAuthority: boolean | null;
  safetyEvidenceComplete: boolean;
  lanes: Array<{ market: string; status: string }>;
}

export interface ResearchPaperLedger {
  present: boolean;
  cycleCount: number | null;
  sampleCount?: number | null;
  positionCount: number | null;
  settlementCount: number | null;
}

export interface ResearchCandidatePerformance {
  present: boolean;
  status: 'MISSING' | 'INVALID' | 'BLOCKED' | 'PRESENT';
  schemaVersion: 'frozen-candidate-performance-reader-v1' | null;
  FIRST_ZERO: string;
  reason: string;
  candidateId: string | null;
  strategyId: string | null;
  freezeTimestamp: string | null;
  identity14Verified: boolean;
  fullCostEvidence: {
    fullCostReady: false;
    components: Record<
      'commission' | 'tax' | 'spread' | 'slippage' | 'funding' | 'latency' | 'liquidityImpact' | 'partialFillImpact',
      { state: 'MEASURED' | 'MODELED' | 'UNKNOWN' | 'BLOCKED_DATA'; valuePercent: number | null; provenance: string | null }
    >;
  };
  effectiveIndependentMarketN: number | null;
  candidateMatchedN: number | null;
  LONG_SIGNAL_N: number | null;
  SHORT_SIGNAL_N: number | null;
  NO_TRADE_N: number | null;
  Entry_N: number | null;
  Position_N: number | null;
  PositionObservation_N: number | null;
  Settlement_N: number | null;
  TRAIN_N: number | null;
  VALIDATION_N: number | null;
  OOS_N: number | null;
  WIN_N: number | null;
  LOSS_N: number | null;
  BREAKEVEN_N: number | null;
  WIN_RATE: number | null;
  AVG_WIN: number | null;
  AVG_LOSS: number | null;
  PAYOFF_RATIO: number | null;
  GROSS_EXPECTANCY: number | null;
  PF: number | null;
  MDD: number | null;
  MFE: number | null;
  MAE: number | null;
  TIME_TO_EXIT: number | null;
  Gross_PnL: number | null;
  Net_PnL: number | null;
  FULL_COST_READY: false;
  NET_ALPHA_PROVEN: false;
  PROFITABILITY_PROVEN: false;
  TRAIN_DIAGNOSTIC_ONLY: true;
  VALIDATION_COMPLETE: false;
  OOS_COMPLETE: false;
  executionAuthority: 'NONE';
}

export interface ResearchShadowGroup {
  name: string;
  total: number | null;
  settled: number | null;
  pending: number | null;
  collapsed: boolean | null;
  macroF1: number | null;
  balancedAccuracy: number | null;
  bullRecall?: number | null;
  bearRecall?: number | null;
  neutralRecall?: number | null;
}

export type StrategyHealthBindingStatus = 'HEALTHY' | 'WATCH' | 'FAIL' | 'MISSING_EVIDENCE';

export interface StrategyHealthEvidenceInput {
  status: StrategyHealthBindingStatus;
  reason: string;
  source: string;
  observedCount: number | null;
}

export interface StrategyHealthBinding {
  status: StrategyHealthBindingStatus;
  evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth';
  canonicalCoreStatus: 'INSUFFICIENT_DATA' | 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL' | null;
  inputs: Record<string, StrategyHealthEvidenceInput>;
  reasons: string[];
  executionAuthority: 'NONE';
}

export interface ResearchFactoryRuntimeSummary {
  present: boolean;
  status: 'MISSING' | 'INVALID' | 'BLOCKED_POLICY_MISSING' | 'BLOCKED_POLICY_INVALID' | 'BLOCKED_NO_READY_PROFILES' | 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING' | 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID' | 'BLOCKED_RUNTIME_BINDINGS' | 'READY_NON_ACTIVATING';
  generatedAt: number | null;
  researchSha: string | null;
  firstZero: string | null;
  policyPresent: boolean | null;
  policyValid: boolean | null;
  policyDigest: string | null;
  readyMarketCount: number | null;
  blockedMarketCount: number | null;
  readyProfileCount: number | null;
  blockedProfileCount: number | null;
  runtimeStatus: string | null;
  nextFirstZero: string | null;
  controlPlaneDigest: string | null;
}

export interface ResearchCenterOverview {
  schemaVersion: 'research-dashboard-overview-v1';
  generatedAt: number;
  state: {
    present: boolean;
    latestCycleAt: number | null;
  };
  safety: {
    readOnlyDashboard: true;
    liveTrading: false;
    privateApi: false;
    orderAuthority: false;
    authorityEvidenceComplete: boolean;
    forbiddenAuthorityObserved: boolean;
  };
  research: {
    status: string;
    failedTasks: number | null;
    blockedDataTasks: number | null;
    cycles: ResearchCycleSummary[];
    liquidityIndependence?: {
      present: boolean;
      status: 'MISSING' | 'INVALID' | 'PRESENT';
      effectiveIndependentN: number | null;
      frozenSplitCounts: { TRAIN: number | null; VALIDATION: number | null; OOS: number | null };
    };
  };
  dataFactory?: {
    temporalCryptoFutures: ResearchTemporalCryptoSummary;
  };
  factory?: ResearchFactoryRuntimeSummary;
  paper: {
    runtime: ResearchPaperRuntime;
    ledger: ResearchPaperLedger;
    candidatePerformance?: ResearchCandidatePerformance;
  };
  shadow: {
    groups: ResearchShadowGroup[];
    records: {
      present: boolean;
      totalRecords: number | null;
      settledRecords: number | null;
      pendingRecords: number | null;
    };
  };
  profitability: {
    proven: boolean;
    status: string;
    note: string;
  };
  canonicalStrategyHealth?: {
    input?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  };
  champion?: {
    currentValidatedChampion?: Record<string, unknown> | null;
  };
  strategyHealth?: StrategyHealthBinding;
}

export async function fetchResearchCenterOverview(signal?: AbortSignal): Promise<ResearchCenterOverview> {
  const response = await authorizedFetch('/api/admin/research/overview', { method: 'GET', signal });
  const body = await response.json().catch(() => null) as ResearchCenterOverview | { error?: string; message?: string } | null;
  if (!response.ok || !body || !('schemaVersion' in body) || body.schemaVersion !== 'research-dashboard-overview-v1') {
    const error = body && 'error' in body ? body.error : null;
    throw new Error(error || `RESEARCH_CENTER_HTTP_${response.status}`);
  }
  return body;
}
