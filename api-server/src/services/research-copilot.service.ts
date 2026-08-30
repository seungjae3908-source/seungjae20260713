import { createHash } from 'node:crypto';
import { createSafeStrategyDslV1 } from '../../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import { answerAiChat } from './ai-chat.service';
import { bindCanonicalStrategyHealth } from './strategy-health-research-adapter.service';
import { createDefaultStrategyPromotionService, type StrategyPromotionList, type PromotionStageEvidence } from './strategy-promotion.service';
import { runResearchDualFreeAiReview, ResearchDualFreeAiError, type ResearchFreeAiProvider, type ResearchAiInvoker } from './research-dual-free-ai.service';
import type { CopilotReview, CopilotSnapshot, CopilotStage, CopilotTask, DslValidation } from './research-copilot.contract';

const SOURCE = 'Research Production /api/research/overview';
const MAX_AGE_MS = 24 * 60 * 60 * 1_000; // Read-model freshness, never an investment gate.
const CACHE_MS = 60_000;
const MAX_CACHE = 64;
export const COPILOT_AUTHORITY = Object.freeze({
  executionAuthority: 'NONE', numericPerformanceAuthority: false, promotionAuthority: false,
  championAuthority: false, leverageAuthority: false, orderAllowed: false, paidFallback: false,
  finalHoldoutOpened: false,
} as const);
const TASKS = new Set<CopilotTask>(['propose_candidates', 'interpret_evidence', 'compare_strategies', 'explain_health']);
const STAGES: Array<[string, string, RegExp]> = [
  ['candidate', '전략 후보', /formula|candidate/i],
  ['dsl', 'DSL / Formula 검증', /dsl|formula.*valid/i],
  ['backtest', '백테스트', /backtest|historical/i],
  ['oos', 'OOS', /\boos\b|out.of.sample/i],
  ['walk-forward', 'Purged Walk Forward', /walk.forward/i],
  ['holdout', 'Final Holdout', /holdout/i],
  ['leakage', '과최적화 / 누수 검증', /firewall|leakage|overfit/i],
  ['comparison', '전략 비교', /tournament|comparison/i],
  ['shadow', 'Shadow / Forward 인계', /shadow|forward/i],
  ['health', 'Strategy Health', /strategy.health/i],
];
const CANONICAL_STAGE: Record<string, string> = {
  candidate: 'RESEARCH_DESIGN', backtest: 'HISTORICAL_BACKTEST', oos: 'OUT_OF_SAMPLE',
  'walk-forward': 'PURGED_WALK_FORWARD', holdout: 'FINAL_HOLDOUT', shadow: 'SHADOW',
};
function receiptAvailable(stage: PromotionStageEvidence, sourceSha: string, now: number): boolean {
  // Read availability from the existing owner; never reconstruct a financial gate.
  if (stage.status !== 'PASS' || stage.gateResult !== 'PASS' || stage.dataQuality !== 'VERIFIED' ||
      stage.sourceSha !== sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha) || !stage.provenance.length) return false;
  if (!stage.validatedAt || !Number.isFinite(Date.parse(stage.validatedAt)) || Date.parse(stage.validatedAt) > now) return false;
  if (stage.stage === 'RESEARCH_DESIGN') return true;
  if (!stage.datasetId || !stage.dataRange || !stage.provider || !stage.metrics) return false;
  const start = Date.parse(stage.dataRange.start), end = Date.parse(stage.dataRange.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now) return false;
  if (['HISTORICAL_BACKTEST', 'OUT_OF_SAMPLE', 'PURGED_WALK_FORWARD', 'FINAL_HOLDOUT'].includes(stage.stage) && stage.pointInTimeSafe !== true) return false;
  return stage.sampleCount !== null && Number.isSafeInteger(stage.sampleCount) && stage.sampleCount > 0;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function id(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
}
function knownTaskStatus(value: unknown): string {
  return typeof value === 'string' && /^(success|complete|completed|pass|ready|failed|fail|error|blocked_data|blocked|running|pending|not_started|replayed)$/i.test(value)
    ? value.toUpperCase() : 'UNKNOWN';
}
export function buildCopilotSnapshot(raw: unknown, now: number, promotions?: StrategyPromotionList): CopilotSnapshot {
  const root = record(raw);
  const safety = record(root.safety);
  const observedAt = timestamp(record(root.state).latestCycleAt);
  const freshness = observedAt === null ? 'UNKNOWN' : observedAt > now ? 'FUTURE_TIMESTAMP' : now - observedAt > MAX_AGE_MS ? 'STALE' : 'FRESH';
  const safe = root.schemaVersion === 'research-dashboard-overview-v1' && safety.readOnlyDashboard === true &&
    safety.liveTrading === false && safety.privateApi === false && safety.orderAuthority === false &&
    safety.authorityEvidenceComplete === true && safety.forbiddenAuthorityObserved === false;
  const research = record(root.research);
  const cycles = Array.isArray(research.cycles) ? research.cycles.slice(0, 3).map(record) : [];
  const tasks = cycles.flatMap(cycle => {
    if (cycle.present !== true || !Array.isArray(cycle.tasks)) return [];
    return cycle.tasks.slice(0, 100).map(record).flatMap(task => {
      const taskId = id(task.id);
      return taskId ? [{ id: taskId, status: task.timedOut === true ? 'TIMEOUT' : knownTaskStatus(task.status), observedAt: timestamp(cycle.generatedAt) }] : [];
    });
  });
  const health = bindCanonicalStrategyHealth(safe ? root : {});
  const stages: CopilotStage[] = STAGES.map(([key, label, pattern]) => {
    const verifiedReceiptCount = safe && freshness === 'FRESH'
      ? (promotions?.items ?? []).filter(item => item.stages.some(stage => stage.stage === CANONICAL_STAGE[key] && receiptAvailable(stage, item.identity.researchCodeSha, observedAt!))).length
      : 0;
    return {
      key, label, status: !safe || freshness !== 'FRESH' ? 'BLOCKED_DATA' : verifiedReceiptCount > 0 ? 'READY' : 'MISSING_EVIDENCE',
      verifiedReceiptCount,
      reason: verifiedReceiptCount > 0
        ? '기존 canonical 평가자가 통과시킨 receipt를 조회할 수 있습니다. 다른 전략·단계의 통과나 승격을 의미하지 않습니다.'
        : '작업 성공은 검증 통과가 아닙니다. 전략·데이터셋·분할·비용 정책에 연결된 canonical 검증 receipt가 필요합니다.',
      observedTasks: tasks.filter(task => pattern.test(task.id)),
    };
  });
  const missing = ['STRATEGY_BOUND_EVIDENCE_RECEIPTS', 'FROZEN_SPLIT_AND_UNTOUCHED_HOLDOUT', 'CANONICAL_COST_AND_RISK_POLICY', 'STRATEGY_COMPARABLE_METRICS'];
  if (!safe) missing.unshift('SAFETY_CONTRACT');
  if (freshness !== 'FRESH') missing.unshift('FRESH_SOURCE_TIMESTAMP');
  // Deliberately omit metrics and promotion decisions from the AI projection.
  // Identity comparison is useful even before economically comparable receipts exist.
  const comparisons = (promotions?.items ?? []).slice(0, 100).map(item => ({
    strategyId: item.identity.strategyId, market: item.identity.market, direction: item.identity.direction,
    timeframe: item.identity.timeframe, universe: item.identity.universe, costPolicyVersion: item.identity.costPolicyVersion,
    researchCodeSha: item.identity.researchCodeSha,
    stages: item.stages.map(stage => ({ stage: stage.stage, status: stage.status, source: stage.source, sourceSha: stage.sourceSha, datasetId: stage.datasetId, sampleCount: stage.sampleCount })),
  })).sort((a, b) => a.strategyId.localeCompare(b.strategyId));
  const evidence = { observedAt, freshness, safe, tasks, comparisons, health };
  return {
    schemaVersion: 'research-copilot-v1', status: safe && freshness === 'FRESH' ? 'needs_context' : 'blocked',
    timestamp: observedAt, evidenceDigest: digest(evidence), data_sources: [SOURCE, 'strategy-promotion.service (identity only)'],
    freshness, stages, missing_data: missing,
    health: { status: health.status, reasons: health.reasons, source: health.evaluator },
    comparisons, comparisonMode: 'IDENTITY_ONLY_NO_PERFORMANCE_RANKING',
    next_action: '후보 가설 → canonical DSL 검증 → 데이터·분할·비용 정책 고정 → 기존 백테스터 → OOS/WF/최종 Holdout receipt → 별도 Shadow/Forward 승인',
    ai: { available: false, reason: 'NOT_CONFIGURED', provider: null, calls: 0, cacheHits: 0, tokenUsage: null, quotaRemaining: null },
    authority: COPILOT_AUTHORITY,
  };
}

export function validateCopilotDsl(value: unknown): DslValidation {
  const base = {
    task: 'validate_dsl' as const, validator: 'createSafeStrategyDslV1' as const,
    evaluationStatus: 'NOT_EVALUATED' as const, profitabilityProven: false as const,
    backtest: { status: 'needs_context' as const, missing_data: ['IMMUTABLE_DATASET', 'FROZEN_SPLIT', 'COST_POLICY', 'RISK_POLICY', 'CANONICAL_BACKTEST_BINDING'], href: '/backtests' as const, submitted: false as const },
    authority: COPILOT_AUTHORITY,
  };
  try {
    if (JSON.stringify(value).length > 32_000) throw new Error('DSL_TOO_LARGE');
    const dsl = createSafeStrategyDslV1(value);
    return { ...base, status: 'ready', candidateId: `dsl:sha256:${dsl.dslHash}`, market: dsl.market, timeframe: dsl.timeframe, direction: dsl.direction, error: null };
  } catch {
    // Validator errors can include user input. Never echo code, secrets or raw payloads.
    return { ...base, status: 'blocked', candidateId: null, market: null, timeframe: null, direction: null, error: 'DSL_INVALID_OR_OUTSIDE_CANONICAL_LIMITS' };
  }
}

export function researchProviderPolicy(env: NodeJS.ProcessEnv): { provider: ResearchFreeAiProvider | null; reason: string } {
  // Billing entitlement is not inferred from a model's name or a credential.
  if (env.RESEARCH_AI_FREE_TIER_CONFIRMED !== 'true') return { provider: null, reason: 'FREE_TIER_NOT_CONFIRMED' };
  const selected = env.AI_CHAT_PROVIDER?.trim().toLowerCase();
  if (selected === 'groq') {
    const model = env.AI_CHAT_MODEL?.trim() || env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b';
    if (model === 'openai/gpt-oss-20b' && (env.AI_CHAT_API_KEY?.trim() || env.GROQ_API_KEY?.trim())) return { provider: 'groq', reason: 'CONFIGURED_FREE_ONLY_QUOTA_UNKNOWN' };
  }
  if (selected === 'gemini' || selected === 'google' || selected === 'google-gemini') {
    const model = env.AI_CHAT_MODEL?.trim() || env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
    // Require provider isolation; do not relabel a fallback as the primary provider.
    if (!env.GROQ_API_KEY?.trim() && model === 'gemini-3.1-flash-lite' && (env.AI_CHAT_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim())) return { provider: 'gemini', reason: 'CONFIGURED_FREE_ONLY_QUOTA_UNKNOWN' };
  }
  return { provider: null, reason: 'ISOLATED_FREE_PROVIDER_REQUIRED' };
}

type Dependencies = {
  loadOverview: (signal?: AbortSignal) => Promise<unknown>;
  promotions: () => StrategyPromotionList;
  now: () => number;
  policy: () => ReturnType<typeof researchProviderPolicy>;
  invoke: ResearchAiInvoker;
};
export class ResearchCopilotService {
  private cache = new Map<string, { until: number; result: CopilotReview }>();
  private inFlight = new Map<string, Promise<CopilotReview>>();
  private calls = 0;
  private cacheHits = 0;
  private lastAttempt = new Map<string, number>();
  private attemptTimes: number[] = [];
  constructor(private readonly deps: Dependencies) {}

  async snapshot(signal?: AbortSignal): Promise<CopilotSnapshot> {
    const snapshot = buildCopilotSnapshot(await this.deps.loadOverview(signal), this.deps.now(), this.deps.promotions());
    const policy = this.deps.policy();
    return { ...snapshot, ai: { ...snapshot.ai, available: policy.provider !== null && snapshot.status !== 'blocked', provider: policy.provider, reason: policy.reason, calls: this.calls, cacheHits: this.cacheHits } };
  }

  async review(userId: string, task: CopilotTask, expectedDigest: string): Promise<CopilotReview> {
    if (!TASKS.has(task) || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new ResearchDualFreeAiError('INVALID_RESEARCH_INPUT', 'invalid task or evidence identity');
    const snapshot = await this.snapshot();
    if (snapshot.evidenceDigest !== expectedDigest) throw new ResearchDualFreeAiError('EVIDENCE_CHANGED', 'refresh evidence before requesting review');
    const policy = this.deps.policy();
    if (!policy.provider || snapshot.status === 'blocked') throw new ResearchDualFreeAiError('AI_RESEARCH_UNAVAILABLE', 'fresh evidence and isolated confirmed free provider required');
    const key = digest([userId, task, expectedDigest, policy.provider, 'copilot-v1']);
    const now = this.deps.now();
    for (const [entry, cached] of this.cache) if (cached.until <= now) this.cache.delete(entry);
    const cached = this.cache.get(key);
    if (cached) { this.cacheHits += 1; return { ...structuredClone(cached.result), cacheHit: true }; }
    const running = this.inFlight.get(key);
    if (running) { this.cacheHits += 1; return { ...structuredClone(await running), cacheHit: true }; }
    const userKey = digest(userId);
    this.attemptTimes = this.attemptTimes.filter(attempt => now - attempt < CACHE_MS);
    if (this.inFlight.size > 0 || this.attemptTimes.length >= 4 || now - (this.lastAttempt.get(userKey) ?? -Infinity) < CACHE_MS) throw new ResearchDualFreeAiError('RESEARCH_AI_BUSY', 'bounded review budget exhausted');
    this.attemptTimes.push(now);
    if (this.lastAttempt.size >= MAX_CACHE) this.lastAttempt.delete(this.lastAttempt.keys().next().value!);
    this.lastAttempt.set(userKey, now);
    const pending = this.invokeReview(snapshot, task, policy.provider);
    this.inFlight.set(key, pending);
    try {
      const result = await pending;
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { until: this.deps.now() + CACHE_MS, result: structuredClone(result) });
      return result;
    } finally { this.inFlight.delete(key); }
  }

  private async invokeReview(snapshot: CopilotSnapshot, task: CopilotTask, provider: ResearchFreeAiProvider): Promise<CopilotReview> {
    this.calls += 1;
    const review = await runResearchDualFreeAiReview({
      provider, role: task === 'propose_candidates' ? 'PROPOSER' : 'CRITIC', promptVersion: 'copilot-v1',
      evidenceDigest: snapshot.evidenceDigest,
      // No free-form user text, account context, holdout outcomes or metric values leave the server.
      evidenceSummary: JSON.stringify({ task, freshness: snapshot.freshness, missing: snapshot.missing_data, evidenceScope: 'Runtime task observations only; no strategy performance receipts. Discuss research design and missing evidence, not empirical conclusions.' }),
    }, this.deps.invoke);
    const expectedModel = provider === 'groq' ? 'openai/gpt-oss-20b' : 'gemini-3.1-flash-lite';
    if (review.model !== expectedModel) throw new ResearchDualFreeAiError('PROVIDER_IDENTITY_MISMATCH', 'provider identity did not match the approved free route');
    return {
      status: 'needs_context', task, market: null, symbol: null, timestamp: snapshot.timestamp,
      data_sources: snapshot.data_sources, freshness: snapshot.freshness, evidenceDigest: snapshot.evidenceDigest,
      signal: null, confidence: null, evidence: ['Only canonical runtime observations were supplied. Strategy receipts are missing.'],
      risks: review.risks, entry_zone: null, invalidation: null, stop_loss: null, targets: [], risk_reward: null,
      missing_data: snapshot.missing_data, next_action: snapshot.next_action, approval_required: false,
      review, cacheHit: false, authority: COPILOT_AUTHORITY,
    };
  }
}

export function createResearchCopilotService(): ResearchCopilotService {
  const promotionService = createDefaultStrategyPromotionService();
  return new ResearchCopilotService({
    now: Date.now, policy: () => researchProviderPolicy(process.env), promotions: () => promotionService.list(),
    loadOverview: async (signal) => {
      const timeout = AbortSignal.timeout(5_000);
      const response = await fetch('http://127.0.0.1:18090/api/research/overview', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new ResearchDualFreeAiError('RESEARCH_SOURCE_UNAVAILABLE', 'canonical research overview unavailable');
      return response.json();
    },
    invoke: async (message) => {
      const result = await answerAiChat({ message }, fetch, undefined, 15_000);
      if (result.kind !== 'answer' || !result.model) throw new ResearchDualFreeAiError('AI_RESEARCH_UNAVAILABLE', 'canonical AI transport unavailable');
      return { answer: result.answer, model: result.model };
    },
  });
}
