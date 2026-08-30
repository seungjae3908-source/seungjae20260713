import { createHash } from 'node:crypto';
import { assertResearchPaperV2 } from '../../external-research/src/index.js';

export const STRATEGY_HYPOTHESIS_SCHEMA_VERSION = 1;
export const HYPOTHESIS_DECISION_SCHEMA_VERSION = 1;
export const HYPOTHESIS_VERDICTS = Object.freeze([
  'APPROVE_FOR_RESEARCH',
  'REJECT',
  'MISSING_EVIDENCE',
  'CONFLICTED',
]);

export const ASSET_CLASSES = Object.freeze([
  'EQUITY',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
  'FUTURES',
  'FX',
  'FIXED_INCOME',
  'COMMODITY',
  'OTHER',
]);

export const DIRECTIONALITIES = Object.freeze(['POSITIVE', 'NEGATIVE', 'NON_DIRECTIONAL']);
export const EVIDENCE_STRENGTHS = Object.freeze(['INSUFFICIENT', 'LIMITED', 'MODERATE', 'STRONG']);

const CONTRADICTORY_STRENGTHS = new Set(['NONE', 'LIMITED', 'MODERATE', 'STRONG']);
const EFFECT_DIRECTIONS = new Set(['INCREASE', 'DECREASE', 'NON_ZERO', 'DIFFERENCE']);
const FALSIFICATION_OPERATORS = new Set(['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NOT_EQ']);
const VERDICTS = new Set(HYPOTHESIS_VERDICTS);
const RETRACTION_CONFLICTS = new Set(['RETRACTED', 'RETRACTION_NOTICE', 'EXPRESSION_OF_CONCERN']);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const HYPOTHESIS_KEYS = Object.freeze([
  'schemaVersion',
  'hypothesisId',
  'hypothesisVersion',
  'title',
  'statement',
  'marketScope',
  'assetClass',
  'timeframeScope',
  'directionality',
  'rationale',
  'supportingPaperIds',
  'contradictoryPaperIds',
  'evidenceStrength',
  'expectedEffect',
  'falsificationCriteria',
  'requiredData',
  'knownLimitations',
  'familyFingerprint',
  'configHash',
  'createdAt',
  'provenance',
]);

const HYPOTHESIS_CORE_KEYS = Object.freeze([
  'title',
  'statement',
  'marketScope',
  'assetClass',
  'timeframeScope',
  'directionality',
  'rationale',
  'supportingPaperIds',
  'contradictoryPaperIds',
  'evidenceStrength',
  'expectedEffect',
  'falsificationCriteria',
  'requiredData',
  'knownLimitations',
  'createdAt',
  'generator',
  'evidencePolicy',
]);

const DECISION_KEYS = Object.freeze([
  'schemaVersion',
  'decisionId',
  'hypothesisId',
  'hypothesisVersion',
  'hypothesisConfigHash',
  'verdict',
  'rationale',
  'decidedAt',
  'committee',
  'evidenceAssessment',
  'executableStrategyCreated',
  'tradingAuthority',
  'decisionHash',
]);

export class StrategyHypothesisValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'StrategyHypothesisValidationError';
    this.code = code;
  }
}

function fail(code, detail = '') {
  throw new StrategyHypothesisValidationError(code, detail ? `${code}:${detail}` : code);
}

function requirePlainObject(value, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function assertExactKeys(value, expected, code) {
  requirePlainObject(value, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function normalizeString(value, code) {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value.trim().normalize('NFC');
}

function assertCanonicalString(value, code) {
  if (normalizeString(value, code) !== value) fail(code);
}

function normalize(value, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('CANONICAL_JSON_UNSUPPORTED_VALUE');
  if (stack.has(value)) fail('CANONICAL_JSON_CYCLE');
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => normalize(entry, stack));
  } else {
    requirePlainObject(value, 'CANONICAL_JSON_NON_PLAIN_OBJECT');
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('CANONICAL_JSON_UNDEFINED_VALUE');
      result[key] = normalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value, new Set()));
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function canonicalStrings(values, code, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) fail(code);
  const normalized = values.map((value) => normalizeString(value, code));
  const result = [...new Set(normalized)].sort();
  if (result.length !== normalized.length) fail(`${code}_DUPLICATE`);
  return result;
}

function assertCanonicalStrings(values, code, options) {
  const canonical = canonicalStrings(values, code, options);
  if (canonical.some((value, index) => value !== values[index])) fail(`${code}_NOT_CANONICAL`);
}

function assertFiniteNumber(value, code, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail(code);
}

function assertTimestamp(value, code) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)) fail(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(code);
}

function normalizeExpectedEffect(effect) {
  assertExactKeys(effect, ['observable', 'direction', 'minimumMagnitude', 'unit', 'evaluationWindow'], 'EXPECTED_EFFECT_SHAPE_INVALID');
  return {
    observable: normalizeString(effect.observable, 'EXPECTED_EFFECT_OBSERVABLE_REQUIRED'),
    direction: effect.direction,
    minimumMagnitude: effect.minimumMagnitude,
    unit: normalizeString(effect.unit, 'EXPECTED_EFFECT_UNIT_REQUIRED'),
    evaluationWindow: normalizeString(effect.evaluationWindow, 'EXPECTED_EFFECT_WINDOW_REQUIRED'),
  };
}

function assertExpectedEffect(effect, directionality, timeframeScope) {
  assertExactKeys(effect, ['observable', 'direction', 'minimumMagnitude', 'unit', 'evaluationWindow'], 'EXPECTED_EFFECT_SHAPE_INVALID');
  assertCanonicalString(effect.observable, 'EXPECTED_EFFECT_OBSERVABLE_REQUIRED');
  if (!EFFECT_DIRECTIONS.has(effect.direction)) fail('EXPECTED_EFFECT_DIRECTION_INVALID');
  assertFiniteNumber(effect.minimumMagnitude, 'EXPECTED_EFFECT_MAGNITUDE_INVALID', { nullable: true });
  if (effect.minimumMagnitude !== null && effect.minimumMagnitude < 0) fail('EXPECTED_EFFECT_MAGNITUDE_NEGATIVE');
  assertCanonicalString(effect.unit, 'EXPECTED_EFFECT_UNIT_REQUIRED');
  assertCanonicalString(effect.evaluationWindow, 'EXPECTED_EFFECT_WINDOW_REQUIRED');
  if (!timeframeScope.includes(effect.evaluationWindow)) fail('EXPECTED_EFFECT_WINDOW_OUT_OF_SCOPE');
  if (directionality === 'POSITIVE' && effect.direction !== 'INCREASE') fail('DIRECTIONALITY_EFFECT_MISMATCH');
  if (directionality === 'NEGATIVE' && effect.direction !== 'DECREASE') fail('DIRECTIONALITY_EFFECT_MISMATCH');
  if (directionality === 'NON_DIRECTIONAL' && !['NON_ZERO', 'DIFFERENCE'].includes(effect.direction)) fail('DIRECTIONALITY_EFFECT_MISMATCH');
}

function normalizeFalsificationCriteria(criteria) {
  assertExactKeys(
    criteria,
    ['observable', 'metric', 'operator', 'threshold', 'unit', 'evaluationWindow', 'minimumObservations', 'rejectionStatement'],
    'FALSIFICATION_CRITERIA_SHAPE_INVALID',
  );
  return {
    observable: normalizeString(criteria.observable, 'FALSIFICATION_OBSERVABLE_REQUIRED'),
    metric: normalizeString(criteria.metric, 'FALSIFICATION_METRIC_REQUIRED'),
    operator: criteria.operator,
    threshold: criteria.threshold,
    unit: normalizeString(criteria.unit, 'FALSIFICATION_UNIT_REQUIRED'),
    evaluationWindow: normalizeString(criteria.evaluationWindow, 'FALSIFICATION_WINDOW_REQUIRED'),
    minimumObservations: criteria.minimumObservations,
    rejectionStatement: normalizeString(criteria.rejectionStatement, 'FALSIFICATION_REJECTION_STATEMENT_REQUIRED'),
  };
}

function assertFalsificationCriteria(criteria, expectedEffect) {
  assertExactKeys(
    criteria,
    ['observable', 'metric', 'operator', 'threshold', 'unit', 'evaluationWindow', 'minimumObservations', 'rejectionStatement'],
    'FALSIFICATION_CRITERIA_SHAPE_INVALID',
  );
  assertCanonicalString(criteria.observable, 'FALSIFICATION_OBSERVABLE_REQUIRED');
  assertCanonicalString(criteria.metric, 'FALSIFICATION_METRIC_REQUIRED');
  if (!FALSIFICATION_OPERATORS.has(criteria.operator)) fail('FALSIFICATION_OPERATOR_INVALID');
  assertFiniteNumber(criteria.threshold, 'FALSIFICATION_THRESHOLD_INVALID');
  assertCanonicalString(criteria.unit, 'FALSIFICATION_UNIT_REQUIRED');
  assertCanonicalString(criteria.evaluationWindow, 'FALSIFICATION_WINDOW_REQUIRED');
  if (!Number.isSafeInteger(criteria.minimumObservations) || criteria.minimumObservations < 1) fail('FALSIFICATION_MINIMUM_OBSERVATIONS_INVALID');
  assertCanonicalString(criteria.rejectionStatement, 'FALSIFICATION_REJECTION_STATEMENT_REQUIRED');
  if (criteria.observable !== expectedEffect.observable) fail('FALSIFICATION_OBSERVABLE_MISMATCH');
  if (criteria.unit !== expectedEffect.unit) fail('FALSIFICATION_UNIT_MISMATCH');
  if (criteria.evaluationWindow !== expectedEffect.evaluationWindow) fail('FALSIFICATION_WINDOW_MISMATCH');
}

function normalizeRequiredData(requiredData) {
  if (!Array.isArray(requiredData) || requiredData.length === 0) fail('REQUIRED_DATA_REQUIRED');
  const normalized = requiredData.map((entry) => {
    assertExactKeys(entry, ['dataset', 'fields', 'frequency', 'provenanceRequired', 'licenseRequired'], 'REQUIRED_DATA_ENTRY_INVALID');
    return {
      dataset: normalizeString(entry.dataset, 'REQUIRED_DATASET_REQUIRED'),
      fields: canonicalStrings(entry.fields, 'REQUIRED_DATA_FIELDS_REQUIRED'),
      frequency: normalizeString(entry.frequency, 'REQUIRED_DATA_FREQUENCY_REQUIRED'),
      provenanceRequired: entry.provenanceRequired,
      licenseRequired: entry.licenseRequired,
    };
  });
  normalized.sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  if (new Set(normalized.map(canonicalJson)).size !== normalized.length) fail('REQUIRED_DATA_DUPLICATE');
  return normalized;
}

function assertRequiredData(requiredData) {
  const canonical = normalizeRequiredData(requiredData);
  if (canonicalJson(canonical) !== canonicalJson(requiredData)) fail('REQUIRED_DATA_NOT_CANONICAL');
  for (const entry of requiredData) {
    if (entry.provenanceRequired !== true) fail('REQUIRED_DATA_PROVENANCE_MUST_BE_TRUE');
    if (typeof entry.licenseRequired !== 'boolean') fail('REQUIRED_DATA_LICENSE_POLICY_INVALID');
  }
}

function normalizeEvidenceStrength(strength) {
  assertExactKeys(strength, ['supporting', 'contradictory'], 'EVIDENCE_STRENGTH_SHAPE_INVALID');
  return { supporting: strength.supporting, contradictory: strength.contradictory };
}

function assertEvidenceStrength(strength, contradictoryPaperIds) {
  assertExactKeys(strength, ['supporting', 'contradictory'], 'EVIDENCE_STRENGTH_SHAPE_INVALID');
  if (!EVIDENCE_STRENGTHS.includes(strength.supporting)) fail('SUPPORTING_EVIDENCE_STRENGTH_INVALID');
  if (!CONTRADICTORY_STRENGTHS.has(strength.contradictory)) fail('CONTRADICTORY_EVIDENCE_STRENGTH_INVALID');
  if ((contradictoryPaperIds.length === 0) !== (strength.contradictory === 'NONE')) fail('CONTRADICTORY_EVIDENCE_STRENGTH_MISMATCH');
}

function normalizeGenerator(generator) {
  assertExactKeys(generator, ['name', 'version'], 'GENERATOR_SHAPE_INVALID');
  return {
    name: normalizeString(generator.name, 'GENERATOR_NAME_REQUIRED'),
    version: normalizeString(generator.version, 'GENERATOR_VERSION_REQUIRED'),
  };
}

function assertGenerator(generator) {
  assertExactKeys(generator, ['name', 'version'], 'GENERATOR_SHAPE_INVALID');
  assertCanonicalString(generator.name, 'GENERATOR_NAME_REQUIRED');
  assertCanonicalString(generator.version, 'GENERATOR_VERSION_REQUIRED');
}

function normalizeEvidencePolicy(policy) {
  assertExactKeys(policy, ['requireKnownContentLicense', 'requireResolvedCorrections'], 'EVIDENCE_POLICY_SHAPE_INVALID');
  return {
    requireKnownContentLicense: policy.requireKnownContentLicense,
    requireResolvedCorrections: policy.requireResolvedCorrections,
  };
}

function assertEvidencePolicy(policy) {
  assertExactKeys(policy, ['requireKnownContentLicense', 'requireResolvedCorrections'], 'EVIDENCE_POLICY_SHAPE_INVALID');
  if (typeof policy.requireKnownContentLicense !== 'boolean') fail('EVIDENCE_LICENSE_POLICY_INVALID');
  if (policy.requireResolvedCorrections !== true) fail('EVIDENCE_CORRECTION_POLICY_MUST_FAIL_CLOSED');
}

function normalizeCore(core) {
  assertExactKeys(core, HYPOTHESIS_CORE_KEYS, 'STRATEGY_HYPOTHESIS_CORE_SHAPE_INVALID');
  return {
    title: normalizeString(core.title, 'HYPOTHESIS_TITLE_REQUIRED'),
    statement: normalizeString(core.statement, 'HYPOTHESIS_STATEMENT_REQUIRED'),
    marketScope: canonicalStrings(core.marketScope, 'MARKET_SCOPE_REQUIRED'),
    assetClass: core.assetClass,
    timeframeScope: canonicalStrings(core.timeframeScope, 'TIMEFRAME_SCOPE_REQUIRED'),
    directionality: core.directionality,
    rationale: normalizeString(core.rationale, 'HYPOTHESIS_RATIONALE_REQUIRED'),
    supportingPaperIds: canonicalStrings(core.supportingPaperIds, 'SUPPORTING_PAPERS_REQUIRED'),
    contradictoryPaperIds: canonicalStrings(core.contradictoryPaperIds, 'CONTRADICTORY_PAPERS_INVALID', { allowEmpty: true }),
    evidenceStrength: normalizeEvidenceStrength(core.evidenceStrength),
    expectedEffect: normalizeExpectedEffect(core.expectedEffect),
    falsificationCriteria: normalizeFalsificationCriteria(core.falsificationCriteria),
    requiredData: normalizeRequiredData(core.requiredData),
    knownLimitations: canonicalStrings(core.knownLimitations, 'KNOWN_LIMITATIONS_REQUIRED'),
    createdAt: core.createdAt,
    generator: normalizeGenerator(core.generator),
    evidencePolicy: normalizeEvidencePolicy(core.evidencePolicy),
  };
}

function configMaterial(hypothesis) {
  return {
    statement: hypothesis.statement,
    marketScope: hypothesis.marketScope,
    assetClass: hypothesis.assetClass,
    timeframeScope: hypothesis.timeframeScope,
    directionality: hypothesis.directionality,
    expectedEffect: hypothesis.expectedEffect,
    falsificationCriteria: hypothesis.falsificationCriteria,
    requiredData: hypothesis.requiredData,
  };
}

function familyMaterial(hypothesis) {
  return {
    marketScope: hypothesis.marketScope,
    assetClass: hypothesis.assetClass,
    timeframeScope: hypothesis.timeframeScope,
    directionality: hypothesis.directionality,
    observable: hypothesis.expectedEffect.observable,
    evaluationWindow: hypothesis.expectedEffect.evaluationWindow,
  };
}

export function computeHypothesisConfigHash(hypothesis) {
  return sha256Hex(configMaterial(hypothesis));
}

export function computeFamilyFingerprint(hypothesis) {
  return sha256Hex(familyMaterial(hypothesis));
}

function assertPaperIdSets(supporting, contradictory) {
  assertCanonicalStrings(supporting, 'SUPPORTING_PAPERS_REQUIRED');
  assertCanonicalStrings(contradictory, 'CONTRADICTORY_PAPERS_INVALID', { allowEmpty: true });
  const supportingSet = new Set(supporting);
  if (contradictory.some((paperId) => supportingSet.has(paperId))) fail('PAPER_EVIDENCE_ROLES_OVERLAP');
}

function buildPaperIndex(papers, { strict = false } = {}) {
  if (!Array.isArray(papers)) fail('RESEARCH_PAPERS_ARRAY_REQUIRED');
  const index = new Map();
  for (const paper of papers) {
    try {
      assertResearchPaperV2(paper);
    } catch (error) {
      if (!strict) continue;
      fail('RESEARCH_PAPER_V2_INVALID', error instanceof Error ? error.message : 'UNKNOWN');
    }
    if (index.has(paper.paperId)) {
      if (strict) fail('RESEARCH_PAPER_DUPLICATE', paper.paperId);
      index.set(paper.paperId, null);
    } else {
      index.set(paper.paperId, paper);
    }
  }
  return index;
}

function assertProvenance(provenance, supportingPaperIds, contradictoryPaperIds) {
  assertExactKeys(provenance, ['sourceContract', 'sourceContractVersion', 'generator', 'evidencePolicy', 'papers'], 'HYPOTHESIS_PROVENANCE_SHAPE_INVALID');
  if (provenance.sourceContract !== 'ResearchPaperV2' || provenance.sourceContractVersion !== 2) fail('HYPOTHESIS_SOURCE_CONTRACT_INVALID');
  assertGenerator(provenance.generator);
  assertEvidencePolicy(provenance.evidencePolicy);
  if (!Array.isArray(provenance.papers)) fail('HYPOTHESIS_PROVENANCE_PAPERS_INVALID');
  const expectedRoles = new Map([
    ...supportingPaperIds.map((paperId) => [paperId, 'SUPPORTING']),
    ...contradictoryPaperIds.map((paperId) => [paperId, 'CONTRADICTORY']),
  ]);
  const seen = new Set();
  for (const reference of provenance.papers) {
    assertExactKeys(reference, ['paperId', 'metadataHash', 'role'], 'HYPOTHESIS_PROVENANCE_PAPER_INVALID');
    assertCanonicalString(reference.paperId, 'HYPOTHESIS_PROVENANCE_PAPER_ID_REQUIRED');
    if (!HASH_PATTERN.test(reference.metadataHash)) fail('HYPOTHESIS_PROVENANCE_METADATA_HASH_INVALID');
    if (reference.role !== expectedRoles.get(reference.paperId)) fail('HYPOTHESIS_PROVENANCE_ROLE_MISMATCH');
    if (seen.has(reference.paperId)) fail('HYPOTHESIS_PROVENANCE_PAPER_DUPLICATE');
    seen.add(reference.paperId);
  }
  const expectedIds = [...expectedRoles.keys()].sort();
  const actualIds = provenance.papers.map((reference) => reference.paperId);
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) fail('HYPOTHESIS_PROVENANCE_PAPERS_MISMATCH');
}

export function assertStrategyHypothesisV1(hypothesis) {
  assertExactKeys(hypothesis, HYPOTHESIS_KEYS, 'STRATEGY_HYPOTHESIS_V1_SHAPE_INVALID');
  if (hypothesis.schemaVersion !== STRATEGY_HYPOTHESIS_SCHEMA_VERSION) fail('STRATEGY_HYPOTHESIS_SCHEMA_VERSION_INVALID');
  if (hypothesis.hypothesisVersion !== 1) fail('HYPOTHESIS_VERSION_INVALID');
  assertCanonicalString(hypothesis.title, 'HYPOTHESIS_TITLE_REQUIRED');
  assertCanonicalString(hypothesis.statement, 'HYPOTHESIS_STATEMENT_REQUIRED');
  assertCanonicalStrings(hypothesis.marketScope, 'MARKET_SCOPE_REQUIRED');
  if (!ASSET_CLASSES.includes(hypothesis.assetClass)) fail('ASSET_CLASS_INVALID');
  assertCanonicalStrings(hypothesis.timeframeScope, 'TIMEFRAME_SCOPE_REQUIRED');
  if (!DIRECTIONALITIES.includes(hypothesis.directionality)) fail('DIRECTIONALITY_INVALID');
  assertCanonicalString(hypothesis.rationale, 'HYPOTHESIS_RATIONALE_REQUIRED');
  assertPaperIdSets(hypothesis.supportingPaperIds, hypothesis.contradictoryPaperIds);
  assertEvidenceStrength(hypothesis.evidenceStrength, hypothesis.contradictoryPaperIds);
  assertExpectedEffect(hypothesis.expectedEffect, hypothesis.directionality, hypothesis.timeframeScope);
  assertFalsificationCriteria(hypothesis.falsificationCriteria, hypothesis.expectedEffect);
  assertRequiredData(hypothesis.requiredData);
  assertCanonicalStrings(hypothesis.knownLimitations, 'KNOWN_LIMITATIONS_REQUIRED');
  assertTimestamp(hypothesis.createdAt, 'HYPOTHESIS_CREATED_AT_INVALID');
  assertProvenance(hypothesis.provenance, hypothesis.supportingPaperIds, hypothesis.contradictoryPaperIds);
  const expectedConfigHash = computeHypothesisConfigHash(hypothesis);
  if (hypothesis.configHash !== expectedConfigHash) fail('HYPOTHESIS_CONFIG_HASH_MISMATCH');
  if (hypothesis.hypothesisId !== `hypothesis:sha256:${expectedConfigHash}`) fail('HYPOTHESIS_ID_MISMATCH');
  if (hypothesis.familyFingerprint !== computeFamilyFingerprint(hypothesis)) fail('HYPOTHESIS_FAMILY_FINGERPRINT_MISMATCH');
  return hypothesis;
}

export function verifyStrategyHypothesisV1(hypothesis) {
  try {
    assertStrategyHypothesisV1(hypothesis);
    return true;
  } catch {
    return false;
  }
}

export function createStrategyHypothesisV1(core, papers) {
  const normalized = normalizeCore(core);
  assertTimestamp(normalized.createdAt, 'HYPOTHESIS_CREATED_AT_INVALID');
  if (!ASSET_CLASSES.includes(normalized.assetClass)) fail('ASSET_CLASS_INVALID');
  if (!DIRECTIONALITIES.includes(normalized.directionality)) fail('DIRECTIONALITY_INVALID');
  assertPaperIdSets(normalized.supportingPaperIds, normalized.contradictoryPaperIds);
  assertEvidenceStrength(normalized.evidenceStrength, normalized.contradictoryPaperIds);
  assertExpectedEffect(normalized.expectedEffect, normalized.directionality, normalized.timeframeScope);
  assertFalsificationCriteria(normalized.falsificationCriteria, normalized.expectedEffect);
  assertRequiredData(normalized.requiredData);
  assertEvidencePolicy(normalized.evidencePolicy);

  const paperIndex = buildPaperIndex(papers, { strict: true });
  const expectedIds = [...normalized.supportingPaperIds, ...normalized.contradictoryPaperIds].sort();
  if (paperIndex.size !== expectedIds.length || expectedIds.some((paperId) => !paperIndex.has(paperId))) fail('RESEARCH_PAPER_SET_MISMATCH');
  const roles = new Map([
    ...normalized.supportingPaperIds.map((paperId) => [paperId, 'SUPPORTING']),
    ...normalized.contradictoryPaperIds.map((paperId) => [paperId, 'CONTRADICTORY']),
  ]);
  const provenance = {
    sourceContract: 'ResearchPaperV2',
    sourceContractVersion: 2,
    generator: normalized.generator,
    evidencePolicy: normalized.evidencePolicy,
    papers: expectedIds.map((paperId) => ({
      paperId,
      metadataHash: paperIndex.get(paperId).metadataHash,
      role: roles.get(paperId),
    })),
  };
  const body = {
    schemaVersion: STRATEGY_HYPOTHESIS_SCHEMA_VERSION,
    hypothesisId: '',
    hypothesisVersion: 1,
    title: normalized.title,
    statement: normalized.statement,
    marketScope: normalized.marketScope,
    assetClass: normalized.assetClass,
    timeframeScope: normalized.timeframeScope,
    directionality: normalized.directionality,
    rationale: normalized.rationale,
    supportingPaperIds: normalized.supportingPaperIds,
    contradictoryPaperIds: normalized.contradictoryPaperIds,
    evidenceStrength: normalized.evidenceStrength,
    expectedEffect: normalized.expectedEffect,
    falsificationCriteria: normalized.falsificationCriteria,
    requiredData: normalized.requiredData,
    knownLimitations: normalized.knownLimitations,
    familyFingerprint: '',
    configHash: '',
    createdAt: normalized.createdAt,
    provenance,
  };
  body.configHash = computeHypothesisConfigHash(body);
  body.hypothesisId = `hypothesis:sha256:${body.configHash}`;
  body.familyFingerprint = computeFamilyFingerprint(body);
  const ordered = Object.fromEntries(HYPOTHESIS_KEYS.map((key) => [key, body[key]]));
  assertStrategyHypothesisV1(ordered);
  return deepFreeze(ordered);
}

function assessmentResult(verdict, reasons, validatedPaperIds) {
  return deepFreeze({
    verdict,
    reasons: [...new Set(reasons)].sort(),
    validatedPaperIds: [...new Set(validatedPaperIds)].sort(),
  });
}

export function assessHypothesisEvidence(hypothesis, papers) {
  assertStrategyHypothesisV1(hypothesis);
  if (!Array.isArray(papers)) return assessmentResult('MISSING_EVIDENCE', ['RESEARCH_PAPERS_ARRAY_REQUIRED'], []);

  const expectedIds = [...hypothesis.supportingPaperIds, ...hypothesis.contradictoryPaperIds];
  const references = new Map(hypothesis.provenance.papers.map((reference) => [reference.paperId, reference]));
  const candidates = new Map();
  const invalidIds = new Set();
  for (const candidate of papers) {
    const candidateId = candidate && typeof candidate === 'object' && typeof candidate.paperId === 'string' ? candidate.paperId : 'UNKNOWN';
    try {
      assertResearchPaperV2(candidate);
      if (candidates.has(candidate.paperId)) invalidIds.add(candidate.paperId);
      candidates.set(candidate.paperId, candidate);
    } catch {
      invalidIds.add(candidateId);
    }
  }

  const missing = [];
  const conflicts = [];
  const validated = [];
  for (const paperId of expectedIds) {
    const paper = candidates.get(paperId);
    if (!paper || invalidIds.has(paperId)) {
      missing.push(`PAPER_INVALID_OR_MISSING:${paperId}`);
      continue;
    }
    if (paper.metadataHash !== references.get(paperId).metadataHash) {
      missing.push(`PAPER_METADATA_HASH_MISMATCH:${paperId}`);
      continue;
    }
    validated.push(paperId);
    if (hypothesis.provenance.evidencePolicy.requireKnownContentLicense && paper.license.content.status !== 'KNOWN') {
      missing.push(`CONTENT_LICENSE_UNKNOWN:${paperId}`);
    }
    if (hypothesis.provenance.evidencePolicy.requireResolvedCorrections && paper.correctionState.status !== 'UNKNOWN') {
      missing.push(`CORRECTION_UNRESOLVED:${paperId}`);
    }
    if (RETRACTION_CONFLICTS.has(paper.retractionState.status)) {
      if (hypothesis.supportingPaperIds.includes(paperId)) conflicts.push(`SUPPORTING_PAPER_INTEGRITY_CONFLICT:${paperId}`);
      else missing.push(`CONTRADICTORY_PAPER_INTEGRITY_UNRESOLVED:${paperId}`);
    }
  }

  if (hypothesis.evidenceStrength.supporting === 'INSUFFICIENT') missing.push('SUPPORTING_EVIDENCE_INSUFFICIENT');
  if (hypothesis.evidenceStrength.contradictory === 'STRONG' && hypothesis.contradictoryPaperIds.length > 0) {
    const allContradictoryEvidenceUsable = hypothesis.contradictoryPaperIds.every((paperId) => validated.includes(paperId) && !missing.some((reason) => reason.endsWith(`:${paperId}`)));
    if (allContradictoryEvidenceUsable) conflicts.push('STRONG_CONTRADICTORY_EVIDENCE');
  }
  if (conflicts.length > 0) return assessmentResult('CONFLICTED', [...conflicts, ...missing], validated);
  if (missing.length > 0) return assessmentResult('MISSING_EVIDENCE', missing, validated);
  return assessmentResult('APPROVE_FOR_RESEARCH', [], validated);
}

function assertEvidenceAssessment(assessment) {
  assertExactKeys(assessment, ['verdict', 'reasons', 'validatedPaperIds'], 'EVIDENCE_ASSESSMENT_SHAPE_INVALID');
  if (!['APPROVE_FOR_RESEARCH', 'MISSING_EVIDENCE', 'CONFLICTED'].includes(assessment.verdict)) fail('EVIDENCE_ASSESSMENT_VERDICT_INVALID');
  assertCanonicalStrings(assessment.reasons, 'EVIDENCE_ASSESSMENT_REASONS_INVALID', { allowEmpty: true });
  assertCanonicalStrings(assessment.validatedPaperIds, 'EVIDENCE_ASSESSMENT_PAPERS_INVALID', { allowEmpty: true });
  if ((assessment.verdict === 'APPROVE_FOR_RESEARCH') !== (assessment.reasons.length === 0)) fail('EVIDENCE_ASSESSMENT_REASONS_MISMATCH');
}

function decisionHashMaterial(decision) {
  return {
    schemaVersion: decision.schemaVersion,
    hypothesisId: decision.hypothesisId,
    hypothesisVersion: decision.hypothesisVersion,
    hypothesisConfigHash: decision.hypothesisConfigHash,
    verdict: decision.verdict,
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
    committee: decision.committee,
    evidenceAssessment: decision.evidenceAssessment,
    executableStrategyCreated: decision.executableStrategyCreated,
    tradingAuthority: decision.tradingAuthority,
  };
}

export function computeHypothesisDecisionHash(decision) {
  return sha256Hex(decisionHashMaterial(decision));
}

export function assertHypothesisDecisionV1(decision) {
  assertExactKeys(decision, DECISION_KEYS, 'HYPOTHESIS_DECISION_V1_SHAPE_INVALID');
  if (decision.schemaVersion !== HYPOTHESIS_DECISION_SCHEMA_VERSION) fail('HYPOTHESIS_DECISION_SCHEMA_VERSION_INVALID');
  assertCanonicalString(decision.hypothesisId, 'DECISION_HYPOTHESIS_ID_REQUIRED');
  if (decision.hypothesisVersion !== 1) fail('DECISION_HYPOTHESIS_VERSION_INVALID');
  if (!HASH_PATTERN.test(decision.hypothesisConfigHash)) fail('DECISION_HYPOTHESIS_HASH_INVALID');
  if (!VERDICTS.has(decision.verdict)) fail('HYPOTHESIS_DECISION_VERDICT_INVALID');
  assertCanonicalString(decision.rationale, 'HYPOTHESIS_DECISION_RATIONALE_REQUIRED');
  assertTimestamp(decision.decidedAt, 'HYPOTHESIS_DECIDED_AT_INVALID');
  assertExactKeys(decision.committee, ['name', 'version', 'members'], 'HYPOTHESIS_COMMITTEE_SHAPE_INVALID');
  assertCanonicalString(decision.committee.name, 'HYPOTHESIS_COMMITTEE_NAME_REQUIRED');
  assertCanonicalString(decision.committee.version, 'HYPOTHESIS_COMMITTEE_VERSION_REQUIRED');
  assertCanonicalStrings(decision.committee.members, 'HYPOTHESIS_COMMITTEE_MEMBERS_REQUIRED');
  assertEvidenceAssessment(decision.evidenceAssessment);
  if (decision.evidenceAssessment.verdict !== 'APPROVE_FOR_RESEARCH' && decision.verdict !== decision.evidenceAssessment.verdict) {
    fail('FAIL_CLOSED_VERDICT_REQUIRED', decision.evidenceAssessment.verdict);
  }
  if (decision.evidenceAssessment.verdict === 'APPROVE_FOR_RESEARCH' && !['APPROVE_FOR_RESEARCH', 'REJECT'].includes(decision.verdict)) {
    fail('HYPOTHESIS_DECISION_VERDICT_UNSUPPORTED');
  }
  if (decision.executableStrategyCreated !== false) fail('EXECUTABLE_STRATEGY_CREATION_FORBIDDEN');
  if (decision.tradingAuthority !== 'NONE') fail('TRADING_AUTHORITY_FORBIDDEN');
  const expectedHash = computeHypothesisDecisionHash(decision);
  if (decision.decisionHash !== expectedHash) fail('HYPOTHESIS_DECISION_HASH_MISMATCH');
  if (decision.decisionId !== `hypothesis-decision:sha256:${expectedHash}`) fail('HYPOTHESIS_DECISION_ID_MISMATCH');
  return decision;
}

export function verifyHypothesisDecisionV1(decision) {
  try {
    assertHypothesisDecisionV1(decision);
    return true;
  } catch {
    return false;
  }
}

export function createHypothesisDecisionV1(input) {
  assertExactKeys(input, ['hypothesis', 'papers', 'verdict', 'rationale', 'decidedAt', 'committee'], 'HYPOTHESIS_DECISION_INPUT_SHAPE_INVALID');
  assertStrategyHypothesisV1(input.hypothesis);
  if (!VERDICTS.has(input.verdict)) fail('HYPOTHESIS_DECISION_VERDICT_INVALID');
  const assessment = assessHypothesisEvidence(input.hypothesis, input.papers);
  if (assessment.verdict !== 'APPROVE_FOR_RESEARCH' && input.verdict !== assessment.verdict) {
    fail('FAIL_CLOSED_VERDICT_REQUIRED', assessment.verdict);
  }
  if (assessment.verdict === 'APPROVE_FOR_RESEARCH' && !['APPROVE_FOR_RESEARCH', 'REJECT'].includes(input.verdict)) {
    fail('HYPOTHESIS_DECISION_VERDICT_UNSUPPORTED');
  }
  const committee = {
    name: normalizeString(input.committee?.name, 'HYPOTHESIS_COMMITTEE_NAME_REQUIRED'),
    version: normalizeString(input.committee?.version, 'HYPOTHESIS_COMMITTEE_VERSION_REQUIRED'),
    members: canonicalStrings(input.committee?.members, 'HYPOTHESIS_COMMITTEE_MEMBERS_REQUIRED'),
  };
  assertTimestamp(input.decidedAt, 'HYPOTHESIS_DECIDED_AT_INVALID');
  const body = {
    schemaVersion: HYPOTHESIS_DECISION_SCHEMA_VERSION,
    decisionId: '',
    hypothesisId: input.hypothesis.hypothesisId,
    hypothesisVersion: input.hypothesis.hypothesisVersion,
    hypothesisConfigHash: input.hypothesis.configHash,
    verdict: input.verdict,
    rationale: normalizeString(input.rationale, 'HYPOTHESIS_DECISION_RATIONALE_REQUIRED'),
    decidedAt: input.decidedAt,
    committee,
    evidenceAssessment: assessment,
    executableStrategyCreated: false,
    tradingAuthority: 'NONE',
    decisionHash: '',
  };
  body.decisionHash = computeHypothesisDecisionHash(body);
  body.decisionId = `hypothesis-decision:sha256:${body.decisionHash}`;
  const ordered = Object.fromEntries(DECISION_KEYS.map((key) => [key, body[key]]));
  assertHypothesisDecisionV1(ordered);
  return deepFreeze(ordered);
}
