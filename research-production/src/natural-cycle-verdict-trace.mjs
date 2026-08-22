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

// These codes describe the zero stage only. They are diagnostic classes, not
// authoritative root-cause evidence. FIRST_ZERO_REASON is accepted separately.
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

const RUNTIME_STAGE_NAMES = Object.freeze({
  UNIVERSE: Object.freeze(['UNIVERSE', 'Universe']),
  SCANNER_EVALUATED: Object.freeze(['SCANNER_EVALUATED', 'Scanner Evaluated']),
  CANDIDATE: Object.freeze(['CANDIDATE', 'Scanner Candidate']),
  EVIDENCE_COMPLETE: Object.freeze(['EVIDENCE_COMPLETE', 'Evidence Complete']),
  ADMISSION_PASS: Object.freeze(['ADMISSION_PASS', 'Admission Pass']),
  RISK_PASS: Object.freeze(['RISK_PASS', 'Risk Pass']),
  COST_PASS: Object.freeze(['COST_PASS', 'Cost Pass']),
  ACCOUNT_READY: Object.freeze(['ACCOUNT_READY', 'Account Ready']),
  PAPER_ENTRY: Object.freeze(['PAPER_ENTRY', 'Paper Entry']),
  POSITION: Object.freeze(['POSITION', 'Paper Position']),
  SETTLEMENT: Object.freeze(['SETTLEMENT', 'Settlement']),
  OUTCOME: Object.freeze(['OUTCOME', 'Outcome']),
});

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

function stageCount(input, stage, identity) {
  const field = NATURAL_PAPER_STAGE_FIELDS[stage];
  const evidence = input?.stageEvidence?.[stage];
  const rawCount = evidence && Object.prototype.hasOwnProperty.call(evidence, 'count')
    ? evidence.count
    : input[field];

  if (evidence?.sourceConflict === true) {
    return Object.freeze({ field, count: null, evidenceStatus: 'DUPLICATE_STAGE_MEASUREMENT_REJECTED' });
  }
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

function authoritativeReasonFor(stage, input, identity) {
  const evidence = input?.reasonEvidenceByStage?.[stage];
  if (!evidence || typeof evidence !== 'object') {
    return Object.freeze({ reason: 'UNKNOWN', status: 'MISSING' });
  }
  if (evidence.authoritative !== true) {
    return Object.freeze({ reason: 'UNKNOWN', status: 'NOT_AUTHORITATIVE' });
  }
  if (String(evidence.freshness ?? '').trim().toUpperCase() !== 'FRESH') {
    return Object.freeze({ reason: 'UNKNOWN', status: 'STALE_OR_UNKNOWN_FRESHNESS' });
  }
  if (!evidenceIdentityMatches(evidence, identity)) {
    return Object.freeze({ reason: 'UNKNOWN', status: 'IDENTITY_MISMATCH' });
  }
  if (hasNonNaturalEvidence(evidence) || hasDuplicateObservationIds(evidence)) {
    return Object.freeze({ reason: 'UNKNOWN', status: 'REJECTED_EVIDENCE' });
  }
  const reasonCode = String(evidence.reasonCode ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) {
    return Object.freeze({ reason: 'UNKNOWN', status: 'INVALID_REASON_CODE' });
  }
  return Object.freeze({ reason: reasonCode, status: 'ACCEPTED' });
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
    let diagnosticClass = null;

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
      diagnosticClass = firstZeroCode;
      if (firstZeroStage === null && firstUnknownStage === null && earlierEvidenceKnown) {
        firstZeroStage = Object.freeze({ stage, field, code: firstZeroCode, diagnosticClass });
      }
    }

    stages.push(Object.freeze({ stage, field, count, status, evidenceStatus, firstZeroCode, diagnosticClass }));
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
  const authoritativeReason = firstZeroStage
    ? authoritativeReasonFor(firstZeroStage.stage, input, identity)
    : Object.freeze({ reason: 'UNKNOWN', status: 'NOT_APPLICABLE' });

  return Object.freeze({
    schemaVersion: 'natural-paper-first-zero-trace-v3',
    cycleId,
    triggerSource,
    naturalCycle,
    identity,
    status,
    counts: Object.freeze(counts),
    stages: Object.freeze(stages),
    firstZeroStage,
    firstZeroStageName: firstZeroStage?.stage ?? (allObservedPositive ? 'NONE' : 'UNKNOWN'),
    firstZeroReason: authoritativeReason.reason,
    firstZeroReasonEvidenceStatus: authoritativeReason.status,
    firstUnknownStage,
    safety: Object.freeze({
      readOnly: true,
      executionAuthority: 'NONE',
      syntheticEvidenceAllowed: false,
      historicalEvidenceAsNaturalAllowed: false,
      replayEvidenceAsNaturalAllowed: false,
      runtimeVerdictTrusted: false,
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

function runtimeIdentity(runtimeResult = {}) {
  const bundle = runtimeResult.identity && typeof runtimeResult.identity === 'object'
    ? runtimeResult.identity
    : runtimeResult;
  return normalizeIdentity({
    strategySha: bundle.strategySha ?? bundle.researchCodeSha,
    runtimeSha: bundle.runtimeSha,
    datasetIdentity: bundle.datasetIdentity,
  });
}

function runtimeMeasurementMatches(measurement, stage) {
  if (!measurement || typeof measurement !== 'object') return false;
  const field = NATURAL_PAPER_STAGE_FIELDS[stage];
  const exactNames = RUNTIME_STAGE_NAMES[stage];
  return measurement.instrumentationKey === field
    || measurement.field === field
    || exactNames.includes(measurement.stage)
    || exactNames.includes(measurement.name);
}

function extractRuntimeStageEvidence(runtimeResult, identity) {
  const source = runtimeResult?.authoritativeStageMeasurements;
  const stageEvidence = {};

  for (const stage of NATURAL_PAPER_STAGE_ORDER) {
    const field = NATURAL_PAPER_STAGE_FIELDS[stage];
    if (Array.isArray(source)) {
      const matches = source.filter((measurement) => runtimeMeasurementMatches(measurement, stage));
      if (matches.length > 1) {
        stageEvidence[stage] = { count: null, sourceConflict: true };
      } else if (matches.length === 1) {
        const measurement = matches[0];
        stageEvidence[stage] = {
          count: measurement.count,
          strategySha: measurement.strategySha ?? identity.strategySha,
          runtimeSha: measurement.runtimeSha ?? identity.runtimeSha,
          datasetIdentity: measurement.datasetIdentity ?? identity.datasetIdentity,
          observationIds: measurement.observationIds,
          synthetic: measurement.synthetic,
          testFixture: measurement.testFixture,
          historical: measurement.historical,
          replay: measurement.replay,
          duplicateReplay: measurement.duplicateReplay,
          manualExpiry: measurement.manualExpiry,
          futureTimeCompression: measurement.futureTimeCompression,
          clockAdvanced: measurement.clockAdvanced,
        };
      }
    } else if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, field)) {
      const measurement = source[field];
      stageEvidence[stage] = measurement && typeof measurement === 'object'
        ? {
            ...measurement,
            count: measurement.count,
            strategySha: measurement.strategySha ?? identity.strategySha,
            runtimeSha: measurement.runtimeSha ?? identity.runtimeSha,
            datasetIdentity: measurement.datasetIdentity ?? identity.datasetIdentity,
          }
        : { count: measurement, strategySha: identity.strategySha, runtimeSha: identity.runtimeSha, datasetIdentity: identity.datasetIdentity };
    }
  }
  return stageEvidence;
}

export function buildNaturalPaperFirstZeroTraceFromRuntime(runtimeResult = {}) {
  const identity = runtimeIdentity(runtimeResult);
  const stageEvidence = extractRuntimeStageEvidence(runtimeResult, identity);
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: runtimeResult.cycleId,
    triggerSource: runtimeResult.triggerSource,
    strategySha: identity.strategySha,
    runtimeSha: identity.runtimeSha,
    datasetIdentity: identity.datasetIdentity,
    stageEvidence,
    reasonEvidenceByStage: runtimeResult.authoritativeFirstZeroReasonEvidenceByStage,
  });

  return Object.freeze({
    ...trace,
    runtimeAdapter: Object.freeze({
      authoritativeMeasurementsPresent: Array.isArray(runtimeResult.authoritativeStageMeasurements)
        ? runtimeResult.authoritativeStageMeasurements.length > 0
        : Boolean(runtimeResult.authoritativeStageMeasurements && typeof runtimeResult.authoritativeStageMeasurements === 'object'),
      completeIdentityPresent: identity.complete,
      suppliedFirstZeroStageIgnored: runtimeResult.firstZeroStage !== undefined,
      suppliedFirstZeroReasonIgnored: runtimeResult.firstZeroReason !== undefined,
      verdictRecomputedFromCounts: true,
    }),
  });
}
