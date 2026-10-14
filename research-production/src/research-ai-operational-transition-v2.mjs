const SHA40 = /^[a-f0-9]{40}$/u;
const CYCLE_CONTRACT = 'autonomous-research-cycle/v2';
const LONG_HISTORY_STATUSES = new Set(['complete', 'partial_failure', 'blocked_data']);

function fail(code) {
  throw new Error(code);
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactSha(value, code = 'RESEARCH_OPERATIONAL_TARGET_SHA_INVALID') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(normalized)) fail(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function exactIsoMs(value, code) {
  const raw = String(value ?? '');
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) fail(code);
  return parsed;
}

function assertNoTradingAuthority(safety, prefix) {
  const row = record(safety, `${prefix}_SAFETY_MISSING`);
  if (row.executionAuthority !== 'NONE'
    || row.liveTrading !== false
    || row.privateTradingApi !== false
    || row.realOrder !== false) fail(`${prefix}_SAFETY_INVALID`);
}

export function classifyLongHistoryForOperationalTransitionV2({ longHistory, targetSha } = {}) {
  const expectedSha = exactSha(targetSha);
  if (longHistory == null) {
    return Object.freeze({
      state: 'MISSING_CURRENT_EVIDENCE',
      sourceResearchSha: null,
      sourceStatus: null,
      currentShaEvidence: false,
      historicalCompletionPreserved: false,
      refreshRequired: true,
      refreshService: 'research-production@long-history.service',
      refreshTimer: 'research-production-long-history.timer',
      treatedAsFailure: false,
    });
  }
  const row = record(longHistory, 'LONG_HISTORY_EVIDENCE_INVALID');
  if (row.schemaVersion !== 'research-production-cycle-v1' || row.profile !== 'long-history') {
    fail('LONG_HISTORY_EVIDENCE_SCHEMA_INVALID');
  }
  const sourceResearchSha = exactSha(row.researchSha, 'LONG_HISTORY_EVIDENCE_SHA_INVALID');
  const sourceStatus = String(row.status ?? '');
  if (!LONG_HISTORY_STATUSES.has(sourceStatus)) fail('LONG_HISTORY_EVIDENCE_STATUS_INVALID');
  const currentShaEvidence = sourceResearchSha === expectedSha;
  return Object.freeze({
    state: currentShaEvidence ? 'CURRENT_SHA_EVIDENCE' : 'STALE_RELEASE_EVIDENCE_PRESERVED',
    sourceResearchSha,
    sourceStatus,
    currentShaEvidence,
    historicalCompletionPreserved: sourceStatus === 'complete',
    refreshRequired: !currentShaEvidence,
    refreshService: 'research-production@long-history.service',
    refreshTimer: 'research-production-long-history.timer',
    // An older complete/partial artifact is historical evidence, never a
    // current-release pass and never a newly manufactured failure.
    treatedAsFailure: false,
  });
}

export function classifyVideoZeroResultForOperationalTransitionV2(video) {
  if (video == null) return Object.freeze({ state: 'MISSING', zeroResult: null });
  const row = record(video, 'VIDEO_DISCOVERY_EVIDENCE_INVALID');
  if (row.schemaVersion !== 'research-video-discovery-scan-v1') fail('VIDEO_DISCOVERY_EVIDENCE_SCHEMA_INVALID');
  const sourceCount = row.sourceCount == null ? null : nonNegativeInteger(row.sourceCount, 'VIDEO_DISCOVERY_SOURCE_COUNT_INVALID');
  if (row.status !== 'COMPLETE' || sourceCount !== 0) {
    return Object.freeze({ state: row.status === 'COMPLETE' ? 'RESULTS_PRESENT' : 'NOT_COMPLETE', zeroResult: false });
  }
  return Object.freeze({
    state: 'PROVIDER_SUCCESS_ZERO_RESULTS',
    zeroResult: true,
    query: typeof row.query === 'string' ? row.query : null,
    queryIndex: Number.isSafeInteger(row.queryIndex) ? row.queryIndex : null,
    queryCount: Number.isSafeInteger(row.queryCount) ? row.queryCount : null,
    nextQueryIndex: Number.isSafeInteger(row.nextQueryIndex) ? row.nextQueryIndex : null,
    requestOrder: row.requestOrder ?? 'date',
    publishedAfter: row.publishedAfter ?? null,
    publishedAfterHours: Number.isSafeInteger(row.publishedAfterHours) ? row.publishedAfterHours : null,
    regionCode: row.regionCode ?? null,
    relevanceLanguage: row.relevanceLanguage ?? null,
    cause: row.zeroResultReason ?? 'ACTIVE_QUERY_AND_FILTERS_RETURNED_NO_PUBLIC_VIDEO',
    providerFailure: false,
  });
}

export function evaluateAutonomousNaturalCycleForOperationalTransitionV2({ cycle, discovery, targetSha, startedAtMs } = {}) {
  const expectedSha = exactSha(targetSha);
  const row = record(cycle, 'AUTONOMOUS_V2_CYCLE_EVIDENCE_MISSING');
  if (row.schemaVersion !== 2 || row.contract !== CYCLE_CONTRACT) fail('AUTONOMOUS_V2_CYCLE_SCHEMA_INVALID');
  if (exactSha(row.researchCodeSha, 'AUTONOMOUS_V2_CYCLE_SHA_INVALID') !== expectedSha) {
    fail('AUTONOMOUS_V2_CYCLE_SHA_MISMATCH');
  }
  const observedAtMs = exactIsoMs(row.observedAt, 'AUTONOMOUS_V2_CYCLE_TIME_INVALID');
  if (!Number.isFinite(Number(startedAtMs)) || observedAtMs < Number(startedAtMs)) fail('AUTONOMOUS_V2_CYCLE_STALE');
  if (row.status !== 'COMPLETE') fail(`AUTONOMOUS_V2_CYCLE_NOT_COMPLETE:${String(row.status ?? 'MISSING')}`);
  if (row.directiveConsumed !== true || !['DOSSIER_STAGED', 'ALREADY_DISCOVERED'].includes(row.discoveryStatus)) {
    fail(`AUTONOMOUS_V2_NATURAL_DISCOVERY_NOT_PROVEN:${String(row.discoveryStatus ?? 'MISSING')}`);
  }
  const discoveryRow = record(discovery, 'AUTONOMOUS_V2_DISCOVERY_EVIDENCE_MISSING');
  if (discoveryRow.schemaVersion !== 2 || discoveryRow.contract !== 'autonomous-research-discovery/v2'
    || discoveryRow.status !== 'DOSSIER_STAGED'
    || exactSha(discoveryRow.researchCodeSha, 'AUTONOMOUS_V2_DISCOVERY_SHA_INVALID') !== expectedSha
    || discoveryRow.directiveConsumed !== true
    || typeof discoveryRow.stagedDossierDigest !== 'string'
    || discoveryRow.stagedDossierDigest !== row.stagedDossierDigest) {
    fail('AUTONOMOUS_V2_DISCOVERY_EVIDENCE_INVALID');
  }
  const providerCalls = record(discoveryRow.actualProviderCalls, 'AUTONOMOUS_V2_PROVIDER_CALLS_MISSING');
  const sourceFetches = record(discoveryRow.actualSourceFetches, 'AUTONOMOUS_V2_SOURCE_FETCHES_MISSING');
  if (nonNegativeInteger(providerCalls.attempted, 'AUTONOMOUS_V2_PROVIDER_CALLS_INVALID') !== 2
    || nonNegativeInteger(providerCalls.succeeded, 'AUTONOMOUS_V2_PROVIDER_CALLS_INVALID') !== 2
    || nonNegativeInteger(providerCalls.failed, 'AUTONOMOUS_V2_PROVIDER_CALLS_INVALID') !== 0) {
    fail('AUTONOMOUS_V2_PROVIDER_CALL_PROOF_INCOMPLETE');
  }
  if (nonNegativeInteger(sourceFetches.attempted, 'AUTONOMOUS_V2_SOURCE_FETCHES_INVALID') !== 3
    || nonNegativeInteger(sourceFetches.succeeded, 'AUTONOMOUS_V2_SOURCE_FETCHES_INVALID') !== 3
    || nonNegativeInteger(sourceFetches.failed, 'AUTONOMOUS_V2_SOURCE_FETCHES_INVALID') !== 0) {
    fail('AUTONOMOUS_V2_SOURCE_FETCH_PROOF_INCOMPLETE');
  }
  const currentProviderCalls = record(row.actualProviderCalls, 'AUTONOMOUS_V2_CURRENT_PROVIDER_CALLS_MISSING');
  const currentSourceFetches = record(row.actualSourceFetches, 'AUTONOMOUS_V2_CURRENT_SOURCE_FETCHES_MISSING');
  const expectedCurrentCount = row.discoveryStatus === 'DOSSIER_STAGED' ? 2 : 0;
  const expectedCurrentFetchCount = row.discoveryStatus === 'DOSSIER_STAGED' ? 3 : 0;
  if (nonNegativeInteger(currentProviderCalls.attempted, 'AUTONOMOUS_V2_CURRENT_PROVIDER_CALLS_INVALID') !== expectedCurrentCount
    || nonNegativeInteger(currentProviderCalls.succeeded, 'AUTONOMOUS_V2_CURRENT_PROVIDER_CALLS_INVALID') !== expectedCurrentCount
    || nonNegativeInteger(currentProviderCalls.failed, 'AUTONOMOUS_V2_CURRENT_PROVIDER_CALLS_INVALID') !== 0
    || nonNegativeInteger(currentSourceFetches.attempted, 'AUTONOMOUS_V2_CURRENT_SOURCE_FETCHES_INVALID') !== expectedCurrentFetchCount
    || nonNegativeInteger(currentSourceFetches.succeeded, 'AUTONOMOUS_V2_CURRENT_SOURCE_FETCHES_INVALID') !== expectedCurrentFetchCount
    || nonNegativeInteger(currentSourceFetches.failed, 'AUTONOMOUS_V2_CURRENT_SOURCE_FETCHES_INVALID') !== 0) {
    fail('AUTONOMOUS_V2_CURRENT_INVOCATION_PROOF_INVALID');
  }
  if (nonNegativeInteger(row.formulaGeneratedCount, 'AUTONOMOUS_V2_FORMULA_COUNT_INVALID') < 1) {
    fail('AUTONOMOUS_V2_FORMULA_NOT_PROVEN');
  }
  if (nonNegativeInteger(row.actualBacktestCount, 'AUTONOMOUS_V2_BACKTEST_COUNT_INVALID') < 1) {
    fail('AUTONOMOUS_V2_BACKTEST_NOT_PROVEN');
  }
  const strategy = record(row.selectedNextStrategy, 'AUTONOMOUS_V2_SELECTED_STRATEGY_MISSING');
  exactSha(strategy.sourceRevision, 'AUTONOMOUS_V2_SOURCE_REVISION_INVALID');
  assertNoTradingAuthority(row.safety, 'AUTONOMOUS_V2');
  return Object.freeze({
    status: 'NATURAL_CYCLE_PROVEN',
    observedAt: row.observedAt,
    directiveConsumed: true,
    discoveryStatus: row.discoveryStatus,
    discoveryEvidenceStatus: discoveryRow.status,
    discoveryExecution: row.discoveryStatus === 'DOSSIER_STAGED' ? 'FRESH_THIS_INVOCATION' : 'RESUMED_EXACT_SHA',
    providerCalls: Object.freeze({ attempted: 2, succeeded: 2, failed: 0 }),
    sourceFetches: Object.freeze({ attempted: 3, succeeded: 3, failed: 0 }),
    formulaGeneratedCount: row.formulaGeneratedCount,
    actualBacktestCount: row.actualBacktestCount,
    selectedStrategy: Object.freeze({
      repository: strategy.repository ?? null,
      sourcePath: strategy.sourcePath ?? null,
      sourceRevision: strategy.sourceRevision,
      family: strategy.family ?? null,
      templateId: strategy.templateId ?? null,
    }),
    paperActivated: false,
    executionAuthority: 'NONE',
  });
}

export function evaluateResearchAiOperationalTransitionV2({
  targetSha,
  startedAtMs,
  autonomousCycle,
  autonomousDiscovery,
  longHistory = null,
  video = null,
} = {}) {
  const researchSha = exactSha(targetSha);
  return Object.freeze({
    schemaVersion: 'research-ai-operational-transition-v2',
    status: 'PASS',
    targetSha: researchSha,
    actualNaturalCycle: evaluateAutonomousNaturalCycleForOperationalTransitionV2({
      cycle: autonomousCycle,
      discovery: autonomousDiscovery,
      targetSha: researchSha,
      startedAtMs,
    }),
    longHistory: classifyLongHistoryForOperationalTransitionV2({ longHistory, targetSha: researchSha }),
    youtube: classifyVideoZeroResultForOperationalTransitionV2(video),
    liveTrading: false,
    privateTradingApiAllowed: false,
    realOrderEnabled: false,
    executionAuthority: 'NONE',
  });
}
