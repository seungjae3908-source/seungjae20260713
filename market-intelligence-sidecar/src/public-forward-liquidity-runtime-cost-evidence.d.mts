export type PublicForwardLiquidityRuntimePercentCostEvidence = Readonly<{
  valuePercent: number;
  quality: 'OBSERVED' | 'DOCUMENTED' | 'ESTIMATED' | 'NOT_APPLICABLE';
  source: string;
  observedAtMs: number;
}>;

export type PublicForwardLiquidityRuntimeCostEvidenceResult = Readonly<{
  schemaVersion: string;
  status: 'PRESENT' | 'BLOCKED_DATA';
  liquidityImpactStatus: 'PRESENT' | 'BLOCKED_DATA';
  evidence: PublicForwardLiquidityRuntimePercentCostEvidence | null;
  estimatedImpactBps: number | null;
  calibrationArtifactDigest: string | null;
  producerMeasurementDigest: string | null;
  residualDatasetDigest: string | null;
  liquidityImpactArtifactDigest: string | null;
  bridgeDigest: string | null;
  blockers: readonly string[];
  calibrationArtifactProduced: boolean;
  runtimeLiquidityImpactCoefficient: number | null;
  naturalEntryCredit: number;
  runtimeCostCredit: number;
  evidenceComplete: number;
  fullCostReady: boolean;
  netAlphaReady: boolean;
  profitabilityProven: boolean;
  currentValidatedChampion: string;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
  unknownCostIsZero: false;
  safety: Readonly<Record<string, unknown>>;
}>;

export function buildPublicForwardLiquidityRuntimeCostEvidence(
  input?: Readonly<Record<string, unknown>>,
): PublicForwardLiquidityRuntimeCostEvidenceResult;
