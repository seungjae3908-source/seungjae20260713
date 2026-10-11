type ProviderConnection = Record<string, unknown> | undefined;

export type ProviderPredeployAssessment = {
  deploymentBlockers: string[];
  postDeployVerificationBlockers: string[];
};

export function assessProviderBeforeRepairDeployment(input: {
  provider: string;
  connection: ProviderConnection;
  liveServerGateEnabled: unknown;
  autoServerGateEnabled: unknown;
  targetDiffersFromActiveProduction: boolean;
}): ProviderPredeployAssessment {
  const provider = input.provider.toUpperCase();
  const deploymentBlockers: string[] = [];
  const postDeployVerificationBlockers: string[] = [];

  if (!input.connection) {
    deploymentBlockers.push(`PROVIDER_MISSING:${provider}`);
  } else {
    if (input.connection.configured !== true) {
      deploymentBlockers.push(`PROVIDER_NOT_CONFIGURED:${provider}`);
    }
    const verificationBlockers = [
      ...(!input.connection.lastVerifiedAt ? [`PROVIDER_NOT_VERIFIED:${provider}`] : []),
      ...(input.connection.lastErrorCode != null ? [`PROVIDER_ERROR:${provider}`] : []),
    ];
    if (input.targetDiffersFromActiveProduction) {
      postDeployVerificationBlockers.push(...verificationBlockers);
    } else {
      // Re-running the already-active SHA cannot repair provider verification.
      deploymentBlockers.push(...verificationBlockers);
    }
  }

  if (input.liveServerGateEnabled !== false) {
    deploymentBlockers.push(`LIVE_SERVER_GATE_NOT_OFF:${provider}`);
  }
  if (input.autoServerGateEnabled !== false) {
    deploymentBlockers.push(`AUTO_SERVER_GATE_NOT_OFF:${provider}`);
  }

  return { deploymentBlockers, postDeployVerificationBlockers };
}
