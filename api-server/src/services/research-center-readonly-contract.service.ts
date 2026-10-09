const RESEARCH_OVERVIEW_SCHEMA = 'research-dashboard-overview-v1';
const V3_INDEPENDENCE_SUMMARY_SCHEMA = 'public-forward-liquidity-v3-authoritative-independence-summary-v1';
const CANDIDATE_PERFORMANCE_SCHEMA = 'frozen-candidate-performance-reader-v1';
const PROFILE_SET = new Set(['forward', 'fast-historical', 'long-history']);
const V3_INDEPENDENCE_STATUS_SET = new Set(['MISSING', 'INVALID', 'PRESENT']);
const CANDIDATE_PERFORMANCE_STATUS_SET = new Set(['MISSING', 'INVALID', 'BLOCKED', 'PRESENT']);
const TEMPORAL_COLLECTION_STATUS_SET = new Set(['MISSING', 'INVALID', 'complete', 'partial_failure']);
const TEMPORAL_SYMBOL_STATUS_SET = new Set(['success', 'failed']);
const FORMULA_READBACK_STATUS_SET = new Set(['MISSING', 'INVALID', 'WAITING_INPUT', 'TRAIN_ONLY']);
const FORMULA_READBACK_COUNTS = ['PASS', 'HOLD', 'RESERVE', 'EXCLUDE'] as const;
const FORMULA_BLOCKERS = Object.freeze({
  MISSING: 'FORMULA_QUEUE_INPUT_MISSING',
  INVALID: 'FORMULA_QUEUE_READBACK_INVALID',
  WAITING_INPUT: 'FORMULA_QUEUE_INPUT_MISSING',
  TRAIN_ONLY: 'FORMULA_QUEUE_PRODUCER_AND_OOS_UNATTESTED',
});

const FACTORY_RUNTIME_STATUS_SET = new Set([
  'MISSING',
  'INVALID',
  'BLOCKED_POLICY_MISSING',
  'BLOCKED_POLICY_INVALID',
  'BLOCKED_NO_READY_PROFILES',
  'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
  'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID',
  'BLOCKED_RUNTIME_BINDINGS',
  'READY_NON_ACTIVATING',
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const CANDIDATE_ID_PATTERN = /^(?:phase3-candidate:sha256:|paper-candidate-v1:)[0-9a-f]{64}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const DECIMAL_ID_PATTERN = /^[0-9]{6,20}$/;
const PRIVATE_TEXT_PATTERN = /(?:^[a-z]:[\\/]|\/(?:var|home|root|etc|opt|srv|users)\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]+)/i;
const PRIVATE_EVIDENCE_KEY_PATTERN = /(?:secret|token|password|credential|private.?key|api.?key)/i;
const FIXTURE_PROVENANCE_PATTERN = /(?:^|[^a-z])(fixture|fake|example|tests?)(?:[^a-z]|$)/i;
const V3_SPLIT_COUNT_KEYS = Object.freeze([
  'TRAIN',
  'TRAIN_BUY',
  'TRAIN_SELL',
  'VALIDATION',
  'VALIDATION_BUY',
  'VALIDATION_SELL',
  'OOS',
  'OOS_BUY',
  'OOS_SELL',
]);
const CANDIDATE_COUNT_KEYS = Object.freeze([
  'effectiveIndependentMarketN', 'candidateMatchedN', 'LONG_SIGNAL_N', 'SHORT_SIGNAL_N', 'NO_TRADE_N',
  'Entry_N', 'Position_N', 'PositionObservation_N', 'Settlement_N',
  'TRAIN_N', 'VALIDATION_N', 'OOS_N', 'WIN_N', 'LOSS_N', 'BREAKEVEN_N',
]);
const CANDIDATE_METRIC_KEYS = Object.freeze([
  'WIN_RATE', 'AVG_WIN', 'AVG_LOSS', 'PAYOFF_RATIO', 'GROSS_EXPECTANCY',
  'PF', 'MDD', 'MFE', 'MAE', 'TIME_TO_EXIT', 'Gross_PnL', 'Net_PnL',
]);
const FULL_COST_KEYS = Object.freeze([
  'commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
]);
const FULL_COST_STATE_SET = new Set(['MEASURED', 'MODELED', 'UNKNOWN', 'BLOCKED_DATA']);

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function countOrNull(value: unknown): number | null | undefined {
  const number = finiteOrNull(value);
  if (number == null) return number;
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'boolean' ? value : undefined;
}

function safeTextOrNull(value: unknown, maximum = 240): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > maximum || PRIVATE_TEXT_PATTERN.test(text)) return undefined;
  return text;
}

function unsafeCandidateEvidence(value: unknown, key = ''): boolean {
  if (value == null) return false;
  if (PRIVATE_EVIDENCE_KEY_PATTERN.test(key)) return true;
  if (typeof value === 'string') {
    return (/path/i.test(key) && PRIVATE_TEXT_PATTERN.test(value))
      || (/(?:provenance|sourceOwner)/i.test(key) && FIXTURE_PROVENANCE_PATTERN.test(value));
  }
  if (Array.isArray(value)) return value.some((item) => unsafeCandidateEvidence(item, key));
  const input = record(value);
  return input ? Object.entries(input).some(([childKey, child]) => unsafeCandidateEvidence(child, childKey)) : false;
}

function unknownFullCostEvidence() {
  return {
    fullCostReady: false,
    components: Object.fromEntries(FULL_COST_KEYS.map((key) => [key, {
      state: 'UNKNOWN', valuePercent: null, provenance: null,
    }])),
  };
}

function sanitizeFullCostEvidence(value: unknown) {
  const input = record(value);
  const componentInput = record(input?.components);
  if (!input || input.fullCostReady !== false || !componentInput) return null;
  const components: UnknownRecord = {};
  for (const key of FULL_COST_KEYS) {
    const component = record(componentInput[key]);
    const state = safeTextOrNull(component?.state, 24);
    const valuePercent = finiteOrNull(component?.valuePercent);
    const provenance = safeTextOrNull(component?.provenance, 160);
    const valueReady = state === 'MEASURED' || state === 'MODELED';
    if (!component || !state || !FULL_COST_STATE_SET.has(state)
      || (valueReady && (valuePercent == null || valuePercent < 0))
      || (!valueReady && valuePercent !== null)
      || provenance === undefined) return null;
    components[key] = { state, valuePercent, provenance };
  }
  return { fullCostReady: false, components };
}

function emptyLiquidityIndependence(status: 'MISSING' | 'INVALID', present: boolean) {
  return {
    present,
    status,
    schemaVersion: null,
    producerSha: null,
    upstreamIngestRunId: null,
    upstreamIngestArtifactId: null,
    upstreamIngestArtifactDigest: null,
    sourceInventoryDigest: null,
    targetSlotIndex: null,
    genuineScheduledSlotN: null,
    rawAcceptedN: null,
    effectiveIndependentN: null,
    independentBuyN: null,
    independentSellN: null,
    independenceAuditDigest: null,
    independentSplitSourceDigest: null,
    v3IndependentSplitIndexDigest: null,
    frozenSplitCounts: Object.fromEntries(V3_SPLIT_COUNT_KEYS.map((key) => [key, null])),
    oosOutcomeCredit: null,
    calibrationArtifactProduced: null,
    liquidityImpactStatus: null,
    fullCostReady: null,
    evidenceComplete: null,
    executionAuthority: null,
    reportDigest: null,
  };
}

function sanitizeLiquidityIndependence(value: unknown) {
  if (value === undefined || value === null) return emptyLiquidityIndependence('MISSING', false);
  const input = record(value);
  if (!input || typeof input.present !== 'boolean') return null;
  const status = safeTextOrNull(input.status, 16);
  if (!status || !V3_INDEPENDENCE_STATUS_SET.has(status)) return null;
  if (status === 'MISSING') {
    if (input.present !== false) return null;
    return emptyLiquidityIndependence('MISSING', false);
  }
  if (status === 'INVALID') {
    if (input.present !== true) return null;
    return emptyLiquidityIndependence('INVALID', true);
  }
  if (input.present !== true || input.schemaVersion !== V3_INDEPENDENCE_SUMMARY_SCHEMA) return null;
  const producerSha = safeTextOrNull(input.producerSha, 40);
  const upstreamIngestRunId = safeTextOrNull(input.upstreamIngestRunId, 20);
  const upstreamIngestArtifactId = safeTextOrNull(input.upstreamIngestArtifactId, 20);
  const upstreamIngestArtifactDigest = safeTextOrNull(input.upstreamIngestArtifactDigest, 64);
  const sourceInventoryDigest = safeTextOrNull(input.sourceInventoryDigest, 64);
  const independenceAuditDigest = safeTextOrNull(input.independenceAuditDigest, 64);
  const independentSplitSourceDigest = safeTextOrNull(input.independentSplitSourceDigest, 64);
  const v3IndependentSplitIndexDigest = safeTextOrNull(input.v3IndependentSplitIndexDigest, 64);
  const reportDigest = safeTextOrNull(input.reportDigest, 64);
  const targetSlotIndex = countOrNull(input.targetSlotIndex);
  const genuineScheduledSlotN = countOrNull(input.genuineScheduledSlotN);
  const rawAcceptedN = countOrNull(input.rawAcceptedN);
  const effectiveIndependentN = countOrNull(input.effectiveIndependentN);
  const independentBuyN = countOrNull(input.independentBuyN);
  const independentSellN = countOrNull(input.independentSellN);
  const oosOutcomeCredit = countOrNull(input.oosOutcomeCredit);
  const evidenceComplete = countOrNull(input.evidenceComplete);
  const calibrationArtifactProduced = booleanOrNull(input.calibrationArtifactProduced);
  const fullCostReady = booleanOrNull(input.fullCostReady);
  const executionAuthority = safeTextOrNull(input.executionAuthority, 16);
  const liquidityImpactStatus = safeTextOrNull(input.liquidityImpactStatus, 40);
  const splitInput = record(input.frozenSplitCounts);
  const frozenSplitCounts = splitInput
    ? Object.fromEntries(V3_SPLIT_COUNT_KEYS.map((key) => [key, countOrNull(splitInput[key])]))
    : null;
  if (!producerSha || !SHA_PATTERN.test(producerSha)
    || !upstreamIngestRunId || !DECIMAL_ID_PATTERN.test(upstreamIngestRunId)
    || !upstreamIngestArtifactId || !DECIMAL_ID_PATTERN.test(upstreamIngestArtifactId)
    || !upstreamIngestArtifactDigest || !DIGEST_PATTERN.test(upstreamIngestArtifactDigest)
    || !sourceInventoryDigest || !DIGEST_PATTERN.test(sourceInventoryDigest)
    || !independenceAuditDigest || !DIGEST_PATTERN.test(independenceAuditDigest)
    || !independentSplitSourceDigest || !DIGEST_PATTERN.test(independentSplitSourceDigest)
    || !v3IndependentSplitIndexDigest || !DIGEST_PATTERN.test(v3IndependentSplitIndexDigest)
    || !reportDigest || !DIGEST_PATTERN.test(reportDigest)
    || targetSlotIndex === null || targetSlotIndex === undefined
    || genuineScheduledSlotN === null || genuineScheduledSlotN === undefined
    || rawAcceptedN === null || rawAcceptedN === undefined
    || effectiveIndependentN === null || effectiveIndependentN === undefined
    || independentBuyN === null || independentBuyN === undefined
    || independentSellN === null || independentSellN === undefined
    || oosOutcomeCredit !== 0
    || evidenceComplete !== 0
    || calibrationArtifactProduced !== false
    || fullCostReady !== false
    || executionAuthority !== 'NONE'
    || liquidityImpactStatus !== 'BLOCKED_DATA'
    || !frozenSplitCounts
    || Object.values(frozenSplitCounts).some((count) => count === undefined || count === null)) return null;
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: V3_INDEPENDENCE_SUMMARY_SCHEMA,
    producerSha,
    upstreamIngestRunId,
    upstreamIngestArtifactId,
    upstreamIngestArtifactDigest,
    sourceInventoryDigest,
    targetSlotIndex,
    genuineScheduledSlotN,
    rawAcceptedN,
    effectiveIndependentN,
    independentBuyN,
    independentSellN,
    independenceAuditDigest,
    independentSplitSourceDigest,
    v3IndependentSplitIndexDigest,
    frozenSplitCounts,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    reportDigest,
  };
}

function emptyCandidatePerformance(status: 'MISSING' | 'INVALID' | 'BLOCKED', present: boolean, reason: string) {
  return {
    present,
    status,
    schemaVersion: null,
    FIRST_ZERO: reason,
    reason,
    candidateId: null,
    strategyId: null,
    freezeTimestamp: null,
    identity14Verified: false,
    fullCostEvidence: unknownFullCostEvidence(),
    ...Object.fromEntries(CANDIDATE_COUNT_KEYS.map((key) => [key, null])),
    ...Object.fromEntries(CANDIDATE_METRIC_KEYS.map((key) => [key, null])),
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    executionAuthority: 'NONE',
  };
}

function sanitizeCandidatePerformance(value: unknown) {
  if (value === undefined || value === null) {
    return emptyCandidatePerformance('MISSING', false, 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING');
  }
  const input = record(value);
  if (!input || typeof input.present !== 'boolean') return null;
  if (unsafeCandidateEvidence(input)) return null;
  const status = safeTextOrNull(input.status, 16);
  if (!status || !CANDIDATE_PERFORMANCE_STATUS_SET.has(status)) return null;
  const reason = safeTextOrNull(input.reason, 160);
  if (!reason || !SAFE_ID_PATTERN.test(reason)) return null;
  if (status === 'MISSING') {
    return input.present === false
      ? emptyCandidatePerformance('MISSING', false, reason)
      : null;
  }
  if (status === 'INVALID') {
    return input.present === true
      ? emptyCandidatePerformance('INVALID', true, reason)
      : null;
  }
  if (input.FULL_COST_READY !== false
    || input.NET_ALPHA_PROVEN !== false
    || input.PROFITABILITY_PROVEN !== false
    || input.TRAIN_DIAGNOSTIC_ONLY !== true
    || input.VALIDATION_COMPLETE !== false
    || input.OOS_COMPLETE !== false
    || input.executionAuthority !== 'NONE') return null;
  const fullCostEvidence = sanitizeFullCostEvidence(input.fullCostEvidence);
  if (!fullCostEvidence) return null;
  const counts = Object.fromEntries(CANDIDATE_COUNT_KEYS.map((key) => [key, countOrNull(input[key])]));
  const metrics = Object.fromEntries(CANDIDATE_METRIC_KEYS.map((key) => [key, finiteOrNull(input[key])]));
  if (Object.values(counts).some((item) => item === undefined)
    || Object.values(metrics).some((item) => item === undefined)) return null;
  if (status === 'BLOCKED') {
    const unavailable = [input.candidateId, input.strategyId, input.freezeTimestamp,
      ...Object.values(counts), ...Object.values(metrics)].every((item) => item == null);
    return input.present === true && unavailable
      ? emptyCandidatePerformance('BLOCKED', true, reason)
      : null;
  }
  if (status !== 'PRESENT' || input.present !== true || input.schemaVersion !== CANDIDATE_PERFORMANCE_SCHEMA) return null;
  const candidateId = safeTextOrNull(input.candidateId, 100);
  const strategyId = safeTextOrNull(input.strategyId, 160);
  const freezeTimestamp = safeTextOrNull(input.freezeTimestamp, 40);
  const freezeMs = Date.parse(String(freezeTimestamp ?? ''));
  if (!candidateId || !CANDIDATE_ID_PATTERN.test(candidateId)
    || !strategyId || !SAFE_ID_PATTERN.test(strategyId)
    || !freezeTimestamp || !Number.isSafeInteger(freezeMs)
    || new Date(freezeMs).toISOString() !== freezeTimestamp
    || input.identity14Verified !== true) return null;
  const directionCounts = [counts.LONG_SIGNAL_N, counts.SHORT_SIGNAL_N, counts.NO_TRADE_N];
  const splitCounts = [counts.TRAIN_N, counts.VALIDATION_N, counts.OOS_N];
  const matchValid = counts.candidateMatchedN == null
    ? [...directionCounts, ...splitCounts].every((item) => item == null)
    : directionCounts.every((item) => item != null)
      && splitCounts.every((item) => item != null)
      && directionCounts.reduce((sum, item) => sum + (item ?? 0), 0) === counts.candidateMatchedN
      && splitCounts.reduce((sum, item) => sum + (item ?? 0), 0) === counts.candidateMatchedN;
  const settlementCounts = [counts.WIN_N, counts.LOSS_N, counts.BREAKEVEN_N];
  const settlementValid = counts.Settlement_N == null
    ? settlementCounts.every((item) => item == null) && metrics.Gross_PnL == null
    : settlementCounts.every((item) => item != null)
      && settlementCounts.reduce((sum, item) => sum + (item ?? 0), 0) === counts.Settlement_N
      && metrics.Gross_PnL != null;
  const lifecycleValid = (counts.Entry_N == null || counts.Position_N == null || counts.Position_N <= counts.Entry_N)
    && (counts.Position_N == null || counts.Settlement_N == null || counts.Settlement_N <= counts.Position_N);
  if (!matchValid || !settlementValid || !lifecycleValid || metrics.Net_PnL != null) return null;
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: CANDIDATE_PERFORMANCE_SCHEMA,
    FIRST_ZERO: reason,
    reason,
    candidateId,
    strategyId,
    freezeTimestamp,
    identity14Verified: true,
    fullCostEvidence,
    ...counts,
    ...metrics,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    executionAuthority: 'NONE',
  };
}

function sanitizeTask(value: unknown) {
  const task = record(value);
  if (!task) return null;
  const id = safeTextOrNull(task.id, 160);
  const status = safeTextOrNull(task.status, 80);
  const durationMs = finiteOrNull(task.durationMs);
  const startedAt = finiteOrNull(task.startedAt);
  const endedAt = finiteOrNull(task.endedAt);
  if (!id || !status || durationMs === undefined || startedAt === undefined || endedAt === undefined || typeof task.timedOut !== 'boolean') return null;
  return { id, status, durationMs, startedAt, endedAt, timedOut: task.timedOut };
}

function sanitizeCycle(value: unknown) {
  const cycle = record(value);
  if (!cycle || !PROFILE_SET.has(String(cycle.profile)) || typeof cycle.present !== 'boolean') return null;
  const status = safeTextOrNull(cycle.status, 80);
  const cycleId = safeTextOrNull(cycle.cycleId, 160);
  const researchSha = safeTextOrNull(cycle.researchSha, 40);
  const generatedAt = finiteOrNull(cycle.generatedAt);
  const concurrency = countOrNull(cycle.concurrency);
  const taskCount = countOrNull(cycle.taskCount);
  const successCount = countOrNull(cycle.successCount);
  const blockedDataCount = countOrNull(cycle.blockedDataCount);
  const failedCount = countOrNull(cycle.failedCount);
  const tasks = Array.isArray(cycle.tasks) ? cycle.tasks.map(sanitizeTask) : null;
  if (!status || cycleId === undefined || researchSha === undefined || generatedAt === undefined
    || concurrency === undefined || taskCount === undefined || successCount === undefined
    || blockedDataCount === undefined || failedCount === undefined || !tasks || tasks.some((task) => !task)) return null;
  if (researchSha !== null && !SHA_PATTERN.test(researchSha)) return null;
  return {
    profile: cycle.profile,
    present: cycle.present,
    status,
    cycleId,
    researchSha,
    generatedAt,
    concurrency,
    taskCount,
    successCount,
    blockedDataCount,
    failedCount,
    tasks,
  };
}

function sanitizePaperRuntime(value: unknown) {
  const runtime = record(value);
  if (!runtime || typeof runtime.present !== 'boolean') return null;
  const status = safeTextOrNull(runtime.status, 80);
  const cycleId = safeTextOrNull(runtime.cycleId, 160);
  const scheduleActive = booleanOrNull(runtime.scheduleActive);
  const allProvidersReady = booleanOrNull(runtime.allProvidersReady);
  const publicForwardEvidenceAccumulating = booleanOrNull(runtime.publicForwardEvidenceAccumulating);
  const paperTradeOutcomeAccumulating = booleanOrNull(runtime.paperTradeOutcomeAccumulating);
  const privateRequestCount = countOrNull(runtime.privateRequestCount);
  const financialMutationCount = countOrNull(runtime.financialMutationCount);
  const orderCount = countOrNull(runtime.orderCount);
  const liveTrading = booleanOrNull(runtime.liveTrading);
  const orderAuthority = booleanOrNull(runtime.orderAuthority);
  const lanes = Array.isArray(runtime.lanes) ? runtime.lanes.map((value) => {
    const lane = record(value);
    const market = safeTextOrNull(lane?.market, 80);
    const laneStatus = safeTextOrNull(lane?.status, 80);
    return market && laneStatus ? { market, status: laneStatus } : null;
  }) : null;
  if (!status || cycleId === undefined || scheduleActive === undefined || allProvidersReady === undefined
    || publicForwardEvidenceAccumulating === undefined || paperTradeOutcomeAccumulating === undefined
    || privateRequestCount === undefined || financialMutationCount === undefined || orderCount === undefined
    || liveTrading === undefined || orderAuthority === undefined || typeof runtime.safetyEvidenceComplete !== 'boolean'
    || !lanes || lanes.some((lane) => !lane)) return null;
  return {
    present: runtime.present,
    status,
    cycleId,
    scheduleActive,
    allProvidersReady,
    publicForwardEvidenceAccumulating,
    paperTradeOutcomeAccumulating,
    privateRequestCount,
    financialMutationCount,
    orderCount,
    liveTrading,
    orderAuthority,
    safetyEvidenceComplete: runtime.safetyEvidenceComplete,
    lanes,
  };
}

function sanitizePaperLedger(value: unknown) {
  const ledger = record(value);
  if (!ledger || typeof ledger.present !== 'boolean') return null;
  const cycleCount = countOrNull(ledger.cycleCount);
  const sampleCount = countOrNull(ledger.sampleCount);
  const positionCount = countOrNull(ledger.positionCount);
  const settlementCount = countOrNull(ledger.settlementCount);
  if ([cycleCount, sampleCount, positionCount, settlementCount].some((item) => item === undefined)) return null;
  return { present: ledger.present, cycleCount, sampleCount, positionCount, settlementCount };
}

function emptyTemporalCryptoSummary(status: 'MISSING' | 'INVALID' = 'MISSING', present = false) {
  return {
    present,
    status,
    generatedAt: null,
    researchSha: null,
    failedCount: null,
    observationCount: null,
    ledgerDigest: null,
    results: [] as Array<{ symbol: string; status: 'success' | 'failed'; observedCount: number; appendedCount: number }>,
  };
}

function sanitizeTemporalCryptoSummary(value: unknown) {
  if (value === undefined || value === null) return emptyTemporalCryptoSummary();
  const input = record(value);
  if (!input || typeof input.present !== 'boolean') return null;
  const status = safeTextOrNull(input.status, 32);
  if (!status || !TEMPORAL_COLLECTION_STATUS_SET.has(status)) return null;
  if (status === 'MISSING') return input.present === false ? emptyTemporalCryptoSummary() : null;
  if (status === 'INVALID') return input.present === true ? emptyTemporalCryptoSummary('INVALID', true) : null;
  if (input.present !== true) return null;
  const generatedAt = finiteOrNull(input.generatedAt);
  const researchSha = safeTextOrNull(input.researchSha, 40);
  const failedCount = countOrNull(input.failedCount);
  const observationCount = countOrNull(input.observationCount);
  const ledgerDigest = safeTextOrNull(input.ledgerDigest, 64);
  if (generatedAt === null || generatedAt === undefined || generatedAt <= 0
    || !researchSha || !SHA_PATTERN.test(researchSha)
    || failedCount === null || failedCount === undefined
    || observationCount === null || observationCount === undefined
    || !ledgerDigest || !DIGEST_PATTERN.test(ledgerDigest)
    || !Array.isArray(input.results) || input.results.length > 50) return null;
  const results = input.results.map((raw) => {
    const row = record(raw);
    const symbol = safeTextOrNull(row?.symbol, 30);
    const rowStatus = safeTextOrNull(row?.status, 16);
    const observedCount = countOrNull(row?.observedCount);
    const appendedCount = countOrNull(row?.appendedCount);
    if (!row || !symbol || !/^[A-Z0-9]{3,30}$/.test(symbol)
      || !rowStatus || !TEMPORAL_SYMBOL_STATUS_SET.has(rowStatus)
      || observedCount === null || observedCount === undefined
      || appendedCount === null || appendedCount === undefined
      || appendedCount > observedCount) return null;
    return { symbol, status: rowStatus as 'success' | 'failed', observedCount, appendedCount };
  });
  if (results.some((row) => !row) || results.filter((row) => row?.status === 'failed').length !== failedCount) return null;
  return {
    present: true,
    status,
    generatedAt,
    researchSha: researchSha.toLowerCase(),
    failedCount,
    observationCount,
    ledgerDigest: ledgerDigest.toLowerCase(),
    results,
  };
}

function emptyFactoryRuntimeSummary(status: 'MISSING' | 'INVALID' = 'MISSING', present = false) {
  return {
    present,
    status,
    generatedAt: null,
    researchSha: null,
    firstZero: null,
    policyPresent: null,
    policyValid: null,
    policyDigest: null,
    readyMarketCount: null,
    blockedMarketCount: null,
    readyProfileCount: null,
    blockedProfileCount: null,
    runtimeStatus: null,
    nextFirstZero: null,
    controlPlaneDigest: null,
  };
}

function sanitizeFactoryRuntimeSummary(value: unknown) {
  if (value === undefined || value === null) return emptyFactoryRuntimeSummary();
  const input = record(value);
  if (!input || typeof input.present !== 'boolean') return null;
  const status = safeTextOrNull(input.status, 64);
  if (!status || !FACTORY_RUNTIME_STATUS_SET.has(status)) return null;
  if (status === 'MISSING') return input.present === false ? emptyFactoryRuntimeSummary() : null;
  if (status === 'INVALID') return input.present === true ? emptyFactoryRuntimeSummary('INVALID', true) : null;
  if (input.present !== true) return null;

  const generatedAt = finiteOrNull(input.generatedAt);
  const researchSha = safeTextOrNull(input.researchSha, 40);
  const firstZero = safeTextOrNull(input.firstZero, 160);
  const policyPresent = booleanOrNull(input.policyPresent);
  const policyValid = booleanOrNull(input.policyValid);
  const policyDigest = safeTextOrNull(input.policyDigest, 64);
  const readyMarketCount = countOrNull(input.readyMarketCount);
  const blockedMarketCount = countOrNull(input.blockedMarketCount);
  const readyProfileCount = countOrNull(input.readyProfileCount);
  const blockedProfileCount = countOrNull(input.blockedProfileCount);
  const runtimeStatus = safeTextOrNull(input.runtimeStatus, 80);
  const nextFirstZero = safeTextOrNull(input.nextFirstZero, 160);
  const controlPlaneDigest = safeTextOrNull(input.controlPlaneDigest, 64);

  if (generatedAt === null || generatedAt === undefined || generatedAt <= 0
    || !researchSha || !SHA_PATTERN.test(researchSha)
    || !firstZero || !SAFE_ID_PATTERN.test(firstZero)
    || policyPresent === null || policyPresent === undefined
    || policyValid === null || policyValid === undefined
    || readyMarketCount === undefined || blockedMarketCount === undefined
    || readyProfileCount === undefined || blockedProfileCount === undefined
    || (policyDigest != null && !DIGEST_PATTERN.test(policyDigest))
    || (controlPlaneDigest != null && !DIGEST_PATTERN.test(controlPlaneDigest))
    || (runtimeStatus != null && !SAFE_ID_PATTERN.test(runtimeStatus))
    || (nextFirstZero != null && !SAFE_ID_PATTERN.test(nextFirstZero))
    || (!policyPresent && (policyValid || policyDigest != null))) return null;

  return {
    present: true,
    status,
    generatedAt,
    researchSha: researchSha.toLowerCase(),
    firstZero,
    policyPresent,
    policyValid,
    policyDigest: policyDigest?.toLowerCase() ?? null,
    readyMarketCount,
    blockedMarketCount,
    readyProfileCount,
    blockedProfileCount,
    runtimeStatus,
    nextFirstZero,
    controlPlaneDigest: controlPlaneDigest?.toLowerCase() ?? null,
  };
}

function emptyRuntimeLiveness() {
  return {
    status: 'UNKNOWN' as const,
    lastSuccessAt: null,
    expectedNextAt: null,
    ageMs: null,
    missedCycles: null,
    stale: false,
    cadenceMs: 60 * 60 * 1000,
  };
}

function sanitizeRuntimeLiveness(value: unknown) {
  if (value === undefined || value === null) return emptyRuntimeLiveness();
  const input = record(value);
  if (!input) return null;
  const status = safeTextOrNull(input.status, 24);
  const lastSuccessAt = finiteOrNull(input.lastSuccessAt);
  const expectedNextAt = finiteOrNull(input.expectedNextAt);
  const ageMs = finiteOrNull(input.ageMs);
  const missedCycles = countOrNull(input.missedCycles);
  const cadenceMs = finiteOrNull(input.cadenceMs);
  if (!status || !new Set(['UNKNOWN', 'LIVE', 'STALE', 'INVALID']).has(status)
    || lastSuccessAt === undefined || expectedNextAt === undefined || ageMs === undefined
    || missedCycles === undefined || cadenceMs == null || cadenceMs <= 0
    || typeof input.stale !== 'boolean'
    || (ageMs != null && ageMs < 0)
    || (status === 'UNKNOWN' && (lastSuccessAt != null || expectedNextAt != null || ageMs != null || missedCycles != null || input.stale))
    || (status === 'STALE' && input.stale !== true)
    || (status === 'LIVE' && input.stale !== false)) return null;
  return { status, lastSuccessAt, expectedNextAt, ageMs, missedCycles, stale: input.stale, cadenceMs };
}

function sanitizeShadowGroup(value: unknown) {
  const group = record(value);
  const name = safeTextOrNull(group?.name, 120);
  if (!group || !name) return null;
  const total = countOrNull(group.total);
  const settled = countOrNull(group.settled);
  const pending = countOrNull(group.pending);
  const collapsed = booleanOrNull(group.collapsed);
  const macroF1 = finiteOrNull(group.macroF1);
  const balancedAccuracy = finiteOrNull(group.balancedAccuracy);
  const bullRecall = finiteOrNull(group.bullRecall);
  const bearRecall = finiteOrNull(group.bearRecall);
  const neutralRecall = finiteOrNull(group.neutralRecall);
  if ([total, settled, pending, collapsed, macroF1, balancedAccuracy, bullRecall, bearRecall, neutralRecall].some((item) => item === undefined)) return null;
  return { name, total, settled, pending, collapsed, macroF1, balancedAccuracy, bullRecall, bearRecall, neutralRecall };
}

function emptyFormulaBacktestReadback(status: 'MISSING' | 'INVALID' = 'MISSING') {
  return {
    present: status === 'INVALID', status,
    inboxCount: null, scanned: null,
    counts: Object.fromEntries(FORMULA_READBACK_COUNTS.map((key) => [key, null])),
    paperRegisteredCount: null,
    producerBound: false, paperConsumerBound: false,
    validationComplete: false, oosComplete: false, fullCostReady: false,
    liveTrading: false, autoTrading: false, executionAuthority: 'NONE' as const,
    firstBlocker: FORMULA_BLOCKERS[status],
  };
}

function sanitizeFormulaBacktestReadback(value: unknown) {
  const input = record(value);
  if (!input) return emptyFormulaBacktestReadback();
  const invalid = () => emptyFormulaBacktestReadback('INVALID');
  const status = input.status;
  if (typeof status !== 'string' || !FORMULA_READBACK_STATUS_SET.has(status)
    || input.present !== (status !== 'MISSING')
    || input.producerBound !== false || input.paperConsumerBound !== false
    || input.validationComplete !== false || input.oosComplete !== false
    || input.fullCostReady !== false
    || input.liveTrading !== false || input.autoTrading !== false
    || input.executionAuthority !== 'NONE'
    || input.firstBlocker !== FORMULA_BLOCKERS[status as keyof typeof FORMULA_BLOCKERS]) return invalid();

  const counts = record(input.counts);
  if (!counts) return invalid();
  if (status === 'MISSING' || status === 'INVALID') {
    if (input.scanned !== null || input.inboxCount !== null
      || input.paperRegisteredCount !== null
      || FORMULA_READBACK_COUNTS.some((key) => counts[key] !== null)) return invalid();
    return emptyFormulaBacktestReadback(status);
  }
  const scanned = countOrNull(input.scanned);
  const inboxCount = countOrNull(input.inboxCount);
  const registered = countOrNull(input.paperRegisteredCount);
  const cleanCounts = Object.fromEntries(FORMULA_READBACK_COUNTS.map((key) => [key, countOrNull(counts[key])]));
  if (scanned == null || scanned > 50 || inboxCount == null || scanned > inboxCount
    || registered !== 0
    || FORMULA_READBACK_COUNTS.some((key) => cleanCounts[key] == null)
    || cleanCounts.PASS !== 0
    || FORMULA_READBACK_COUNTS.reduce((sum, key) => sum + cleanCounts[key]!, 0) > scanned
    || (status === 'WAITING_INPUT' && scanned !== 0)
    || (status === 'TRAIN_ONLY' && scanned === 0)) return invalid();
  return {
    present: true, status,
    inboxCount, scanned, counts: cleanCounts, paperRegisteredCount: 0,
    producerBound: false, paperConsumerBound: false,
    validationComplete: false, oosComplete: false, fullCostReady: false,
    liveTrading: false, autoTrading: false, executionAuthority: 'NONE' as const,
    firstBlocker: FORMULA_BLOCKERS[status as keyof typeof FORMULA_BLOCKERS],
  };
}

/**
 * Builds the only browser-facing Research DTO from an explicit allowlist.
 * Unknown upstream fields are intentionally dropped so a future state-file,
 * account, credential, or filesystem field cannot leak through object spread.
 */
const MARKET_WATCH_READBACK_CONTRACT = 'lightweight-market-watch-readback/v1';
const MARKET_WATCH_STATES = new Set(['MISSING', 'INVALID', 'STALE', 'HOLD', 'THROTTLED', 'BLOCKED_DATA', 'OBSERVING', 'PARTIAL']);
const WATCH_MARKETS = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
const WATCH_HEALTHY_SOURCE = new Set(['READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE']);
const WATCH_BLOCKED_SOURCE = /^BLOCKED_[A-Z0-9_]{1,100}$/u;

function emptyMarketWatch(status: 'MISSING' | 'INVALID' = 'MISSING', present = false) {
  return {
    contract: MARKET_WATCH_READBACK_CONTRACT,
    status, present, researchSha: null, observedAt: null, ageMs: null,
    marketCoverageCount: null, markets: [] as unknown[],
    cyclesToday: null, candidatesToday: null, cyclesSinceRelease: null,
    prospectiveSampleStudy: null,
    continuous24hProven: false, formulaCandidateProduced: false,
    oosProven: false, paperExecutionProven: false,
    profitabilityProven: false, executionAuthority: 'NONE',
  };
}
function watchSafeCount(value: unknown, upper: number) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value < upper ? value : null;
}
export function sanitizeMarketWatchReadback(value: unknown) {
  if (value == null) return emptyMarketWatch();
  const v = record(value);
  if (!v || v.contract !== MARKET_WATCH_READBACK_CONTRACT
    || typeof v.status !== 'string' || !MARKET_WATCH_STATES.has(v.status)
    || typeof v.present !== 'boolean' || v.executionAuthority !== 'NONE'
    || v.continuous24hProven !== false || v.formulaCandidateProduced !== false
    || v.oosProven !== false || v.paperExecutionProven !== false
    || v.profitabilityProven !== false) return emptyMarketWatch('INVALID', true);
  if (v.status === 'MISSING') return v.present === false
    ? emptyMarketWatch() : emptyMarketWatch('INVALID', true);
  if (v.status === 'INVALID') return emptyMarketWatch('INVALID', true);
  if (v.present !== true
    || typeof v.researchSha !== 'string' || !SHA_PATTERN.test(v.researchSha)
    || !Array.isArray(v.markets) || v.markets.length !== WATCH_MARKETS.length) {
    return emptyMarketWatch('INVALID', true);
  }
  const observedAt = finiteOrNull(v.observedAt);
  const ageMs = watchSafeCount(v.ageMs, 1_000_000_000);
  const coverage = watchSafeCount(v.marketCoverageCount, 5);
  const cyclesToday = watchSafeCount(v.cyclesToday, 1_000_000_000_000);
  const candidatesToday = watchSafeCount(v.candidatesToday, 1_000_000_000_000);
  const cyclesSinceRelease = watchSafeCount(v.cyclesSinceRelease, 1_000_000_000_000);
  if (observedAt == null || observedAt <= 0 || ageMs == null || coverage == null
    || cyclesToday == null || cyclesToday < 1 || candidatesToday == null
    || cyclesSinceRelease == null || cyclesSinceRelease < cyclesToday) {
    return emptyMarketWatch('INVALID', true);
  }
  // A public ticker excursion is NOT a fill, formula PASS, OOS sample or PnL.
  let prospectiveSampleStudy: null | {
    status: 'PUBLIC_PRICE_OBSERVATION_ONLY';
    pendingCount: number; observedCoarseToday: number;
    blockedToday: number; untrackedThisCycle: number;
    economicEvidenceCredit: 0; paperCredit: 0; oosCredit: 0;
  } = null;
  if (v.prospectiveSampleStudy != null) {
    const row = record(v.prospectiveSampleStudy);
    const pending = watchSafeCount(row?.pendingCount, 1025);
    const observed = watchSafeCount(row?.observedCoarseToday, 1_000_000_000_000);
    const blocked = watchSafeCount(row?.blockedToday, 1_000_000_000_000);
    const untracked = watchSafeCount(row?.untrackedThisCycle, 49);
    if (!row || row.status !== 'PUBLIC_PRICE_OBSERVATION_ONLY'
      || pending == null || observed == null || blocked == null
      || untracked == null || row.economicEvidenceCredit !== 0
      || row.paperCredit !== 0 || row.oosCredit !== 0) {
      return emptyMarketWatch('INVALID', true);
    }
    prospectiveSampleStudy = {
      status: 'PUBLIC_PRICE_OBSERVATION_ONLY', pendingCount: pending,
      observedCoarseToday: observed, blockedToday: blocked,
      untrackedThisCycle: untracked,
      economicEvidenceCredit: 0, paperCredit: 0, oosCredit: 0,
    };
  }
  const rows = v.markets.map((raw, index) => {
    const row = record(raw);
    const status = row?.status;
    const source = row?.source;
    const listedCount = watchSafeCount(row?.listedCount, 30_001);
    const observedCount = watchSafeCount(row?.observedCount, 8_001);
    const newCandidates = watchSafeCount(row?.newCandidates, 13);
    const blocked = typeof status === 'string' && WATCH_BLOCKED_SOURCE.test(status);
    const healthy = typeof status === 'string' && WATCH_HEALTHY_SOURCE.has(status);
    if (!row || row.market !== WATCH_MARKETS[index]
      || typeof source !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(source)
      || !(blocked || healthy) || (blocked && source !== 'NONE')
      || (healthy && source === 'NONE') || listedCount == null
      || observedCount == null || newCandidates == null || observedCount > listedCount
      || newCandidates > observedCount || row.executionAuthority !== 'NONE'
      || (status === 'READY' && listedCount !== observedCount)
      || (blocked && (newCandidates !== 0 || observedCount !== 0))) return null;
    return { market: WATCH_MARKETS[index], status, source, listedCount, observedCount, newCandidates };
  });
  if (rows.some((row) => row == null)
    || rows.filter((row) => row?.status === 'READY').length !== coverage
    || (v.status === 'OBSERVING' && coverage !== 4)) {
    return emptyMarketWatch('INVALID', true);
  }
  return {
    contract: MARKET_WATCH_READBACK_CONTRACT,
    status: v.status, present: true, researchSha: v.researchSha.toLowerCase(),
    observedAt, ageMs, marketCoverageCount: coverage, markets: rows,
    cyclesToday, candidatesToday, cyclesSinceRelease, prospectiveSampleStudy,
    continuous24hProven: false, formulaCandidateProduced: false,
    oosProven: false, paperExecutionProven: false,
    profitabilityProven: false, executionAuthority: 'NONE',
  };
}

export function sanitizeResearchCenterOverview(value: unknown): UnknownRecord | null {
  const payload = record(value);
  const state = record(payload?.state);
  const safety = record(payload?.safety);
  const research = record(payload?.research);
  const paper = record(payload?.paper);
  const shadow = record(payload?.shadow);
  const profitability = record(payload?.profitability);
  const dataFactory = record(payload?.dataFactory);
  const factory = sanitizeFactoryRuntimeSummary(payload?.factory);
  const runtimeLiveness = sanitizeRuntimeLiveness(state?.runtimeLiveness);
  const runtime = sanitizePaperRuntime(paper?.runtime);
  const ledger = sanitizePaperLedger(paper?.ledger);
  const candidatePerformance = sanitizeCandidatePerformance(paper?.candidatePerformance);
  const temporalCryptoFutures = sanitizeTemporalCryptoSummary(dataFactory?.temporalCryptoFutures);
  const records = record(shadow?.records);
  const liquidityIndependence = sanitizeLiquidityIndependence(research?.liquidityIndependence);
  const formulaBacktest = sanitizeFormulaBacktestReadback(research?.formulaBacktest);
  const lightweightMarketWatch = sanitizeMarketWatchReadback(dataFactory?.lightweightMarketWatch);
  if (!payload || payload.schemaVersion !== RESEARCH_OVERVIEW_SCHEMA || !state || !safety || !research
    || !paper || !shadow || !profitability || !runtime || !ledger || !candidatePerformance || !temporalCryptoFutures || !factory || !runtimeLiveness || !records || !liquidityIndependence) return null;
  if (safety.readOnlyDashboard !== true || safety.liveTrading !== false || safety.privateApi !== false || safety.orderAuthority !== false
    || typeof safety.authorityEvidenceComplete !== 'boolean' || typeof safety.forbiddenAuthorityObserved !== 'boolean') return null;
  const generatedAt = finiteOrNull(payload.generatedAt);
  const latestCycleAt = finiteOrNull(state.latestCycleAt);
  const failedTasks = countOrNull(research.failedTasks);
  const blockedDataTasks = countOrNull(research.blockedDataTasks);
  const researchStatus = safeTextOrNull(research.status, 80);
  const cycles = Array.isArray(research.cycles) ? research.cycles.map(sanitizeCycle) : null;
  const groups = Array.isArray(shadow.groups) ? shadow.groups.map(sanitizeShadowGroup) : null;
  const totalRecords = countOrNull(records.totalRecords);
  const settledRecords = countOrNull(records.settledRecords);
  const pendingRecords = countOrNull(records.pendingRecords);
  const profitabilityStatus = safeTextOrNull(profitability.status, 80);
  const profitabilityNote = safeTextOrNull(profitability.note, 500);
  if (generatedAt === null || generatedAt === undefined || typeof state.present !== 'boolean' || latestCycleAt === undefined
    || failedTasks === undefined || blockedDataTasks === undefined || !researchStatus || !cycles || cycles.some((cycle) => !cycle)
    || !groups || groups.some((group) => !group) || typeof records.present !== 'boolean'
    || totalRecords === undefined || settledRecords === undefined || pendingRecords === undefined
    || typeof profitability.proven !== 'boolean' || !profitabilityStatus || !profitabilityNote) return null;
  return {
    schemaVersion: RESEARCH_OVERVIEW_SCHEMA,
    generatedAt,
    state: { present: state.present, latestCycleAt, runtimeLiveness },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: safety.authorityEvidenceComplete,
      forbiddenAuthorityObserved: safety.forbiddenAuthorityObserved,
    },
    research: { status: researchStatus, failedTasks, blockedDataTasks, cycles, liquidityIndependence, formulaBacktest },
    dataFactory: { temporalCryptoFutures, lightweightMarketWatch },
    factory,
    paper: { runtime, ledger, candidatePerformance },
    shadow: { groups, records: { present: records.present, totalRecords, settledRecords, pendingRecords } },
    profitability: { proven: profitability.proven, status: profitabilityStatus, note: profitabilityNote },
  };
}

export const RESEARCH_CENTER_READONLY_CONTRACT = Object.freeze({
  methods: Object.freeze(['GET']),
  schemaVersion: RESEARCH_OVERVIEW_SCHEMA,
  unknownFieldsDropped: true,
  privateAccountFieldsExposed: false,
  filesystemPathsExposed: false,
  credentialsExposed: false,
  executionAuthority: 'NONE',
});
