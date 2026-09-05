import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptCrossrefMetadata,
  computeResearchPaperMetadataHash,
} from '../../external-research/src/index.js';
import {
  assessHypothesisEvidence,
  assertHypothesisDecisionV1,
  assertStrategyHypothesisV1,
  computeHypothesisDecisionHash,
  createHypothesisDecisionV1,
  createStrategyHypothesisV1,
  verifyHypothesisDecisionV1,
  verifyStrategyHypothesisV1,
} from '../src/index.js';

const CREATED_AT = '2026-08-24T09:00:00.000Z';
const DECIDED_AT = '2026-08-24T10:00:00.000Z';

function makePaper(doi, { knownLicense = true, updateType = null } = {}) {
  const message = {
    DOI: doi,
    title: [`Evidence for ${doi}`],
    author: [{ given: 'Ada', family: 'Lovelace' }],
    published: { 'date-parts': [[2024, 2, 1]] },
    indexed: { 'date-time': '2026-08-23T03:04:05Z', version: '3.51.4' },
  };
  if (knownLicense) {
    message.license = [{
      URL: 'https://creativecommons.org/licenses/by/4.0/',
      'content-version': 'vor',
      'delay-in-days': 0,
      start: { 'date-parts': [[2024, 2, 1]] },
    }];
  }
  if (updateType) {
    message['updated-by'] = [{
      DOI: `10.9999/${updateType}.notice`,
      type: updateType,
      label: updateType,
      source: 'publisher',
      updated: { 'date-parts': [[2025, 1, 2]] },
    }];
  }
  return adaptCrossrefMetadata({
    status: 'ok',
    'message-type': 'work',
    'message-version': '1.0.0',
    message,
  }, {
    retrievedAt: '2026-08-24T06:00:00.000Z',
    retrievedFrom: `https://api.crossref.org/v1/works/${doi}`,
  });
}

const paperA = makePaper('10.1234/hypothesis.001');
const paperB = makePaper('10.1234/hypothesis.002');
const paperC = makePaper('10.1234/hypothesis.003');

function hypothesisCore({
  supporting = [paperA],
  contradictory = [],
  supportingStrength = 'STRONG',
  contradictoryStrength = contradictory.length > 0 ? 'STRONG' : 'NONE',
  statement = 'Daily cross-sectional momentum is positively associated with next-day excess return in United States large-cap equities.',
  threshold = 0,
  expectedEffect,
  falsificationCriteria,
  createdAt = CREATED_AT,
  requireKnownContentLicense = true,
} = {}) {
  return {
    title: 'Cross-sectional momentum research hypothesis',
    statement,
    marketScope: ['US_LARGE_CAP'],
    assetClass: 'EQUITY',
    timeframeScope: ['1d'],
    directionality: 'POSITIVE',
    rationale: 'Peer-reviewed evidence motivates a bounded empirical test, not an executable trading rule.',
    supportingPaperIds: supporting.map((paper) => paper.paperId),
    contradictoryPaperIds: contradictory.map((paper) => paper.paperId),
    evidenceStrength: {
      supporting: supportingStrength,
      contradictory: contradictoryStrength,
    },
    expectedEffect: expectedEffect ?? {
      observable: 'NEXT_DAY_EXCESS_RETURN',
      direction: 'INCREASE',
      minimumMagnitude: 0.001,
      unit: 'DECIMAL_RETURN',
      evaluationWindow: '1d',
    },
    falsificationCriteria: falsificationCriteria ?? {
      observable: 'NEXT_DAY_EXCESS_RETURN',
      metric: 'MEAN_TOP_MINUS_BOTTOM_QUINTILE_RETURN',
      operator: 'LTE',
      threshold,
      unit: 'DECIMAL_RETURN',
      evaluationWindow: '1d',
      minimumObservations: 252,
      rejectionStatement: 'Reject when the measured mean spread is less than or equal to the threshold.',
    },
    requiredData: [{
      dataset: 'LICENSED_DAILY_EQUITY_PANEL',
      fields: ['return', 'close', 'security_id'],
      frequency: '1d',
      provenanceRequired: true,
      licenseRequired: true,
    }],
    knownLimitations: ['Corporate-action quality and survivorship bias can affect the observable.'],
    createdAt,
    generator: { name: 'strategy-hypothesis-foundation', version: '1.0.0' },
    evidencePolicy: {
      requireKnownContentLicense,
      requireResolvedCorrections: true,
    },
  };
}

function makeHypothesis(options = {}) {
  const supporting = options.supporting ?? [paperA];
  const contradictory = options.contradictory ?? [];
  return createStrategyHypothesisV1(
    hypothesisCore({ ...options, supporting, contradictory }),
    [...supporting, ...contradictory],
  );
}

function committee() {
  return { name: 'Research Review Committee', version: '1.0.0', members: ['reviewer-b', 'reviewer-a'] };
}

test('StrategyHypothesisV1 is canonical, frozen, and independently verifiable', () => {
  const hypothesis = makeHypothesis();
  assert.equal(verifyStrategyHypothesisV1(hypothesis), true);
  assert.doesNotThrow(() => assertStrategyHypothesisV1(hypothesis));
  assert.equal(Object.isFrozen(hypothesis), true);
  assert.equal(Object.isFrozen(hypothesis.falsificationCriteria), true);
  assert.deepEqual(hypothesis.requiredData[0].fields, ['close', 'return', 'security_id']);
  assert.match(hypothesis.configHash, /^[0-9a-f]{64}$/u);
  assert.match(hypothesis.hypothesisId, /^hypothesis:sha256:[0-9a-f]{64}$/u);
});

test('canonical hash is stable across object insertion order and unordered set input', () => {
  const first = makeHypothesis();
  const second = createStrategyHypothesisV1(hypothesisCore({
    expectedEffect: {
      evaluationWindow: '1d',
      unit: 'DECIMAL_RETURN',
      minimumMagnitude: 0.001,
      direction: 'INCREASE',
      observable: 'NEXT_DAY_EXCESS_RETURN',
    },
    falsificationCriteria: {
      rejectionStatement: 'Reject when the measured mean spread is less than or equal to the threshold.',
      minimumObservations: 252,
      evaluationWindow: '1d',
      unit: 'DECIMAL_RETURN',
      threshold: 0,
      operator: 'LTE',
      metric: 'MEAN_TOP_MINUS_BOTTOM_QUINTILE_RETURN',
      observable: 'NEXT_DAY_EXCESS_RETURN',
    },
  }), [paperA]);
  assert.equal(first.configHash, second.configHash);
  assert.equal(first.hypothesisId, second.hypothesisId);
});

test('multiple supporting papers preserve hypothesis identity and pin each metadata hash', () => {
  const single = makeHypothesis({ supporting: [paperA] });
  const multiple = makeHypothesis({ supporting: [paperB, paperA] });
  assert.equal(single.hypothesisId, multiple.hypothesisId);
  assert.equal(single.configHash, multiple.configHash);
  assert.deepEqual(multiple.supportingPaperIds, [paperA.paperId, paperB.paperId]);
  assert.deepEqual(multiple.provenance.papers.map((entry) => entry.metadataHash), [paperA.metadataHash, paperB.metadataHash]);
});

test('hypothesis identity is never derived from any paper identity', () => {
  const hypothesis = makeHypothesis();
  assert.notEqual(hypothesis.hypothesisId, paperA.paperId);
  assert.equal(hypothesis.hypothesisId.includes(paperA.paperId), false);
});

test('strong valid contradictory evidence fails closed as CONFLICTED', () => {
  const hypothesis = makeHypothesis({ supporting: [paperA], contradictory: [paperC] });
  const assessment = assessHypothesisEvidence(hypothesis, [paperA, paperC]);
  assert.equal(assessment.verdict, 'CONFLICTED');
  assert.ok(assessment.reasons.includes('STRONG_CONTRADICTORY_EVIDENCE'));
  assert.throws(() => createHypothesisDecisionV1({
    hypothesis,
    papers: [paperA, paperC],
    verdict: 'APPROVE_FOR_RESEARCH',
    rationale: 'Attempted override.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  }), /FAIL_CLOSED_VERDICT_REQUIRED:CONFLICTED/);
});

test('family fingerprint collisions are similarity candidates, never identity authority', () => {
  const first = makeHypothesis({ threshold: 0 });
  const second = makeHypothesis({ threshold: 0.0005 });
  assert.equal(first.familyFingerprint, second.familyFingerprint);
  assert.notEqual(first.configHash, second.configHash);
  assert.notEqual(first.hypothesisId, second.hypothesisId);
});

test('malformed or semantically changed hypothesis fails closed', () => {
  const changed = structuredClone(makeHypothesis());
  changed.statement = 'A changed statement must invalidate the original identity.';
  assert.equal(verifyStrategyHypothesisV1(changed), false);
  assert.throws(() => assertStrategyHypothesisV1(changed), /HYPOTHESIS_CONFIG_HASH_MISMATCH/);
});

test('missing falsification criteria is rejected rather than inferred', () => {
  const changed = structuredClone(makeHypothesis());
  delete changed.falsificationCriteria;
  assert.throws(() => assertStrategyHypothesisV1(changed), /STRATEGY_HYPOTHESIS_V1_SHAPE_INVALID/);
});

test('unknown hypothesis fields are rejected', () => {
  const changed = { ...structuredClone(makeHypothesis()), executableStrategy: {} };
  assert.throws(() => assertStrategyHypothesisV1(changed), /STRATEGY_HYPOTHESIS_V1_SHAPE_INVALID/);
});

test('invalid and non-canonical timestamps are rejected', () => {
  assert.throws(() => makeHypothesis({ createdAt: 'not-a-timestamp' }), /HYPOTHESIS_CREATED_AT_INVALID/);
  assert.throws(() => makeHypothesis({ createdAt: '2026-08-24T09:00:00Z' }), /HYPOTHESIS_CREATED_AT_INVALID/);
});

test('missing paper evidence returns MISSING_EVIDENCE', () => {
  const hypothesis = makeHypothesis();
  const assessment = assessHypothesisEvidence(hypothesis, []);
  assert.equal(assessment.verdict, 'MISSING_EVIDENCE');
  assert.deepEqual(assessment.validatedPaperIds, []);
  assert.ok(assessment.reasons.includes(`PAPER_INVALID_OR_MISSING:${paperA.paperId}`));
});

test('ResearchPaperV2 tampering propagates to MISSING_EVIDENCE even with a recomputed metadata hash', () => {
  const hypothesis = makeHypothesis();
  const tampered = structuredClone(paperA);
  tampered.title = 'Tampered evidence title';
  tampered.metadataHash = computeResearchPaperMetadataHash(tampered);
  const assessment = assessHypothesisEvidence(hypothesis, [tampered]);
  assert.equal(assessment.verdict, 'MISSING_EVIDENCE');
  assert.ok(assessment.reasons.includes(`PAPER_METADATA_HASH_MISMATCH:${paperA.paperId}`));
  assert.throws(() => createHypothesisDecisionV1({
    hypothesis,
    papers: [tampered],
    verdict: 'APPROVE_FOR_RESEARCH',
    rationale: 'Tampered evidence cannot be approved.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  }), /FAIL_CLOSED_VERDICT_REQUIRED:MISSING_EVIDENCE/);
});

test('unknown content license fails closed when the provenance policy requires it', () => {
  const unknownLicensePaper = makePaper('10.1234/hypothesis.license-unknown', { knownLicense: false });
  const hypothesis = makeHypothesis({ supporting: [unknownLicensePaper] });
  const assessment = assessHypothesisEvidence(hypothesis, [unknownLicensePaper]);
  assert.equal(assessment.verdict, 'MISSING_EVIDENCE');
  assert.ok(assessment.reasons.includes(`CONTENT_LICENSE_UNKNOWN:${unknownLicensePaper.paperId}`));
});

test('unresolved correction evidence fails closed', () => {
  const correctedPaper = makePaper('10.1234/hypothesis.corrected', { updateType: 'correction' });
  const hypothesis = makeHypothesis({ supporting: [correctedPaper] });
  const assessment = assessHypothesisEvidence(hypothesis, [correctedPaper]);
  assert.equal(assessment.verdict, 'MISSING_EVIDENCE');
  assert.ok(assessment.reasons.includes(`CORRECTION_UNRESOLVED:${correctedPaper.paperId}`));
});

test('retracted supporting evidence cannot be approved for research', () => {
  const retractedPaper = makePaper('10.1234/hypothesis.retracted', { updateType: 'retraction' });
  const hypothesis = makeHypothesis({ supporting: [retractedPaper] });
  const assessment = assessHypothesisEvidence(hypothesis, [retractedPaper]);
  assert.equal(assessment.verdict, 'CONFLICTED');
  assert.ok(assessment.reasons.includes(`SUPPORTING_PAPER_INTEGRITY_CONFLICT:${retractedPaper.paperId}`));
});

test('decision is a separate immutable record and never overwrites hypothesis content', () => {
  const hypothesis = makeHypothesis();
  const statementBefore = hypothesis.statement;
  const decision = createHypothesisDecisionV1({
    hypothesis,
    papers: [paperA],
    verdict: 'APPROVE_FOR_RESEARCH',
    rationale: 'Evidence is admissible for a later empirical research stage.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  });
  assert.equal(verifyHypothesisDecisionV1(decision), true);
  assert.doesNotThrow(() => assertHypothesisDecisionV1(decision));
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.evidenceAssessment), true);
  assert.equal(hypothesis.statement, statementBefore);
  assert.equal(decision.hypothesisId, hypothesis.hypothesisId);
  assert.equal('statement' in decision, false);
});

test('APPROVE_FOR_RESEARCH creates no executable strategy and grants no trading authority', () => {
  const decision = createHypothesisDecisionV1({
    hypothesis: makeHypothesis(),
    papers: [paperA],
    verdict: 'APPROVE_FOR_RESEARCH',
    rationale: 'Research review only.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  });
  assert.equal(decision.executableStrategyCreated, false);
  assert.equal(decision.tradingAuthority, 'NONE');
  assert.equal('executableStrategyCandidate' in decision, false);
  assert.equal('backtestResult' in decision, false);
  assert.equal('profitability' in decision, false);
});

test('decision verdict vocabulary and unknown fields are closed', () => {
  assert.throws(() => createHypothesisDecisionV1({
    hypothesis: makeHypothesis(),
    papers: [paperA],
    verdict: 'BACKTEST_PASS',
    rationale: 'Forbidden verdict.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  }), /HYPOTHESIS_DECISION_VERDICT_INVALID/);
  const decision = createHypothesisDecisionV1({
    hypothesis: makeHypothesis(),
    papers: [paperA],
    verdict: 'REJECT',
    rationale: 'Committee declines further research.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  });
  assert.throws(() => assertHypothesisDecisionV1({ ...structuredClone(decision), promotion: 'READY' }), /HYPOTHESIS_DECISION_V1_SHAPE_INVALID/);
});

test('recomputed decision hash cannot bypass a fail-closed evidence verdict', () => {
  const missingDecision = createHypothesisDecisionV1({
    hypothesis: makeHypothesis(),
    papers: [],
    verdict: 'MISSING_EVIDENCE',
    rationale: 'Required evidence is unavailable.',
    decidedAt: DECIDED_AT,
    committee: committee(),
  });
  const changed = structuredClone(missingDecision);
  changed.verdict = 'APPROVE_FOR_RESEARCH';
  changed.decisionHash = computeHypothesisDecisionHash(changed);
  changed.decisionId = `hypothesis-decision:sha256:${changed.decisionHash}`;
  assert.throws(() => assertHypothesisDecisionV1(changed), /FAIL_CLOSED_VERDICT_REQUIRED:MISSING_EVIDENCE/);
});
