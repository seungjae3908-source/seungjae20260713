import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  createImmutablePaperTradingStateSnapshot,
  writeImmutablePaperTradingStateSnapshotFile,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { PaperTradingState } from './paper-trading.types';

export const PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION =
  'paper-state-transport-publish-result-v2' as const;

const DEFAULT_MAXIMUM_AGE_MS = 65 * 60_000;
const MINIMUM_AGE_MS = 1_000;
const MAXIMUM_AGE_MS = 4 * 60 * 60_000;

type PublisherEnvironment = Readonly<Record<string, string | undefined>>;

export type PaperStateTransportPublishResult = Readonly<{
  schemaVersion: typeof PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION;
  status: 'PUBLISHED' | 'BLOCKED_DATA';
  invoked: boolean;
  callbackEligible: boolean;
  reason: string | null;
  snapshotSchemaVersion: 'paper-trading-state-snapshot-v2' | null;
  publisherAccountBound: boolean;
  stateDigestSha256: string | null;
  observedAtMs: number | null;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
  unknownIsZero: false;
}>;

type PublishInput = Readonly<{
  state: PaperTradingState;
  authenticatedPublisherAccountId: string;
  sourceSha: string;
  observedAtMs?: number;
}>;

type PublishDependencies = Readonly<{
  env?: PublisherEnvironment;
  writeSnapshot?: (
    snapshotPath: string,
    snapshot: PaperTradingStateSnapshot,
    nowMs: number,
  ) => Promise<PaperTradingStateSnapshot>;
}>;

function accountDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function blocked(reason: string): PaperStateTransportPublishResult {
  return Object.freeze({
    schemaVersion: PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION,
    status: 'BLOCKED_DATA',
    invoked: false,
    callbackEligible: false,
    reason,
    snapshotSchemaVersion: null,
    publisherAccountBound: false,
    stateDigestSha256: null,
    observedAtMs: null,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    unknownIsZero: false,
  });
}

function maximumAgeMs(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return DEFAULT_MAXIMUM_AGE_MS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MINIMUM_AGE_MS && parsed <= MAXIMUM_AGE_MS
    ? parsed
    : null;
}

export async function publishAuthenticatedPaperTradingState(
  input: PublishInput,
  dependencies: PublishDependencies = {},
): Promise<PaperStateTransportPublishResult> {
  const env = dependencies.env ?? process.env;
  const snapshotPath = String(env.PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH ?? '').trim();
  const configuredPublisherAccountIdSha256 = String(
    env.PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256 ?? '',
  ).trim();
  const observedAtMs = input.observedAtMs ?? Date.now();
  const allowedMaximumAgeMs = maximumAgeMs(env.PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS);

  if (!snapshotPath || !configuredPublisherAccountIdSha256) {
    return blocked('PAPER_STATE_TRANSPORT_NOT_CONFIGURED');
  }
  if (!isAbsolute(snapshotPath) || !snapshotPath.toLowerCase().endsWith('.json')) {
    return blocked('PAPER_STATE_TRANSPORT_PATH_INVALID');
  }
  if (!/^[0-9a-f]{64}$/u.test(configuredPublisherAccountIdSha256)) {
    return blocked('PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_INVALID');
  }
  if (!input.authenticatedPublisherAccountId
    || accountDigest(input.authenticatedPublisherAccountId) !== configuredPublisherAccountIdSha256) {
    return blocked('PAPER_STATE_PUBLISHER_ACCOUNT_MISMATCH');
  }
  if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) {
    return blocked('PAPER_STATE_SOURCE_SHA_UNAVAILABLE');
  }
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0 || allowedMaximumAgeMs == null) {
    return blocked('PAPER_STATE_TRANSPORT_FRESHNESS_INVALID');
  }

  try {
    const snapshot = createImmutablePaperTradingStateSnapshot({
      state: input.state,
      sourceOwner: 'authenticated-paper-trading-evaluate-v2',
      sourceSha: input.sourceSha,
      market: 'CRYPTO_FUTURES',
      currency: 'USDT',
      provenance: [
        'authenticated-member-session',
        'paper-trading-engine-result',
        'lossless-atomic-shared-path',
      ],
      publisherAccountIdSha256: configuredPublisherAccountIdSha256,
      observedAtMs,
      maximumAgeMs: allowedMaximumAgeMs,
    });
    const persisted = await (dependencies.writeSnapshot
      ?? writeImmutablePaperTradingStateSnapshotFile)(snapshotPath, snapshot, observedAtMs);
    return Object.freeze({
      schemaVersion: PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION,
      status: 'PUBLISHED',
      invoked: true,
      callbackEligible: true,
      reason: null,
      snapshotSchemaVersion: persisted.schemaVersion,
      publisherAccountBound: true,
      stateDigestSha256: persisted.stateDigestSha256,
      observedAtMs: persisted.observedAtMs,
      executionAuthority: 'NONE',
      privateApiAllowed: false,
      liveTrading: false,
      financialMutationAllowed: false,
      unknownIsZero: false,
    });
  } catch {
    return blocked('PAPER_STATE_SNAPSHOT_VALIDATION_OR_WRITE_FAILED');
  }
}
