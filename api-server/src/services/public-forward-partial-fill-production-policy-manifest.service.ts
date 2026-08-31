import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import type { PublicForwardPartialFillSplitPolicy } from './public-forward-partial-fill-calibration-split-audit.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_VERSION =
  'public-forward-partial-fill-production-policy-manifest-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY = Object.freeze({
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
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

export const PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS = Object.freeze([
  'businessTolerance',
  'statisticalPolicy',
  'scopeUniverse',
  'instrumentManifest',
  'bucketPolicy',
  'regimePolicy',
  'independenceMethodology',
  'numericMinimumArtifact',
] as const);

export type PublicForwardPartialFillPolicyComponentKey =
  typeof PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS[number];

export type PublicForwardPartialFillFrozenComponentRef = Readonly<{
  identity: string;
  version: string;
  digest: string;
  frozenAtMs: number;
  status: 'FROZEN';
}>;

export type PublicForwardPartialFillPolicyComponents = Readonly<
  Record<PublicForwardPartialFillPolicyComponentKey, PublicForwardPartialFillFrozenComponentRef>
>;

export type PublicForwardPartialFillScopeUniverseEntry = Readonly<{
  market: 'CRYPTO_FUTURES';
  sourceIdentity: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
}>;

export type PublicForwardPartialFillScopeUniverse = Readonly<{
  identity: string;
  version: string;
  frozenAtMs: number;
  effectiveCohortStartMs: number;
  entries: readonly PublicForwardPartialFillScopeUniverseEntry[];
  crossSideExtrapolationAllowed: false;
  crossSymbolExtrapolationAllowed: false;
  crossVenueExtrapolationAllowed: false;
  crossBucketExtrapolationAllowed: false;
  missingRegimeBehavior: 'BLOCKED_UNKNOWN';
  observedScopeSelectionAllowed: false;
  changeRequiresNewVersion: true;
  changeRequiresNewDigest: true;
  changeRequiresNewCohort: true;
  digest: string;
}>;

type PublicForwardPartialFillManifestScopeMinimum =
  PublicForwardPartialFillSplitPolicy['scopeMinimums'][number] & Readonly<{ sourceIdentity: string }>;

export type PublicForwardPartialFillManifestSplitPolicy = Omit<
  PublicForwardPartialFillSplitPolicy,
  'scopeMinimums'
> & Readonly<{ scopeMinimums: readonly PublicForwardPartialFillManifestScopeMinimum[] }>;

export type PublicForwardPartialFillProductionPolicyManifest = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_VERSION;
  kind: 'IMMUTABLE_PROSPECTIVE_PARTIAL_FILL_POLICY_CANDIDATE';
  policyIdentity: string;
  policyVersion: string;
  policyFrozenAtMs: number;
  effectiveCohortStartMs: number;
  authorityOwnerIdentity: string;
  approvalReceiptIdentity: string;
  approvalReceiptDigest: string;
  datasetSchemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION;
  datasetStoreContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  collectorCodeSha: string;
  components: PublicForwardPartialFillPolicyComponents;
  scopeUniverse: PublicForwardPartialFillScopeUniverse;
  regimeOwnerIdentity: string;
  splitPolicy: PublicForwardPartialFillManifestSplitPolicy;
  consumerIdentities: readonly string[];
  candidateStatus: 'CANDIDATE_COMPONENTS_VALIDATED';
  productionAuthorityConnected: false;
  policyArtifactProduced: false;
  calibrationArtifactProduced: false;
  partialFillCostProduced: false;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  fullCostReady: false;
  evidenceComplete: 0;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  orderSubmissionAllowed: false;
  manifestDigest: string;
}>;

export type PublicForwardPartialFillProductionPolicyManifestInput = Omit<
  PublicForwardPartialFillProductionPolicyManifest,
  | 'schemaVersion'
  | 'kind'
  | 'candidateStatus'
  | 'productionAuthorityConnected'
  | 'policyArtifactProduced'
  | 'calibrationArtifactProduced'
  | 'partialFillCostProduced'
  | 'naturalEntryCredit'
  | 'runtimeCostCredit'
  | 'fullCostReady'
  | 'evidenceComplete'
  | 'executionAuthority'
  | 'privateApiAllowed'
  | 'liveTrading'
  | 'orderSubmissionAllowed'
  | 'manifestDigest'
>;

export type PublicForwardPartialFillProductionPolicyManifestResult = Readonly<{
  status: 'PRESENT' | 'BLOCKED_POLICY';
  blockers: readonly string[];
  manifest: PublicForwardPartialFillProductionPolicyManifest | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function immutableCanonicalClone<T>(value: T): T {
  const cloned = JSON.parse(JSON.stringify(canonicalize(value))) as T;
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned;
}

export function computePublicForwardPartialFillProductionPolicyManifestDigest(
  value: Omit<PublicForwardPartialFillProductionPolicyManifest, 'manifestDigest'>
    | PublicForwardPartialFillProductionPolicyManifest,
): string {
  const body = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'manifestDigest'),
  );
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function nonEmpty(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 240;
}

function exactDigest(value: unknown): boolean {
  return SHA256.test(String(value ?? '').trim().toLowerCase());
}

export function computePublicForwardPartialFillScopeUniverseDigest(
  value: Omit<PublicForwardPartialFillScopeUniverse, 'digest'> | PublicForwardPartialFillScopeUniverse,
): string {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'));
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function finitePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveMinimums(value: PublicForwardPartialFillSplitPolicy['overallMinimums']): boolean {
  return finitePositiveInteger(value.train)
    && finitePositiveInteger(value.validation)
    && finitePositiveInteger(value.oos);
}

function blocked(...codes: string[]): PublicForwardPartialFillProductionPolicyManifestResult {
  return Object.freeze({
    status: 'BLOCKED_POLICY',
    blockers: Object.freeze([...new Set(codes)]),
    manifest: null,
  });
}

function validateComponents(
  components: PublicForwardPartialFillPolicyComponents,
  policyFrozenAtMs: number,
): string[] {
  const blockers: string[] = [];
  const candidate = components as unknown as Record<string, PublicForwardPartialFillFrozenComponentRef | undefined>;
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS) {
    const component = candidate[key];
    if (!component) {
      blockers.push(`POLICY_COMPONENT_MISSING:${key}`);
      continue;
    }
    if (component.status !== 'FROZEN') blockers.push(`POLICY_COMPONENT_NOT_FROZEN:${key}`);
    if (!nonEmpty(component.identity)) blockers.push(`POLICY_COMPONENT_IDENTITY_INVALID:${key}`);
    if (!nonEmpty(component.version)) blockers.push(`POLICY_COMPONENT_VERSION_INVALID:${key}`);
    if (!exactDigest(component.digest)) blockers.push(`POLICY_COMPONENT_DIGEST_INVALID:${key}`);
    if (!finitePositiveInteger(component.frozenAtMs)) blockers.push(`POLICY_COMPONENT_FROZEN_AT_INVALID:${key}`);
    if (finitePositiveInteger(component.frozenAtMs) && component.frozenAtMs > policyFrozenAtMs) {
      blockers.push(`POLICY_COMPONENT_FROZEN_AFTER_ROOT:${key}`);
    }
  }
  const unknown = Object.keys(candidate).filter(
    (key) => !PUBLIC_FORWARD_PARTIAL_FILL_POLICY_COMPONENT_KEYS.includes(key as PublicForwardPartialFillPolicyComponentKey),
  );
  if (unknown.length > 0) blockers.push('UNKNOWN_POLICY_COMPONENT');
  return blockers;
}

function validateSplitPolicy(
  policy: PublicForwardPartialFillManifestSplitPolicy,
  input: PublicForwardPartialFillProductionPolicyManifestInput,
): string[] {
  const blockers: string[] = [];
  if (policy.policyIdentity !== input.policyIdentity) blockers.push('SPLIT_POLICY_IDENTITY_MISMATCH');
  if (policy.policyVersion !== input.policyVersion) blockers.push('SPLIT_POLICY_VERSION_MISMATCH');
  if (policy.policyFrozenAtMs !== input.policyFrozenAtMs) blockers.push('SPLIT_POLICY_FROZEN_AT_MISMATCH');
  if (policy.expectedRegimeOwnerIdentity !== input.regimeOwnerIdentity) {
    blockers.push('REGIME_OWNER_IDENTITY_MISMATCH');
  }
  if (policy.expectedRegimePolicyIdentity !== input.components.regimePolicy.identity) {
    blockers.push('REGIME_POLICY_IDENTITY_MISMATCH');
  }
  if (policy.expectedRegimePolicyDigest !== input.components.regimePolicy.digest) {
    blockers.push('REGIME_POLICY_DIGEST_MISMATCH');
  }
  if (!finitePositiveInteger(policy.maxRegimeEvidenceAgeMs)) blockers.push('REGIME_MAX_AGE_INVALID');
  const windows = [policy.windows.train, policy.windows.validation, policy.windows.oos];
  if (windows.some((window) => !finitePositiveInteger(window.startInclusiveMs)
    || !finitePositiveInteger(window.endExclusiveMs)
    || window.startInclusiveMs >= window.endExclusiveMs)) {
    blockers.push('SPLIT_WINDOW_INVALID');
  } else if (policy.windows.train.endExclusiveMs > policy.windows.validation.startInclusiveMs
    || policy.windows.validation.endExclusiveMs > policy.windows.oos.startInclusiveMs) {
    blockers.push('SPLIT_WINDOWS_OVERLAP');
  }
  if (policy.policyFrozenAtMs >= policy.windows.train.startInclusiveMs) {
    blockers.push('POLICY_NOT_FROZEN_BEFORE_COHORT');
  }
  if (!positiveMinimums(policy.overallMinimums)) blockers.push('OVERALL_MINIMUMS_INVALID');
  if (!Array.isArray(policy.scopeMinimums) || policy.scopeMinimums.length === 0) {
    blockers.push('SCOPE_MINIMUMS_REQUIRED');
  } else {
    const scopeKeys = new Set<string>();
    for (const scope of policy.scopeMinimums) {
      const key = [
        scope.market,
        scope.sourceIdentity,
        scope.symbol,
        scope.side,
        scope.quantityNotionalBucketIdentity,
        scope.volatilityRegimeIdentity,
        scope.liquidityRegimeIdentity,
      ].join('\u0000');
      if (scopeKeys.has(key)) blockers.push('DUPLICATE_SCOPE_MINIMUM');
      scopeKeys.add(key);
      if (scope.market !== 'CRYPTO_FUTURES'
        || !nonEmpty(scope.sourceIdentity)
        || !nonEmpty(scope.symbol)
        || !['LONG', 'SHORT'].includes(scope.side)
        || !nonEmpty(scope.quantityNotionalBucketIdentity)
        || !nonEmpty(scope.volatilityRegimeIdentity)
        || !nonEmpty(scope.liquidityRegimeIdentity)) blockers.push('SCOPE_IDENTITY_INVALID');
      if (!positiveMinimums(scope.minimums)) blockers.push('SCOPE_MINIMUMS_INVALID');
    }
  }
  return blockers;
}

function scopeKey(scope: PublicForwardPartialFillScopeUniverseEntry): string {
  return [scope.market, scope.sourceIdentity, scope.symbol, scope.side,
    scope.quantityNotionalBucketIdentity, scope.volatilityRegimeIdentity,
    scope.liquidityRegimeIdentity].join('\u0000');
}

function validateScopeUniverse(
  universe: PublicForwardPartialFillScopeUniverse,
  input: PublicForwardPartialFillProductionPolicyManifestInput,
): string[] {
  const blockers: string[] = [];
  const component = input.components.scopeUniverse;
  if (!universe || typeof universe !== 'object') return ['SCOPE_UNIVERSE_REQUIRED'];
  if (!component) return ['POLICY_COMPONENT_MISSING:scopeUniverse'];
  if (universe.identity !== component.identity) blockers.push('SCOPE_UNIVERSE_IDENTITY_MISMATCH');
  if (universe.version !== component.version) blockers.push('SCOPE_UNIVERSE_VERSION_MISMATCH');
  if (universe.frozenAtMs !== component.frozenAtMs) blockers.push('SCOPE_UNIVERSE_FROZEN_AT_MISMATCH');
  if (universe.effectiveCohortStartMs !== input.effectiveCohortStartMs) {
    blockers.push('SCOPE_UNIVERSE_COHORT_MISMATCH');
  }
  if (!exactDigest(universe.digest)
    || universe.digest !== computePublicForwardPartialFillScopeUniverseDigest(universe)
    || universe.digest !== component.digest) blockers.push('SCOPE_UNIVERSE_DIGEST_MISMATCH');
  if (universe.crossSideExtrapolationAllowed !== false) blockers.push('CROSS_SIDE_EXTRAPOLATION_FORBIDDEN');
  if (universe.crossSymbolExtrapolationAllowed !== false) blockers.push('CROSS_SYMBOL_EXTRAPOLATION_FORBIDDEN');
  if (universe.crossVenueExtrapolationAllowed !== false) blockers.push('CROSS_VENUE_EXTRAPOLATION_FORBIDDEN');
  if (universe.crossBucketExtrapolationAllowed !== false) blockers.push('CROSS_BUCKET_EXTRAPOLATION_FORBIDDEN');
  if (universe.missingRegimeBehavior !== 'BLOCKED_UNKNOWN') blockers.push('MISSING_REGIME_MUST_BLOCK_UNKNOWN');
  if (universe.observedScopeSelectionAllowed !== false) blockers.push('OBSERVED_SCOPE_SELECTION_FORBIDDEN');
  if (universe.changeRequiresNewVersion !== true
    || universe.changeRequiresNewDigest !== true
    || universe.changeRequiresNewCohort !== true) blockers.push('SCOPE_UNIVERSE_SUPERSESSION_RULE_INVALID');
  if (!Array.isArray(universe.entries) || universe.entries.length === 0) {
    blockers.push('SCOPE_UNIVERSE_ENTRIES_REQUIRED');
    return blockers;
  }
  const universeKeys = new Set<string>();
  for (const entry of universe.entries) {
    if (entry.market !== 'CRYPTO_FUTURES' || !nonEmpty(entry.sourceIdentity)
      || !nonEmpty(entry.symbol) || !['LONG', 'SHORT'].includes(entry.side)
      || !nonEmpty(entry.quantityNotionalBucketIdentity)
      || !nonEmpty(entry.volatilityRegimeIdentity) || !nonEmpty(entry.liquidityRegimeIdentity)) {
      blockers.push('SCOPE_UNIVERSE_ENTRY_INVALID');
    }
    const key = scopeKey(entry);
    if (universeKeys.has(key)) blockers.push('DUPLICATE_SCOPE_UNIVERSE_ENTRY');
    universeKeys.add(key);
  }
  const splitKeys = new Set(input.splitPolicy.scopeMinimums.map(scopeKey));
  if (universeKeys.size !== splitKeys.size
    || [...universeKeys].some((key) => !splitKeys.has(key))) blockers.push('SPLIT_SCOPE_UNIVERSE_MISMATCH');
  return blockers;
}

export function buildPublicForwardPartialFillProductionPolicyManifestCandidate(
  input: PublicForwardPartialFillProductionPolicyManifestInput,
): PublicForwardPartialFillProductionPolicyManifestResult {
  const blockers: string[] = [];
  if (!nonEmpty(input.policyIdentity)) blockers.push('POLICY_IDENTITY_INVALID');
  if (!nonEmpty(input.policyVersion)) blockers.push('POLICY_VERSION_INVALID');
  if (!finitePositiveInteger(input.policyFrozenAtMs)) blockers.push('POLICY_FROZEN_AT_INVALID');
  if (!finitePositiveInteger(input.effectiveCohortStartMs)
    || input.effectiveCohortStartMs <= input.policyFrozenAtMs) blockers.push('EFFECTIVE_COHORT_NOT_PROSPECTIVE');
  if (!nonEmpty(input.authorityOwnerIdentity)) blockers.push('AUTHORITY_OWNER_IDENTITY_INVALID');
  if (!nonEmpty(input.approvalReceiptIdentity)) blockers.push('APPROVAL_RECEIPT_IDENTITY_INVALID');
  if (!exactDigest(input.approvalReceiptDigest)) blockers.push('APPROVAL_RECEIPT_DIGEST_INVALID');
  if (input.datasetSchemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION) {
    blockers.push('DATASET_SCHEMA_VERSION_MISMATCH');
  }
  if (input.datasetStoreContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    blockers.push('DATASET_STORE_CONTRACT_MISMATCH');
  }
  if (!COMMIT_SHA.test(String(input.collectorCodeSha ?? '').trim().toLowerCase())) blockers.push('COLLECTOR_CODE_SHA_INVALID');
  if (!nonEmpty(input.regimeOwnerIdentity)) blockers.push('REGIME_OWNER_IDENTITY_INVALID');
  blockers.push(...validateComponents(input.components, input.policyFrozenAtMs));
  blockers.push(...validateScopeUniverse(input.scopeUniverse, input));
  blockers.push(...validateSplitPolicy(input.splitPolicy, input));
  if (!Array.isArray(input.consumerIdentities) || input.consumerIdentities.length === 0) {
    blockers.push('CONSUMER_IDENTITIES_REQUIRED');
  } else {
    if (input.consumerIdentities.some((identity) => !nonEmpty(identity))) blockers.push('CONSUMER_IDENTITY_INVALID');
    if (new Set(input.consumerIdentities).size !== input.consumerIdentities.length) blockers.push('DUPLICATE_CONSUMER_IDENTITY');
  }
  if (blockers.length > 0) return blocked(...blockers);

  const body = immutableCanonicalClone({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_VERSION,
    kind: 'IMMUTABLE_PROSPECTIVE_PARTIAL_FILL_POLICY_CANDIDATE' as const,
    ...input,
    components: input.components,
    consumerIdentities: input.consumerIdentities,
    candidateStatus: 'CANDIDATE_COMPONENTS_VALIDATED' as const,
    productionAuthorityConnected: false as const,
    policyArtifactProduced: false as const,
    calibrationArtifactProduced: false as const,
    partialFillCostProduced: false as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    executionAuthority: 'NONE' as const,
    privateApiAllowed: false as const,
    liveTrading: false as const,
    orderSubmissionAllowed: false as const,
  });
  const manifest = immutableCanonicalClone({
    ...body,
    manifestDigest: computePublicForwardPartialFillProductionPolicyManifestDigest(body),
  });
  return Object.freeze({ status: 'PRESENT' as const, blockers: Object.freeze([]), manifest });
}
