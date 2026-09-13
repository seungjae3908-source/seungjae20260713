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
  };
  paper: {
    runtime: ResearchPaperRuntime;
    ledger: ResearchPaperLedger;
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
