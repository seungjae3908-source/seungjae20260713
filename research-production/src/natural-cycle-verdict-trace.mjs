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

export const CANONICAL_NATURAL_PAPER_STAGE_ORDER = Object.freeze([
  'SIGNAL_CANDIDATE',
  'QUALITY_PASSED',
  'RISK_PASSED',
  'ENTRY_ELIGIBLE',
  'ENTRY',
  'POSITION',
  'EXIT_ELIGIBLE',
  'SETTLEMENT',
]);

export const CANONICAL_NATURAL_PAPER_STAGE_FIELDS = Object.freeze({
  SIGNAL_CANDIDATE: 'signalCandidate',
  QUALITY_PASSED: 'qualityPassed',
  RISK_PASSED: 'riskPassed',
  ENTRY_ELIGIBLE: 'entryEligible',
  ENTRY: 'entry',
  POSITION: 'position',
  EXIT_ELIGIBLE: 'exitEligible',
  SETTLEMENT: 'settlement',
});

export const CANONICAL_NATURAL_PAPER_REASON_TAXONOMY = Object.freeze([
  'NO_SIGNAL',
  'QUALITY_GATE',
  'RISK_GATE',
  'DATA_STALE',
  'DATA_MISSING',
  'MARKET_CLOSED',
  'PROVIDER_FAILURE',
  'IDENTITY_MISMATCH',
  'ACCOUNT_STATE_BLOCK',
  'COOLDOWN',
  'DUPLICATE',
  'REPLAY_ONLY',
  'UNKNOWN',
]);

const CANONICAL_REASON_SOURCE_STAGE = Object.freeze({
  SIGNAL_CANDIDATE: 'SIGNAL_CANDIDATE',
  QUALITY_PASSED: 'QUALITY_GATE',
  RISK_PASSED: 'RISK_GATE',
  ENTRY_ELIGIBLE: 'ENTRY_ELIGIBLE',
  ENTRY: 'ENTRY',
  POSITION: 'POSITION',
  EXIT_ELIGIBLE: 'EXIT_ELIGIBLE',
  SETTLEMENT: 'SETTLEMENT',
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

function canonicalIdentity(evidence = {}) {
  const source = evidence.identity && typeof evidence.identity === 'object' ? evidence.identity : {};
  const base = normalizeIdentity(source);
  const cycleId = nonEmpty(source.cycleId) ? source.cycleId.trim() : null;
  const triggerSource = nonEmpty(source.triggerSource) ? source.triggerSource.trim().toLowerCase() : null;
  return Object.freeze({
    ...base,
    cycleId,
    triggerSource,
    complete: Boolean(base.complete && cycleId),
  });
}

function canonicalIdentityMatches(source, identity) {
  if (!source || typeof source !== 'object') return false;
  return exactSha(source.strategySha) === identity.strategySha
    && exactSha(source.runtimeSha) === identity.runtimeSha
    && String(source.datasetIdentity ?? '').trim() === identity.datasetIdentity
    && String(source.cycleId ?? '').trim() === identity.cycleId
    && String(source.triggerSource ?? '').trim().toLowerCase() === identity.triggerSource;
}

function canonicalStageObservation(evidence, stage, identity, naturalCycle) {
  const field = CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage];
  const measurement = evidence?.stageCounts?.[field];
  if (!measurement || typeof measurement !== 'object') {
    return Object.freeze({ stage, field, count: null, status: 'UNKNOWN', evidenceStatus: 'MISSING' });
  }
  if (!identity.complete) {
    return Object.freeze({ stage, field, count: null, status: 'UNKNOWN_IDENTITY', evidenceStatus: 'IDENTITY_INCOMPLETE' });
  }
  if (!naturalCycle) {
    return Object.freeze({ stage, field, count: null, status: 'NOT_NATURAL_CYCLE', evidenceStatus: 'NON_NATURAL_CYCLE' });
  }
  if (measurement.status !== 'MEASURED') {
    return Object.freeze({
      stage,
      field,
      count: null,
      status: 'UNKNOWN',
      evidenceStatus: nonEmpty(measurement.blocker) ? measurement.blocker.trim() : 'UNMEASURED',
    });
  }
  if (!canonicalIdentityMatches(measurement.identity, identity)) {
    return Object.freeze({ stage, field, count: null, status: 'IDENTITY_MISMATCH', evidenceStatus: 'IDENTITY_MISMATCH' });
  }
  if (!Number.isSafeInteger(measurement.count) || measurement.count < 0) {
    return Object.freeze({ stage, field, count: null, status: 'INVALID_COUNT', evidenceStatus: 'INVALID_COUNT' });
  }
  const ids = Array.isArray(measurement.observationIds)
    ? measurement.observationIds.filter((value) => nonEmpty(value)).map((value) => value.trim())
    : [];
  if (ids.length !== measurement.count) {
    return Object.freeze({ stage, field, count: null, status: 'INCOMPLETE_PROVENANCE', evidenceStatus: 'OBSERVATION_ID_COVERAGE_INCOMPLETE' });
  }
  if (new Set(ids).size !== ids.length) {
    return Object.freeze({ stage, field, count: null, status: 'DUPLICATE_OBSERVATION_REJECTED', evidenceStatus: 'DUPLICATE_OBSERVATION_REJECTED' });
  }
  if (measurement.naturalCredit !== measurement.count
    || measurement.replayCredit !== 0
    || measurement.duplicateCredit !== 0) {
    return Object.freeze({ stage, field, count: null, status: 'INVALID_CREDIT', evidenceStatus: 'NON_NATURAL_CREDIT_REJECTED' });
  }
  return Object.freeze({
    stage,
    field,
    count: measurement.count,
    status: measurement.count === 0 ? 'ZERO' : 'PASS',
    evidenceStatus: 'ACCEPTED',
    observationIds: Object.freeze(ids),
    provenance: measurement.provenance ?? null,
  });
}

function canonicalReasonFor(stage, evidence, identity) {
  const allowed = new Set(CANONICAL_NATURAL_PAPER_REASON_TAXONOMY);
  const expectedSourceStage = CANONICAL_REASON_SOURCE_STAGE[stage];
  const accepted = (Array.isArray(evidence?.reasonObservations) ? evidence.reasonObservations : [])
    .filter((row) => row?.sourceStage === expectedSourceStage
      && row?.lossless === true
      && nonEmpty(row?.rawReason)
      && canonicalIdentityMatches(row?.identity, identity)
      && row?.replayCredit === 0
      && row?.duplicateCredit === 0)
    .map((row) => String(row.canonicalReason ?? 'UNKNOWN').trim().toUpperCase())
    .filter((reason) => allowed.has(reason) && reason !== 'UNKNOWN');
  return accepted.length > 0 && new Set(accepted).size === 1
    ? Object.freeze({ reason: accepted[0], status: 'ACCEPTED_LOSSLESS' })
    : Object.freeze({ reason: 'UNKNOWN', status: 'MISSING_OR_LOSSY' });
}

export function buildCanonicalNaturalPaperFirstZeroTrace(evidence = {}) {
  const identity = canonicalIdentity(evidence);
  const naturalCycle = NATURAL_TRIGGER_SOURCES.has(identity.triggerSource);
  const topLevelCreditValid = evidence.replayCredit === 0
    && evidence.duplicateCredit === 0
    && evidence.historicalCredit === 0
    && (!naturalCycle || evidence.naturalCredit === 1);
  const stages = CANONICAL_NATURAL_PAPER_STAGE_ORDER.map((stage) => (
    topLevelCreditValid
      ? canonicalStageObservation(evidence, stage, identity, naturalCycle)
      : Object.freeze({
          stage,
          field: CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage],
          count: null,
          status: 'INVALID_CREDIT',
          evidenceStatus: 'NON_NATURAL_CREDIT_REJECTED',
        })
  ));
  let firstZero = null;
  let firstUnknownStage = null;
  for (const stage of stages) {
    if (stage.evidenceStatus !== 'ACCEPTED') {
      firstUnknownStage = stage.stage;
      break;
    }
    if (stage.count === 0) {
      firstZero = stage;
      break;
    }
  }
  const allPositive = stages.every((stage) => stage.evidenceStatus === 'ACCEPTED' && stage.count > 0);
  const reason = firstZero
    ? canonicalReasonFor(firstZero.stage, evidence, identity)
    : Object.freeze({ reason: 'UNKNOWN', status: 'NOT_APPLICABLE' });
  const status = !identity.complete
    ? 'WAITING_IDENTITY'
    : !naturalCycle
      ? 'NOT_NATURAL_CYCLE'
      : firstZero
        ? 'BLOCKED'
        : firstUnknownStage
          ? 'WAITING_EVIDENCE'
          : allPositive
            ? 'COMPLETE'
            : 'WAITING_EVIDENCE';
  return Object.freeze({
    schemaVersion: 'canonical-natural-paper-first-zero-trace-v1',
    status,
    identity,
    naturalCycle,
    stages: Object.freeze(stages),
    firstZeroStage: firstZero,
    firstZeroStageName: firstZero?.stage ?? (allPositive ? 'NONE' : 'UNKNOWN'),
    firstZeroReason: reason.reason,
    firstZeroReasonEvidenceStatus: reason.status,
    firstUnknownStage,
    suppliedFirstZeroIgnored: evidence.firstZeroStage !== undefined || evidence.firstZeroReason !== undefined,
    unknownIsZero: false,
    safety: Object.freeze({
      readOnly: true,
      executionAuthority: 'NONE',
      replayEvidenceAsNaturalAllowed: false,
      duplicateEvidenceAsNaturalAllowed: false,
      historicalEvidenceAsNaturalAllowed: false,
      liveTrading: false,
      privateTradingApiAllowed: false,
      orderCount: 0,
    }),
  });
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
    strategySha: bundle.strategySha
      ?? bundle.researchCodeSha
      ?? runtimeResult.naturalStrategySha,
    runtimeSha: bundle.runtimeSha
      ?? runtimeResult.naturalRuntimeSha,
    datasetIdentity: bundle.datasetIdentity
      ?? runtimeResult.naturalDatasetIdentity,
  });
}

function runtimeTriggerSource(runtimeResult = {}) {
  if (nonEmpty(runtimeResult.triggerSource)) return runtimeResult.triggerSource.trim().toLowerCase();
  return runtimeResult.naturalScheduleInvocation === true ? 'scheduler' : null;
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

function runtimeMeasurementSelection(runtimeResult = {}) {
  if (Array.isArray(runtimeResult.naturalFunnelMeasurements)
    || (runtimeResult.naturalFunnelMeasurements
      && typeof runtimeResult.naturalFunnelMeasurements === 'object')) {
    return Object.freeze({
      source: runtimeResult.naturalFunnelMeasurements,
      sourceName: 'NATURAL_FUNNEL',
      requiresMeasuredStatus: true,
    });
  }
  return Object.freeze({
    source: runtimeResult.authoritativeStageMeasurements,
    sourceName: 'AUTHORITATIVE_LEGACY',
    requiresMeasuredStatus: false,
  });
}

function runtimeMeasurementCount(measurement, requiresMeasuredStatus) {
  if (!requiresMeasuredStatus) return measurement?.count;
  return String(measurement?.status ?? '').trim().toUpperCase() === 'MEASURED'
    ? measurement.count
    : null;
}

function extractRuntimeStageEvidence(runtimeResult, identity) {
  const selection = runtimeMeasurementSelection(runtimeResult);
  const { source, requiresMeasuredStatus } = selection;
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
          count: runtimeMeasurementCount(measurement, requiresMeasuredStatus),
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
            count: runtimeMeasurementCount(measurement, requiresMeasuredStatus),
            strategySha: measurement.strategySha ?? identity.strategySha,
            runtimeSha: measurement.runtimeSha ?? identity.runtimeSha,
            datasetIdentity: measurement.datasetIdentity ?? identity.datasetIdentity,
          }
        : {
            count: requiresMeasuredStatus ? null : measurement,
            strategySha: identity.strategySha,
            runtimeSha: identity.runtimeSha,
            datasetIdentity: identity.datasetIdentity,
          };
    }
  }
  return Object.freeze({ stageEvidence, sourceName: selection.sourceName });
}

function measurementsPresent(source) {
  return Array.isArray(source)
    ? source.length > 0
    : Boolean(source && typeof source === 'object');
}

export function buildNaturalPaperFirstZeroTraceFromRuntime(runtimeResult = {}) {
  const identity = runtimeIdentity(runtimeResult);
  const { stageEvidence, sourceName } = extractRuntimeStageEvidence(runtimeResult, identity);
  const triggerSource = runtimeTriggerSource(runtimeResult);
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: runtimeResult.cycleId,
    triggerSource,
    strategySha: identity.strategySha,
    runtimeSha: identity.runtimeSha,
    datasetIdentity: identity.datasetIdentity,
    stageEvidence,
    reasonEvidenceByStage: runtimeResult.authoritativeFirstZeroReasonEvidenceByStage,
  });
  const canonicalTrace = runtimeResult.canonicalNaturalStageEvidence
    ? buildCanonicalNaturalPaperFirstZeroTrace(runtimeResult.canonicalNaturalStageEvidence)
    : null;

  return Object.freeze({
    ...trace,
    canonicalTrace,
    runtimeAdapter: Object.freeze({
      authoritativeMeasurementsPresent: measurementsPresent(runtimeResult.authoritativeStageMeasurements),
      naturalMeasurementsPresent: measurementsPresent(runtimeResult.naturalFunnelMeasurements),
      canonicalMeasurementsPresent: canonicalTrace !== null,
      selectedMeasurementSource: sourceName,
      completeIdentityPresent: identity.complete,
      suppliedFirstZeroStageIgnored: runtimeResult.firstZeroStage !== undefined
        || runtimeResult.naturalFirstZeroStage !== undefined,
      suppliedFirstZeroReasonIgnored: runtimeResult.firstZeroReason !== undefined
        || runtimeResult.naturalFirstZeroReason !== undefined,
      verdictRecomputedFromCounts: true,
    }),
  });
}
