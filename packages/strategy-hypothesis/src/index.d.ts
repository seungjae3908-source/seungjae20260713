import type { ResearchPaperV2 } from '../../external-research/src/index.js';

export type AssetClass =
  | 'EQUITY'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES'
  | 'FUTURES'
  | 'FX'
  | 'FIXED_INCOME'
  | 'COMMODITY'
  | 'OTHER';

export type Directionality = 'POSITIVE' | 'NEGATIVE' | 'NON_DIRECTIONAL';
export type SupportingEvidenceStrength = 'INSUFFICIENT' | 'LIMITED' | 'MODERATE' | 'STRONG';
export type ContradictoryEvidenceStrength = 'NONE' | 'LIMITED' | 'MODERATE' | 'STRONG';
export type HypothesisVerdict = 'APPROVE_FOR_RESEARCH' | 'REJECT' | 'MISSING_EVIDENCE' | 'CONFLICTED';

export interface ExpectedEffectV1 {
  observable: string;
  direction: 'INCREASE' | 'DECREASE' | 'NON_ZERO' | 'DIFFERENCE';
  minimumMagnitude: number | null;
  unit: string;
  evaluationWindow: string;
}

export interface FalsificationCriteriaV1 {
  observable: string;
  metric: string;
  operator: 'LT' | 'LTE' | 'GT' | 'GTE' | 'EQ' | 'NOT_EQ';
  threshold: number;
  unit: string;
  evaluationWindow: string;
  minimumObservations: number;
  rejectionStatement: string;
}

export interface RequiredDataV1 {
  dataset: string;
  fields: readonly string[];
  frequency: string;
  provenanceRequired: true;
  licenseRequired: boolean;
}

export interface HypothesisEvidencePolicyV1 {
  requireKnownContentLicense: boolean;
  requireResolvedCorrections: true;
}

export interface StrategyHypothesisV1 {
  schemaVersion: 1;
  hypothesisId: string;
  hypothesisVersion: 1;
  title: string;
  statement: string;
  marketScope: readonly string[];
  assetClass: AssetClass;
  timeframeScope: readonly string[];
  directionality: Directionality;
  rationale: string;
  supportingPaperIds: readonly string[];
  contradictoryPaperIds: readonly string[];
  evidenceStrength: Readonly<{
    supporting: SupportingEvidenceStrength;
    contradictory: ContradictoryEvidenceStrength;
  }>;
  expectedEffect: Readonly<ExpectedEffectV1>;
  falsificationCriteria: Readonly<FalsificationCriteriaV1>;
  requiredData: readonly Readonly<RequiredDataV1>[];
  knownLimitations: readonly string[];
  /** Similarity-candidate signal only; equality is never identity or merge authority. */
  familyFingerprint: string;
  configHash: string;
  createdAt: string;
  provenance: Readonly<{
    sourceContract: 'ResearchPaperV2';
    sourceContractVersion: 2;
    generator: Readonly<{ name: string; version: string }>;
    evidencePolicy: Readonly<HypothesisEvidencePolicyV1>;
    papers: readonly Readonly<{
      paperId: string;
      metadataHash: string;
      role: 'SUPPORTING' | 'CONTRADICTORY';
    }>[];
  }>;
}

export interface StrategyHypothesisCoreV1 {
  title: string;
  statement: string;
  marketScope: readonly string[];
  assetClass: AssetClass;
  timeframeScope: readonly string[];
  directionality: Directionality;
  rationale: string;
  supportingPaperIds: readonly string[];
  contradictoryPaperIds: readonly string[];
  evidenceStrength: Readonly<{
    supporting: SupportingEvidenceStrength;
    contradictory: ContradictoryEvidenceStrength;
  }>;
  expectedEffect: ExpectedEffectV1;
  falsificationCriteria: FalsificationCriteriaV1;
  requiredData: readonly RequiredDataV1[];
  knownLimitations: readonly string[];
  createdAt: string;
  generator: Readonly<{ name: string; version: string }>;
  evidencePolicy: HypothesisEvidencePolicyV1;
}

export interface HypothesisEvidenceAssessmentV1 {
  verdict: Exclude<HypothesisVerdict, 'REJECT'>;
  reasons: readonly string[];
  validatedPaperIds: readonly string[];
}

export interface HypothesisDecisionV1 {
  schemaVersion: 1;
  decisionId: string;
  hypothesisId: string;
  hypothesisVersion: 1;
  hypothesisConfigHash: string;
  verdict: HypothesisVerdict;
  rationale: string;
  decidedAt: string;
  committee: Readonly<{ name: string; version: string; members: readonly string[] }>;
  evidenceAssessment: Readonly<HypothesisEvidenceAssessmentV1>;
  executableStrategyCreated: false;
  tradingAuthority: 'NONE';
  decisionHash: string;
}

export class StrategyHypothesisValidationError extends Error {
  readonly code: string;
}

export const STRATEGY_HYPOTHESIS_SCHEMA_VERSION: 1;
export const HYPOTHESIS_DECISION_SCHEMA_VERSION: 1;
export const HYPOTHESIS_VERDICTS: readonly HypothesisVerdict[];
export const ASSET_CLASSES: readonly AssetClass[];
export const DIRECTIONALITIES: readonly Directionality[];
export const EVIDENCE_STRENGTHS: readonly SupportingEvidenceStrength[];

export function computeHypothesisConfigHash(hypothesis: StrategyHypothesisV1): string;
export function computeFamilyFingerprint(hypothesis: StrategyHypothesisV1): string;
export function computeHypothesisDecisionHash(decision: HypothesisDecisionV1): string;
export function createStrategyHypothesisV1(core: StrategyHypothesisCoreV1, papers: readonly ResearchPaperV2[]): Readonly<StrategyHypothesisV1>;
export function assertStrategyHypothesisV1(hypothesis: unknown): asserts hypothesis is StrategyHypothesisV1;
export function verifyStrategyHypothesisV1(hypothesis: unknown): hypothesis is StrategyHypothesisV1;
export function assessHypothesisEvidence(hypothesis: StrategyHypothesisV1, papers: readonly ResearchPaperV2[]): Readonly<HypothesisEvidenceAssessmentV1>;
export function createHypothesisDecisionV1(input: {
  hypothesis: StrategyHypothesisV1;
  papers: readonly ResearchPaperV2[];
  verdict: HypothesisVerdict;
  rationale: string;
  decidedAt: string;
  committee: { name: string; version: string; members: readonly string[] };
}): Readonly<HypothesisDecisionV1>;
export function assertHypothesisDecisionV1(decision: unknown): asserts decision is HypothesisDecisionV1;
export function verifyHypothesisDecisionV1(decision: unknown): decision is HypothesisDecisionV1;
