import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const NATURAL_PAPER_OBSERVABILITY_VERSION = 'natural-paper-evidence-observability-v1';

export const NATURAL_PAPER_OBSERVABILITY_STAGES = Object.freeze([
  Object.freeze({ name: 'CANDIDATE', field: 'candidateCount', kind: 'canonical', source: 'signalCandidate', identityRequired: true }),
  Object.freeze({ name: 'EVIDENCE', field: 'authoritativeEvidenceReadyCount', kind: 'funnel', source: 'EVIDENCE_COMPLETE', identityRequired: false }),
  Object.freeze({ name: 'RISK', field: 'riskSizingReadyCount', kind: 'canonical', source: 'riskPassed', identityRequired: true }),
  Object.freeze({ name: 'ADMISSION', field: 'admissionReadyCount', kind: 'canonical', source: 'entryEligible', identityRequired: true }),
  Object.freeze({ name: 'ENTRY', field: 'entryCreatedCount', kind: 'canonical', source: 'entry', identityRequired: true }),
  Object.freeze({ name: 'POSITION', field: 'positionOpenCount', kind: 'canonical', source: 'position', identityRequired: true }),
  Object.freeze({ name: 'EXIT_ELIGIBLE', field: 'exitEligibleCount', kind: 'canonical', source: 'exitEligible', identityRequired: true }),
  Object.freeze({ name: 'SETTLEMENT', field: 'settlementCreatedCount', kind: 'canonical', source: 'settlement', identityRequired: true }),
]);

export const NATURAL_PAPER_REJECTION_REASONS = Object.freeze([
  'NO_TRADE',
  'MISSING_EVIDENCE',
  'BLOCKED_DATA',
  'STALE_DATA',
  'IDENTITY_MISMATCH',
  'RISK_REJECTED',
  'COST_INCOMPLETE',
  'POLICY_REJECTED',
  'ENTRY_DUPLICATE',
  'EXIT_NOT_REACHED',
  'SETTLEMENT_DUPLICATE',
  'RUNTIME_ERROR',
]);

const NATURAL_TRIGGERS = new Set(['cron', 'scheduler', 'scheduled', 'systemd-timer', 'systemd_timer', 'timer']);
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_FUTURE_SKEW_MS = 60_000;

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableSerialize(value)).digest('hex');
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return HEX_40.test(normalized) ? normalized : null;
}

function digest(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^sha256:/u, '');
  return HEX_64.test(normalized) ? normalized : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function idDigests(source = {}) {
  const supplied = Array.isArray(source.observationIdDigests)
    ? source.observationIdDigests.map(digest)
    : Array.isArray(source.observationIds)
      ? source.observationIds.map((value) => nonEmpty(value) ? sha256(value.trim()) : null)
      : [];
  return supplied;
}

function canonicalIdentity(input = {}) {
  const state = input.strategyIdentity && typeof input.strategyIdentity === 'object'
    ? input.strategyIdentity
    : {};
  const researchCodeSha = exactSha(input.exactCodeSha ?? input.naturalRuntimeSha ?? state.researchCodeSha);
  const strategySha = exactSha(input.naturalStrategySha);
  const runtimeSha = exactSha(input.naturalRuntimeSha);
  const expectedCodeSha = exactSha(input.expectedCodeSha);
  const parameterHash = digest(state.parameterHash);
  const datasetIdentityDigest = digest(input.naturalDatasetIdentityDigest);
  const identity = {
    cycleId: nonEmpty(input.cycleId) ? input.cycleId.trim().slice(0, 256) : null,
    triggerSource: nonEmpty(input.triggerSource) ? input.triggerSource.trim().toLowerCase() : null,
    research: {
      exactCodeSha: researchCodeSha,
      expectedCodeSha,
    },
    model: {
      parameterHash,
      source: parameterHash ? 'recurring-paper-loop.identity.parameterHash' : null,
    },
    strategy: {
      strategyId: nonEmpty(state.strategyId) ? state.strategyId.trim().slice(0, 160) : null,
      strategyVersion: nonEmpty(state.strategyVersion) ? state.strategyVersion.trim().slice(0, 80) : null,
      strategySha,
      costPolicyVersion: nonEmpty(state.costPolicyVersion) ? state.costPolicyVersion.trim().slice(0, 160) : null,
      executionPolicyVersion: nonEmpty(state.executionPolicyVersion) ? state.executionPolicyVersion.trim().slice(0, 160) : null,
    },
    runtimeSha,
    datasetIdentityDigest,
  };
  const shaMatches = Boolean(researchCodeSha && strategySha && runtimeSha
    && researchCodeSha === strategySha
    && researchCodeSha === runtimeSha
    && (!expectedCodeSha || expectedCodeSha === researchCodeSha));
  const complete = Boolean(identity.cycleId
    && NATURAL_TRIGGERS.has(identity.triggerSource)
    && shaMatches
    && parameterHash
    && identity.strategy.strategyId
    && identity.strategy.strategyVersion
    && identity.strategy.costPolicyVersion
    && identity.strategy.executionPolicyVersion
    && datasetIdentityDigest);
  return freeze({ ...identity, shaMatches, complete });
}

function inputSafety(input = {}) {
  const checks = {
    externalFinancialMutationAllowed: input.externalFinancialMutationAllowed === false,
    privateRequestCount: input.privateRequestCount === 0,
    financialMutationCount: input.financialMutationCount === 0,
    orderCount: input.orderCount === 0,
    liveTrading: input.liveTrading === false,
    orderAuthority: input.orderAuthority === false || input.orderAuthority === 'NONE',
  };
  return freeze({
    valid: Object.values(checks).every(Boolean),
    checks,
    readOnly: true,
    runtimeMutationCount: 0,
    databaseMutationCount: 0,
    privateApiCount: 0,
    liveTrading: false,
    executionAuthority: 'NONE',
    realOrderCount: 0,
  });
}

function canonicalRoot(input = {}) {
  return input.canonicalNaturalStageEvidence && typeof input.canonicalNaturalStageEvidence === 'object'
    ? input.canonicalNaturalStageEvidence
    : {};
}

function rootIdentityMatches(root, identity) {
  const source = root.identity && typeof root.identity === 'object' ? root.identity : {};
  const sourceDatasetDigest = digest(source.datasetIdentityDigest)
    ?? (nonEmpty(source.datasetIdentity) ? sha256(source.datasetIdentity.trim()) : null);
  return String(source.cycleId ?? '').trim() === identity.cycleId
    && exactSha(source.strategySha) === identity.research.exactCodeSha
    && exactSha(source.runtimeSha) === identity.runtimeSha
    && sourceDatasetDigest === identity.datasetIdentityDigest
    && String(source.triggerSource ?? '').trim().toLowerCase() === identity.triggerSource;
}

function sourceForStage(input, descriptor) {
  if (descriptor.kind === 'canonical') {
    return canonicalRoot(input)?.stageCounts?.[descriptor.source] ?? null;
  }
  const matches = (Array.isArray(input.naturalFunnelMeasurements) ? input.naturalFunnelMeasurements : [])
    .filter((row) => row?.stage === descriptor.source || row?.name === descriptor.source || row?.field === descriptor.field);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? { sourceConflict: true } : null;
}

function sourceTimestamp(source = {}) {
  return timestamp(source.observedAtMs ?? source.observedAt ?? source.measuredAtMs ?? source.sourceTimestampMs);
}

function stageObservation(input, descriptor, identity, verifiedAtMs, rootIdentityValid, naturalEligible) {
  const source = sourceForStage(input, descriptor);
  const sourceCount = count(source?.count);
  const digests = idDigests(source);
  const uniqueDigests = digests.filter(Boolean);
  const duplicateCount = uniqueDigests.length - new Set(uniqueDigests).size;
  const observedAtMs = sourceTimestamp(source);
  const timestampValid = observedAtMs !== null && observedAtMs <= verifiedAtMs + MAX_FUTURE_SKEW_MS;
  const canonical = descriptor.kind === 'canonical';
  const stageIdentityMatches = canonical
    ? rootIdentityMatches({ identity: source?.identity }, identity)
    : identity.complete;
  const identityMatches = canonical ? rootIdentityValid && stageIdentityMatches : identity.complete;
  const creditValid = !canonical || (
    source?.naturalCredit === sourceCount
    && source?.replayCredit === 0
    && source?.duplicateCredit === 0
  );
  const idsValid = !descriptor.identityRequired || (
    sourceCount !== null
    && digests.length === sourceCount
    && digests.every(Boolean)
    && duplicateCount === 0
  );
  const measured = source?.status === 'MEASURED' && sourceCount !== null && source?.sourceConflict !== true;
  let status = 'ACCEPTED';
  let blocker = null;
  if (!naturalEligible) {
    status = 'NON_NATURAL_EXCLUDED';
    blocker = 'NON_NATURAL_EVIDENCE_HAS_ZERO_CREDIT';
  } else if (!source) {
    status = 'MISSING';
    blocker = `MISSING_${descriptor.name}_MEASUREMENT`;
  } else if (source?.sourceConflict === true) {
    status = 'SOURCE_CONFLICT';
    blocker = `DUPLICATE_${descriptor.name}_MEASUREMENT`;
  } else if (!measured) {
    status = 'UNKNOWN';
    blocker = nonEmpty(source?.blocker) ? source.blocker.trim().slice(0, 240) : `UNMEASURED_${descriptor.name}`;
  } else if (!identityMatches) {
    status = 'IDENTITY_MISMATCH';
    blocker = `${descriptor.name}_IDENTITY_MISMATCH`;
  } else if (!creditValid) {
    status = 'INVALID_CREDIT';
    blocker = `${descriptor.name}_NON_NATURAL_CREDIT_REJECTED`;
  } else if (!idsValid) {
    status = duplicateCount > 0 ? 'DUPLICATE_IDENTITY' : 'IDENTITY_COVERAGE_INCOMPLETE';
    blocker = duplicateCount > 0
      ? `${descriptor.name}_DUPLICATE_IDENTITY`
      : `${descriptor.name}_IDENTITY_COVERAGE_INCOMPLETE`;
  } else if (!timestampValid) {
    status = observedAtMs === null ? 'SOURCE_TIMESTAMP_MISSING' : 'SOURCE_TIMESTAMP_FUTURE';
    blocker = `${descriptor.name}_${status}`;
  }
  const accepted = status === 'ACCEPTED';
  const sanitizedSource = {
    stage: descriptor.name,
    field: descriptor.field,
    sourceKind: descriptor.kind,
    sourceName: descriptor.source,
    count: accepted ? sourceCount : null,
    status,
    blocker,
    provenance: nonEmpty(source?.provenance) ? source.provenance.trim().slice(0, 320) : null,
    sourceTimestampMs: observedAtMs,
    observationIdDigests: accepted ? uniqueDigests : [],
    identityRequired: descriptor.identityRequired,
    identityValid: accepted && idsValid && identityMatches,
    duplicateIdentityCount: duplicateCount,
  };
  return freeze({ ...sanitizedSource, evidenceDigest: sha256(sanitizedSource) });
}

function nonNaturalEvidence(input, root) {
  const flags = [
    input.testOnly,
    input.synthetic,
    input.historical,
    input.replay,
    input.duplicateReplay,
    input.testFixture,
    input.manualExpiry,
    input.futureTimeCompression,
    input.clockAdvanced,
  ];
  return flags.some((value) => value === true)
    || input.evidenceClass === 'TEST_ONLY'
    || input.status === 'REPLAYED'
    || root.naturalCredit !== 1
    || root.replayCredit !== 0
    || root.duplicateCredit !== 0
    || root.historicalCredit !== 0;
}

function reasonCategory(row = {}, stageName = null) {
  const canonical = String(row.canonicalReason ?? '').trim().toUpperCase();
  const code = `${row.reasonCode ?? ''} ${row.sourceCode ?? ''} ${row.sourceReason ?? ''} ${canonical}`.toUpperCase();
  const sourceStage = String(row.sourceStage ?? stageName ?? '').toUpperCase();
  if (/DUPLICATE_SETTLEMENT|SETTLEMENT_DUPLICATE/u.test(code)
    || (canonical === 'DUPLICATE' && sourceStage === 'SETTLEMENT')) return 'SETTLEMENT_DUPLICATE';
  if (/DUPLICATE_SIGNAL|DUPLICATE_POSITION|POSITION_DUPLICATE|ENTRY_DUPLICATE/u.test(code)
    || (canonical === 'DUPLICATE' && ['ENTRY', 'ENTRY_ELIGIBLE'].includes(sourceStage))) return 'ENTRY_DUPLICATE';
  if (/EXIT_NOT_REACHED|EXIT_NOT_ELIGIBLE|HOLDING_HORIZON_NOT_REACHED/u.test(code)) return 'EXIT_NOT_REACHED';
  if (/IDENTITY|MISMATCH|WRONG_CYCLE|WRONG_ACCOUNT/u.test(code) || canonical === 'IDENTITY_MISMATCH') return 'IDENTITY_MISMATCH';
  if (/STALE/u.test(code) || canonical === 'DATA_STALE') return 'STALE_DATA';
  if (/COST|FUNDING|LIQUIDITY|SLIPPAGE|SPREAD|LATENCY|PARTIAL_FILL/u.test(code)) return 'COST_INCOMPLETE';
  if (/RISK/u.test(code) || canonical === 'RISK_GATE') return 'RISK_REJECTED';
  if (/NO_TRADE|NO_SIGNAL|MARKET_CLOSED/u.test(code) || ['NO_SIGNAL', 'MARKET_CLOSED'].includes(canonical)) return 'NO_TRADE';
  if (/BLOCKED_DATA|PROVIDER_FAILURE/u.test(code) || canonical === 'PROVIDER_FAILURE') return 'BLOCKED_DATA';
  if (/MISSING|REQUIRED|UNAVAILABLE/u.test(code) || canonical === 'DATA_MISSING') return 'MISSING_EVIDENCE';
  if (/RUNTIME|EXCEPTION|UNHANDLED|FAILED/u.test(code)) return 'RUNTIME_ERROR';
  if (/POLICY|QUALITY|COOLDOWN|ACCOUNT_STATE/u.test(code)
    || ['QUALITY_GATE', 'COOLDOWN', 'ACCOUNT_STATE_BLOCK'].includes(canonical)) return 'POLICY_REJECTED';
  return null;
}

function reasonIdentityDigests(row = {}) {
  const source = row.identity && typeof row.identity === 'object' ? row.identity : row;
  const values = source.observationIdDigests ?? row.observationIdDigests ?? source.observationIds ?? row.observationIds;
  if (!Array.isArray(values)) {
    const one = source.observationIdDigest ?? row.observationIdDigest;
    return one ? [digest(one)].filter(Boolean) : [];
  }
  return values.map((value) => digest(value) ?? (nonEmpty(value) ? sha256(value.trim()) : null)).filter(Boolean);
}

function collectedReasonRows(input, identity, naturalEligible) {
  if (!naturalEligible) return [];
  const root = canonicalRoot(input);
  const canonicalRows = Array.isArray(root.reasonObservations) ? root.reasonObservations : [];
  const firstZeroRows = Object.entries(input.authoritativeFirstZeroReasonEvidenceByStage ?? {})
    .map(([stage, row]) => ({ ...row, sourceStage: row?.sourceStage ?? stage }));
  const rows = [...canonicalRows, ...firstZeroRows];
  const accepted = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.replayCredit !== undefined && row.replayCredit !== 0) continue;
    if (row.duplicateCredit !== undefined && row.duplicateCredit !== 0) continue;
    if (row.historicalCredit !== undefined && row.historicalCredit !== 0) continue;
    if (row.authoritative === false || row.freshness === 'STALE') continue;
    const sourceIdentity = row.identity && typeof row.identity === 'object' ? row.identity : row;
    const sourceDatasetDigest = digest(sourceIdentity.datasetIdentityDigest)
      ?? (nonEmpty(sourceIdentity.datasetIdentity) ? sha256(sourceIdentity.datasetIdentity.trim()) : null);
    const reasonIdentityMatches = exactSha(sourceIdentity.strategySha) === identity.research.exactCodeSha
      && exactSha(sourceIdentity.runtimeSha) === identity.runtimeSha
      && sourceDatasetDigest === identity.datasetIdentityDigest
      && (!nonEmpty(sourceIdentity.cycleId) || sourceIdentity.cycleId.trim() === identity.cycleId)
      && (!nonEmpty(sourceIdentity.triggerSource)
        || sourceIdentity.triggerSource.trim().toLowerCase() === identity.triggerSource);
    if (!reasonIdentityMatches) continue;
    const category = reasonCategory(row);
    if (!category) continue;
    const observationIdDigests = reasonIdentityDigests(row);
    const sanitized = {
      category,
      sourceStage: nonEmpty(row.sourceStage) ? row.sourceStage.trim().slice(0, 100) : null,
      sourceCode: nonEmpty(row.sourceCode ?? row.reasonCode)
        ? String(row.sourceCode ?? row.reasonCode).trim().slice(0, 240)
        : null,
      canonicalReason: nonEmpty(row.canonicalReason) ? row.canonicalReason.trim().slice(0, 100) : null,
      sourceTimestampMs: sourceTimestamp(row),
      observationIdDigests,
      identityDigest: sha256({ cycleId: identity.cycleId, observationIdDigests }),
    };
    const rowDigest = sha256(sanitized);
    if (seen.has(rowDigest)) continue;
    seen.add(rowDigest);
    accepted.push(freeze({ ...sanitized, evidenceDigest: rowDigest }));
  }
  return accepted;
}

function reasonCounts(rows) {
  const values = Object.fromEntries(NATURAL_PAPER_REJECTION_REASONS.map((reason) => [reason, 0]));
  for (const row of rows) values[row.category] += Math.max(1, row.observationIdDigests.length);
  return values;
}

function firstZero(stages, reasonRows) {
  for (const stage of stages) {
    if (stage.status !== 'ACCEPTED') {
      const category = reasonCategory({ sourceCode: stage.blocker }, stage.stage) ?? 'MISSING_EVIDENCE';
      return freeze({
        stage: 'UNKNOWN',
        reason: category,
        reasonEvidenceStatus: 'STAGE_EVIDENCE_INCOMPLETE',
        firstUnknownStage: stage.stage,
      });
    }
    if (stage.count === 0) {
      const matches = reasonRows.filter((row) => {
        const source = String(row.sourceStage ?? '').toUpperCase();
        if (stage.stage === 'EVIDENCE') return source.includes('EVIDENCE');
        if (stage.stage === 'RISK') return source.includes('RISK');
        if (stage.stage === 'ADMISSION') return source.includes('ADMISSION') || source.includes('ENTRY_ELIGIBLE');
        return source === stage.stage;
      });
      const categories = [...new Set(matches.map((row) => row.category))];
      return freeze({
        stage: stage.stage,
        reason: categories.length === 1 ? categories[0] : 'MISSING_EVIDENCE',
        reasonEvidenceStatus: categories.length === 1 ? 'AUTHORITATIVE' : 'MISSING_OR_AMBIGUOUS',
        firstUnknownStage: null,
      });
    }
  }
  return freeze({ stage: 'NONE', reason: 'NONE', reasonEvidenceStatus: 'NOT_APPLICABLE', firstUnknownStage: null });
}

function lifecycleIdentityChecks(stages) {
  const byName = Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
  return Object.fromEntries(['ENTRY', 'POSITION', 'SETTLEMENT'].map((name) => {
    const stage = byName[name];
    return [name.toLowerCase(), freeze({
      valid: stage?.status === 'ACCEPTED' && stage.identityValid === true,
      count: stage?.count ?? null,
      uniqueIdentityCount: stage?.observationIdDigests?.length ?? 0,
      duplicateIdentityCount: stage?.duplicateIdentityCount ?? 0,
      evidenceDigest: stage?.evidenceDigest ?? null,
    })];
  }));
}

function assertSanitized(value) {
  const forbiddenKeys = /(^|_)(secret|token|password|privatekey|private_key|accountid|account_id|chatid|chat_id|endpoint|sshhost|ssh_host)$/iu;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (forbiddenKeys.test(key)) throw new Error(`UNSANITIZED_ARTIFACT_KEY:${key}`);
      visit(child);
    }
  };
  visit(value);
}

export function buildNaturalPaperEvidenceObservabilityArtifact(input = {}, { verifiedAtMs = Date.now() } = {}) {
  const verified = timestamp(verifiedAtMs);
  if (!verified) throw new TypeError('verifiedAtMs must be a positive integer timestamp');
  const identity = canonicalIdentity(input);
  const safety = inputSafety(input);
  const root = canonicalRoot(input);
  const rootIdentityValid = identity.complete && rootIdentityMatches(root, identity);
  const excludedNonNatural = nonNaturalEvidence(input, root);
  const naturalEligible = Boolean(identity.complete
    && safety.valid
    && !excludedNonNatural
    && input.collectionStatus === 'READY'
    && input.schemaVersion === 'paper-forward-schedule-cli-v5'
    && input.naturalScheduleInvocation === true
    && input.evidenceClass === 'NATURAL');
  const stages = NATURAL_PAPER_OBSERVABILITY_STAGES.map((descriptor) => (
    stageObservation(input, descriptor, identity, verified, rootIdentityValid, naturalEligible)
  ));
  const reasons = collectedReasonRows(input, identity, naturalEligible);
  const first = firstZero(stages, reasons);
  const counts = Object.fromEntries(stages.map((stage) => [stage.field, stage.count]));
  const rejections = reasonCounts(reasons);
  if (first.stage !== 'NONE' && first.stage !== 'UNKNOWN' && first.reasonEvidenceStatus === 'AUTHORITATIVE') {
    const stageIndex = stages.findIndex((stage) => stage.stage === first.stage);
    const priorCount = stageIndex > 0 ? stages[stageIndex - 1].count : null;
    if (Number.isSafeInteger(priorCount) && priorCount > 0) {
      rejections[first.reason] = Math.max(rejections[first.reason], priorCount);
    }
  }
  const lifecycleIdentity = lifecycleIdentityChecks(stages);
  const observable = Boolean(naturalEligible
    && rootIdentityValid
    && first.stage !== 'UNKNOWN'
    && stages.slice(0, first.stage === 'NONE' ? stages.length : stages.findIndex((stage) => stage.stage === first.stage) + 1)
      .every((stage) => stage.status === 'ACCEPTED'));
  const body = {
    schemaVersion: NATURAL_PAPER_OBSERVABILITY_VERSION,
    artifactVersion: 1,
    artifactId: `natural-paper-observability:${identity.cycleId ?? 'unidentified'}`,
    verifiedAtMs: verified,
    collectionStatus: nonEmpty(input.collectionStatus) ? input.collectionStatus.trim().slice(0, 120) : 'UNKNOWN',
    naturalSampleCredit: naturalEligible ? 1 : 0,
    naturalFunnelObservable: observable,
    identity,
    funnel: counts,
    stages,
    reasonCounts: rejections,
    reasonEvidence: reasons,
    firstZeroStage: first.stage,
    firstZeroReason: first.reason,
    firstZeroReasonEvidenceStatus: first.reasonEvidenceStatus,
    firstUnknownStage: first.firstUnknownStage,
    lifecycleIdentity,
    sourceTimestamps: {
      cycleEvaluatedAtMs: timestamp(input.cycleEvaluatedAtMs),
      recurringStateUpdatedAtMs: timestamp(input.recurringStateUpdatedAtMs),
      stageSourceTimestampMs: Object.fromEntries(stages.map((stage) => [stage.stage, stage.sourceTimestampMs])),
    },
    evidenceDigests: {
      probeDigest: digest(input.probeDigest),
      stageDigest: sha256(stages.map((stage) => stage.evidenceDigest)),
      reasonDigest: sha256(reasons.map((row) => row.evidenceDigest)),
      datasetIdentityDigest: identity.datasetIdentityDigest,
    },
    excludedEvidence: {
      testOnly: input.evidenceClass === 'TEST_ONLY' || input.testOnly === true || input.testFixture === true,
      synthetic: input.synthetic === true,
      historical: input.historical === true,
      replay: input.replay === true || input.status === 'REPLAYED',
      duplicateReplay: input.duplicateReplay === true,
      naturalCreditGranted: naturalEligible,
    },
    safety,
    sanitization: {
      rawObservationIdsIncluded: false,
      secretsIncluded: false,
      accountIdentifiersIncluded: false,
      privateEndpointsIncluded: false,
    },
  };
  assertSanitized(body);
  const artifactDigest = sha256(body);
  return freeze({ ...body, artifactDigest });
}

export function verifyNaturalPaperEvidenceObservabilityArtifact(artifact = {}) {
  if (artifact.schemaVersion !== NATURAL_PAPER_OBSERVABILITY_VERSION) return false;
  const { artifactDigest, ...body } = artifact;
  if (digest(artifactDigest) !== sha256(body)) return false;
  try {
    assertSanitized(body);
  } catch {
    return false;
  }
  return artifact.safety?.readOnly === true
    && artifact.safety?.runtimeMutationCount === 0
    && artifact.safety?.databaseMutationCount === 0
    && artifact.safety?.privateApiCount === 0
    && artifact.safety?.executionAuthority === 'NONE'
    && artifact.safety?.realOrderCount === 0
    && artifact.sanitization?.rawObservationIdsIncluded === false;
}

async function runCli(argv = process.argv.slice(2)) {
  const inputFlag = argv.indexOf('--input');
  const outputFlag = argv.indexOf('--output');
  if (inputFlag < 0 || !argv[inputFlag + 1] || outputFlag < 0 || !argv[outputFlag + 1]) {
    throw new Error('Usage: node natural-paper-evidence-observability.mjs --input <json> --output <json>');
  }
  const input = JSON.parse(await readFile(argv[inputFlag + 1], 'utf8'));
  const artifact = buildNaturalPaperEvidenceObservabilityArtifact(input);
  if (!verifyNaturalPaperEvidenceObservabilityArtifact(artifact)) throw new Error('ARTIFACT_SELF_VERIFICATION_FAILED');
  await writeFile(argv[outputFlag + 1], `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write([
    `NATURAL_FUNNEL_OBSERVABLE=${artifact.naturalFunnelObservable}`,
    `ENTRY_COUNT=${artifact.funnel.entryCreatedCount ?? 'unknown'}`,
    `POSITION_COUNT=${artifact.funnel.positionOpenCount ?? 'unknown'}`,
    `SETTLEMENT_COUNT=${artifact.funnel.settlementCreatedCount ?? 'unknown'}`,
    `FIRST_ZERO_STAGE=${artifact.firstZeroStage}`,
    `FIRST_ZERO_REASON=${artifact.firstZeroReason}`,
    `EVIDENCE_COMPLETE_COUNT=${artifact.funnel.authoritativeEvidenceReadyCount ?? 'unknown'}`,
    `ARTIFACT_DIGEST=${artifact.artifactDigest}`,
  ].join('\n') + '\n');
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await runCli();
