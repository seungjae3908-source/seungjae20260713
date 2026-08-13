import { authorizedFetch } from '@/lib/auth-fetch';

export type PromotionStageStatus = 'NOT_STARTED' | 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED' | 'INSUFFICIENT_SAMPLE' | 'STALE' | 'INVALIDATED';
export type PromotionState = 'RESEARCH' | 'BLOCKED_DATA' | 'RESEARCH_HOLD' | 'PAPER_CANDIDATE' | 'PAPER_VALIDATED' | 'SHADOW_CANDIDATE' | 'SHADOW_VALIDATED' | 'PROMOTION_CANDIDATE' | 'SUSPENDED' | 'KILLED';

export interface PromotionStage {
  stage: string;
  status: PromotionStageStatus;
  observedAt: string;
  source: string;
  sourceSha: string | null;
  sampleSize: number | null;
  tradeCount: number | null;
  metrics: Record<string, number | string | boolean | null> | null;
  gate: string;
  failureReason: string | null;
  provenance: string[];
  costAssumptions: Record<string, number | string | boolean | null> | null;
  dataQuality: string;
}

export interface StrategyPromotionItem {
  identity: {
    strategyFamily: string;
    strategyId: string;
    version: string;
    parameterHash: string;
    market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
    assetClass: string;
    symbol: string | null;
    universe: string;
    timeframe: string;
    horizon: 'SCALP' | 'SWING' | 'POSITION';
    direction: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
    researchCodeSha: string;
    costPolicyVersion: string;
    riskPolicyVersion: string;
  };
  promotionState: PromotionState;
  stages: PromotionStage[];
  drift: {
    classification: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL' | null;
    status: 'MEASURED' | 'INSUFFICIENT_SAMPLE';
    reason: string;
    observedSampleSize: number | null;
  };
  killState: 'NONE' | 'SUSPEND_RECOMMENDED' | 'KILLED';
  blockers: string[];
  promotionEligible: boolean;
  executionAuthority: 'NONE';
  liveTradingAuthority: false;
  privateTradingApiCount: 0;
}

export interface StrategyPromotionResponse {
  ok: true;
  generatedAt: string;
  sourceSha: string;
  items: StrategyPromotionItem[];
  counts: Record<PromotionState, number>;
  evidenceSources: Array<{ id: string; owner: string; status: string; use: string; executionAuthority: 'NONE' }>;
  promotionCandidates: number;
  executionAuthority: 'NONE';
  liveTradingAuthority: false;
  privateTradingApiCount: 0;
}

export async function fetchStrategyPromotions(signal?: AbortSignal): Promise<StrategyPromotionResponse> {
  const response = await authorizedFetch('/api/strategy-promotion', { method: 'GET', signal });
  const body = await response.json().catch(() => null) as StrategyPromotionResponse | { error?: string } | null;
  if (!response.ok || !body || !('items' in body)) {
    throw new Error(body && 'error' in body ? body.error : `STRATEGY_PROMOTION_HTTP_${response.status}`);
  }
  return body;
}

export function completedPromotionStages(item: StrategyPromotionItem): number {
  return item.stages.filter((stage) => stage.status === 'PASS').length;
}
