import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  canonicalJson,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  computePublicForwardLiquiditySplitPolicyDigest,
} from '../src/public-forward-liquidity-calibration-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_SPLIT_SOURCE_VERSION,
} from '../src/public-forward-liquidity-independence-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_SAFETY,
  auditPublicForwardLiquidityIndependentSplits,
} from '../src/public-forward-liquidity-multi-source-split-audit.mjs';

const PRODUCER_SHA = 'c'.repeat(40);
const COLLECTOR_A = 'a'.repeat(40);
const COLLECTOR_B = 'b'.repeat(40);

function digest(value) {
  return sha256(canonicalJson(value));
}

function upstreamSource(identity, collectorCodeSha) {
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-bound-source-v1',
    sourceIdentity: identity,
    producerCodeSha: PRODUCER_SHA,
    collectorCodeSha,
    collectorImplementationPath: 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs',
    collectorImplementationBlobSha: collectorCodeSha,
    datasetDigest: digest(`dataset:${identity}`),
    datasetRelativePath: `forward/${identity}/dataset.json`,
    receiptDigest: digest(`receipt:${identity}`),
    artifactId: identity === 'source-a' ? '1001' : '1002',
    artifactDigest: digest(`artifact:${identity}`),
    rawBatchDigest: digest(`raw:${identity}`),
  });
}

function rawObservation({ id, timestamp, collectorCodeSha, publicExecutionId }) {
  return Object.freeze({
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    observationId: id,
    collectorCodeSha,
    sourceDigest: digest(`source:${id}`),
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    aggressiveSide: 'BUY',
    tradeFlowQuantity: 1,
    tradeFlowNotional: 101,
    eventTimestampMs: timestamp,
    forwardCalibrationSampleCredit: 1,
    historicalBackfillForwardCredit: 0,
    executionCostEligible: false,
    liquidityImpactCoefficient: null,
    causalMarketImpactClaim: false,
    paperOrderSourceAllowed: false,
    rawSourceProvenance: Object.freeze({
      publicTrade: Object.freeze({ publicExecutionId }),
    }),
  });
}

function splitSource() {
  const sourceA = upstreamSource('source-a', COLLECTOR_A);
  const sourceB = upstreamSource('source-b', COLLECTOR_B);
  const rows = [
    { source: sourceA, raw: rawObservation({ id: 'raw-train', timestamp: 1_500, collectorCodeSha: COLLECTOR_A, publicExecutionId: 'exec-train' }) },
    { source: sourceB, raw: rawObservation({ id: 'raw-validation', timestamp: 2_500, collectorCodeSha: COLLECTOR_B, publicExecutionId: 'exec-validation' }) },
    { source: sourceA, raw: rawObservation({ id: 'raw-oos', timestamp: 3_500, collectorCodeSha: COLLECTOR_A, publicExecutionId: 'exec-oos' }) },
  ];
  const observations = rows.map(({ source, raw }) => Object.freeze({
    observationId: `bound:${raw.observationId}`,
    sourceObservationId: raw.observationId,
    sourceIdentity: source.sourceIdentity,
    eventIdentity: `event:${raw.observationId}`,
    sourceFrameIdentity: `frame:${raw.observationId}`,
    observation: raw,
  }));
  const core = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_SPLIT_SOURCE_VERSION,
    kind: 'public-forward-liquidity-independent-split-source',
    producerCodeSha: PRODUCER_SHA,
    independenceAuditDigest: digest('independence-audit'),
    upstreamSources: Object.freeze([sourceA, sourceB]),
    observations: Object.freeze(observations),
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return Object.freeze({ ...core, splitSourceDigest: digest(core) });
}

function policy(overrides = {}) {
  const body = {
    policyIdentity: 'liquidity-multi-source-frozen-split-v2',
    policyVersion: 'v2',
    policyFrozenAtMs: 500,
    expectedScopeOwnerIdentity: 'scope-owner',
    expectedScopePolicyIdentity: 'scope-policy-v1',
    expectedScopePolicyDigest: digest('scope-policy'),
    expectedRegimeOwnerIdentity: 'regime-owner',
    expectedRegimePolicyIdentity: 'regime-policy-v1',
    expectedRegimePolicyDigest: digest('regime-policy'),
    maxRegimeEvidenceAgeMs: 1_000,
    windows: {
      train: { startInclusiveMs: 1_000, endExclusiveMs: 2_000 },
      validation: { startInclusiveMs: 2_000, endExclusiveMs: 3_000 },
      oos: { startInclusiveMs: 3_000, endExclusiveMs: 4_000 },
    },
    overallMinimums: { train: 1, validation: 1, oos: 1 },
    scopeMinimums: [{
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      aggressiveSide: 'BUY',
      quantityNotionalBucketIdentity: 'bucket-1',
      volatilityRegimeIdentity: 'VOL_NORMAL',
      liquidityRegimeIdentity: 'LIQ_NORMAL',
      minimums: { train: 1, validation: 1, oos: 1 },
    }],
    ...overrides,
  };
  return { ...body, policyDigest: computePublicForwardLiquiditySplitPolicyDigest(body) };
}

function bindings(source, splitPolicy) {
  const scopeBindings = source.observations.map((entry, index) => ({
    observationId: entry.sourceObservationId,
    sourceObservationId: entry.sourceObservationId,
    sourceIdentity: entry.sourceIdentity,
    sourceDigest: entry.observation.sourceDigest,
    market: entry.observation.market,
    symbol: entry.observation.symbol,
    aggressiveSide: entry.observation.aggressiveSide,
    tradeFlowQuantity: entry.observation.tradeFlowQuantity,
    tradeFlowNotional: entry.observation.tradeFlowNotional,
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeOwnerIdentity: splitPolicy.expectedScopeOwnerIdentity,
    scopePolicyIdentity: splitPolicy.expectedScopePolicyIdentity,
    scopePolicyDigest: splitPolicy.expectedScopePolicyDigest,
    scopeEvidenceIdentity: `scope-${index}`,
    scopeEvidenceDigest: digest(`scope-${index}`),
    scopePolicyFrozenAtMs: 400,
  }));
  const regimeBindings = source.observations.map((entry, index) => ({
    observationId: entry.sourceObservationId,
    sourceObservationId: entry.sourceObservationId,
    sourceIdentity: entry.sourceIdentity,
    sourceDigest: entry.observation.sourceDigest,
    market: entry.observation.market,
    symbol: entry.observation.symbol,
    aggressiveSide: entry.observation.aggressiveSide,
    regimeOwnerIdentity: splitPolicy.expectedRegimeOwnerIdentity,
    regimePolicyIdentity: splitPolicy.expectedRegimePolicyIdentity,
    regimePolicyDigest: splitPolicy.expectedRegimePolicyDigest,
    regimeEvidenceIdentity: `regime-${index}`,
    regimeEvidenceDigest: digest(`regime-${index}`),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    observedAtMs: entry.observation.eventTimestampMs - 100,
  }));
  return { scopeBindings, regimeBindings };
}

test('multi-source split audit preserves upstream provenance without synthetic single dataset/collector identity', () => {
  const source = splitSource();
  const splitPolicy = policy();
  const evidence = bindings(source, splitPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({ splitSource: source, policy: splitPolicy, ...evidence });

  assert.equal(result.status, 'PRESENT');
  assert.equal(result.audit.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION);
  assert.equal(result.audit.independentSplitSourceDigest, source.splitSourceDigest);
  assert.equal(result.audit.independenceAuditDigest, source.independenceAuditDigest);
  assert.deepEqual(result.audit.counts, { train: 1, validation: 1, oos: 1 });
  assert.deepEqual(result.audit.collectorCodeShas, [COLLECTOR_A, COLLECTOR_B]);
  assert.equal(result.audit.datasetDigest, undefined);
  assert.equal(result.audit.collectorCodeSha, undefined);
  assert.equal(result.audit.upstreamSources.length, 2);
  assert.match(result.audit.upstreamLineageDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.audit.assignments.length, 3);
  assert.equal(result.audit.assignments[0].sourceDatasetDigest, source.upstreamSources[0].datasetDigest);
  assert.equal(result.audit.assignments[1].sourceCollectorCodeSha, COLLECTOR_B);
  assert.equal(result.audit.calibrationSampleSufficient, true);
  assert.equal(result.audit.oosValidationComplete, false);
  assert.equal(result.audit.fullCostReady, false);
  assert.equal(result.audit.evidenceCompleteCredit, 0);
  assert.equal(result.safety.syntheticAggregateDatasetAllowed, false);
  assert.deepEqual(result.safety, PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_SAFETY);
});

test('multi-source split audit fails closed when frozen minima are not met', () => {
  const source = splitSource();
  const base = policy();
  const stricterPolicy = policy({ overallMinimums: { train: 2, validation: 1, oos: 1 } });
  const evidence = bindings(source, stricterPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({ splitSource: source, policy: stricterPolicy, ...evidence });

  assert.equal(base.overallMinimums.train, 1);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.deepEqual(result.blockers, ['CALIBRATION_SAMPLE_INSUFFICIENT']);
  assert.equal(result.audit.calibrationSampleSufficient, false);
  assert.ok(result.audit.sampleDeficits.some((value) => value === 'OVERALL:TRAIN:1<2'));
  assert.equal(result.audit.fullCostReady, false);
});

test('multi-source split audit rejects forged split-source digest', () => {
  const source = splitSource();
  const forged = { ...source, splitSourceDigest: 'f'.repeat(64) };
  const splitPolicy = policy();
  const evidence = bindings(source, splitPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({ splitSource: forged, policy: splitPolicy, ...evidence });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('INDEPENDENT_SPLIT_SOURCE_DIGEST_MISMATCH'));
});

test('multi-source split audit rejects post-event regime evidence', () => {
  const source = splitSource();
  const splitPolicy = policy();
  const evidence = bindings(source, splitPolicy);
  evidence.regimeBindings[0] = {
    ...evidence.regimeBindings[0],
    observedAtMs: source.observations[0].observation.eventTimestampMs + 1,
  };
  const result = auditPublicForwardLiquidityIndependentSplits({ splitSource: source, policy: splitPolicy, ...evidence });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('REGIME_EVIDENCE_AFTER_EVENT'));
});

test('multi-source split audit rejects source/collector provenance drift', () => {
  const source = splitSource();
  const forgedObservation = {
    ...source.observations[1],
    observation: { ...source.observations[1].observation, collectorCodeSha: COLLECTOR_A },
  };
  const core = {
    ...source,
    observations: Object.freeze([source.observations[0], forgedObservation, source.observations[2]]),
  };
  delete core.splitSourceDigest;
  const forged = { ...core, splitSourceDigest: digest(core) };
  const splitPolicy = policy();
  const evidence = bindings(forged, splitPolicy);
  const result = auditPublicForwardLiquidityIndependentSplits({ splitSource: forged, policy: splitPolicy, ...evidence });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OBSERVATION_COLLECTOR_LINEAGE_MISMATCH'));
});
