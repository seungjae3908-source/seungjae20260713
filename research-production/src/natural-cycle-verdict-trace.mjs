export const NATURAL_PAPER_STAGE_ORDER = Object.freeze([
  'UNIVERSE',
  'SCANNER_EVALUATED',
  'CANDIDATE',
  'EVIDENCE_COMPLETE',
  'ADMISSION_PASS',
  'RISK_PASS',
  'COST_PASS',
  'ACCOUNT_READY',
  'PAPER_ENTRY',
  'POSITION',
  'SETTLEMENT',
  'OUTCOME',
]);

export const NATURAL_PAPER_STAGE_FIELDS = Object.freeze({
  UNIVERSE: 'universeCount',
  SCANNER_EVALUATED: 'scannerEvaluatedCount',
  CANDIDATE: 'scannerCandidateCount',
  EVIDENCE_COMPLETE: 'evidenceCompleteCount',
  ADMISSION_PASS: 'admissionPassCount',
  RISK_PASS: 'riskPassCount',
  COST_PASS: 'costPassCount',
  ACCOUNT_READY: 'accountReadyCount',
  PAPER_ENTRY: 'paperEntryCount',
  POSITION: 'paperPositionCount',
  SETTLEMENT: 'settlementCount',
  OUTCOME: 'outcomeCount',
});

export const NATURAL_PAPER_FIRST_ZERO_CODES = Object.freeze({
  UNIVERSE: 'UNIVERSE_EMPTY',
  SCANNER_EVALUATED: 'SCANNER_NOT_EVALUATED',
  CANDIDATE: 'SCANNER_CANDIDATE_ZERO',
  EVIDENCE_COMPLETE: 'EVIDENCE_INCOMPLETE',
  ADMISSION_PASS: 'ADMISSION_REJECTED',
  RISK_PASS: 'RISK_VETO',
  COST_PASS: 'COST_EVIDENCE_REJECTED',
  ACCOUNT_READY: 'ACCOUNT_NOT_READY',
  PAPER_ENTRY: 'PAPER_ENTRY_NOT_CREATED',
  POSITION: 'PAPER_POSITION_NOT_OPENED',
  SETTLEMENT: 'SETTLEMENT_NOT_COMPLETED',
  OUTCOME: 'OUTCOME_NOT_PERSISTED',
});

const NATURAL_TRIGGER_SOURCES = new Set([
  'cron',
  'scheduler',
  'scheduled',
  'systemd-timer',
  'systemd_timer',
  'timer',
]);

const NON_NATURAL_EVIDENCE_FLAGS = Object.freeze([
  'synthetic',
  'testFixture',
  'historical',
  'replay',
  'duplicateReplay',
  'manualExpiry',
  'futureTimeCompression',
  'clockAdvanced',
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function countOrUnknown(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError('Natural Paper stage counts must be non-negative integers or null');
  }
  return number;
}

function normalizeIdentity(input = {}) {
  const strategySha = exactSha(input.strategySha ?? input.researchCodeSha);
  const runtimeSha = exactSha(input.runtimeSha);
  const datasetIdentity = nonEmpty(input.datasetIdentity) ? input.datasetIdentity.trim() : null;
  return Object.freeze({
    strategySha,
    runtimeSha,
    datasetIdentity,
    complete: Boolean(strategySha && runtimeSha && datasetIdentity),
  });
}

function evidenceIdentityMatches(evidence, identity) {
  if (!evidence || typeof evidence !== 'object') return true;
  const strategySha = evidence.strategySha === undefined ? identity.strategySha : exactSha(evidence.strategySha);
  const runtimeSha = evidence.runtimeSha === undefined ? identity.runtimeSha : exactSha(evidence.runtimeSha);
  const datasetIdentity = evidence.datasetIdentity === undefined
    ? identity.datasetIdentity
    : (nonEmpty(evidence.datasetIdentity) ? evidence.datasetIdentity.trim() : null);
  return strategySha === identity.strategySha
    && runtimeSha === identity.runtimeSha
    && datasetIdentity === identity.datasetIdentity;
}

function hasNonNaturalEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return NON_NATURAL_EVIDENCE_FLAGS.some((flag) => evidence[flag] === true);
}

function hasDuplicateObservationIds(evidence) {
  if (!Array.isArray(evidence?.observationIds)) return false;
  const ids = evidence.observationIds.filter((value) => nonEmpty(value)).map((value) => value.trim());
  return new Set(ids).size !== ids.length;
}

function blockerFor(stage, input) {
  const explicit = input?.blockerReasons?.[stage];
  if (nonEmpty(explicit)) return explicit.trim();
  return NATURAL_PAPER_FIRST_ZERO_CODES[stage];
}

function stageCount(input, stage, identity) {
  const field = NATURAL_PAPER_STAGE_FIELDS[stage];
  const evidence = input?.stageEvidence?.[stage];
  const rawCount = evidence && Object.prototype.hasOwnProperty.call(evidence, 'count')
    ? evidence.count
    : input[field];

  if (evidence && !evidenceIdentityMatches(evidence, identity)) {
    return Object.freeze({ field, count: null, evidenceStatus: 'IDENTITY_MISMATCH' });
  }
  if (hasNonNaturalEvidence(evidence)) {
    return Object.freeze({ field, count: null, evidenceStatus: 'NON_NATURAL_EVIDENCE_REJECTED' });
  }
  if (hasDuplicateObservationIds(evidence)) {
    return Object.freeze({ field, count: null, evidenceStatus: 'DUPLICATE_OBSERVATION_REJECTED' });
  }
  return Object.freeze({ field, count: countOrUnknown(rawCount), evidenceStatus: 'ACCEPTED' });
}

export function buildNaturalPaperFirstZeroTrace(input = {}) {
  const cycleId = nonEmpty(input.cycleId) ? input.cycleId.trim() : null;
  const triggerSource = nonEmpty(input.triggerSource) ? input.triggerSource.trim().toLowerCase() : null;
  const naturalCycle = NATURAL_TRIGGER_SOURCES.has(triggerSource);
  const identity = normalizeIdentity(input);
  const counts = {};
  const stages = [];
  let firstZeroStage = null;
  let firstUnknownStage = null;
  let earlierEvidenceKnown = identity.complete && naturalCycle;

  for (const stage of NATURAL_PAPER_STAGE_ORDER) {
    const observed = stageCount(input, stage, identity);
    const { field, count, evidenceStatus } = observed;
    counts[field] = count;
    let status = 'PASS';
    let firstZeroCode = null;
    let blockerReason = null;

    if (!identity.complete) {
      status = 'UNKNOWN_IDENTITY';
      if (firstUnknownStage === null) firstUnknownStage = stage;
      earlierEvidenceKnown = false;
    } else if (!naturalCycle) {
      status = 'NOT_NATURAL_CYCLE';
      if (firstUnknownStage === null) firstUnknownStage = stage;
      earlierEvidenceKnown = false;
    } else if (evidenceStatus !== 'ACCEPTED') {
      status = evidenceStatus;
      if (firstUnknownStage === null && firstZeroStage === null) firstUnknownStage = stage;
      earlierEvidenceKnown = false;
    } else if (count === null) {
      status = 'UNKNOWN';
      if (firstUnknownStage === null && firstZeroStage === null) firstUnknownStage = stage;
      earlierEvidenceKnown = false;
    } else if (count === 0) {
      status = 'ZERO';
      firstZeroCode = NATURAL_PAPER_FIRST_ZERO_CODES[stage];
      blockerReason = blockerFor(stage, input);
      if (firstZeroStage === null && firstUnknownStage === null && earlierEvidenceKnown) {
        firstZeroStage = Object.freeze({ stage, field, code: firstZeroCode, blockerReason });
      }
    }

    stages.push(Object.freeze({ stage, field, count, status, evidenceStatus, firstZeroCode, blockerReason }));
  }

  const allObservedPositive = stages.every((stage) => stage.status === 'PASS' && stage.count > 0);
  const status = !identity.complete
    ? 'WAITING_IDENTITY'
    : !naturalCycle
      ? 'NOT_NATURAL_CYCLE'
      : firstZeroStage
        ? 'BLOCKED'
        : firstUnknownStage
          ? 'WAITING_EVIDENCE'
          : allObservedPositive
            ? 'COMPLETE'
            : 'WAITING_EVIDENCE';

  return Object.freeze({
    schemaVersion: 'natural-paper-first-zero-trace-v2',
    cycleId,
    triggerSource,
    naturalCycle,
    identity,
    status,
    counts: Object.freeze(counts),
    stages: Object.freeze(stages),
    firstZeroStage,
    firstZeroStageName: firstZeroStage?.stage ?? (allObservedPositive ? 'NONE' : 'UNKNOWN'),
    firstUnknownStage,
    safety: Object.freeze({
      readOnly: true,
      executionAuthority: 'NONE',
      syntheticEvidenceAllowed: false,
      historicalEvidenceAsNaturalAllowed: false,
      replayEvidenceAsNaturalAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      transferEnabled: false,
      withdrawalEnabled: false,
      orderCount: 0,
      cancelCount: 0,
      amendCount: 0,
      transferCount: 0,
      withdrawalCount: 0,
    }),
  });
}
