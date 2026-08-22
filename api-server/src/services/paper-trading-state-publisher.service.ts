import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createImmutablePaperTradingStateSnapshot,
  writeImmutablePaperTradingStateSnapshotFile,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { PaperTradingState } from './paper-trading.types';

export const PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION =
  'paper-state-transport-publish-result-v2' as const;
export const PAPER_STATE_RUNTIME_BINDING_VERSION =
  'paper-state-publisher-runtime-binding-v1' as const;

const DEFAULT_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const RUNTIME_BINDING_FILE = 'publisher-binding.json';
const RUNTIME_SNAPSHOT_RELATIVE_PATH = 'publisher/paper-state-v2.json';
const DEFAULT_MAXIMUM_AGE_MS = 65 * 60_000;
const MINIMUM_AGE_MS = 1_000;
const MAXIMUM_AGE_MS = 4 * 60 * 60_000;

type PublisherEnvironment = Readonly<Record<string, string | undefined>>;

type PaperStateRuntimeBinding = Readonly<{
  schemaVersion: typeof PAPER_STATE_RUNTIME_BINDING_VERSION;
  paperRuntimeSourceSha: string;
  snapshotPath: string;
  publisherAccountIdSha256: string;
  immutable: true;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
}>;

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

type PublisherConfiguration = Readonly<{
  snapshotPath: string;
  publisherAccountIdSha256: string;
  paperRuntimeSourceSha: string;
  runtimeBinding: boolean;
}>;

function accountDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function immutableSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function sha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
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

function normalizedStateRoot(env: PublisherEnvironment): string {
  const configured = String(env.PAPER_FORWARD_STATE_ROOT ?? '').trim();
  return resolve(configured || DEFAULT_STATE_ROOT);
}

function exactRuntimePaths(env: PublisherEnvironment) {
  const stateRoot = normalizedStateRoot(env);
  return Object.freeze({
    stateRoot,
    bindingPath: join(stateRoot, RUNTIME_BINDING_FILE),
    snapshotPath: join(stateRoot, RUNTIME_SNAPSHOT_RELATIVE_PATH),
  });
}

async function loadRuntimeBinding(env: PublisherEnvironment): Promise<PaperStateRuntimeBinding | null> {
  const paths = exactRuntimePaths(env);
  let raw: string;
  try {
    raw = await readFile(paths.bindingPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw Object.assign(new Error('PAPER_STATE_RUNTIME_BINDING_UNREADABLE'), {
      code: 'PAPER_STATE_RUNTIME_BINDING_UNREADABLE',
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error('PAPER_STATE_RUNTIME_BINDING_INVALID'), {
      code: 'PAPER_STATE_RUNTIME_BINDING_INVALID',
    });
  }
  const binding = value as Partial<PaperStateRuntimeBinding>;
  const valid = binding?.schemaVersion === PAPER_STATE_RUNTIME_BINDING_VERSION
    && immutableSha(binding.paperRuntimeSourceSha)
    && binding.snapshotPath === paths.snapshotPath
    && isAbsolute(binding.snapshotPath)
    && sha256Digest(binding.publisherAccountIdSha256)
    && binding.immutable === true
    && binding.executionAuthority === 'NONE'
    && binding.privateApiAllowed === false
    && binding.liveTrading === false
    && binding.financialMutationAllowed === false;
  if (!valid) {
    throw Object.assign(new Error('PAPER_STATE_RUNTIME_BINDING_INVALID'), {
      code: 'PAPER_STATE_RUNTIME_BINDING_INVALID',
    });
  }
  return Object.freeze(binding as PaperStateRuntimeBinding);
}

async function resolvePublisherConfiguration(
  input: PublishInput,
  env: PublisherEnvironment,
): Promise<PublisherConfiguration | PaperStateTransportPublishResult> {
  if (!immutableSha(input.sourceSha)) return blocked('PAPER_STATE_APPLICATION_SHA_UNAVAILABLE');

  let runtimeBinding: PaperStateRuntimeBinding | null;
  try {
    runtimeBinding = await loadRuntimeBinding(env);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? '').trim();
    return blocked(code || 'PAPER_STATE_RUNTIME_BINDING_INVALID');
  }

  if (runtimeBinding) {
    return Object.freeze({
      snapshotPath: runtimeBinding.snapshotPath,
      publisherAccountIdSha256: runtimeBinding.publisherAccountIdSha256,
      paperRuntimeSourceSha: runtimeBinding.paperRuntimeSourceSha,
      runtimeBinding: true,
    });
  }

  const snapshotPath = String(env.PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH ?? '').trim();
  const publisherAccountIdSha256 = String(
    env.PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256 ?? '',
  ).trim();
  if (!snapshotPath || !publisherAccountIdSha256) {
    return blocked('PAPER_STATE_TRANSPORT_NOT_CONFIGURED');
  }
  if (!isAbsolute(snapshotPath) || !snapshotPath.toLowerCase().endsWith('.json')) {
    return blocked('PAPER_STATE_TRANSPORT_PATH_INVALID');
  }
  if (!sha256Digest(publisherAccountIdSha256)) {
    return blocked('PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_INVALID');
  }
  return Object.freeze({
    snapshotPath,
    publisherAccountIdSha256,
    paperRuntimeSourceSha: input.sourceSha,
    runtimeBinding: false,
  });
}

export async function publishAuthenticatedPaperTradingState(
  input: PublishInput,
  dependencies: PublishDependencies = {},
): Promise<PaperStateTransportPublishResult> {
  const env = dependencies.env ?? process.env;
  const observedAtMs = input.observedAtMs ?? Date.now();
  const allowedMaximumAgeMs = maximumAgeMs(env.PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS);
  const configuration = await resolvePublisherConfiguration(input, env);
  if ('status' in configuration) return configuration;

  if (!input.authenticatedPublisherAccountId
    || accountDigest(input.authenticatedPublisherAccountId) !== configuration.publisherAccountIdSha256) {
    return blocked('PAPER_STATE_PUBLISHER_ACCOUNT_MISMATCH');
  }
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0 || allowedMaximumAgeMs == null) {
    return blocked('PAPER_STATE_TRANSPORT_FRESHNESS_INVALID');
  }

  try {
    const provenance = [
      'authenticated-member-session',
      'paper-trading-engine-result',
      'lossless-atomic-shared-path',
      ...(configuration.runtimeBinding ? ['paper-runtime-source-binding'] : []),
    ];
    const snapshot = createImmutablePaperTradingStateSnapshot({
      state: input.state,
      sourceOwner: 'authenticated-paper-trading-evaluate-v2',
      sourceSha: configuration.paperRuntimeSourceSha,
      market: 'CRYPTO_FUTURES',
      currency: 'USDT',
      provenance,
      publisherAccountIdSha256: configuration.publisherAccountIdSha256,
      observedAtMs,
      maximumAgeMs: allowedMaximumAgeMs,
    });
    const persisted = await (dependencies.writeSnapshot
      ?? writeImmutablePaperTradingStateSnapshotFile)(configuration.snapshotPath, snapshot, observedAtMs);
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
