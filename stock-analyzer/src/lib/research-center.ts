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
  concurrency?: number;
  taskCount: number;
  successCount: number;
  blockedDataCount: number;
  failedCount: number;
  tasks: ResearchCycleTask[];
}

export interface ResearchPaperRuntime {
  present: boolean;
  status: string;
  cycleId?: string | null;
  scheduleActive?: boolean;
  allProvidersReady?: boolean;
  publicForwardEvidenceAccumulating?: boolean;
  paperTradeOutcomeAccumulating?: boolean;
  privateRequestCount: number;
  financialMutationCount: number;
  orderCount: number;
  liveTrading: boolean;
  orderAuthority: boolean;
  lanes: Array<{ market: string; status: string }>;
}

export interface ResearchPaperLedger {
  present: boolean;
  cycleCount: number;
  positionCount: number;
  settlementCount: number;
}

export interface ResearchShadowGroup {
  name: string;
  total: number | null;
  settled: number | null;
  pending: number | null;
  collapsed: boolean | null;
  macroF1: number | null;
  balancedAccuracy: number | null;
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
    forbiddenAuthorityObserved: boolean;
  };
  research: {
    status: string;
    failedTasks: number;
    blockedDataTasks: number;
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
      totalRecords: number;
      settledRecords: number;
      pendingRecords: number;
    };
  };
  profitability: {
    proven: boolean;
    status: string;
    note: string;
  };
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
