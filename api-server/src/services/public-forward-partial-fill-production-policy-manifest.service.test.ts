import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS,
  PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY,
  buildPublicForwardPartialFillProductionPolicyManifestCandidate,
  computePublicForwardPartialFillProductionPolicyManifestDigest,
  computePublicForwardPartialFillScopeUniverseDigest,
  type PublicForwardPartialFillPolicyComponents,
  type PublicForwardPartialFillProductionPolicyManifestInput,
  type PublicForwardPartialFillScopeUniverse,
} from './public-forward-partial-fill-production-policy-manifest.service';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const policyIdentity = 'TEST_ONLY_PARTIAL_FILL_PRODUCTION_POLICY';
const policyVersion = 'test-only-v1';
const policyFrozenAtMs = 1_000;

function components(): PublicForwardPartialFillPolicyComponents {
  return Object.fromEntries(PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS.map((key, index) => [key, {
    identity: key === 'regimePolicy' ? 'TEST_ONLY_REGIME_POLICY' : `TEST_ONLY_${key.toUpperCase()}`,
    version: 'test-only-v1',
    digest: sha256(`component:${key}`),
    frozenAtMs: 100 + index,
    status: 'FROZEN' as const,
  }])) as unknown as PublicForwardPartialFillPolicyComponents;
}

function input(overrides: Partial<PublicForwardPartialFillProductionPolicyManifestInput> = {}) {
  const refs = components();
  const scopeUniverseBody: Omit<PublicForwardPartialFillScopeUniverse, 'digest'> = {
    identity: refs.scopeUniverse.identity,
    version: refs.scopeUniverse.version,
    frozenAtMs: refs.scopeUniverse.frozenAtMs,
    effectiveCohortStartMs: 2_000,
    entries: [{
      market: 'CRYPTO_FUTURES',
      sourceIdentity: 'TEST_ONLY_PUBLIC_VENUE',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantityNotionalBucketIdentity: 'TEST_ONLY_BUCKET',
      volatilityRegimeIdentity: 'TEST_ONLY_VOLATILITY_REGIME',
      liquidityRegimeIdentity: 'TEST_ONLY_LIQUIDITY_REGIME',
    }],
    crossSideExtrapolationAllowed: false,
    crossSymbolExtrapolationAllowed: false,
    crossVenueExtrapolationAllowed: false,
    crossBucketExtrapolationAllowed: false,
    missingRegimeBehavior: 'BLOCKED_UNKNOWN',
    observedScopeSelectionAllowed: false,
    changeRequiresNewVersion: true,
    changeRequiresNewDigest: true,
    changeRequiresNewCohort: true,
  };
  const scopeUniverse: PublicForwardPartialFillScopeUniverse = {
    ...scopeUniverseBody,
    digest: computePublicForwardPartialFillScopeUniverseDigest(scopeUniverseBody),
  };
  (refs as unknown as Record<string, unknown>).scopeUniverse = {
    ...refs.scopeUniverse,
    digest: scopeUniverse.digest,
  };
  const value: PublicForwardPartialFillProductionPolicyManifestInput = {
    policyIdentity,
    policyVersion,
    policyFrozenAtMs,
    effectiveCohortStartMs: 2_000,
    authorityOwnerIdentity: 'TEST_ONLY_RELEASE_CONTROL_OWNER',
    approvalReceiptIdentity: 'TEST_ONLY_APPROVAL_RECEIPT',
    approvalReceiptDigest: sha256('approval'),
    datasetSchemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
    datasetStoreContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    collectorCodeSha: 'a'.repeat(40),
    components: refs,
    scopeUniverse,
    regimeOwnerIdentity: 'TEST_ONLY_REGIME_OWNER',
    splitPolicy: {
      policyIdentity,
      policyVersion,
      policyFrozenAtMs,
      expectedRegimeOwnerIdentity: 'TEST_ONLY_REGIME_OWNER',
      expectedRegimePolicyIdentity: refs.regimePolicy.identity,
      expectedRegimePolicyDigest: refs.regimePolicy.digest,
      maxRegimeEvidenceAgeMs: 100,
      windows: {
        train: { startInclusiveMs: 2_000, endExclusiveMs: 3_000 },
        validation: { startInclusiveMs: 3_000, endExclusiveMs: 4_000 },
        oos: { startInclusiveMs: 4_000, endExclusiveMs: 5_000 },
      },
      overallMinimums: { train: 1, validation: 1, oos: 1 },
      scopeMinimums: [{
        market: 'CRYPTO_FUTURES',
        sourceIdentity: 'TEST_ONLY_PUBLIC_VENUE',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantityNotionalBucketIdentity: 'TEST_ONLY_BUCKET',
        volatilityRegimeIdentity: 'TEST_ONLY_VOLATILITY_REGIME',
        liquidityRegimeIdentity: 'TEST_ONLY_LIQUIDITY_REGIME',
        minimums: { train: 1, validation: 1, oos: 1 },
      }],
    },
    consumerIdentities: [
      'TEST_ONLY_PRODUCTION_READER',
      'TEST_ONLY_SPLIT_AUDIT',
      'TEST_ONLY_SPLIT_AUDIT_ARTIFACT_PRODUCER',
    ],
  };
  return { ...value, ...overrides };
}

test('builds only a digest-bound non-authoritative candidate from fully frozen TEST_ONLY components', () => {
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input());
  assert.equal(result.status, 'PRESENT');
  assert.deepEqual(result.blockers, []);
  assert.ok(result.manifest);
  assert.equal(result.manifest.candidateStatus, 'CANDIDATE_COMPONENTS_VALIDATED');
  assert.equal(result.manifest.productionAuthorityConnected, false);
  assert.equal(result.manifest.policyArtifactProduced, false);
  assert.equal(result.manifest.calibrationArtifactProduced, false);
  assert.equal(result.manifest.partialFillCostProduced, false);
  assert.equal(result.manifest.fullCostReady, false);
  assert.equal(result.manifest.evidenceComplete, 0);
  assert.equal(result.manifest.executionAuthority, 'NONE');
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.components), true);
  assert.equal(Object.isFrozen(result.manifest.splitPolicy.scopeMinimums), true);
  assert.equal(
    result.manifest.manifestDigest,
    computePublicForwardPartialFillProductionPolicyManifestDigest(result.manifest),
  );
});

test('digest is canonical across object insertion order and changes with semantic content', () => {
  const base = input();
  const first = buildPublicForwardPartialFillProductionPolicyManifestCandidate(base);
  const reordered = input({ components: Object.fromEntries(
    Object.entries(base.components).reverse(),
  ) as unknown as PublicForwardPartialFillPolicyComponents });
  const second = buildPublicForwardPartialFillProductionPolicyManifestCandidate(reordered);
  assert.equal(first.manifest?.manifestDigest, second.manifest?.manifestDigest);

  const changed = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    authorityOwnerIdentity: 'TEST_ONLY_DIFFERENT_OWNER',
  }));
  assert.notEqual(first.manifest?.manifestDigest, changed.manifest?.manifestDigest);
});

test('missing, unknown and non-frozen components fail closed', () => {
  const missing = components() as unknown as Record<string, unknown>;
  delete missing.businessTolerance;
  let result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    components: missing as unknown as PublicForwardPartialFillPolicyComponents,
  }));
  assert.equal(result.status, 'BLOCKED_POLICY');
  assert.ok(result.blockers.includes('POLICY_COMPONENT_MISSING:businessTolerance'));

  const notFrozen = components() as unknown as Record<string, Record<string, unknown>>;
  notFrozen.statisticalPolicy = { ...notFrozen.statisticalPolicy, status: 'DESIGN_ONLY' };
  result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    components: notFrozen as unknown as PublicForwardPartialFillPolicyComponents,
  }));
  assert.ok(result.blockers.includes('POLICY_COMPONENT_NOT_FROZEN:statisticalPolicy'));

  const unknown = { ...components(), extraPolicy: components().bucketPolicy };
  result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    components: unknown as unknown as PublicForwardPartialFillPolicyComponents,
  }));
  assert.ok(result.blockers.includes('UNKNOWN_POLICY_COMPONENT'));
});

test('invalid component digest and post-root component freeze fail closed', () => {
  const invalid = components();
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    components: {
      ...invalid,
      bucketPolicy: { ...invalid.bucketPolicy, digest: 'invalid', frozenAtMs: policyFrozenAtMs + 1 },
    },
  }));
  assert.ok(result.blockers.includes('POLICY_COMPONENT_DIGEST_INVALID:bucketPolicy'));
  assert.ok(result.blockers.includes('POLICY_COMPONENT_FROZEN_AFTER_ROOT:bucketPolicy'));
});

test('root freeze, approval, dataset and collector identities fail closed instead of receiving defaults', () => {
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    effectiveCohortStartMs: policyFrozenAtMs,
    approvalReceiptDigest: '',
    datasetStoreContract: 'wrong' as typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    collectorCodeSha: 'not-a-sha',
  }));
  assert.ok(result.blockers.includes('EFFECTIVE_COHORT_NOT_PROSPECTIVE'));
  assert.ok(result.blockers.includes('APPROVAL_RECEIPT_DIGEST_INVALID'));
  assert.ok(result.blockers.includes('DATASET_STORE_CONTRACT_MISMATCH'));
  assert.ok(result.blockers.includes('COLLECTOR_CODE_SHA_INVALID'));
});

test('split policy identity, regime authority and minimum mismatches fail closed', () => {
  const base = input();
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    splitPolicy: {
      ...base.splitPolicy,
      policyIdentity: 'WRONG_POLICY',
      expectedRegimeOwnerIdentity: 'WRONG_REGIME_OWNER',
      expectedRegimePolicyDigest: sha256('wrong-regime'),
      overallMinimums: { train: 1, validation: 0, oos: 1 },
    },
  }));
  assert.ok(result.blockers.includes('SPLIT_POLICY_IDENTITY_MISMATCH'));
  assert.ok(result.blockers.includes('REGIME_OWNER_IDENTITY_MISMATCH'));
  assert.ok(result.blockers.includes('REGIME_POLICY_DIGEST_MISMATCH'));
  assert.ok(result.blockers.includes('OVERALL_MINIMUMS_INVALID'));
});

test('overlapping windows, duplicate scopes and empty consumers fail closed', () => {
  const base = input();
  const scope = base.splitPolicy.scopeMinimums[0];
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate(input({
    splitPolicy: {
      ...base.splitPolicy,
      windows: {
        train: { startInclusiveMs: 2_000, endExclusiveMs: 3_500 },
        validation: { startInclusiveMs: 3_000, endExclusiveMs: 4_000 },
        oos: { startInclusiveMs: 4_000, endExclusiveMs: 5_000 },
      },
      scopeMinimums: [scope, scope],
    },
    consumerIdentities: [],
  }));
  assert.ok(result.blockers.includes('SPLIT_WINDOWS_OVERLAP'));
  assert.ok(result.blockers.includes('DUPLICATE_SCOPE_MINIMUM'));
  assert.ok(result.blockers.includes('CONSUMER_IDENTITIES_REQUIRED'));
});

test('scope universe binds every production dimension and exact split scope', () => {
  const base = input();
  const changedEntries = base.scopeUniverse.entries.map((entry) => ({
    ...entry,
    sourceIdentity: 'TEST_ONLY_OTHER_VENUE',
  }));
  const changedBody = { ...base.scopeUniverse, entries: changedEntries };
  const changedUniverse = {
    ...changedBody,
    digest: computePublicForwardPartialFillScopeUniverseDigest(changedBody),
  };
  const changedComponents = {
    ...base.components,
    scopeUniverse: { ...base.components.scopeUniverse, digest: changedUniverse.digest },
  };
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate({
    ...base,
    components: changedComponents,
    scopeUniverse: changedUniverse,
  });
  assert.equal(result.status, 'BLOCKED_POLICY');
  assert.ok(result.blockers.includes('SPLIT_SCOPE_UNIVERSE_MISMATCH'));
});

test('missing scope universe fails closed without a runtime fallback', () => {
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate({
    ...input(),
    scopeUniverse: undefined,
  } as unknown as PublicForwardPartialFillProductionPolicyManifestInput);
  assert.equal(result.status, 'BLOCKED_POLICY');
  assert.ok(result.blockers.includes('SCOPE_UNIVERSE_REQUIRED'));
});

test('scope extrapolation, observed-scope selection and missing-regime defaults fail closed', () => {
  const base = input();
  const unsafe = {
    ...base.scopeUniverse,
    crossSideExtrapolationAllowed: true,
    crossSymbolExtrapolationAllowed: true,
    crossVenueExtrapolationAllowed: true,
    crossBucketExtrapolationAllowed: true,
    missingRegimeBehavior: 'NORMAL',
    observedScopeSelectionAllowed: true,
  } as unknown as PublicForwardPartialFillScopeUniverse;
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate({
    ...base,
    scopeUniverse: unsafe,
  });
  assert.ok(result.blockers.includes('CROSS_SIDE_EXTRAPOLATION_FORBIDDEN'));
  assert.ok(result.blockers.includes('CROSS_SYMBOL_EXTRAPOLATION_FORBIDDEN'));
  assert.ok(result.blockers.includes('CROSS_VENUE_EXTRAPOLATION_FORBIDDEN'));
  assert.ok(result.blockers.includes('CROSS_BUCKET_EXTRAPOLATION_FORBIDDEN'));
  assert.ok(result.blockers.includes('MISSING_REGIME_MUST_BLOCK_UNKNOWN'));
  assert.ok(result.blockers.includes('OBSERVED_SCOPE_SELECTION_FORBIDDEN'));
});

test('scope universe changes require new version, digest and prospective cohort', () => {
  const base = input();
  const unsafe = {
    ...base.scopeUniverse,
    changeRequiresNewVersion: false,
    changeRequiresNewDigest: false,
    changeRequiresNewCohort: false,
  } as unknown as PublicForwardPartialFillScopeUniverse;
  const result = buildPublicForwardPartialFillProductionPolicyManifestCandidate({ ...base, scopeUniverse: unsafe });
  assert.ok(result.blockers.includes('SCOPE_UNIVERSE_SUPERSESSION_RULE_INVALID'));
  assert.ok(result.blockers.includes('SCOPE_UNIVERSE_DIGEST_MISMATCH'));
});

test('safety contract forbids authority, economic credit, execution and threshold invention', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY, {
    candidateOnly: true,
    allComponentsFrozenRequired: true,
    prospectiveCohortRequired: true,
    defaultPolicyAllowed: false,
    defaultMinimumAllowed: false,
    productionAuthorityConnected: false,
    policyArtifactProduced: false,
    calibrationArtifactProduced: false,
    partialFillCostProduced: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
  });
});
