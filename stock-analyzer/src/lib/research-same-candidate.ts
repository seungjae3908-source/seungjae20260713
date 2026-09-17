import type { ResearchBundleResolution } from '../../../api-server/src/services/research-bundle.contract';
import type { ResearchSameCandidatePrewireResult } from '../../../api-server/src/services/research-same-candidate-prewire.service';

const STAGES = ['FORWARD', 'SHADOW', 'PAPER', 'SETTLEMENT'] as const;
const row = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reasons = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 1000);

// Validate a read-only server comparison, not caller-supplied runtime stages or economic evidence.
export function validResearchSameCandidate(value: unknown, bundle: ResearchBundleResolution): value is ResearchSameCandidatePrewireResult {
  const result = row(value);
  if (result.schemaVersion !== 'research-same-candidate-prewire-v1' || result.evidenceCredit !== 0
    || result.profitabilityProven !== false || result.champion !== null || result.executionAuthority !== 'NONE'
    || result.liveTrading !== false || result.privateTradingApiAllowed !== false || result.orderSubmitted !== false
    || result.productionMutationAllowed !== false || !reasons(result.blockers)) return false;
  if (!['BLOCKED_DATA', 'IDENTITY_MISMATCH', 'PREWIRED_WAITING_EVIDENCE', 'PREWIRED_IDENTITY_MATCHED'].includes(String(result.status))) return false;
  const stages = row(result.stages);
  if (Object.keys(stages).length !== STAGES.length || !STAGES.every(stage => {
    const item = row(stages[stage]);
    return item.stage === stage && ['MISSING_EVIDENCE', 'IDENTITY_MATCHED', 'IDENTITY_MISMATCH', 'BLOCKED_DATA'].includes(String(item.status))
      && typeof item.matched === 'boolean' && item.matched === (item.status === 'IDENTITY_MATCHED') && reasons(item.blockers);
  })) return false;
  const allMatched = STAGES.every(stage => row(stages[stage]).matched === true);
  if (result.allIdentityStagesMatched !== allMatched) return false;
  if (result.identityAnchor === null) return result.identityAnchorDigest === null && result.status === 'BLOCKED_DATA' && !allMatched;
  if (bundle.publicationStatus !== 'READBACK_VERIFIED' || !bundle.backtestCompleted || !bundle.receipt
    || typeof result.identityAnchorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(result.identityAnchorDigest)) return false;
  const anchor = row(result.identityAnchor);
  const receipt = bundle.receipt;
  const expected = {
    identityAnchorSchemaVersion: 'research-same-candidate-identity-anchor-v1', researchBundleDigest: bundle.bundleDigest,
    resultArtifactDigest: bundle.resultArtifactDigest, strategyIdentityDigest: bundle.strategyIdentityDigest,
    modelIdentityDigest: bundle.modelIdentityDigest, featureOrderDigest: bundle.featureOrderDigest,
    datasetIdentity: receipt.datasetIdentity, datasetDigest: receipt.datasetDigest, preprocessingVersion: receipt.preprocessingVersion,
    riskPolicyId: receipt.riskPolicyId, riskPolicyVersion: receipt.riskPolicyVersion, costPolicyIdentity: receipt.costPolicyIdentity,
    researchCodeSha: receipt.researchCodeSha,
  };
  if (!Object.entries(expected).every(([key, item]) => typeof item === 'string' && anchor[key] === item)) return false;
  const status = STAGES.some(stage => row(stages[stage]).status === 'BLOCKED_DATA') ? 'BLOCKED_DATA'
    : STAGES.some(stage => row(stages[stage]).status === 'IDENTITY_MISMATCH') ? 'IDENTITY_MISMATCH'
      : allMatched ? 'PREWIRED_IDENTITY_MATCHED' : 'PREWIRED_WAITING_EVIDENCE';
  return result.status === status;
}
