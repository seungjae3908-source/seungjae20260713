/** Public projection. Raw policies, sizing/account inputs and holdout outcomes stay server-side. */
export interface ResearchBundleResolution {
  schemaVersion: 'research-bundle-resolution-v1';
  dslValid: boolean;
  dslDigest: string | null;
  bundleDigest: string | null;
  strategyIdentityDigest: string | null;
  modelIdentityDigest: string | null;
  featureOrderDigest: string | null;
  preprocessingVersion: string | null;
  researchBundleReady: boolean;
  backtestExecutable: boolean;
  backtestSubmitted: boolean;
  backtestCompleted: boolean;
  backtestStatus: 'NOT_SUBMITTED' | 'BLOCKED_DATA' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  backtesterCalls: number;
  resultArtifactDigest: string | null;
  publicationStatus: 'MISSING_EVIDENCE' | 'BLOCKED_DATA' | 'READBACK_VERIFIED';
  components: Array<{ key: string; status: 'READY' | 'MISSING_EVIDENCE' | 'BLOCKED_DATA'; blockers: string[] }>;
  blockers: string[];
  wfStatus: 'NOT_EVALUATED' | 'MISSING_EVIDENCE' | 'PASS' | 'FAIL';
  oosStatus: 'NOT_EVALUATED' | 'MISSING_EVIDENCE' | 'PASS' | 'FAIL';
  holdoutStatus: 'LOCKED' | 'NOT_EVALUATED' | 'PASS' | 'FAIL';
  wfEvidencePresent: false;
  oosEvidencePresent: false;
  holdoutEvidencePresent: false;
  statisticalFirewallPass: false;
  statisticalFirewallStatus: 'MISSING_EVIDENCE';
  promotionEligible: false;
  profitabilityProven: false;
  champion: null;
  evidenceCredit: 0;
  executionAuthority: 'NONE';
  receipt: {
    requestDigest: string;
    strategyIdentity: Record<string, unknown>;
    strategyIdentityDigest: string;
    modelIdentityDigest: string;
    featureOrderDigest: string;
    preprocessingVersion: string;
    dslDigest: string;
    bundleDigest: string;
    datasetIdentity: string;
    datasetDigest: string;
    splitReceiptDigest: string;
    riskPolicyId: string;
    riskPolicyVersion: string;
    costPolicyIdentity: string;
    researchCodeSha: string;
    submittedAt: number;
  } | null;
}
/** Implementations must atomically reserve and durably retain keys across restarts.
 * Failed/unknown completions must never release reservations for automatic replay. */
export interface ResearchSubmissionStore {
  reserve(key: string, receipt: ResearchBundleResolution): Promise<{ acquired: boolean; receipt: ResearchBundleResolution }>;
  /** Retain the unmodified #690 result with its receipt atomically. Never rebuild metrics. */
  complete(key: string, receipt: ResearchBundleResolution, artifact?: Record<string, unknown>): Promise<void>;
  /** Durable owner read, independent of an in-process response/cache. */
  read?(key: string): Promise<{ receipt: ResearchBundleResolution; artifact: unknown } | null>;
}
