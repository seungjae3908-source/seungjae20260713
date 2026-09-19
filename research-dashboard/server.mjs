import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STATE_ROOT = '/var/lib/investment-research-production';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18090;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const PROFILES = ['forward', 'fast-historical', 'long-history'];
const V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH = Object.freeze([
  'forward',
  'liquidity',
  'v3-authoritative-independence-summary.json',
]);
const V3_INDEPENDENCE_SUMMARY_SCHEMA = 'public-forward-liquidity-v3-authoritative-independence-summary-v1';
const CANDIDATE_PERFORMANCE_SCHEMA = 'frozen-candidate-performance-reader-v1';
const CANDIDATE_PERFORMANCE_RELATIVE_PATH = Object.freeze([
  'forward',
  'paper',
  'status',
  'candidate-performance.json',
]);
const TEMPORAL_CRYPTO_SUMMARY_RELATIVE_PATH = Object.freeze([
  'latest',
  'temporal-crypto-futures.json',
]);
const TEMPORAL_CRYPTO_SUMMARY_SCHEMA = 'crypto-futures-temporal-public-collection-v1';
const TEMPORAL_COLLECTION_STATUSES = new Set(['complete', 'partial_failure']);
const TEMPORAL_SYMBOL_STATUSES = new Set(['success', 'failed']);
const FACTORY_RUNTIME_CONTRACT = 'research-factory-runtime-status/v1';
const FACTORY_RUNTIME_STATUSES = new Set([
  'BLOCKED_POLICY_MISSING',
  'BLOCKED_POLICY_INVALID',
  'BLOCKED_NO_READY_PROFILES',
  'BLOCKED_RUNTIME_BINDINGS',
  'READY_NON_ACTIVATING',
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CANDIDATE_ID_PATTERN = /^(?:phase3-candidate:sha256:|paper-candidate-v1:)[0-9a-f]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const CANDIDATE_COUNT_KEYS = Object.freeze([
  'effectiveIndependentMarketN', 'candidateMatchedN', 'LONG_SIGNAL_N', 'SHORT_SIGNAL_N', 'NO_TRADE_N',
  'Entry_N', 'Position_N', 'PositionObservation_N', 'Settlement_N',
  'TRAIN_N', 'VALIDATION_N', 'OOS_N', 'WIN_N', 'LOSS_N', 'BREAKEVEN_N',
]);
const CANDIDATE_METRIC_KEYS = Object.freeze([
  'WIN_RATE', 'AVG_WIN', 'AVG_LOSS', 'PAYOFF_RATIO', 'GROSS_EXPECTANCY',
  'PF', 'MDD', 'MFE', 'MAE', 'TIME_TO_EXIT', 'Gross_PnL', 'Net_PnL',
]);
const CANDIDATE_IDENTITY_KEYS = Object.freeze([
  'candidateId', 'strategyId', 'strategyVersion', 'parameterHash', 'researchCodeSha',
  'market', 'provider', 'symbol', 'timeframe', 'sidePolicy', 'accountMode',
  'costPolicyVersion', 'executionPolicyVersion',
]);
const FULL_COST_KEYS = Object.freeze([
  'commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
]);
const FULL_COST_STATES = new Set(['MEASURED', 'MODELED', 'UNKNOWN', 'BLOCKED_DATA']);
const FORBIDDEN_EVIDENCE_KEY = /(?:secret|token|password|credential|private.?key|api.?key)/iu;
const FORBIDDEN_PROVENANCE = /(?:^|[^a-z])(fixture|fake|example|tests?)(?:[^a-z]|$)/iu;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\/)/iu;
const SPLIT_COUNT_KEYS = Object.freeze([
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

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalIntegerCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function candidateCount(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function candidateMetric(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unknownFullCostEvidence() {
  return Object.freeze({
    fullCostReady: false,
    components: Object.freeze(Object.fromEntries(FULL_COST_KEYS.map((key) => [key, Object.freeze({
      state: 'UNKNOWN', valuePercent: null, provenance: null,
    })]))),
  });
}

function unsafeBrowserEvidence(value, key = '') {
  if (value == null) return false;
  if (FORBIDDEN_EVIDENCE_KEY.test(key)) return true;
  if (typeof value === 'string') {
    return (/path/iu.test(key) && ABSOLUTE_PATH.test(value))
      || (/(?:provenance|sourceOwner)/iu.test(key) && FORBIDDEN_PROVENANCE.test(value));
  }
  if (Array.isArray(value)) return value.some((item) => unsafeBrowserEvidence(item, key));
  if (typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) => unsafeBrowserEvidence(child, childKey));
  }
  return false;
}

function summarizeFullCostEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.fullCostReady !== false || !value.components || typeof value.components !== 'object') return null;
  const components = {};
  for (const key of FULL_COST_KEYS) {
    const component = value.components[key];
    if (!component || typeof component !== 'object' || Array.isArray(component)
      || !FULL_COST_STATES.has(component.state)) return null;
    const valueReady = component.state === 'MEASURED' || component.state === 'MODELED';
    const valuePercent = candidateMetric(component.valuePercent);
    const provenance = component.provenance == null ? null : String(component.provenance);
    if ((valueReady && (valuePercent == null || valuePercent < 0))
      || (!valueReady && valuePercent !== null)
      || (provenance != null && (!SAFE_ID_PATTERN.test(provenance) || FORBIDDEN_PROVENANCE.test(provenance)))) return null;
    components[key] = Object.freeze({ state: component.state, valuePercent, provenance });
  }
  return Object.freeze({ fullCostReady: false, components: Object.freeze(components) });
}

async function readJsonOptional(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    if (metadata.size > MAX_JSON_BYTES) throw new Error(`state file exceeds ${MAX_JSON_BYTES} bytes`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`unable to read research state ${path}: ${String(error?.message ?? error).slice(0, 240)}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256Canonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function emptyV3Independence(status, present) {
  return Object.freeze({
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
    frozenSplitCounts: Object.freeze(Object.fromEntries(SPLIT_COUNT_KEYS.map((key) => [key, null]))),
    oosOutcomeCredit: null,
    calibrationArtifactProduced: null,
    liquidityImpactStatus: null,
    fullCostReady: null,
    evidenceComplete: null,
    executionAuthority: null,
    reportDigest: null,
  });
}

function summarizeV3Independence(value, readFailed = false) {
  if (readFailed) return emptyV3Independence('INVALID', true);
  if (!value) return emptyV3Independence('MISSING', false);
  if (typeof value !== 'object' || Array.isArray(value)) return emptyV3Independence('INVALID', true);
  const body = { ...value };
  delete body.reportDigest;
  const splitCounts = value.frozenSplitCounts;
  const counts = Object.fromEntries(SPLIT_COUNT_KEYS.map((key) => [key, optionalIntegerCount(splitCounts?.[key])]));
  const requiredCountsPresent = Object.values(counts).every((item) => item !== null);
  const targetSlotIndex = optionalIntegerCount(value.targetSlotIndex);
  const genuineScheduledSlotN = optionalIntegerCount(value.genuineScheduledSlotN);
  const rawAcceptedN = optionalIntegerCount(value.rawAcceptedN);
  const effectiveIndependentN = optionalIntegerCount(value.effectiveIndependentN);
  const independentBuyN = optionalIntegerCount(value.independentBuyN);
  const independentSellN = optionalIntegerCount(value.independentSellN);
  const oosOutcomeCredit = optionalIntegerCount(value.oosOutcomeCredit);
  const evidenceComplete = optionalIntegerCount(value.evidenceComplete);
  const shapeValid = value.schemaVersion === V3_INDEPENDENCE_SUMMARY_SCHEMA
    && SHA_PATTERN.test(String(value.producerSha ?? ''))
    && /^[0-9]{6,20}$/u.test(String(value.upstreamIngestRunId ?? ''))
    && /^[0-9]{6,20}$/u.test(String(value.upstreamIngestArtifactId ?? ''))
    && DIGEST_PATTERN.test(String(value.upstreamIngestArtifactDigest ?? ''))
    && DIGEST_PATTERN.test(String(value.sourceInventoryDigest ?? ''))
    && DIGEST_PATTERN.test(String(value.independenceAuditDigest ?? ''))
    && DIGEST_PATTERN.test(String(value.independentSplitSourceDigest ?? ''))
    && DIGEST_PATTERN.test(String(value.v3IndependentSplitIndexDigest ?? ''))
    && DIGEST_PATTERN.test(String(value.reportDigest ?? ''))
    && targetSlotIndex !== null
    && genuineScheduledSlotN !== null
    && rawAcceptedN !== null
    && effectiveIndependentN !== null
    && independentBuyN !== null
    && independentSellN !== null
    && requiredCountsPresent
    && oosOutcomeCredit === 0
    && value.calibrationArtifactProduced === false
    && value.liquidityImpactStatus === 'BLOCKED_DATA'
    && value.fullCostReady === false
    && evidenceComplete === 0
    && value.executionAuthority === 'NONE'
    && value.frozenV3SplitIndexPresent === true
    && value.v2SplitReceiptPresent === false
    && rawAcceptedN >= effectiveIndependentN
    && genuineScheduledSlotN >= effectiveIndependentN
    && effectiveIndependentN === independentBuyN + independentSellN
    && counts.TRAIN === counts.TRAIN_BUY + counts.TRAIN_SELL
    && counts.VALIDATION === counts.VALIDATION_BUY + counts.VALIDATION_SELL
    && counts.OOS === counts.OOS_BUY + counts.OOS_SELL
    && effectiveIndependentN === counts.TRAIN + counts.VALIDATION + counts.OOS
    && independentBuyN === counts.TRAIN_BUY + counts.VALIDATION_BUY + counts.OOS_BUY
    && independentSellN === counts.TRAIN_SELL + counts.VALIDATION_SELL + counts.OOS_SELL
    && sha256Canonical(body) === value.reportDigest;
  if (!shapeValid) return emptyV3Independence('INVALID', true);
  return Object.freeze({
    present: true,
    status: 'PRESENT',
    schemaVersion: value.schemaVersion,
    producerSha: value.producerSha,
    upstreamIngestRunId: value.upstreamIngestRunId,
    upstreamIngestArtifactId: value.upstreamIngestArtifactId,
    upstreamIngestArtifactDigest: value.upstreamIngestArtifactDigest,
    sourceInventoryDigest: value.sourceInventoryDigest,
    targetSlotIndex,
    genuineScheduledSlotN,
    rawAcceptedN,
    effectiveIndependentN,
    independentBuyN,
    independentSellN,
    independenceAuditDigest: value.independenceAuditDigest,
    independentSplitSourceDigest: value.independentSplitSourceDigest,
    v3IndependentSplitIndexDigest: value.v3IndependentSplitIndexDigest,
    frozenSplitCounts: Object.freeze(counts),
    oosOutcomeCredit,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    reportDigest: value.reportDigest,
  });
}

async function readV3IndependenceSummary(root) {
  const path = join(root, ...V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH);
  try {
    return summarizeV3Independence(await readJsonOptional(path));
  } catch {
    return summarizeV3Independence(null, true);
  }
}

function emptyCandidatePerformance(status, present, reason = null) {
  return Object.freeze({
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
  });
}

function summarizeCandidatePerformance(value, readFailed = false) {
  if (readFailed) return emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_READ_FAILED');
  if (!value) return emptyCandidatePerformance('MISSING', false, 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING');
  if (typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== CANDIDATE_PERFORMANCE_SCHEMA) {
    return emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID');
  }
  if (unsafeBrowserEvidence(value)) {
    return emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID');
  }
  const status = value.status;
  const reason = typeof value.reason === 'string' && SAFE_ID_PATTERN.test(value.reason) ? value.reason : null;
  const counts = Object.fromEntries(CANDIDATE_COUNT_KEYS.map((key) => [key, candidateCount(value[key])]));
  const metrics = Object.fromEntries(CANDIDATE_METRIC_KEYS.map((key) => [key, candidateMetric(value[key])]));
  const safetyValid = value.FULL_COST_READY === false
    && value.NET_ALPHA_PROVEN === false
    && value.PROFITABILITY_PROVEN === false
    && value.TRAIN_DIAGNOSTIC_ONLY === true
    && value.VALIDATION_COMPLETE === false
    && value.OOS_COMPLETE === false
    && value.sampleCredit === 0
    && value.executionRealismCredit === 0
    && value.profitabilityCredit === 0
    && value.backfillCredit === 0
    && value.replayCredit === 0
    && value.syntheticCredit === 0
    && value.manualEconomicCredit === 0
    && value.executionAuthority === 'NONE'
    && value.LIVE_TRADING === false
    && value.AUTO_TRADING === false
    && value.REAL_ORDER_ENABLED === false
    && value.PRIVATE_TRADING_API_ALLOWED === false
    && value.realOrderCount === 0
    && value.cancelCount === 0
    && value.amendCount === 0
    && value.transferCount === 0
    && value.withdrawalCount === 0
    && value.Net_PnL == null;
  const fullCostEvidence = summarizeFullCostEvidence(value.fullCostEvidence);
  if (!safetyValid || !reason
    || !fullCostEvidence
    || Object.values(counts).some((item) => item === undefined)
    || Object.values(metrics).some((item) => item === undefined)) {
    return emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID');
  }
  if (status === 'BLOCKED') {
    const unavailable = [value.candidateId, value.strategyId, value.freezeTimestamp,
      ...Object.values(counts), ...Object.values(metrics)].every((item) => item == null);
    return unavailable
      ? emptyCandidatePerformance('BLOCKED', true, reason)
      : emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_BLOCKED_PARTIAL_EVIDENCE');
  }
  const freezeMs = Date.parse(String(value.freezeTimestamp ?? ''));
  const identity = value.identity;
  const provenanceValid = value.provenance?.evidenceClass === 'PRODUCTION_AUTHORITATIVE'
    && typeof value.provenance?.sourceOwner === 'string'
    && value.provenance.sourceOwner.length > 0
    && value.provenance.fixture === false
    && value.provenance.synthetic === false
    && value.provenance.replay === false
    && value.provenance.backfill === false
    && value.provenance.manual === false;
  const identityValidFields = identity && typeof identity === 'object' && !Array.isArray(identity)
    && CANDIDATE_IDENTITY_KEYS.every((key) => typeof identity[key] === 'string' && identity[key].length > 0)
    && identity.candidateId === value.candidateId
    && identity.strategyId === value.strategyId
    && identity.accountMode === 'PAPER'
    && SHA_PATTERN.test(identity.researchCodeSha)
    && DIGEST_PATTERN.test(identity.parameterHash)
    && identity.parameterHash === identity.parameterDigest;
  const identityValid = status === 'PRESENT'
    && CANDIDATE_ID_PATTERN.test(String(value.candidateId ?? ''))
    && SAFE_ID_PATTERN.test(String(value.strategyId ?? ''))
    && Number.isSafeInteger(freezeMs)
    && new Date(freezeMs).toISOString() === value.freezeTimestamp
    && value.identity14Verified === true
    && identityValidFields
    && provenanceValid;
  const matchedCounts = [counts.LONG_SIGNAL_N, counts.SHORT_SIGNAL_N, counts.NO_TRADE_N];
  const splitCounts = [counts.TRAIN_N, counts.VALIDATION_N, counts.OOS_N];
  const matchValid = counts.candidateMatchedN == null
    ? [...matchedCounts, ...splitCounts].every((item) => item == null)
    : matchedCounts.every((item) => item != null)
      && splitCounts.every((item) => item != null)
      && matchedCounts.reduce((sum, item) => sum + item, 0) === counts.candidateMatchedN
      && splitCounts.reduce((sum, item) => sum + item, 0) === counts.candidateMatchedN;
  const settlementCounts = [counts.WIN_N, counts.LOSS_N, counts.BREAKEVEN_N];
  const settlementValid = counts.Settlement_N == null
    ? settlementCounts.every((item) => item == null) && metrics.Gross_PnL == null
    : settlementCounts.every((item) => item != null)
      && settlementCounts.reduce((sum, item) => sum + item, 0) === counts.Settlement_N
      && metrics.Gross_PnL != null;
  const lifecycleValid = (counts.Entry_N == null || counts.Position_N == null || counts.Position_N <= counts.Entry_N)
    && (counts.Position_N == null || counts.Settlement_N == null || counts.Settlement_N <= counts.Position_N);
  if (!identityValid || !matchValid || !settlementValid || !lifecycleValid) {
    return emptyCandidatePerformance('INVALID', true, 'CANDIDATE_PERFORMANCE_EVIDENCE_INVALID');
  }
  return Object.freeze({
    present: true,
    status: 'PRESENT',
    schemaVersion: CANDIDATE_PERFORMANCE_SCHEMA,
    FIRST_ZERO: reason,
    reason,
    candidateId: value.candidateId,
    strategyId: value.strategyId,
    freezeTimestamp: value.freezeTimestamp,
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
  });
}

async function readCandidatePerformance(root) {
  const path = join(root, ...CANDIDATE_PERFORMANCE_RELATIVE_PATH);
  try {
    return summarizeCandidatePerformance(await readJsonOptional(path));
  } catch {
    return summarizeCandidatePerformance(null, true);
  }
}

function summarizeTask(row = {}) {
  return Object.freeze({
    id: String(row.id ?? 'unknown'),
    status: String(row.status ?? 'unknown'),
    durationMs: finiteNumber(row.durationMs),
    startedAt: finiteNumber(row.startedAt),
    endedAt: finiteNumber(row.endedAt),
    timedOut: row.timedOut === true,
  });
}

function summarizeCycle(profile, value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({
      profile,
      present: false,
      status: 'not_started',
      concurrency: null,
      taskCount: null,
      successCount: null,
      blockedDataCount: null,
      failedCount: null,
      tasks: [],
    });
  }
  const hasTaskEvidence = Array.isArray(value.results);
  const tasks = hasTaskEvidence ? value.results.map(summarizeTask) : [];
  return Object.freeze({
    profile,
    present: true,
    status: String(value.status ?? 'unknown'),
    cycleId: typeof value.cycleId === 'string' ? value.cycleId : null,
    researchSha: typeof value.researchSha === 'string' ? value.researchSha : null,
    generatedAt: finiteNumber(value.generatedAt),
    concurrency: optionalIntegerCount(value.concurrency),
    taskCount: optionalIntegerCount(value.taskCount) ?? (hasTaskEvidence ? tasks.length : null),
    successCount: optionalIntegerCount(value.successCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'success').length : null),
    blockedDataCount: optionalIntegerCount(value.blockedDataCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'blocked_data').length : null),
    failedCount: optionalIntegerCount(value.failedCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'failed').length : null),
    tasks,
  });
}

function summarizePaperRuntime(value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({
      present: false,
      status: 'not_started',
      scheduleActive: null,
      allProvidersReady: null,
      publicForwardEvidenceAccumulating: null,
      paperTradeOutcomeAccumulating: null,
      privateRequestCount: null,
      financialMutationCount: null,
      orderCount: null,
      liveTrading: null,
      orderAuthority: null,
      safetyEvidenceComplete: true,
      lanes: [],
    });
  }
  const lanes = Array.isArray(value.lanes)
    ? value.lanes.map((lane) => ({
        market: String(lane?.market ?? lane?.lane ?? lane?.provider ?? 'unknown'),
        status: String(lane?.status ?? 'unknown'),
      }))
    : [];
  const privateRequestCount = optionalIntegerCount(value.privateRequestCount);
  const financialMutationCount = optionalIntegerCount(value.financialMutationCount);
  const orderCount = optionalIntegerCount(value.orderCount);
  const liveTrading = optionalBoolean(value.liveTrading);
  const orderAuthority = optionalBoolean(value.orderAuthority);
  const safetyEvidenceComplete = [
    privateRequestCount,
    financialMutationCount,
    orderCount,
    liveTrading,
    orderAuthority,
  ].every((item) => item !== null);
  return Object.freeze({
    present: true,
    status: String(value.status ?? 'unknown'),
    cycleId: typeof value.cycleId === 'string' ? value.cycleId : null,
    scheduleActive: optionalBoolean(value.scheduleActive),
    allProvidersReady: optionalBoolean(value.allProvidersReady),
    publicForwardEvidenceAccumulating: optionalBoolean(value.publicForwardEvidenceAccumulating),
    paperTradeOutcomeAccumulating: optionalBoolean(value.paperTradeOutcomeAccumulating),
    privateRequestCount,
    financialMutationCount,
    orderCount,
    liveTrading,
    orderAuthority,
    safetyEvidenceComplete,
    lanes,
  });
}

function summarizePaperLedger(value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({
      present: false,
      cycleCount: null,
      sampleCount: null,
      positionCount: null,
      settlementCount: null,
    });
  }
  return Object.freeze({
    present: true,
    cycleCount: Array.isArray(value.cycles) ? value.cycles.length : null,
    sampleCount: Array.isArray(value.samples) ? value.samples.length : null,
    positionCount: Array.isArray(value.positions) ? value.positions.length : null,
    settlementCount: Array.isArray(value.settlements) ? value.settlements.length : null,
  });
}

function summarizeShadowGroups(value) {
  if (!value || typeof value !== 'object') return [];
  const source = value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)
    ? value.groups
    : value;
  const groups = [];
  for (const [name, row] of Object.entries(source)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const candidate = row.candidate && typeof row.candidate === 'object' && !Array.isArray(row.candidate)
      ? row.candidate
      : row;
    const total = finiteNumber(row.total ?? row.totalCount ?? row.records ?? row.sampleSize);
    const settled = finiteNumber(row.settled ?? row.settledCount);
    const pending = finiteNumber(row.pending ?? row.pendingCount);
    const collapsed = candidate.predictionHealth?.collapsed ?? row.predictionHealth?.collapsed ?? row.collapsed;
    const macroF1 = finiteNumber(candidate.macroF1 ?? candidate.metrics?.macroF1);
    const balancedAccuracy = finiteNumber(candidate.balancedAccuracy ?? candidate.metrics?.balancedAccuracy);
    const bullRecall = finiteNumber(candidate.perClass?.bullish?.recall);
    const bearRecall = finiteNumber(candidate.perClass?.bearish?.recall);
    const neutralRecall = finiteNumber(candidate.perClass?.neutral?.recall);
    if ([total, settled, pending, macroF1, balancedAccuracy, bullRecall, bearRecall, neutralRecall].every((item) => item === null) && collapsed === undefined) continue;
    groups.push({
      name,
      total,
      settled,
      pending,
      collapsed: typeof collapsed === 'boolean' ? collapsed : null,
      macroF1,
      balancedAccuracy,
      bullRecall,
      bearRecall,
      neutralRecall,
    });
  }
  return groups;
}

function countShadowRecords(value) {
  const seen = new Set();
  let foundRecords = false;
  let total = 0;
  let settled = 0;
  let pending = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (Array.isArray(node.records)) {
      foundRecords = true;
      total += node.records.length;
      for (const record of node.records) {
        if (record?.status === 'settled') settled += 1;
        if (record?.status === 'pending') pending += 1;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'records') continue;
      visit(child);
    }
  };
  visit(value);
  return Object.freeze({
    present: Boolean(value),
    totalRecords: foundRecords ? total : null,
    settledRecords: foundRecords ? settled : null,
    pendingRecords: foundRecords ? pending : null,
  });
}

function canonicalShadowHandoffs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const groups = value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)
    ? value.groups
    : {};
  return Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).flatMap(([group, row]) => {
    const handoff = row?.canonicalEvidence?.handoff?.strategyHealthHandoff;
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return [];
    return [{ group, handoff }];
  });
}

function newestTimestamp(cycles) {
  return cycles.reduce((max, cycle) => Math.max(max, finiteNumber(cycle.generatedAt) ?? 0), 0) || null;
}

function sumKnownCycleCounts(cycles, key) {
  const presentCycles = cycles.filter((cycle) => cycle.present);
  if (presentCycles.some((cycle) => cycle[key] === null)) return null;
  return presentCycles.reduce((sum, cycle) => sum + (cycle[key] ?? 0), 0);
}

function emptyTemporalCryptoSummary(status = 'MISSING', present = false) {
  return Object.freeze({
    present,
    status,
    generatedAt: null,
    researchSha: null,
    failedCount: null,
    observationCount: null,
    ledgerDigest: null,
    results: Object.freeze([]),
  });
}

function summarizeTemporalCryptoSummary(value) {
  if (value == null) return emptyTemporalCryptoSummary();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== TEMPORAL_CRYPTO_SUMMARY_SCHEMA
    || !TEMPORAL_COLLECTION_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.generatedAt) || value.generatedAt <= 0
    || !SHA_PATTERN.test(String(value.researchSha ?? ''))
    || !Number.isInteger(value.failedCount) || value.failedCount < 0
    || !Number.isInteger(value.observationCount) || value.observationCount < 0
    || !DIGEST_PATTERN.test(String(value.ledgerDigest ?? ''))
    || !Array.isArray(value.results)
    || value.results.length > 50
    || value.safety?.publicDataOnly !== true
    || value.safety?.privateApi !== false
    || value.safety?.liveTrading !== false
    || value.safety?.realOrders !== false
    || value.safety?.historicalCurrentValueBackfill !== false
    || value.safety?.executionAuthority !== 'NONE') {
    return emptyTemporalCryptoSummary('INVALID', true);
  }
  const results = [];
  for (const raw of value.results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.symbol !== 'string' || !/^[A-Z0-9]{3,30}$/u.test(raw.symbol)
      || !TEMPORAL_SYMBOL_STATUSES.has(raw.status)
      || !Number.isInteger(raw.observedCount) || raw.observedCount < 0
      || !Number.isInteger(raw.appendedCount) || raw.appendedCount < 0
      || raw.appendedCount > raw.observedCount) {
      return emptyTemporalCryptoSummary('INVALID', true);
    }
    results.push(Object.freeze({
      symbol: raw.symbol,
      status: raw.status,
      observedCount: raw.observedCount,
      appendedCount: raw.appendedCount,
    }));
  }
  const observedFailures = results.filter((row) => row.status === 'failed').length;
  if (observedFailures !== value.failedCount) return emptyTemporalCryptoSummary('INVALID', true);
  return Object.freeze({
    present: true,
    status: value.status,
    generatedAt: value.generatedAt,
    researchSha: String(value.researchSha).toLowerCase(),
    failedCount: value.failedCount,
    observationCount: value.observationCount,
    ledgerDigest: String(value.ledgerDigest).toLowerCase(),
    results: Object.freeze(results),
  });
}

function emptyFactoryRuntimeSummary(status = 'MISSING', present = false) {
  return Object.freeze({
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
  });
}

function summarizeFactoryRuntimeStatus(value) {
  if (value == null) return emptyFactoryRuntimeSummary();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== FACTORY_RUNTIME_CONTRACT
    || !FACTORY_RUNTIME_STATUSES.has(value.status)
    || typeof value.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !SHA_PATTERN.test(String(value.researchSha ?? ''))
    || typeof value.firstZero !== 'string' || !SAFE_ID_PATTERN.test(value.firstZero)
    || !value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)
    || typeof value.policy.present !== 'boolean' || typeof value.policy.valid !== 'boolean'
    || !value.dataFactory || typeof value.dataFactory !== 'object' || Array.isArray(value.dataFactory)
    || !value.canonicalAdaptive || typeof value.canonicalAdaptive !== 'object' || Array.isArray(value.canonicalAdaptive)
    || !value.safety || typeof value.safety !== 'object' || Array.isArray(value.safety)
    || value.safety.runtimeExecutionAttempted !== false
    || value.safety.runtimeActivationAllowed !== false
    || value.safety.scheduleMutationAllowed !== false
    || value.safety.deploymentAllowed !== false
    || value.safety.databaseMutationAllowed !== false
    || value.safety.secretMutationAllowed !== false
    || value.safety.liveTrading !== false
    || value.safety.autoTrading !== false
    || value.safety.privateTradingApi !== false
    || value.safety.realOrder !== false
    || value.safety.profitabilityClaim !== false
    || value.safety.executionAuthority !== 'NONE') {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }

  const nullableCount = (raw) => raw == null ? null : Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  const readyMarketCount = nullableCount(value.dataFactory.readyMarketCount);
  const blockedMarketCount = nullableCount(value.dataFactory.blockedMarketCount);
  const readyProfileCount = nullableCount(value.canonicalAdaptive.readyProfileCount);
  const blockedProfileCount = nullableCount(value.canonicalAdaptive.blockedProfileCount);
  if ([readyMarketCount, blockedMarketCount, readyProfileCount, blockedProfileCount].some((item) => item === undefined)) {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }

  const policyDigest = value.policy.policyDigest == null ? null : String(value.policy.policyDigest).toLowerCase();
  const controlPlaneDigest = value.controlPlaneDigest == null ? null : String(value.controlPlaneDigest).toLowerCase();
  if ((policyDigest != null && !DIGEST_PATTERN.test(policyDigest))
    || (controlPlaneDigest != null && !DIGEST_PATTERN.test(controlPlaneDigest))) {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }
  if (!value.policy.present && (value.policy.valid || policyDigest != null)) {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }

  const runtimeStatus = value.canonicalAdaptive.runtimeStatus == null ? null : String(value.canonicalAdaptive.runtimeStatus);
  const nextFirstZero = value.canonicalAdaptive.nextFirstZero == null ? null : String(value.canonicalAdaptive.nextFirstZero);
  if ((runtimeStatus != null && !SAFE_ID_PATTERN.test(runtimeStatus))
    || (nextFirstZero != null && !SAFE_ID_PATTERN.test(nextFirstZero))) {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }

  return Object.freeze({
    present: true,
    status: value.status,
    generatedAt: Date.parse(value.generatedAt),
    researchSha: String(value.researchSha).toLowerCase(),
    firstZero: value.firstZero,
    policyPresent: value.policy.present,
    policyValid: value.policy.valid,
    policyDigest,
    readyMarketCount,
    blockedMarketCount,
    readyProfileCount,
    blockedProfileCount,
    runtimeStatus,
    nextFirstZero,
    controlPlaneDigest,
  });
}

async function readFactoryRuntimeSummary(root) {
  try {
    return summarizeFactoryRuntimeStatus(await readJsonOptional(join(root, 'latest', 'research-factory.json')));
  } catch {
    return emptyFactoryRuntimeSummary('INVALID', true);
  }
}

export async function buildResearchOverview({ stateRoot = DEFAULT_STATE_ROOT } = {}) {
  const root = resolve(stateRoot);
  const cycleValues = await Promise.all(PROFILES.map((profile) => readJsonOptional(join(root, 'latest', `${profile}.json`))));
  const cycles = cycleValues.map((value, index) => summarizeCycle(PROFILES[index], value));
  const [paperRuntimeRaw, paperLedgerRaw, shadowSummaryRaw, shadowStateRaw, liquidityIndependence, candidatePerformance, temporalCryptoRaw, factoryRuntime] = await Promise.all([
    readJsonOptional(join(root, 'forward', 'paper', 'status', 'runtime-status.json')),
    readJsonOptional(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json')),
    readJsonOptional(join(root, 'forward', 'shadow-summary.json')),
    readJsonOptional(join(root, 'forward', 'shadow-state.json')),
    readV3IndependenceSummary(root),
    readCandidatePerformance(root),
    readJsonOptional(join(root, ...TEMPORAL_CRYPTO_SUMMARY_RELATIVE_PATH)),
    readFactoryRuntimeSummary(root),
  ]);

  const paperRuntime = summarizePaperRuntime(paperRuntimeRaw);
  const paperLedger = summarizePaperLedger(paperLedgerRaw);
  const shadowGroups = summarizeShadowGroups(shadowSummaryRaw);
  const shadowRecords = countShadowRecords(shadowStateRaw);
  const shadowCanonicalHandoffs = canonicalShadowHandoffs(shadowStateRaw);
  const temporalCrypto = summarizeTemporalCryptoSummary(temporalCryptoRaw);
  const failedTasks = sumKnownCycleCounts(cycles, 'failedCount');
  const blockedDataTasks = sumKnownCycleCounts(cycles, 'blockedDataCount');
  const authorityEvidenceComplete = !paperRuntime.present || paperRuntime.safetyEvidenceComplete;
  const forbiddenAuthorityObserved = paperRuntime.privateRequestCount !== null && paperRuntime.privateRequestCount > 0
    || paperRuntime.financialMutationCount !== null && paperRuntime.financialMutationCount > 0
    || paperRuntime.orderCount !== null && paperRuntime.orderCount > 0
    || paperRuntime.liveTrading === true
    || paperRuntime.orderAuthority === true;
  const researchStatus = forbiddenAuthorityObserved
    ? 'safety_block'
    : !authorityEvidenceComplete
      ? 'safety_evidence_incomplete'
      : liquidityIndependence.status === 'INVALID' || candidatePerformance.status === 'INVALID'
        || temporalCrypto.status === 'INVALID' || temporalCrypto.status === 'partial_failure'
        || factoryRuntime.status === 'INVALID' || factoryRuntime.status === 'BLOCKED_POLICY_INVALID'
        ? 'attention'
        : failedTasks === null || blockedDataTasks === null
          ? 'evidence_incomplete'
          : failedTasks > 0
            ? 'attention'
            : 'collecting';
  return Object.freeze({
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: Date.now(),
    state: Object.freeze({
      present: cycles.some((cycle) => cycle.present) || paperRuntime.present || paperLedger.present || shadowRecords.present || liquidityIndependence.present || candidatePerformance.present || temporalCrypto.present || factoryRuntime.present,
      latestCycleAt: newestTimestamp(cycles),
    }),
    safety: Object.freeze({
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete,
      forbiddenAuthorityObserved,
    }),
    research: Object.freeze({
      status: researchStatus,
      failedTasks,
      blockedDataTasks,
      cycles,
      liquidityIndependence,
    }),
    dataFactory: Object.freeze({
      temporalCryptoFutures: temporalCrypto,
    }),
    factory: factoryRuntime,
    paper: Object.freeze({ runtime: paperRuntime, ledger: paperLedger, candidatePerformance }),
    shadow: Object.freeze({ groups: shadowGroups, records: shadowRecords, canonicalHandoffs: shadowCanonicalHandoffs }),
    profitability: Object.freeze({
      proven: false,
      status: 'evidence_collection',
      note: 'Dashboard never promotes profitability by itself; promotion remains evidence-gated in the research pipeline.',
    }),
  });
}

function json(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function resolveStaticPath(publicRoot, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(publicRoot, relative);
  const normalizedRoot = resolve(publicRoot) + sep;
  if (!(candidate + sep).startsWith(normalizedRoot) && candidate !== resolve(publicRoot)) return null;
  return candidate;
}

export function createResearchDashboardServer({ stateRoot = DEFAULT_STATE_ROOT, publicRoot = join(MODULE_DIR, 'public') } = {}) {
  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    const method = req.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) {
      res.setHeader('allow', 'GET, HEAD');
      return json(res, 405, { ok: false, error: 'read_only_dashboard' });
    }

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'investment-research-dashboard',
          readOnly: true,
          liveTrading: false,
          privateApi: false,
          orderAuthority: false,
        });
      }
      if (url.pathname === '/api/research/overview') {
        const overview = await buildResearchOverview({ stateRoot });
        return json(res, 200, overview);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not_found' });

      const filePath = resolveStaticPath(publicRoot, decodeURIComponent(url.pathname));
      if (!filePath) return json(res, 404, { ok: false, error: 'not_found' });
      let metadata;
      try {
        metadata = await stat(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { ok: false, error: 'not_found' });
        throw error;
      }
      if (!metadata.isFile()) return json(res, 404, { ok: false, error: 'not_found' });
      const body = await readFile(filePath);
      const extension = extname(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'cache-control': extension === '.html' || filePath.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
        'content-length': body.length,
      });
      if (method === 'HEAD') return res.end();
      res.end(body);
    } catch (error) {
      json(res, 500, { ok: false, error: 'research_state_unavailable', detail: String(error?.message ?? error).slice(0, 240) });
    }
  });
}

export function startResearchDashboard({
  host = process.env.RESEARCH_DASHBOARD_HOST || DEFAULT_HOST,
  port = Number(process.env.RESEARCH_DASHBOARD_PORT || DEFAULT_PORT),
  stateRoot = process.env.RESEARCH_STATE_ROOT || DEFAULT_STATE_ROOT,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RESEARCH_DASHBOARD_PORT must be a valid TCP port');
  const server = createResearchDashboardServer({ stateRoot });
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      service: 'investment-research-dashboard',
      host,
      port,
      stateRoot,
      readOnly: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
    }));
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) startResearchDashboard();
