const RESEARCH_OVERVIEW_SCHEMA = 'research-dashboard-overview-v1';
const V3_INDEPENDENCE_SUMMARY_SCHEMA = 'public-forward-liquidity-v3-authoritative-independence-summary-v1';
const PROFILE_SET = new Set(['forward', 'fast-historical', 'long-history']);
const V3_INDEPENDENCE_STATUS_SET = new Set(['MISSING', 'INVALID', 'PRESENT']);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const DECIMAL_ID_PATTERN = /^[0-9]{6,20}$/;
const PRIVATE_TEXT_PATTERN = /(?:^[a-z]:[\\/]|\/(?:var|home|root|etc|opt|srv|users)\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]+)/i;
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

/**
 * Builds the only browser-facing Research DTO from an explicit allowlist.
 * Unknown upstream fields are intentionally dropped so a future state-file,
 * account, credential, or filesystem field cannot leak through object spread.
 */
export function sanitizeResearchCenterOverview(value: unknown): UnknownRecord | null {
  const payload = record(value);
  const state = record(payload?.state);
  const safety = record(payload?.safety);
  const research = record(payload?.research);
  const paper = record(payload?.paper);
  const shadow = record(payload?.shadow);
  const profitability = record(payload?.profitability);
  const runtime = sanitizePaperRuntime(paper?.runtime);
  const ledger = sanitizePaperLedger(paper?.ledger);
  const records = record(shadow?.records);
  const liquidityIndependence = sanitizeLiquidityIndependence(research?.liquidityIndependence);
  if (!payload || payload.schemaVersion !== RESEARCH_OVERVIEW_SCHEMA || !state || !safety || !research
    || !paper || !shadow || !profitability || !runtime || !ledger || !records || !liquidityIndependence) return null;
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
    state: { present: state.present, latestCycleAt },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: safety.authorityEvidenceComplete,
      forbiddenAuthorityObserved: safety.forbiddenAuthorityObserved,
    },
    research: { status: researchStatus, failedTasks, blockedDataTasks, cycles, liquidityIndependence },
    paper: { runtime, ledger },
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
