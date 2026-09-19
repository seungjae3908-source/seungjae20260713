import { createHash } from 'node:crypto';

export const RESEARCH_FACTORY_STAGE_SEQUENCE = Object.freeze([
  'FORMULA_CANDIDATE',
  'SANITY_CHECK',
  'HISTORICAL_BACKTEST',
  'OOS',
  'PURGED_OOS',
  'WALK_FORWARD',
  'COST_STRESS',
  'REGIME_STRESS',
  'STATISTICAL_FIREWALL',
  'FINAL_HOLDOUT',
  'FUTURE_ONLY',
  'SHADOW',
  'NATURAL_PAPER',
  'SETTLEMENT',
  'FULL_COST',
  'STRATEGY_REGISTRY',
]);

export const RESEARCH_FACTORY_GUARDED_STAGES = Object.freeze(new Set([
  'FINAL_HOLDOUT',
  'SHADOW',
  'NATURAL_PAPER',
]));

const SHA40 = /^[0-9a-f]{40}$/i;
const HASH64 = /^[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const TERMINAL_STATES = new Set(['REJECTED', 'COMPLETE']);

const DEFAULT_BUDGET = Object.freeze({
  maxQueue: 8,
  maxConcurrentJobs: 3,
  maxAiCallsPerCycle: 1,
  maxCandidatesPerFamily: 32,
});

const OWNER_BY_STAGE = Object.freeze({
  FORMULA_CANDIDATE: 'market-prediction-lab/formula-generator',
  SANITY_CHECK: 'market-prediction-lab/research-tournament',
  HISTORICAL_BACKTEST: 'market-prediction-lab/research-tournament',
  OOS: 'market-prediction-lab/research-tournament',
  PURGED_OOS: 'market-prediction-lab/research-tournament',
  WALK_FORWARD: 'market-prediction-lab/research-tournament',
  COST_STRESS: 'market-prediction-lab/research-tournament',
  REGIME_STRESS: 'market-prediction-lab/research-tournament',
  STATISTICAL_FIREWALL: 'market-prediction-lab/research-tournament',
  FINAL_HOLDOUT: 'market-prediction-lab/final-holdout',
  FUTURE_ONLY: 'market-prediction-lab/forward',
  SHADOW: 'market-prediction-lab/canonical-shadow',
  NATURAL_PAPER: 'research-production/forward',
  SETTLEMENT: 'market-prediction-lab/paper-settlement',
  FULL_COST: 'market-prediction-lab/authoritative-paper-full-cost',
  STRATEGY_REGISTRY: 'market-prediction-lab/strategy-registry',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function requireText(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positiveInteger(value, fallback, name, max = 10_000) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) throw new RangeError(`${name} must be a positive integer <= ${max}`);
  return resolved;
}

function normalizeBudget(raw = {}) {
  return Object.freeze({
    maxQueue: positiveInteger(raw.maxQueue, DEFAULT_BUDGET.maxQueue, 'maxQueue', 128),
    maxConcurrentJobs: positiveInteger(raw.maxConcurrentJobs, DEFAULT_BUDGET.maxConcurrentJobs, 'maxConcurrentJobs', 16),
    maxAiCallsPerCycle: positiveInteger(raw.maxAiCallsPerCycle, DEFAULT_BUDGET.maxAiCallsPerCycle, 'maxAiCallsPerCycle', 8),
    maxCandidatesPerFamily: positiveInteger(raw.maxCandidatesPerFamily, DEFAULT_BUDGET.maxCandidatesPerFamily, 'maxCandidatesPerFamily', 512),
  });
}

function normalizeMarketData(markets = {}) {
  const rows = {};
  for (const [market, value] of Object.entries(markets)) {
    requireText(market, 'market');
    const missingFeatures = [...new Set((value?.missingFeatures ?? []).map((item) => requireText(item, 'missingFeature')))].sort();
    rows[market] = Object.freeze({
      ready: value?.ready === true,
      datasetSnapshotHash: value?.datasetSnapshotHash == null ? null : String(value.datasetSnapshotHash).toLowerCase(),
      missingFeatures: Object.freeze(missingFeatures),
    });
    if (rows[market].ready && !HASH64.test(rows[market].datasetSnapshotHash ?? '')) {
      throw new TypeError(`ready market ${market} requires datasetSnapshotHash`);
    }
  }
  return Object.freeze(rows);
}

function assertCompletedPrefix(completedStages) {
  if (!Array.isArray(completedStages)) throw new TypeError('completedStages must be an array');
  const dedup = new Set(completedStages);
  if (dedup.size !== completedStages.length) throw new Error('completedStages contains duplicates');
  for (let index = 0; index < completedStages.length; index += 1) {
    if (completedStages[index] !== RESEARCH_FACTORY_STAGE_SEQUENCE[index]) {
      throw new Error(`completedStages must be a canonical prefix; mismatch at ${index}`);
    }
  }
}

function normalizeCandidate(raw, researchSha) {
  const candidateId = requireText(raw?.candidateId, 'candidateId');
  const familyId = requireText(raw?.familyId, 'familyId');
  const market = requireText(raw?.market, 'candidate.market');
  const candidateResearchSha = String(raw?.researchSha ?? '').toLowerCase();
  if (candidateResearchSha !== researchSha) throw new Error(`candidate ${candidateId} researchSha mismatch`);
  if (!HASH64.test(String(raw?.strategyHash ?? ''))) throw new TypeError(`candidate ${candidateId} strategyHash invalid`);
  if (!HASH64.test(String(raw?.parameterHash ?? ''))) throw new TypeError(`candidate ${candidateId} parameterHash invalid`);
  if (!HASH64.test(String(raw?.datasetSnapshotHash ?? ''))) throw new TypeError(`candidate ${candidateId} datasetSnapshotHash invalid`);
  assertCompletedPrefix(raw?.completedStages ?? []);
  const terminalState = raw?.terminalState == null ? null : String(raw.terminalState);
  if (terminalState != null && !TERMINAL_STATES.has(terminalState)) throw new TypeError(`candidate ${candidateId} terminalState invalid`);
  const stageAuthorizations = Object.freeze({ ...(raw?.stageAuthorizations ?? {}) });
  return Object.freeze({
    candidateId,
    familyId,
    market,
    researchSha: candidateResearchSha,
    strategyHash: String(raw.strategyHash).toLowerCase(),
    parameterHash: String(raw.parameterHash).toLowerCase(),
    datasetSnapshotHash: String(raw.datasetSnapshotHash).toLowerCase(),
    completedStages: Object.freeze([...raw.completedStages]),
    terminalState,
    stageAuthorizations,
  });
}

function work(kind, priority, payload) {
  const identity = { kind, ...payload };
  return Object.freeze({
    id: `${kind.toLowerCase()}:sha256:${digest(identity)}`,
    kind,
    priority,
    ...payload,
  });
}

function blocker(code, payload = {}) {
  return Object.freeze({ code, ...payload });
}

function dedupeAndSort(tasks) {
  const byId = new Map();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  return [...byId.values()].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

export function planResearchFactoryCycle(raw = {}) {
  const researchSha = String(raw.researchSha ?? '').toLowerCase();
  if (!SHA40.test(researchSha)) throw new TypeError('researchSha must be an exact 40-character SHA');
  const observedAt = String(raw.observedAt ?? '');
  if (!Number.isFinite(Date.parse(observedAt))) throw new TypeError('observedAt must be an ISO timestamp');
  const budget = normalizeBudget(raw.budget);
  const markets = normalizeMarketData(raw.markets);
  const candidates = Object.freeze((raw.candidates ?? []).map((candidate) => normalizeCandidate(candidate, researchSha)));
  const failureMemory = new Set((raw.failureMemory ?? []).map((row) => String(row?.strategyHash ?? '').toLowerCase()).filter((row) => HASH64.test(row)));
  const blockers = [];
  const tasks = [];

  for (const [market, state] of Object.entries(markets)) {
    if (state.ready) continue;
    blockers.push(blocker('MARKET_DATA_NOT_READY', { market, missingFeatures: state.missingFeatures }));
    tasks.push(work('DATA_EVIDENCE', 100, {
      market,
      missingFeatures: state.missingFeatures,
      canonicalOwner: 'research-data-factory',
      executionAuthority: 'NONE',
    }));
  }

  const activePerFamily = new Map();
  for (const candidate of candidates) {
    if (!candidate.terminalState) activePerFamily.set(candidate.familyId, (activePerFamily.get(candidate.familyId) ?? 0) + 1);
    if (candidate.terminalState) continue;
    if (failureMemory.has(candidate.strategyHash)) {
      blockers.push(blocker('KNOWN_FAILED_STRATEGY', { candidateId: candidate.candidateId, strategyHash: candidate.strategyHash }));
      continue;
    }
    const marketState = markets[candidate.market];
    if (!marketState || marketState.ready !== true) {
      blockers.push(blocker('CANDIDATE_DATA_BLOCKED', { candidateId: candidate.candidateId, market: candidate.market }));
      continue;
    }
    if (marketState.datasetSnapshotHash !== candidate.datasetSnapshotHash) {
      blockers.push(blocker('DATASET_SNAPSHOT_MISMATCH', {
        candidateId: candidate.candidateId,
        market: candidate.market,
        candidateDatasetSnapshotHash: candidate.datasetSnapshotHash,
        marketDatasetSnapshotHash: marketState.datasetSnapshotHash,
      }));
      continue;
    }
    const nextStage = RESEARCH_FACTORY_STAGE_SEQUENCE[candidate.completedStages.length] ?? null;
    if (!nextStage) {
      blockers.push(blocker('CANDIDATE_AWAITS_TERMINAL_MARK', { candidateId: candidate.candidateId }));
      continue;
    }
    if (RESEARCH_FACTORY_GUARDED_STAGES.has(nextStage) && candidate.stageAuthorizations[nextStage] !== true) {
      blockers.push(blocker('STAGE_AUTHORIZATION_REQUIRED', { candidateId: candidate.candidateId, stage: nextStage }));
      continue;
    }
    tasks.push(work('RUN_STAGE', 80 - candidate.completedStages.length, {
      candidateId: candidate.candidateId,
      familyId: candidate.familyId,
      market: candidate.market,
      stage: nextStage,
      canonicalOwner: OWNER_BY_STAGE[nextStage],
      strategyHash: candidate.strategyHash,
      parameterHash: candidate.parameterHash,
      datasetSnapshotHash: candidate.datasetSnapshotHash,
      executionAuthority: 'NONE',
    }));
  }

  const ai = raw.ai ?? {};
  const dataReady = Object.keys(markets).length > 0 && Object.values(markets).every((row) => row.ready === true);
  const aiCallsUsed = Number.isSafeInteger(ai.callsUsed) && ai.callsUsed >= 0 ? ai.callsUsed : 0;
  if (ai.enabled === true && ai.freeOnly === true && ai.allowNewHypotheses === true && dataReady && aiCallsUsed < budget.maxAiCallsPerCycle) {
    const saturatedFamilies = [...activePerFamily.entries()].filter(([, count]) => count >= budget.maxCandidatesPerFamily).map(([familyId]) => familyId).sort();
    tasks.push(work('AI_PROPOSE', 10, {
      providerPolicy: 'FREE_ONLY',
      role: 'PROPOSER_CRITIC',
      saturatedFamilies: Object.freeze(saturatedFamilies),
      canonicalOwner: 'api-server/research-dual-free-ai',
      evidenceCredit: 0,
      executionAuthority: 'NONE',
    }));
  }

  const queue = Object.freeze(dedupeAndSort(tasks).slice(0, budget.maxQueue));
  return Object.freeze({
    schemaVersion: 'research-factory-plan-v1',
    researchSha,
    observedAt: new Date(observedAt).toISOString(),
    budget,
    queue,
    blockers: Object.freeze(blockers),
    summary: Object.freeze({
      marketCount: Object.keys(markets).length,
      marketReadyCount: Object.values(markets).filter((row) => row.ready).length,
      candidateCount: candidates.length,
      terminalCandidateCount: candidates.filter((row) => row.terminalState).length,
      queuedCount: queue.length,
      blockedCount: blockers.length,
      maxConcurrentJobs: budget.maxConcurrentJobs,
    }),
    safety: Object.freeze({
      branchWrite: false,
      productionDeploy: false,
      scheduleMutation: false,
      databaseMutation: false,
      secretMutation: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      championPromotion: false,
      profitabilityClaim: false,
      paidAiFallback: false,
      executionAuthority: 'NONE',
    }),
  });
}
