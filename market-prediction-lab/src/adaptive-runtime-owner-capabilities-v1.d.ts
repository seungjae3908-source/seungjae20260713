export const ADAPTIVE_RUNTIME_OWNER_CAPABILITIES_CONTRACT_V1:
  'adaptive-runtime-owner-capabilities/v1';

export const CANONICAL_BUNDLE_OFFLINE_PUBLICATION_RECEIPT_CONTRACT_V1:
  'research-canonical-bundle-offline-publication-receipt/v1';

export interface RawCanonicalBundlePublicationV1 {
  schemaVersion: 'research-canonical-bundle-publication-v1';
  dslDigest: string;
  bundleDigest: string;
  publicationStatus: 'READBACK_VERIFIED';
  evidenceCredit: 0;
  profitabilityProven: false;
  executionAuthority: 'NONE';
}

export interface CanonicalBundleOfflinePublicationReceiptV1 {
  schemaVersion: 1;
  contract: typeof CANONICAL_BUNDLE_OFFLINE_PUBLICATION_RECEIPT_CONTRACT_V1;
  researchCodeSha: string;
  publishedAt: string;
  publisherMode: 'OFFLINE_OWNER_CONTROLLED';
  catalogReadbackVerified: true;
  dslDigest: string;
  bundleDigest: string;
  publicationStatus: 'READBACK_VERIFIED';
  evidenceCredit: 0;
  profitabilityProven: false;
  executionAuthority: 'NONE';
  receiptDigest: string;
}

export interface AdaptiveRuntimeOwnerBindingV1 {
  status: 'AVAILABLE' | 'MISSING';
  ownerRefs: readonly string[] | null;
  capability: string | null;
  sourceSha: string | null;
  evidenceId: string | null;
  properties: Readonly<Record<string, unknown>> | null;
  reason: string | null;
}

export interface AdaptiveRuntimeOwnerCapabilitiesV1 {
  schemaVersion: 1;
  contract: typeof ADAPTIVE_RUNTIME_OWNER_CAPABILITIES_CONTRACT_V1;
  sourceSha: string;
  bindings: Readonly<Record<string, AdaptiveRuntimeOwnerBindingV1>>;
  availableKeys: readonly string[];
  missingKeys: readonly string[];
  allBindingsAvailable: boolean;
  safety: Readonly<{
    capabilityEvidenceOnly: true;
    runtimeExecutionAttempted: false;
    runtimeActivationAllowed: false;
    scheduleMutationAllowed: false;
    deploymentAllowed: false;
    finalHoldoutAccessAllowed: false;
    liveTradingAllowed: false;
    executionAuthority: 'NONE';
  }>;
}

export function createCanonicalBundleOfflinePublicationReceiptV1(input?: {
  researchCodeSha?: string;
  publication?: RawCanonicalBundlePublicationV1 | null;
  publishedAt?: string;
}): CanonicalBundleOfflinePublicationReceiptV1;

export function validateCanonicalBundlePublicationV1(
  value: unknown,
  expectedSourceSha?: string | null,
): value is CanonicalBundleOfflinePublicationReceiptV1;

export function buildAdaptiveRuntimeOwnerBindingsV1(input?: {
  sourceSha?: string;
  bundlePublication?: CanonicalBundleOfflinePublicationReceiptV1 | null;
}): AdaptiveRuntimeOwnerCapabilitiesV1;
