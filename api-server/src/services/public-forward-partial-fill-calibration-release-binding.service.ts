import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT } from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  type PublicForwardPartialFillCalibrationDatasetPointer,
  verifyPublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_VERSION =
  'public-forward-partial-fill-calibration-release-binding-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY = Object.freeze({
  releaseAuthority: 'ISSUE_23_OWNER_AUTHORIZED_CONTROL_PLANE' as const,
  stateRootAuthorityKey: 'RESEARCH_STATE_ROOT' as const,
  createOnlySemanticsRequired: true,
  rollbackByNewBindingRequired: true,
  pointerRewriteAllowed: false,
  filesystemLatestSelectionAllowed: false,
  productionPolicyAuthorityConnected: false,
  runtimeResolverConnected: false,
  apiStartupBindingConnected: false,
  releaseControlPublicationConnected: false,
  calibrationSampleSufficient: false,
  partialFillCostPresent: false,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
});

export type PublicForwardPartialFillReleaseBindingPublicationProvenance = Readonly<{
  repository: string;
  exactMainSha: string;
  issueNumber: 23;
  approvalReference: string;
  approvedBy: string;
}>;

export type PublicForwardPartialFillCalibrationReleaseBinding = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_VERSION;
  datasetPointerIdentity: string;
  datasetPointerRef: string;
  datasetPointerDigest: string;
  stateRootAuthorityKey: 'RESEARCH_STATE_ROOT';
  expectedStoreContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  releaseControlReference: string;
  publicationAuthority: 'ISSUE_23_OWNER_AUTHORIZED_CONTROL_PLANE';
  publicationProvenance: PublicForwardPartialFillReleaseBindingPublicationProvenance;
  releaseBindingIdentity: string;
  releaseBindingDigest: string;
}>;

export type PublicForwardPartialFillReleaseBindingVerification = Readonly<{
  valid: boolean;
  blockers: readonly string[];
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function safeRelativeRef(value: unknown): value is string {
  if (!nonEmpty(value) || isAbsolute(value) || value.includes('\\')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function bodyWithoutDigest(
  value: PublicForwardPartialFillCalibrationReleaseBinding,
): Omit<PublicForwardPartialFillCalibrationReleaseBinding, 'releaseBindingDigest'> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'releaseBindingDigest'),
  ) as Omit<PublicForwardPartialFillCalibrationReleaseBinding, 'releaseBindingDigest'>;
}

export function computePublicForwardPartialFillReleaseBindingDigest(
  value: Omit<PublicForwardPartialFillCalibrationReleaseBinding, 'releaseBindingDigest'>
    | PublicForwardPartialFillCalibrationReleaseBinding,
): string {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'releaseBindingDigest'));
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function validPublicationProvenance(
  value: PublicForwardPartialFillReleaseBindingPublicationProvenance | undefined,
  releaseControlReference: string,
): boolean {
  return Boolean(value)
    && REPOSITORY.test(value!.repository)
    && exactSha(value!.exactMainSha)
    && value!.issueNumber === 23
    && nonEmpty(value!.approvalReference)
    && nonEmpty(value!.approvedBy)
    && releaseControlReference === `https://github.com/${value!.repository}/issues/23`;
}

export function verifyPublicForwardPartialFillCalibrationReleaseBinding(
  binding: unknown,
  expectedPointer?: PublicForwardPartialFillCalibrationDatasetPointer,
): PublicForwardPartialFillReleaseBindingVerification {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    return Object.freeze({ valid: false, blockers: Object.freeze(['RELEASE_BINDING_SCHEMA_INVALID']) });
  }
  const candidate = binding as Partial<PublicForwardPartialFillCalibrationReleaseBinding>;
  if (candidate.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_VERSION) add('RELEASE_BINDING_SCHEMA_INVALID');
  if (!nonEmpty(candidate.datasetPointerIdentity)) add('RELEASE_BINDING_POINTER_MISMATCH');
  if (!safeRelativeRef(candidate.datasetPointerRef)) add('RELEASE_BINDING_POINTER_MISMATCH');
  if (!exactDigest(candidate.datasetPointerDigest)) add('RELEASE_BINDING_POINTER_MISMATCH');
  if (candidate.stateRootAuthorityKey !== 'RESEARCH_STATE_ROOT') add('RELEASE_BINDING_AUTHORITY_INVALID');
  if (candidate.expectedStoreContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) add('RELEASE_BINDING_AUTHORITY_INVALID');
  if (!nonEmpty(candidate.releaseControlReference)) add('RELEASE_BINDING_AUTHORITY_INVALID');
  if (candidate.publicationAuthority !== 'ISSUE_23_OWNER_AUTHORIZED_CONTROL_PLANE') add('RELEASE_BINDING_AUTHORITY_INVALID');
  if (!validPublicationProvenance(candidate.publicationProvenance, String(candidate.releaseControlReference ?? ''))) {
    add('RELEASE_BINDING_AUTHORITY_INVALID');
  }
  if (!nonEmpty(candidate.releaseBindingIdentity)) add('RELEASE_BINDING_SCHEMA_INVALID');
  if (!exactDigest(candidate.releaseBindingDigest)) add('RELEASE_BINDING_DIGEST_MISMATCH');
  if (exactDigest(candidate.releaseBindingDigest)) {
    try {
      if (computePublicForwardPartialFillReleaseBindingDigest(
        bodyWithoutDigest(candidate as PublicForwardPartialFillCalibrationReleaseBinding),
      ) !== candidate.releaseBindingDigest) add('RELEASE_BINDING_DIGEST_MISMATCH');
    } catch {
      add('RELEASE_BINDING_DIGEST_MISMATCH');
    }
  }

  if (expectedPointer) {
    const pointerVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(expectedPointer);
    if (!pointerVerification.valid) add('RELEASE_BINDING_POINTER_MISMATCH');
    if (candidate.datasetPointerIdentity !== expectedPointer.pointerIdentity
      || candidate.datasetPointerRef !== expectedPointer.pointerRelativePath
      || candidate.datasetPointerDigest !== expectedPointer.pointerDigest) add('RELEASE_BINDING_POINTER_MISMATCH');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function buildPublicForwardPartialFillCalibrationReleaseBinding(input: Readonly<{
  pointer: PublicForwardPartialFillCalibrationDatasetPointer;
  releaseBindingIdentity: string;
  releaseControlReference: string;
  publicationProvenance: PublicForwardPartialFillReleaseBindingPublicationProvenance;
}>): PublicForwardPartialFillCalibrationReleaseBinding {
  const pointerVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(input.pointer);
  if (!pointerVerification.valid) throw new Error(`RELEASE_BINDING_POINTER_MISMATCH:${pointerVerification.blockers.join(',')}`);
  if (!nonEmpty(input.releaseBindingIdentity)) throw new Error('RELEASE_BINDING_SCHEMA_INVALID');
  if (!nonEmpty(input.releaseControlReference)
    || !validPublicationProvenance(input.publicationProvenance, input.releaseControlReference)) {
    throw new Error('RELEASE_BINDING_AUTHORITY_INVALID');
  }

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_VERSION,
    datasetPointerIdentity: input.pointer.pointerIdentity,
    datasetPointerRef: input.pointer.pointerRelativePath,
    datasetPointerDigest: input.pointer.pointerDigest,
    stateRootAuthorityKey: 'RESEARCH_STATE_ROOT' as const,
    expectedStoreContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    releaseControlReference: input.releaseControlReference,
    publicationAuthority: 'ISSUE_23_OWNER_AUTHORIZED_CONTROL_PLANE' as const,
    publicationProvenance: Object.freeze({ ...input.publicationProvenance }),
    releaseBindingIdentity: input.releaseBindingIdentity,
  });
  const binding = Object.freeze({
    ...body,
    releaseBindingDigest: computePublicForwardPartialFillReleaseBindingDigest(body),
  });
  const verification = verifyPublicForwardPartialFillCalibrationReleaseBinding(binding, input.pointer);
  if (!verification.valid) throw new Error(`RELEASE_BINDING_SCHEMA_INVALID:${verification.blockers.join(',')}`);
  return binding;
}

export function assertPublicForwardPartialFillReleaseBindingCompatible(
  existing: PublicForwardPartialFillCalibrationReleaseBinding,
  candidate: PublicForwardPartialFillCalibrationReleaseBinding,
): void {
  const existingVerification = verifyPublicForwardPartialFillCalibrationReleaseBinding(existing);
  const candidateVerification = verifyPublicForwardPartialFillCalibrationReleaseBinding(candidate);
  if (!existingVerification.valid || !candidateVerification.valid) throw new Error('RELEASE_BINDING_SCHEMA_INVALID');
  if (existing.releaseBindingIdentity !== candidate.releaseBindingIdentity) return;
  if (existing.releaseBindingDigest !== candidate.releaseBindingDigest
    || existing.datasetPointerDigest !== candidate.datasetPointerDigest
    || existing.datasetPointerIdentity !== candidate.datasetPointerIdentity
    || existing.datasetPointerRef !== candidate.datasetPointerRef
    || JSON.stringify(canonicalize(existing)) !== JSON.stringify(canonicalize(candidate))) {
    throw new Error('RELEASE_BINDING_CONFLICT');
  }
}
