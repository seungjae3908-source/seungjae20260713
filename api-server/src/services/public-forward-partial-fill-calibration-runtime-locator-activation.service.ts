import {
  resolvePublicForwardPartialFillCalibrationRuntimeBinding,
} from './public-forward-partial-fill-calibration-runtime-binding-resolver.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_VERSION =
  'public-forward-partial-fill-calibration-runtime-locator-activation-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_KEYS = Object.freeze([
  'RESEARCH_STATE_ROOT',
  'PARTIAL_FILL_RELEASE_BINDING_REF',
  'PARTIAL_FILL_RELEASE_BINDING_DIGEST',
] as const);

export const PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY = Object.freeze({
  locatorOnly: true,
  authoritySource: 'IMMUTABLE_RELEASE_BINDING' as const,
  resolverReuseRequired: true,
  exactExistingDeployShaRequired: true,
  deployShaMutationAllowed: false,
  stateRootMutationAllowed: false,
  releaseBindingPublicationAllowed: false,
  pointerMutationAllowed: false,
  datasetMutationAllowed: false,
  codeDeployAllowed: false,
  databaseMutationAllowed: false,
  secretMutationAllowed: false,
  scheduleMutationAllowed: false,
  runtimeMutationPerformed: false,
  runtimeActivationPerformed: false,
  serviceRestartPerformed: false,
  productionPolicyAuthorityConnected: false,
  calibrationSampleSufficient: false,
  partialFillCostPresent: false,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  currentValidatedChampion: 'NONE' as const,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
});

type RuntimeLocatorValues = Readonly<{
  RESEARCH_STATE_ROOT: string;
  PARTIAL_FILL_RELEASE_BINDING_REF: string;
  PARTIAL_FILL_RELEASE_BINDING_DIGEST: string;
}>;

export type PublicForwardPartialFillRuntimeLocatorActivationInput = Readonly<{
  stateRoot: string;
  releaseBindingRef: string;
  releaseBindingDigest: string;
  runtimeReleaseSha: string;
}>;

export type PublicForwardPartialFillRuntimeLocatorActivationPreflight = Readonly<{
  activationVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_VERSION;
  status: 'LOCATOR_ACTIVATION_PREFLIGHT_READY';
  authoritySource: 'IMMUTABLE_RELEASE_BINDING';
  locatorKeys: typeof PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_KEYS;
  locatorValues: RuntimeLocatorValues;
  requiredExistingDeploySha: string;
  approvedMainSha: string;
  releaseBindingRef: string;
  releaseBindingDigest: string;
  datasetPointerIdentity: string;
  datasetPointerRef: string;
  datasetPointerDigest: string;
  datasetRelativePath: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetBytesDigest: string;
  collectorCodeSha: string;
  sampleClass: string;
  storeContract: string;
  deployShaMutationPerformed: false;
  releaseBindingPublicationPerformed: false;
  pointerMutationPerformed: false;
  datasetMutationPerformed: false;
  productionDeployPerformed: false;
  runtimeMutationPerformed: false;
  runtimeActivationPerformed: false;
  serviceRestartPerformed: false;
  productionPolicyAuthorityConnected: false;
  calibrationSampleSufficient: false;
  partialFillCostPresent: false;
  fullCostReady: false;
  evidenceComplete: 0;
  profitabilityProven: false;
  currentValidatedChampion: 'NONE';
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
}>;

export async function preparePublicForwardPartialFillRuntimeLocatorActivation(
  input: PublicForwardPartialFillRuntimeLocatorActivationInput,
): Promise<PublicForwardPartialFillRuntimeLocatorActivationPreflight> {
  const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding({
    stateRoot: input.stateRoot,
    releaseBindingRef: input.releaseBindingRef,
    releaseBindingDigest: input.releaseBindingDigest,
    runtimeReleaseSha: input.runtimeReleaseSha,
  });

  const locatorValues = Object.freeze({
    RESEARCH_STATE_ROOT: resolved.stateRoot,
    PARTIAL_FILL_RELEASE_BINDING_REF: resolved.releaseBindingRef,
    PARTIAL_FILL_RELEASE_BINDING_DIGEST: resolved.releaseBindingDigest,
  });

  return Object.freeze({
    activationVersion: PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_VERSION,
    status: 'LOCATOR_ACTIVATION_PREFLIGHT_READY' as const,
    authoritySource: 'IMMUTABLE_RELEASE_BINDING' as const,
    locatorKeys: PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_KEYS,
    locatorValues,
    requiredExistingDeploySha: resolved.approvedMainSha,
    approvedMainSha: resolved.approvedMainSha,
    releaseBindingRef: resolved.releaseBindingRef,
    releaseBindingDigest: resolved.releaseBindingDigest,
    datasetPointerIdentity: resolved.datasetPointerIdentity,
    datasetPointerRef: resolved.datasetPointerRef,
    datasetPointerDigest: resolved.datasetPointerDigest,
    datasetRelativePath: resolved.datasetRelativePath,
    datasetIdentity: resolved.datasetIdentity,
    datasetDigest: resolved.datasetDigest,
    datasetBytesDigest: resolved.datasetBytesDigest,
    collectorCodeSha: resolved.collectorCodeSha,
    sampleClass: resolved.sampleClass,
    storeContract: resolved.storeContract,
    deployShaMutationPerformed: false as const,
    releaseBindingPublicationPerformed: false as const,
    pointerMutationPerformed: false as const,
    datasetMutationPerformed: false as const,
    productionDeployPerformed: false as const,
    runtimeMutationPerformed: false as const,
    runtimeActivationPerformed: false as const,
    serviceRestartPerformed: false as const,
    productionPolicyAuthorityConnected: false as const,
    calibrationSampleSufficient: false as const,
    partialFillCostPresent: false as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    profitabilityProven: false as const,
    currentValidatedChampion: 'NONE' as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
}
