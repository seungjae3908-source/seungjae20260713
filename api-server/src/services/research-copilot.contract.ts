import type { ResearchDualFreeAiResult } from './research-dual-free-ai.service';
import type { ResearchBundleResolution } from './research-bundle.contract';

export type CopilotTask = 'propose_candidates' | 'interpret_evidence' | 'compare_strategies' | 'explain_health';
export type CopilotStatus = 'ready' | 'needs_context' | 'waiting_approval' | 'blocked' | 'no_action';
export interface CopilotStage {
  key: string;
  label: string;
  status: 'MISSING_EVIDENCE' | 'BLOCKED_DATA' | 'READY';
  reason: string;
  verifiedReceiptCount: number;
  observedTasks: Array<{ id: string; status: string; observedAt: number | null }>;
}
export interface CopilotSnapshot {
  schemaVersion: 'research-copilot-v1';
  status: CopilotStatus;
  timestamp: number | null;
  evidenceDigest: string;
  data_sources: string[];
  freshness: 'FRESH' | 'STALE' | 'UNKNOWN' | 'FUTURE_TIMESTAMP';
  stages: CopilotStage[];
  missing_data: string[];
  health: { status: string; reasons: readonly string[]; source: string };
  comparisons: Array<{
    strategyId: string; market: string; direction: string; timeframe: string;
    universe: string; costPolicyVersion: string; researchCodeSha: string;
    stages: Array<{ stage: string; status: string; source: string; sourceSha: string | null; datasetId: string | null; sampleCount: number | null }>;
  }>;
  comparisonMode: 'IDENTITY_ONLY_NO_PERFORMANCE_RANKING';
  next_action: string;
  ai: { available: boolean; reason: string; provider: string | null; calls: number; cacheHits: number; tokenUsage: null; quotaRemaining: null };
  authority: {
    executionAuthority: 'NONE'; numericPerformanceAuthority: false;
    promotionAuthority: false; championAuthority: false; leverageAuthority: false;
    orderAllowed: false; paidFallback: false; finalHoldoutOpened: false;
  };
}
export interface CopilotReview {
  status: CopilotStatus;
  task: CopilotTask;
  market: null;
  symbol: null;
  timestamp: number | null;
  data_sources: string[];
  freshness: CopilotSnapshot['freshness'];
  evidenceDigest: string;
  signal: null;
  confidence: null;
  evidence: string[];
  risks: string[];
  entry_zone: null;
  invalidation: null;
  stop_loss: null;
  targets: [];
  risk_reward: null;
  missing_data: string[];
  next_action: string;
  approval_required: false;
  review: ResearchDualFreeAiResult | null;
  cacheHit: boolean;
  authority: CopilotSnapshot['authority'];
}
export interface DslValidation {
  bundle?: ResearchBundleResolution;
  status: 'ready' | 'blocked';
  task: 'validate_dsl';
  candidateId: string | null;
  market: string | null;
  timeframe: string | null;
  direction: string | null;
  validator: 'createSafeStrategyDslV1';
  error: string | null;
  evaluationStatus: 'NOT_EVALUATED';
  profitabilityProven: false;
  backtest: { status: 'needs_context'; missing_data: string[]; href: '/backtests'; submitted: false };
  authority: CopilotSnapshot['authority'];
}
