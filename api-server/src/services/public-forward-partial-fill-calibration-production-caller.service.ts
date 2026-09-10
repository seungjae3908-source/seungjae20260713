import {
  readAndConnectPublicForwardPartialFillCalibrationSplitAudit,
  type PublicForwardPartialFillProductionReaderInput,
  type PublicForwardPartialFillProductionSplitAuditReadback,
} from './public-forward-partial-fill-calibration-production-reader.service';
import {
  resolvePublicForwardPartialFillCalibrationRuntimeBinding,
} from './public-forward-partial-fill-calibration-runtime-binding-resolver.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION =
  'public-forward-partial-fill-calibration-production-caller-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY = Object.freeze({
  readOnly: true,
  runtimeBindingsRequired: true,
  defaultStateRootAllowed: false,
  productionCallerConnectedByStaticImportOnly: false,
  productionPolicyAuthorityConnected: false,
  testOnlyPolicyPromotionAllowed: false,
  regimeBindingInventionAllowed: false,
  datasetMutationAllowed: false,
  captureAllowed: false,
  replayAllowed: false,
  backfillAllowed: false,
  effectiveIndependentNProduced: false,
  buySellSemanticRemapAllowed: false,
  calibrationArtifactProduced: false,
  partialFillCostProduced: false,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

const ENV_BINDINGS = Object.freeze({
  stateRoot: 'PARTIAL_FILL_CANONICAL_STATE_ROOT',
  storeContract: 'PARTIAL_FILL_CANONICAL_STORE_CONTRACT',
  sampleClass: 'PARTIAL_FILL_CANONICAL_SAMPLE_CLASS',
  collectorCodeSha: 'PARTIAL_FILL_CANONICAL_COLLECTOR_CODE_SHA',
  expectedDatasetIdentity: 'PARTIAL_FILL_CANONICAL_DATASET_IDENTITY',
  expectedDatasetDigest: 'PARTIAL_FILL_CANONICAL_DATASET_DIGEST',
} as const);

const AUTHORITATIVE_RUNTIME_BINDINGS = Object.freeze({
  stateRoot: 'RESEARCH_STATE_ROOT',
  releaseBindingRef: 'PARTIAL_FILL_RELEASE_BINDING_REF',
  releaseBindingDigest: 'PARTIAL_FILL_RELEASE_BINDING_DIGEST',
  runtimeReleaseSha: 'DEPLOY_SHA',
} as const);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type CallerSafetyEnvelope = Readonly<{
  productionPolicyAuthorityConnected: false;
  calibrationSampleSufficient: false;
  calibrationArtifactProduced: false;
  partialFillCostPresent: false;
  fullCostReady: false;
  evidenceComplete: 0;
  profitabilityProven: false;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
}>;

export type PublicForwardPartialFillProductionCallerBlocked = Readonly<{
  callerVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION;
  status: 'BLOCKED';
  blocker:
    | 'NOT_EVALUABLE_RUNTIME_BINDING_MISSING'
    | 'RUNTIME_BINDING_NOT_EVALUABLE'
    | 'CANONICAL_READER_BLOCKED';
  missingBindings: readonly string[];
  readerError: string | null;
  productionCallerConnected: boolean;
}> & CallerSafetyEnvelope;

export type PublicForwardPartialFillProductionCallerConnected = Readonly<{
  callerVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION;
  status: 'READBACK';
  productionCallerConnected: true;
  readback: Omit<PublicForwardPartialFillProductionSplitAuditReadback, 'productionCallerConnected'>;
}> & CallerSafetyEnvelope;

export type PublicForwardPartialFillProductionCallerResult =
  | PublicForwardPartialFillProductionCallerBlocked
  | PublicForwardPartialFillProductionCallerConnected;

function safetyEnvelope(): CallerSafetyEnvelope {
  return Object.freeze({
    productionPolicyAuthorityConnected: false as const,
    calibrationSampleSufficient: false as const,
    calibrationArtifactProduced: false as const,
    partialFillCostPresent: false as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    profitabilityProven: false as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
}

function missingBindingResult(missingBindings: readonly string[]): PublicForwardPartialFillProductionCallerBlocked {
  return Object.freeze({
    callerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION,
    status: 'BLOCKED' as const,
    blocker: 'NOT_EVALUABLE_RUNTIME_BINDING_MISSING' as const,
    missingBindings: Object.freeze([...missingBindings]),
    readerError: null,
    productionCallerConnected: false,
    ...safetyEnvelope(),
  });
}

function runtimeBindingBlockedResult(error: unknown): PublicForwardPartialFillProductionCallerBlocked {
  return Object.freeze({
    callerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION,
    status: 'BLOCKED' as const,
    blocker: 'RUNTIME_BINDING_NOT_EVALUABLE' as const,
    missingBindings: Object.freeze([]),
    readerError: error instanceof Error ? error.message : String(error),
    productionCallerConnected: false,
    ...safetyEnvelope(),
  });
}

function readerBlockedResult(error: unknown): PublicForwardPartialFillProductionCallerBlocked {
  return Object.freeze({
    callerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION,
    status: 'BLOCKED' as const,
    blocker: 'CANONICAL_READER_BLOCKED' as const,
    missingBindings: Object.freeze([]),
    readerError: error instanceof Error ? error.message : String(error),
    productionCallerConnected: true,
    ...safetyEnvelope(),
  });
}

function connectedResult(
  readerResult: PublicForwardPartialFillProductionSplitAuditReadback,
): PublicForwardPartialFillProductionCallerConnected {
  const { productionCallerConnected: _readerDoesNotOwnCallerConnection, ...readback } = readerResult;
  return Object.freeze({
    callerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_VERSION,
    status: 'READBACK' as const,
    productionCallerConnected: true as const,
    readback: Object.freeze(readback),
    ...safetyEnvelope(),
  });
}

function resolveReaderInput(environment: RuntimeEnvironment):
  | Readonly<{ input: PublicForwardPartialFillProductionReaderInput; missingBindings: readonly [] }>
  | Readonly<{ input: null; missingBindings: readonly string[] }> {
  const missingBindings = Object.values(ENV_BINDINGS).filter((name) => !environment[name]?.trim());
  if (missingBindings.length > 0) return Object.freeze({ input: null, missingBindings: Object.freeze(missingBindings) });

  return Object.freeze({
    input: Object.freeze({
      stateRoot: environment[ENV_BINDINGS.stateRoot]!.trim(),
      storeContract: environment[ENV_BINDINGS.storeContract]!.trim(),
      sampleClass: environment[ENV_BINDINGS.sampleClass]!.trim() as PublicForwardPartialFillProductionReaderInput['sampleClass'],
      collectorCodeSha: environment[ENV_BINDINGS.collectorCodeSha]!.trim(),
      expectedDatasetIdentity: environment[ENV_BINDINGS.expectedDatasetIdentity]!.trim(),
      expectedDatasetDigest: environment[ENV_BINDINGS.expectedDatasetDigest]!.trim(),
    }),
    missingBindings: Object.freeze([]) as readonly [],
  });
}

/**
 * Compatibility readback retained for the merged #856 regression contract.
 * The real startup entrypoint below does not use these duplicate dataset authorities.
 */
export async function callPublicForwardPartialFillCalibrationReaderFromProduction(
  environment: RuntimeEnvironment,
): Promise<PublicForwardPartialFillProductionCallerResult> {
  const resolved = resolveReaderInput(environment);
  if (!resolved.input) return missingBindingResult(resolved.missingBindings);

  try {
    const readerResult = await readAndConnectPublicForwardPartialFillCalibrationSplitAudit({
      reader: resolved.input,
      productionPolicy: null,
      regimeBindings: null,
    });
    return connectedResult(readerResult);
  } catch (error) {
    return readerBlockedResult(error);
  }
}

export async function callPublicForwardPartialFillCalibrationReaderFromAuthoritativeRuntimeBinding(
  environment: RuntimeEnvironment,
): Promise<PublicForwardPartialFillProductionCallerResult> {
  const missingBindings = Object.values(AUTHORITATIVE_RUNTIME_BINDINGS)
    .filter((name) => !environment[name]?.trim());
  if (missingBindings.length > 0) return missingBindingResult(missingBindings);

  let resolved;
  try {
    resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding({
      stateRoot: environment[AUTHORITATIVE_RUNTIME_BINDINGS.stateRoot]!.trim(),
      releaseBindingRef: environment[AUTHORITATIVE_RUNTIME_BINDINGS.releaseBindingRef]!.trim(),
      releaseBindingDigest: environment[AUTHORITATIVE_RUNTIME_BINDINGS.releaseBindingDigest]!.trim(),
      runtimeReleaseSha: environment[AUTHORITATIVE_RUNTIME_BINDINGS.runtimeReleaseSha]!.trim(),
    });
  } catch (error) {
    return runtimeBindingBlockedResult(error);
  }

  try {
    const readerResult = await readAndConnectPublicForwardPartialFillCalibrationSplitAudit({
      reader: {
        stateRoot: resolved.stateRoot,
        storeContract: resolved.storeContract,
        sampleClass: resolved.sampleClass,
        collectorCodeSha: resolved.collectorCodeSha,
        expectedDatasetIdentity: resolved.datasetIdentity,
        expectedDatasetDigest: resolved.datasetDigest,
        datasetRelativePath: resolved.datasetRelativePath,
        expectedDatasetBytesDigest: resolved.datasetBytesDigest,
        runtimeBindingSource: resolved.runtimeBindingSource,
      },
      productionPolicy: null,
      regimeBindings: null,
    });
    return connectedResult(readerResult);
  } catch (error) {
    return readerBlockedResult(error);
  }
}

export function runPublicForwardPartialFillCalibrationProductionReadback(
  environment: RuntimeEnvironment = process.env,
): Promise<PublicForwardPartialFillProductionCallerResult> {
  return callPublicForwardPartialFillCalibrationReaderFromAuthoritativeRuntimeBinding(environment);
}
