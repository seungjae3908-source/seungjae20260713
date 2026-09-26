import preHoldoutArtifact from '../../../market-prediction-lab/docs/pre-holdout-profitability-gate-v1.json';
import type { ResearchPromotionBridgeResult } from './strategy-promotion-research-bridge.service';

export const RESEARCH_ADOPTION_REVIEW_GATE_VERSION = 'research-adoption-review-gate-v1' as const;

type UnknownRecord = Record<string, unknown>;

export type ResearchAdoptionReviewStatus =
  | 'INVALID_EVIDENCE'
  | 'RESEARCH_BRIDGE_BLOCKED'
  | 'CANDIDATE_MISMATCH'
  | 'STATISTICAL_REVIEW_BLOCKED'
  | 'ECONOMIC_EVIDENCE_BLOCKED'
  | 'FINAL_HOLDOUT_BLOCKED'
  | 'PAPER_EVIDENCE_BLOCKED'
  | 'HUMAN_REVIEW_READY';

export interface ResearchAdoptionReviewResult {
  contract: typeof RESEARCH_ADOPTION_REVIEW_GATE_VERSION;
  status: ResearchAdoptionReviewStatus;
  generatedAt: string;
  canonicalOwner: '#547';
  bridgeStatus: ResearchPromotionBridgeResult['status'];
  candidateAligned: boolean;
  evidence: {
    researchCodeSha: string | null;
    strategyId: string | null;
    parameterHash: string | null;
    statisticalEvidenceStatus: string | null;
    statisticalDecisionStatus: string | null;
    preHoldoutGateStatus: string | null;
    oosN: number | null;
    walkForwardN: number | null;
    finalHoldoutN: number | null;
    shadowN: number | null;
    paperN: number | null;
    settledN: number | null;
    allInCostComplete: boolean;
    admissionGrade: boolean;
    frozenResearchCandidate: boolean;
    finalHoldoutNotOpened: boolean;
    oneShotFinalHoldoutReady: boolean;
    unresolvedCostDimensions: string[];
  };
  blockers: readonly string[];
  automaticAdoptionAllowed: false;
  humanReviewRequired: true;
  paperHandoffAllowed: false;
  scannerMutationAllowed: false;
  liveTradingAllowed: false;
  privateTradingApiAllowed: false;
  orderAllowed: false;
  executionAuthority: 'NONE';
}

const SHA40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function emptyEvidence(): ResearchAdoptionReviewResult['evidence'] {
  return {
    researchCodeSha: null,
    strategyId: null,
    parameterHash: null,
    statisticalEvidenceStatus: null,
    statisticalDecisionStatus: null,
    preHoldoutGateStatus: null,
    oosN: null,
    walkForwardN: null,
    finalHoldoutN: null,
    shadowN: null,
    paperN: null,
    settledN: null,
    allInCostComplete: false,
    admissionGrade: false,
    frozenResearchCandidate: false,
    finalHoldoutNotOpened: false,
    oneShotFinalHoldoutReady: false,
    unresolvedCostDimensions: [],
  };
}

function base(
  status: ResearchAdoptionReviewStatus,
  bridgeStatus: ResearchPromotionBridgeResult['status'],
  blockers: string[],
  evidence: ResearchAdoptionReviewResult['evidence'] = emptyEvidence(),
  candidateAligned = false,
  generatedAt = new Date().toISOString(),
): ResearchAdoptionReviewResult {
  return Object.freeze({
    contract: RESEARCH_ADOPTION_REVIEW_GATE_VERSION,
    status,
    generatedAt,
    canonicalOwner: '#547',
    bridgeStatus,
    candidateAligned,
    evidence: Object.freeze({ ...evidence, unresolvedCostDimensions: Object.freeze([...evidence.unresolvedCostDimensions]) as unknown as string[] }),
    blockers: Object.freeze([...new Set(blockers)]),
    automaticAdoptionAllowed: false,
    humanReviewRequired: true,
    paperHandoffAllowed: false,
    scannerMutationAllowed: false,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    orderAllowed: false,
    executionAuthority: 'NONE',
  });
}

function validateArtifact(value: unknown): {
  valid: boolean;
  evidence: ResearchAdoptionReviewResult['evidence'];
  blockers: string[];
} {
  const root = record(value);
  const sample = record(root?.sampleAccounting);
  const costs = record(root?.costEvidence);
  const statistical = record(root?.statisticalEvidence);
  const statisticalDecision = record(statistical?.decision);
  const policy = record(root?.policyEvaluation);
  const identity = record(root?.candidateIdentityPreview);
  const holdout = record(root?.finalHoldoutProtection);
  const safety = record(root?.safety);

  const evidence = emptyEvidence();
  const blockers: string[] = [];

  if (!root
    || root.schemaVersion !== 1
    || root.phase !== 'PRE_HOLDOUT_PROFITABILITY_GATE'
    || !sample || !costs || !statistical || !policy || !identity || !holdout || !safety) {
    return { valid: false, evidence, blockers: ['PRE_HOLDOUT_ARTIFACT_SHAPE_INVALID'] };
  }

  const researchCodeSha = text(root.researchCodeSha);
  const strategyId = text(identity.strategyId);
  const parameterHash = text(identity.parameterHash);
  const statStatus = text(statistical.status);
  const statDecisionStatus = text(statisticalDecision?.status);
  const gateStatus = text(policy.status);

  evidence.researchCodeSha = researchCodeSha;
  evidence.strategyId = strategyId;
  evidence.parameterHash = parameterHash;
  evidence.statisticalEvidenceStatus = statStatus;
  evidence.statisticalDecisionStatus = statDecisionStatus;
  evidence.preHoldoutGateStatus = gateStatus;
  evidence.oosN = count(sample.ourOosN);
  evidence.walkForwardN = count(sample.ourWalkForwardN);
  evidence.finalHoldoutN = count(sample.ourHoldoutN);
  evidence.shadowN = count(sample.ourShadowN);
  evidence.paperN = count(sample.ourPaperN);
  evidence.settledN = count(sample.ourSettledN);
  evidence.allInCostComplete = costs.allInCostComplete === true;
  evidence.admissionGrade = costs.admissionGrade === true;
  evidence.frozenResearchCandidate = root.frozenResearchCandidate === true;
  evidence.finalHoldoutNotOpened = holdout.finalHoldoutNotOpened === true;
  evidence.oneShotFinalHoldoutReady = holdout.oneShotFinalHoldoutReady === true;
  evidence.unresolvedCostDimensions = stringArray(costs.unresolvedAllInDimensions);

  if (!researchCodeSha || !SHA40.test(researchCodeSha)) blockers.push('PRE_HOLDOUT_RESEARCH_SHA_INVALID');
  if (!strategyId || !SAFE_ID.test(strategyId)) blockers.push('PRE_HOLDOUT_STRATEGY_ID_INVALID');
  if (!parameterHash || !HASH64.test(parameterHash)) blockers.push('PRE_HOLDOUT_PARAMETER_HASH_INVALID');

  if (safety.profitabilityProven !== false
    || safety.liveTrading !== false
    || safety.autoTrading !== false
    || safety.realOrderEnabled !== false
    || safety.privateTradingApiAllowed !== false
    || safety.scannerEligibility !== false
    || safety.shadowActivation !== false
    || safety.paperActivation !== false
    || safety.executionAuthority !== 'NONE'
    || safety.actualOrders !== 0
    || safety.actualCancels !== 0
    || safety.actualAmends !== 0
    || safety.actualTransfers !== 0
    || safety.actualWithdrawals !== 0) {
    blockers.push('PRE_HOLDOUT_SAFETY_INVALID');
  }

  if (holdout.numericHoldoutValuesParsed !== 0
    || holdout.holdoutUsedForSelection !== false
    || holdout.holdoutUsedForTuning !== false
    || holdout.holdoutUsedForCalibration !== false) {
    blockers.push('FINAL_HOLDOUT_FIREWALL_INVALID');
  }

  if (sample.observationCountsAreNeverStudyCounts !== true) {
    blockers.push('SAMPLE_ACCOUNTING_CONTRACT_INVALID');
  }

  return { valid: blockers.length === 0, evidence, blockers };
}

function exactCandidateMatch(
  bridge: ResearchPromotionBridgeResult,
  evidence: ResearchAdoptionReviewResult['evidence'],
): boolean {
  const candidate = bridge.candidate;
  if (!candidate || !evidence.strategyId || !evidence.parameterHash || !evidence.researchCodeSha) return false;
  return candidate.strategyId === evidence.strategyId
    && candidate.parameterHash === evidence.parameterHash
    && candidate.researchCodeSha === evidence.researchCodeSha;
}

export function buildResearchAdoptionReview(
  bridge: ResearchPromotionBridgeResult,
  artifact: unknown = preHoldoutArtifact,
  generatedAt = new Date().toISOString(),
): ResearchAdoptionReviewResult {
  const parsed = validateArtifact(artifact);
  if (!parsed.valid) {
    return base('INVALID_EVIDENCE', bridge.status, parsed.blockers, parsed.evidence, false, generatedAt);
  }

  if (['UNAVAILABLE', 'NO_CANDIDATE', 'INVALID'].includes(bridge.status)) {
    return base(
      'RESEARCH_BRIDGE_BLOCKED',
      bridge.status,
      ['RESEARCH_BRIDGE_NOT_REVIEWABLE', ...bridge.blockers],
      parsed.evidence,
      false,
      generatedAt,
    );
  }

  const aligned = exactCandidateMatch(bridge, parsed.evidence);
  if (!aligned) {
    return base(
      'CANDIDATE_MISMATCH',
      bridge.status,
      ['GLOBAL_FIREWALL_CANDIDATE_MISMATCH', 'CROSS_CANDIDATE_EVIDENCE_TRANSFER_FORBIDDEN'],
      parsed.evidence,
      false,
      generatedAt,
    );
  }

  const blockers: string[] = [];

  if (parsed.evidence.statisticalEvidenceStatus !== 'EVIDENCE_READY'
    || parsed.evidence.statisticalDecisionStatus !== 'STATISTICAL_REVIEW_READY'
    || parsed.evidence.preHoldoutGateStatus !== 'PRE_HOLDOUT_GATE_PASSED') {
    blockers.push('STATISTICAL_REVIEW_NOT_CLEARED');
  }
  if (!parsed.evidence.allInCostComplete || !parsed.evidence.admissionGrade) {
    blockers.push('ALL_IN_COST_NOT_ADMISSION_GRADE');
  }
  if (!bridge.evidence.validationComplete || !bridge.evidence.oosComplete || !bridge.evidence.fullCostReady) {
    blockers.push('BRIDGE_VALIDATION_OOS_FULL_COST_INCOMPLETE');
  }
  if (!parsed.evidence.frozenResearchCandidate
    || !parsed.evidence.oneShotFinalHoldoutReady
    || parsed.evidence.finalHoldoutN === 0
    || parsed.evidence.finalHoldoutNotOpened) {
    blockers.push('FINAL_HOLDOUT_NOT_CLEARED');
  }
  if ((parsed.evidence.shadowN ?? 0) <= 0
    || (parsed.evidence.paperN ?? 0) <= 0
    || (parsed.evidence.settledN ?? 0) <= 0
    || (bridge.evidence.settlementN ?? 0) <= 0) {
    blockers.push('PAPER_SHADOW_SETTLEMENT_EVIDENCE_MISSING');
  }

  if (blockers.includes('STATISTICAL_REVIEW_NOT_CLEARED')) {
    return base('STATISTICAL_REVIEW_BLOCKED', bridge.status, blockers, parsed.evidence, true, generatedAt);
  }
  if (blockers.includes('ALL_IN_COST_NOT_ADMISSION_GRADE')
    || blockers.includes('BRIDGE_VALIDATION_OOS_FULL_COST_INCOMPLETE')) {
    return base('ECONOMIC_EVIDENCE_BLOCKED', bridge.status, blockers, parsed.evidence, true, generatedAt);
  }
  if (blockers.includes('FINAL_HOLDOUT_NOT_CLEARED')) {
    return base('FINAL_HOLDOUT_BLOCKED', bridge.status, blockers, parsed.evidence, true, generatedAt);
  }
  if (blockers.includes('PAPER_SHADOW_SETTLEMENT_EVIDENCE_MISSING')) {
    return base('PAPER_EVIDENCE_BLOCKED', bridge.status, blockers, parsed.evidence, true, generatedAt);
  }

  return base(
    'HUMAN_REVIEW_READY',
    bridge.status,
    ['SEPARATE_HUMAN_ADOPTION_REVIEW_REQUIRED'],
    parsed.evidence,
    true,
    generatedAt,
  );
}
