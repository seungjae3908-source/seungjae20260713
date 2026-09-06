import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const V3_INDEPENDENCE_SUMMARY_SCHEMA =
  'public-forward-liquidity-v3-authoritative-independence-summary-v1';
export const V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH = Object.freeze([
  'forward',
  'liquidity',
  'v3-authoritative-independence-summary.json',
]);

const WORKFLOW_NAME = 'Public Forward Liquidity V3 Independence Consume';
const SOURCE_EVENT = 'workflow_run';
const SOURCE_BRANCH = 'main';
const SOURCE_CONCLUSION = 'success';
const MAX_SUMMARY_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const GITHUB_ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NUMERIC_ID_PATTERN = /^[0-9]{6,20}$/u;
const SPLIT_COUNT_KEYS = Object.freeze([
  'TRAIN',
  'TRAIN_BUY',
  'TRAIN_SELL',
  'VALIDATION',
  'VALIDATION_BUY',
  'VALIDATION_SELL',
  'OOS',
  'OOS_BUY',
  'OOS_SELL',
]);
const CUMULATIVE_COUNT_KEYS = Object.freeze([
  'genuineScheduledSlotN',
  'rawAcceptedN',
  'effectiveIndependentN',
  'independentBuyN',
  'independentSellN',
]);

export class V3LiquidityIndependencePublisherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V3LiquidityIndependencePublisherError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new V3LiquidityIndependencePublisherError(code, message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Canonical(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function integerCount(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('SOURCE_INVALID', `${field} must be a non-negative JSON integer`);
  }
  return value;
}

function numericId(value, field) {
  const stringValue = String(value ?? '');
  if (!NUMERIC_ID_PATTERN.test(stringValue)) {
    fail('SOURCE_INVALID', `${field} must be a 6-20 digit GitHub id`);
  }
  return stringValue;
}

function exactDigest(value, field) {
  const stringValue = String(value ?? '');
  if (!DIGEST_PATTERN.test(stringValue)) {
    fail('SOURCE_INVALID', `${field} must be a lowercase sha256 digest`);
  }
  return stringValue;
}

function assertFrozenSplitPolicy(summary, counts) {
  const slot = summary.targetSlotIndex;
  if (slot > 1023) fail('SOURCE_INVALID', 'targetSlotIndex exceeds frozen V3 cohort');
  if (summary.genuineScheduledSlotN > slot + 1) {
    fail('SOURCE_INVALID', 'genuineScheduledSlotN exceeds elapsed frozen slots');
  }
  if (counts.TRAIN > 512 || counts.VALIDATION > 256 || counts.OOS > 256) {
    fail('SOURCE_INVALID', 'frozen split capacity exceeded');
  }
  if (slot < 512 && (counts.VALIDATION !== 0 || counts.OOS !== 0)) {
    fail('SOURCE_INVALID', 'future VALIDATION/OOS credit is not allowed during TRAIN');
  }
  if (slot < 768 && counts.OOS !== 0) {
    fail('SOURCE_INVALID', 'future OOS credit is not allowed before slot 768');
  }
}

export function validateV3LiquidityIndependenceSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SOURCE_INVALID', 'summary must be a JSON object');
  }

  if (value.schemaVersion !== V3_INDEPENDENCE_SUMMARY_SCHEMA) {
    fail('SOURCE_INVALID', 'unexpected summary schemaVersion');
  }
  if (!SHA_PATTERN.test(String(value.producerSha ?? ''))) {
    fail('SOURCE_INVALID', 'producerSha must be an exact 40-character SHA');
  }

  numericId(value.upstreamIngestRunId, 'upstreamIngestRunId');
  numericId(value.upstreamIngestArtifactId, 'upstreamIngestArtifactId');
  exactDigest(value.upstreamIngestArtifactDigest, 'upstreamIngestArtifactDigest');
  exactDigest(value.sourceInventoryDigest, 'sourceInventoryDigest');
  exactDigest(value.independenceAuditDigest, 'independenceAuditDigest');
  exactDigest(value.independentSplitSourceDigest, 'independentSplitSourceDigest');
  exactDigest(value.v3IndependentSplitIndexDigest, 'v3IndependentSplitIndexDigest');
  exactDigest(value.reportDigest, 'reportDigest');

  const normalized = {
    targetSlotIndex: integerCount(value.targetSlotIndex, 'targetSlotIndex'),
    genuineScheduledSlotN: integerCount(value.genuineScheduledSlotN, 'genuineScheduledSlotN'),
    rawAcceptedN: integerCount(value.rawAcceptedN, 'rawAcceptedN'),
    effectiveIndependentN: integerCount(value.effectiveIndependentN, 'effectiveIndependentN'),
    independentBuyN: integerCount(value.independentBuyN, 'independentBuyN'),
    independentSellN: integerCount(value.independentSellN, 'independentSellN'),
    oosOutcomeCredit: integerCount(value.oosOutcomeCredit, 'oosOutcomeCredit'),
    evidenceComplete: integerCount(value.evidenceComplete, 'evidenceComplete'),
  };

  const splitCounts = value.frozenSplitCounts;
  if (!splitCounts || typeof splitCounts !== 'object' || Array.isArray(splitCounts)) {
    fail('SOURCE_INVALID', 'frozenSplitCounts must be an object');
  }
  const counts = Object.fromEntries(
    SPLIT_COUNT_KEYS.map((key) => [key, integerCount(splitCounts[key], `frozenSplitCounts.${key}`)]),
  );

  if (normalized.oosOutcomeCredit !== 0) fail('SOURCE_INVALID', 'oosOutcomeCredit must remain zero');
  if (value.calibrationArtifactProduced !== false) {
    fail('SOURCE_INVALID', 'calibrationArtifactProduced must remain false');
  }
  if (value.liquidityImpactStatus !== 'BLOCKED_DATA') {
    fail('SOURCE_INVALID', 'liquidityImpactStatus must remain BLOCKED_DATA');
  }
  if (value.fullCostReady !== false) fail('SOURCE_INVALID', 'fullCostReady must remain false');
  if (normalized.evidenceComplete !== 0) fail('SOURCE_INVALID', 'evidenceComplete must remain zero');
  if (value.executionAuthority !== 'NONE') fail('SOURCE_INVALID', 'executionAuthority must remain NONE');
  if (value.frozenV3SplitIndexPresent !== true) {
    fail('SOURCE_INVALID', 'frozenV3SplitIndexPresent must be true');
  }
  if (value.v2SplitReceiptPresent !== false) {
    fail('SOURCE_INVALID', 'v2SplitReceiptPresent must be false');
  }

  if (normalized.rawAcceptedN < normalized.effectiveIndependentN) {
    fail('SOURCE_INVALID', 'rawAcceptedN cannot be smaller than effectiveIndependentN');
  }
  if (normalized.genuineScheduledSlotN < normalized.effectiveIndependentN) {
    fail('SOURCE_INVALID', 'genuineScheduledSlotN cannot be smaller than effectiveIndependentN');
  }
  if (normalized.effectiveIndependentN !== normalized.independentBuyN + normalized.independentSellN) {
    fail('SOURCE_INVALID', 'independent side counts do not reconcile');
  }
  if (counts.TRAIN !== counts.TRAIN_BUY + counts.TRAIN_SELL) {
    fail('SOURCE_INVALID', 'TRAIN side counts do not reconcile');
  }
  if (counts.VALIDATION !== counts.VALIDATION_BUY + counts.VALIDATION_SELL) {
    fail('SOURCE_INVALID', 'VALIDATION side counts do not reconcile');
  }
  if (counts.OOS !== counts.OOS_BUY + counts.OOS_SELL) {
    fail('SOURCE_INVALID', 'OOS side counts do not reconcile');
  }
  if (normalized.effectiveIndependentN !== counts.TRAIN + counts.VALIDATION + counts.OOS) {
    fail('SOURCE_INVALID', 'split totals do not reconcile with effectiveIndependentN');
  }
  if (normalized.independentBuyN !== counts.TRAIN_BUY + counts.VALIDATION_BUY + counts.OOS_BUY) {
    fail('SOURCE_INVALID', 'BUY split totals do not reconcile');
  }
  if (normalized.independentSellN !== counts.TRAIN_SELL + counts.VALIDATION_SELL + counts.OOS_SELL) {
    fail('SOURCE_INVALID', 'SELL split totals do not reconcile');
  }

  const body = { ...value };
  delete body.reportDigest;
  if (sha256Canonical(body) !== value.reportDigest) {
    fail('SOURCE_INVALID', 'reportDigest does not match canonical summary body');
  }

  const validated = canonicalize({ ...value, ...normalized, frozenSplitCounts: counts });
  assertFrozenSplitPolicy(validated, counts);
  return validated;
}

function parseSummaryText(summaryText) {
  if (typeof summaryText !== 'string') {
    fail('SOURCE_INVALID', 'summaryText must be UTF-8 JSON text');
  }
  if (Buffer.byteLength(summaryText, 'utf8') > MAX_SUMMARY_BYTES) {
    fail('SOURCE_INVALID', `summaryText exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(summaryText);
  } catch {
    fail('SOURCE_INVALID', 'summaryText is not valid JSON');
  }
  return validateV3LiquidityIndependenceSummary(value);
}

function validateAuthenticatedSource(authenticatedSource, summary) {
  if (!authenticatedSource || typeof authenticatedSource !== 'object' || Array.isArray(authenticatedSource)) {
    fail('SOURCE_UNAUTHENTICATED', 'authenticatedSource metadata is required');
  }

  const workflowRunId = numericId(authenticatedSource.workflowRunId, 'authenticatedSource.workflowRunId');
  const artifactId = numericId(authenticatedSource.artifactId, 'authenticatedSource.artifactId');
  const runAttempt = integerCount(authenticatedSource.runAttempt, 'authenticatedSource.runAttempt');
  const artifactName = String(authenticatedSource.artifactName ?? '');
  const expectedArtifactName =
    `public-forward-liquidity-v3-authoritative-independence-slot-${summary.targetSlotIndex}-${workflowRunId}-${runAttempt}`;

  const valid = authenticatedSource.workflowName === WORKFLOW_NAME
    && authenticatedSource.event === SOURCE_EVENT
    && authenticatedSource.branch === SOURCE_BRANCH
    && authenticatedSource.conclusion === SOURCE_CONCLUSION
    && runAttempt === 1
    && String(authenticatedSource.headSha ?? '') === summary.producerSha
    && artifactName === expectedArtifactName
    && GITHUB_ARTIFACT_DIGEST_PATTERN.test(String(authenticatedSource.artifactDigest ?? ''));

  if (!valid) {
    fail('SOURCE_UNAUTHENTICATED', 'source metadata does not bind to the authoritative #813 workflow artifact');
  }

  return Object.freeze({
    workflowRunId,
    artifactId,
    artifactName,
    artifactDigest: authenticatedSource.artifactDigest,
  });
}

async function validateStateRoot(stateRoot) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    fail('STATE_ROOT_INVALID', 'stateRoot must be an absolute path');
  }
  const resolvedRoot = resolve(stateRoot);
  let metadata;
  try {
    metadata = await lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('STATE_ROOT_MISSING', 'stateRoot must already exist');
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('STATE_ROOT_INVALID', 'stateRoot must be a real directory, not a symlink');
  }
  const actualRoot = await realpath(resolvedRoot);
  if (actualRoot !== resolvedRoot) {
    fail('STATE_ROOT_INVALID', 'stateRoot path must not traverse symlinks');
  }
  return resolvedRoot;
}

async function ensureSafeChildDirectory(root, components) {
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o750 });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('TARGET_PATH_UNSAFE', `state child ${component} must be a real directory`);
    }
    const actual = await realpath(current);
    if (actual !== current || !(actual === root || actual.startsWith(`${root}${sep}`))) {
      fail('TARGET_PATH_UNSAFE', 'target directory escaped the verified stateRoot');
    }
  }
  return current;
}

async function readExistingTarget(targetPath) {
  let metadata;
  try {
    metadata = await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail('TARGET_PATH_UNSAFE', 'existing target must be a real regular file');
  }
  if (metadata.size > MAX_SUMMARY_BYTES) {
    fail('EXISTING_INVALID', 'existing target exceeds maximum summary size');
  }
  const bytes = await readFile(targetPath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('EXISTING_INVALID', 'existing target is not valid JSON');
  }
  let summary;
  try {
    summary = validateV3LiquidityIndependenceSummary(value);
  } catch (error) {
    if (error instanceof V3LiquidityIndependencePublisherError) {
      fail('EXISTING_INVALID', `existing target failed validation: ${error.message}`);
    }
    throw error;
  }
  return Object.freeze({ summary, bytes, fileDigest: sha256(bytes) });
}

function assertMonotonicAdvance(existing, incoming) {
  if (incoming.targetSlotIndex < existing.targetSlotIndex) {
    fail('STALE_SOURCE', 'incoming targetSlotIndex is older than the published target');
  }
  if (incoming.targetSlotIndex === existing.targetSlotIndex) {
    if (incoming.reportDigest === existing.reportDigest) return 'UNCHANGED';
    fail('SAME_SLOT_CONFLICT', 'same target slot has a different authenticated reportDigest');
  }

  for (const key of CUMULATIVE_COUNT_KEYS) {
    if (incoming[key] < existing[key]) {
      fail('ROLLBACK_DETECTED', `${key} decreased across a newer target slot`);
    }
  }
  for (const key of SPLIT_COUNT_KEYS) {
    if (incoming.frozenSplitCounts[key] < existing.frozenSplitCounts[key]) {
      fail('ROLLBACK_DETECTED', `frozenSplitCounts.${key} decreased across a newer target slot`);
    }
  }
  return 'ADVANCE';
}

async function acquirePublishLock(directory) {
  const lockPath = join(directory, '.v3-authoritative-independence-summary.publish.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      fail('PUBLISH_BUSY', 'another cooperative V3 independence publication is in progress');
    }
    throw error;
  }

  return async () => {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  };
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteVerified(targetPath, directory, bytes) {
  const tempPath = join(
    directory,
    `.v3-authoritative-independence-summary.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o640);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  const metadata = await lstat(targetPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail('READBACK_FAILED', 'published target is not a regular file');
  }
  const readback = await readFile(targetPath);
  if (!readback.equals(bytes)) {
    fail('READBACK_FAILED', 'published bytes differ from the verified source bytes');
  }
  const parsed = JSON.parse(readback.toString('utf8'));
  validateV3LiquidityIndependenceSummary(parsed);
  return Object.freeze({ bytes: readback, fileDigest: sha256(readback) });
}

export async function publishV3LiquidityIndependenceSummary({
  stateRoot,
  summaryText,
  authenticatedSource,
}) {
  // Validate source truth completely before mutating even a child directory.
  const incoming = parseSummaryText(summaryText);
  const source = validateAuthenticatedSource(authenticatedSource, incoming);
  const root = await validateStateRoot(stateRoot);
  const directory = await ensureSafeChildDirectory(root, V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH.slice(0, -1));
  const targetPath = join(directory, V3_INDEPENDENCE_SUMMARY_RELATIVE_PATH.at(-1));
  const releaseLock = await acquirePublishLock(directory);

  try {
    const existing = await readExistingTarget(targetPath);

    if (existing) {
      const disposition = assertMonotonicAdvance(existing.summary, incoming);
      if (disposition === 'UNCHANGED') {
        return Object.freeze({
          status: 'UNCHANGED',
          targetPath,
          targetSlotIndex: incoming.targetSlotIndex,
          reportDigest: incoming.reportDigest,
          fileDigest: existing.fileDigest,
          source,
        });
      }
    }

    // Deterministic, bounded JSON bytes; reportDigest remains the producer's body digest.
    const bytes = Buffer.from(`${JSON.stringify(canonicalize(incoming), null, 2)}\n`, 'utf8');
    const readback = await atomicWriteVerified(targetPath, directory, bytes);

    return Object.freeze({
      status: 'PUBLISHED',
      targetPath,
      targetSlotIndex: incoming.targetSlotIndex,
      reportDigest: incoming.reportDigest,
      fileDigest: readback.fileDigest,
      replacedExisting: Boolean(existing),
      source,
    });
  } finally {
    await releaseLock();
  }
}
