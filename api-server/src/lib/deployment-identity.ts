import { readFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export type DeploymentIdentityStatus =
  | 'match'
  | 'process_missing_or_malformed'
  | 'marker_missing_or_malformed'
  | 'mismatch';

export type DeploymentIdentity = {
  processDeploySha: string | null;
  deployMarkerSha: string | null;
  identityMatch: boolean;
  identityStatus: DeploymentIdentityStatus;
};

export function normalizeDeploymentSha(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA_PATTERN.test(normalized) ? normalized : null;
}

export function readDeploymentMarker(markerPath: string): string | null {
  try {
    return normalizeDeploymentSha(readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

export function evaluateDeploymentIdentity(
  processShaValue: unknown,
  markerShaValue: unknown,
): DeploymentIdentity {
  const processDeploySha = normalizeDeploymentSha(processShaValue);
  const deployMarkerSha = normalizeDeploymentSha(markerShaValue);
  const identityMatch = processDeploySha !== null
    && deployMarkerSha !== null
    && processDeploySha === deployMarkerSha;

  let identityStatus: DeploymentIdentityStatus = 'match';
  if (!processDeploySha) identityStatus = 'process_missing_or_malformed';
  else if (!deployMarkerSha) identityStatus = 'marker_missing_or_malformed';
  else if (!identityMatch) identityStatus = 'mismatch';

  return { processDeploySha, deployMarkerSha, identityMatch, identityStatus };
}

export function readRuntimeDeploymentIdentity(
  processShaValue: unknown,
  markerPath: string,
): DeploymentIdentity {
  return evaluateDeploymentIdentity(processShaValue, readDeploymentMarker(markerPath));
}
