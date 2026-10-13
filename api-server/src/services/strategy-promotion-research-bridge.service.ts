import {
  StrategyPromotionService,
  type StrategyPromotionRecord,
} from './strategy-promotion.service';

export const RESEARCH_PROMOTION_BRIDGE_VERSION = 'research-promotion-readonly-bridge-v1' as const;
export const RESEARCH_PROMOTION_OVERVIEW_URL = 'http://127.0.0.1:18090/api/research/overview';
export const RESEARCH_PROMOTION_TIMEOUT_MS = 10_000;

type UnknownRecord = Record<string, unknown>;

export type ResearchPromotionBridgeStatus =
  | 'UNAVAILABLE'
  | 'NO_CANDIDATE'
  | 'INVALID'
  | 'UNMAPPED'
  | 'RESEARCH_ONLY'
  | 'VALIDATION_COLLECTING'
  | 'OOS_COLLECTING'
  | 'FULL_COST_COLLECTING'
  | 'PAPER_EVIDENCE_COLLECTING'
  | 'PAPER_ADOPTION_REVIEW_READY';

export interface ResearchPromotionBridgeResult {
  contract: typeof RESEARCH_PROMOTION_BRIDGE_VERSION;
  status: ResearchPromotionBridgeStatus;
  generatedAt: string;
  candidate: {
    candidateId: string;
    strategyId: string;
    strategyVersion: string;
    parameterHash: string;
    researchCodeSha: string;
    market: string;
    timeframe: string;
    sidePolicy: string;
    accountMode: 'PAPER';
    costPolicyVersion: string;
    executionPolicyVersion: string;
  } | null;
  scannerProfile: {
    strategyId: string;
    parameterHash: string;
    market: string;
    timeframe: string;
    direction: string;
    promotionState: string;
  } | null;
  evidence: {
    trainN: number | null;
    validationN: number | null;
    oosN: number | null;
    settlementN: number | null;
    fullCostReady: boolean;
    validationComplete: boolean;
    oosComplete: boolean;
    profitabilityProven: boolean;
  };
  blockers: readonly string[];
  automaticAdoptionAllowed: false;
  paperHandoffAllowed: false;
  scannerMutationAllowed: false;
  liveTradingAllowed: false;
  privateTradingApiAllowed: false;
  orderAllowed: false;
  executionAuthority: 'NONE';
}

const SHA40 = /^[0-9a-f]{40}$/iu;
const HASH64 = /^[0-9a-f]{64}$/iu;
const CANDIDATE_ID = /^(?:phase3-candidate:sha256:|paper-candidate-v1:)[0-9a-f]{64}$/iu;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const SIDES = new Set(['LONG', 'SHORT', 'BUY', 'SELL']);

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeIdentity(value: unknown): ResearchPromotionBridgeResult['candidate'] {
  const row = record(value);
  if (!row) return null;
  const candidateId = String(row.candidateId ?? '');
  const strategyId = String(row.strategyId ?? '');
  const strategyVersion = String(row.strategyVersion ?? '');
  const parameterHash = String(row.parameterHash ?? '').toLowerCase();
  const researchCodeSha = String(row.researchCodeSha ?? '').toLowerCase();
  const market = String(row.market ?? '');
  const timeframe = String(row.timeframe ?? '');
  const sidePolicy = String(row.sidePolicy ?? '').toUpperCase();
  const accountMode = String(row.accountMode ?? '');
  const costPolicyVersion = String(row.costPolicyVersion ?? '');
  const executionPolicyVersion = String(row.executionPolicyVersion ?? '');

  if (!CANDIDATE_ID.test(candidateId)
    || !SAFE_ID.test(strategyId)
    || !SAFE_ID.test(strategyVersion)
    || !HASH64.test(parameterHash)
    || !SHA40.test(researchCodeSha)
    || !MARKETS.has(market)
    || !SAFE_ID.test(timeframe)
    || !SIDES.has(sidePolicy)
    || accountMode !== 'PAPER'
    || !SAFE_ID.test(costPolicyVersion)
    || !SAFE_ID.test(executionPolicyVersion)) {
    return null;
  }

  return {
    candidateId,
    strategyId,
    strategyVersion,
    parameterHash,
    researchCodeSha,
    market,
    timeframe,
    sidePolicy,
    accountMode: 'PAPER',
    costPolicyVersion,
    executionPolicyVersion,
  };
}

function emptyEvidence(): ResearchPromotionBridgeResult['evidence'] {
  return {
    trainN: null,
    validationN: null,
    oosN: null,
    settlementN: null,
    fullCostReady: false,
    validationComplete: false,
    oosComplete: false,
    profitabilityProven: false,
  };
}

function base(
  status: ResearchPromotionBridgeStatus,
  blockers: string[],
  generatedAt = new Date().toISOString(),
): ResearchPromotionBridgeResult {
  return Object.freeze({
    contract: RESEARCH_PROMOTION_BRIDGE_VERSION,
    status,
    generatedAt,
    candidate: null,
    scannerProfile: null,
    evidence: emptyEvidence(),
    blockers: Object.freeze([...new Set(blockers)]),
    automaticAdoptionAllowed: false,
    paperHandoffAllowed: false,
    scannerMutationAllowed: false,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    orderAllowed: false,
    executionAuthority: 'NONE',
  });
}

function directionFor(candidate: NonNullable<ResearchPromotionBridgeResult['candidate']>): string {
  if (candidate.market === 'CRYPTO_FUTURES') {
    return candidate.sidePolicy === 'SHORT' ? 'SHORT' : candidate.sidePolicy === 'LONG' ? 'LONG' : candidate.sidePolicy;
  }
  if (candidate.sidePolicy === 'LONG') return 'BUY';
  if (candidate.sidePolicy === 'SHORT') return 'SELL';
  return candidate.sidePolicy;
}

function mappedRecord(candidate: NonNullable<ResearchPromotionBridgeResult['candidate']>, currentSha: string): StrategyPromotionRecord | null {
  const service = new StrategyPromotionService({ sourceSha: currentSha });
  const direction = directionFor(candidate);
  return service.list({
    market: candidate.market,
    direction,
  }).items.find((item) => (
    item.identity.strategyId === candidate.strategyId
    && item.identity.strategyVersion === candidate.strategyVersion
    && item.identity.parameterHash === candidate.parameterHash
    && item.identity.researchCodeSha === candidate.researchCodeSha
    && item.identity.market === candidate.market
    && item.identity.timeframe === candidate.timeframe
    && item.identity.direction === direction
    && item.identity.costPolicyVersion === candidate.costPolicyVersion
  )) ?? null;
}

function classifyProgress(evidence: ResearchPromotionBridgeResult['evidence']): ResearchPromotionBridgeStatus {
  if (evidence.profitabilityProven
    && evidence.fullCostReady
    && evidence.validationComplete
    && evidence.oosComplete
    && (evidence.settlementN ?? 0) > 0) {
    return 'PAPER_ADOPTION_REVIEW_READY';
  }
  if (evidence.oosComplete) {
    return evidence.fullCostReady ? 'PAPER_EVIDENCE_COLLECTING' : 'FULL_COST_COLLECTING';
  }
  if ((evidence.oosN ?? 0) > 0) return 'OOS_COLLECTING';
  if ((evidence.validationN ?? 0) > 0) return 'VALIDATION_COLLECTING';
  return 'RESEARCH_ONLY';
}

export function buildResearchPromotionBridge(
  overview: unknown,
  currentSha: string,
  generatedAt = new Date().toISOString(),
): ResearchPromotionBridgeResult {
  const root = record(overview);
  const safety = record(root?.safety);
  if (!root
    || root.schemaVersion !== 'research-dashboard-overview-v1'
    || safety?.readOnlyDashboard !== true
    || safety?.liveTrading !== false
    || safety?.privateApi !== false
    || safety?.orderAuthority !== false
    || safety?.forbiddenAuthorityObserved !== false) {
    return base('INVALID', ['RESEARCH_DASHBOARD_SAFETY_INVALID'], generatedAt);
  }

  const candidatePerformance = record(record(root.paper)?.candidatePerformance);
  if (!candidatePerformance || candidatePerformance.present === false || candidatePerformance.status === 'MISSING') {
    return base('NO_CANDIDATE', ['RESEARCH_CANDIDATE_NOT_PRESENT'], generatedAt);
  }
  if (candidatePerformance.status !== 'PRESENT'
    || candidatePerformance.schemaVersion !== 'frozen-candidate-performance-reader-v1'
    || candidatePerformance.identity14Verified !== true
    || candidatePerformance.FULL_COST_READY !== false
    || candidatePerformance.NET_ALPHA_PROVEN !== false
    || candidatePerformance.PROFITABILITY_PROVEN !== false
    || candidatePerformance.TRAIN_DIAGNOSTIC_ONLY !== true
    || candidatePerformance.VALIDATION_COMPLETE !== false
    || candidatePerformance.OOS_COMPLETE !== false
    || candidatePerformance.Net_PnL !== null
    || candidatePerformance.executionAuthority !== 'NONE') {
    return base('INVALID', ['RESEARCH_CANDIDATE_EVIDENCE_INVALID'], generatedAt);
  }

  const candidate = safeIdentity(candidatePerformance.promotionIdentity);
  if (!candidate) return base('INVALID', ['RESEARCH_CANDIDATE_PROMOTION_IDENTITY_INVALID'], generatedAt);

  const evidence = {
    trainN: count(candidatePerformance.TRAIN_N),
    validationN: count(candidatePerformance.VALIDATION_N),
    oosN: count(candidatePerformance.OOS_N),
    settlementN: count(candidatePerformance.Settlement_N),
    fullCostReady: false,
    validationComplete: false,
    oosComplete: false,
    profitabilityProven: false,
  };

  const blockers: string[] = [];
  if (!SHA40.test(currentSha)) blockers.push('CURRENT_APP_SHA_REQUIRED');
  if (candidate.researchCodeSha !== currentSha.toLowerCase()) blockers.push('RESEARCH_CODE_SHA_NOT_CURRENT');
  if (candidatePerformance.TRAIN_DIAGNOSTIC_ONLY === true) blockers.push('TRAIN_DIAGNOSTIC_ONLY');
  if (!evidence.validationComplete) blockers.push('VALIDATION_NOT_COMPLETE');
  if (!evidence.oosComplete) blockers.push('OOS_NOT_COMPLETE');
  if (!evidence.fullCostReady) blockers.push('FULL_COST_NOT_READY');
  if (!evidence.profitabilityProven) blockers.push('PROFITABILITY_NOT_PROVEN');

  const mapping = blockers.includes('CURRENT_APP_SHA_REQUIRED')
    || blockers.includes('RESEARCH_CODE_SHA_NOT_CURRENT')
    ? null
    : mappedRecord(candidate, currentSha.toLowerCase());

  if (!mapping) {
    blockers.push('SCANNER_PROFILE_IDENTITY_UNMAPPED');
    return Object.freeze({
      ...base('UNMAPPED', blockers, generatedAt),
      candidate,
      evidence,
    });
  }

  const status = classifyProgress(evidence);
  if (status === 'PAPER_ADOPTION_REVIEW_READY') {
    // The bridge can surface review readiness only. It never writes Scanner
    // profiles, never creates Paper admission, and never grants promotion.
    blockers.push('SEPARATE_HUMAN_ADOPTION_REVIEW_REQUIRED');
  }

  return Object.freeze({
    ...base(status, blockers, generatedAt),
    candidate,
    scannerProfile: {
      strategyId: mapping.identity.strategyId,
      parameterHash: mapping.identity.parameterHash,
      market: mapping.identity.market,
      timeframe: mapping.identity.timeframe,
      direction: mapping.identity.direction,
      promotionState: mapping.promotionState,
    },
    evidence,
  });
}

export async function loadResearchPromotionBridge(options: {
  fetchImpl?: typeof fetch;
  currentSha?: string;
  timeoutMs?: number;
} = {}): Promise<ResearchPromotionBridgeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const currentSha = String(options.currentSha ?? process.env.DEPLOY_SHA ?? process.env.GITHUB_SHA ?? '').trim().toLowerCase();
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? RESEARCH_PROMOTION_TIMEOUT_MS, 15_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RESEARCH_PROMOTION_OVERVIEW_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return base('UNAVAILABLE', ['RESEARCH_DASHBOARD_UNAVAILABLE']);
    }
    const overview: unknown = await response.json().catch(() => null);
    return buildResearchPromotionBridge(overview, currentSha);
  } catch {
    return base('UNAVAILABLE', ['RESEARCH_DASHBOARD_UNAVAILABLE']);
  } finally {
    clearTimeout(timeout);
  }
}
