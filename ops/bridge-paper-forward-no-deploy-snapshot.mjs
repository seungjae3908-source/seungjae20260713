#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  createMetadataOnlyFlatRefreshState,
  validateBinding,
  validateFlatSnapshot,
} from './run-paper-forward-flat-snapshot-republish.mjs';

export const SNAPSHOT_BRIDGE_SCHEMA_VERSION = 'paper-forward-no-deploy-snapshot-bridge-v1';
const RUNTIME_MANIFEST_SCHEMA_VERSION = 'authoritative-paper-runtime-package-manifest-v1';
const MAXIMUM_PAPER_STATE_AGE_MS = 3_900_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path, code) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch { fail(code); }
  try { return JSON.parse(raw); } catch { fail(`${code}_INVALID_JSON`); }
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function bridgePaperForwardNoDeploySnapshot({
  targetSha,
  publisherDigest,
  bindingPath,
  sourceSnapshotPath,
  outputSnapshotPath,
  runtimeBundlePath,
  runtimeManifestPath,
  nowMs = Date.now(),
}) {
  if (!exactSha(targetSha)) fail('SNAPSHOT_BRIDGE_TARGET_SHA_INVALID');
  if (!digest(publisherDigest)) fail('SNAPSHOT_BRIDGE_PUBLISHER_DIGEST_INVALID');
  if (![bindingPath, sourceSnapshotPath, outputSnapshotPath, runtimeBundlePath, runtimeManifestPath]
    .every((value) => typeof value === 'string' && value.startsWith('/'))) fail('SNAPSHOT_BRIDGE_ABSOLUTE_PATH_REQUIRED');
  if (sourceSnapshotPath === outputSnapshotPath) fail('SNAPSHOT_BRIDGE_DISTINCT_OUTPUT_REQUIRED');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) fail('SNAPSHOT_BRIDGE_TIME_INVALID');

  const manifest = await readJson(runtimeManifestPath, 'SNAPSHOT_BRIDGE_RUNTIME_MANIFEST_READ_FAILED');
  const runtimeBytes = await readFile(runtimeBundlePath).catch(() => fail('SNAPSHOT_BRIDGE_RUNTIME_READ_FAILED'));
  if (manifest?.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION
    || manifest?.artifactFile !== 'authoritative-paper-runtime-v1.mjs'
    || manifest?.paperStateSnapshotSchemaVersion !== 'paper-trading-state-snapshot-v2'
    || manifest?.bundleSha256 !== sha256Bytes(runtimeBytes)
    || manifest?.safety?.executionAuthority !== 'NONE'
    || manifest?.safety?.privateApiAllowed !== false
    || manifest?.safety?.liveTrading !== false
    || manifest?.safety?.scheduleActivationAuthority !== false
    || manifest?.safety?.financialMutationAllowed !== false) fail('SNAPSHOT_BRIDGE_RUNTIME_MANIFEST_INVALID');

  const runtime = await import(pathToFileURL(runtimeBundlePath).href);
  if (typeof runtime.createImmutablePaperTradingStateSnapshot !== 'function'
    || typeof runtime.validateImmutablePaperTradingStateSnapshot !== 'function') fail('SNAPSHOT_BRIDGE_RUNTIME_EXPORT_INVALID');

  const binding = await readJson(bindingPath, 'SNAPSHOT_BRIDGE_BINDING_READ_FAILED');
  validateBinding(binding, { targetSha, publisherDigest, snapshotPath: sourceSnapshotPath });
  const beforeSnapshot = validateFlatSnapshot(
    await readJson(sourceSnapshotPath, 'SNAPSHOT_BRIDGE_SOURCE_READ_FAILED'),
    { publisherDigest },
  );
  if (beforeSnapshot.sourceSha === targetSha) fail('SNAPSHOT_BRIDGE_NOT_REQUIRED');
  if (!Array.isArray(beforeSnapshot.provenance)
    || beforeSnapshot.provenance.length === 0
    || beforeSnapshot.provenance.some((value) => typeof value !== 'string' || !value.trim())) {
    fail('SNAPSHOT_BRIDGE_SOURCE_PROVENANCE_INVALID');
  }

  const action = {
    type: 'snapshot_bridge',
    eventId: `paper-no-deploy-snapshot-bridge:${beforeSnapshot.stateDigestSha256.slice(0, 24)}:${targetSha.slice(0, 12)}`,
  };
  const nowIso = new Date(nowMs).toISOString();
  const afterState = createMetadataOnlyFlatRefreshState(beforeSnapshot.state, action, nowIso);
  const maximumAgeMs = Math.min(beforeSnapshot.maximumAgeMs, MAXIMUM_PAPER_STATE_AGE_MS);
  const bridgedSnapshot = runtime.createImmutablePaperTradingStateSnapshot({
    state: afterState,
    sourceOwner: SNAPSHOT_BRIDGE_SCHEMA_VERSION,
    sourceSha: targetSha,
    market: beforeSnapshot.market,
    currency: beforeSnapshot.currency,
    provenance: [...beforeSnapshot.provenance, SNAPSHOT_BRIDGE_SCHEMA_VERSION],
    publisherAccountIdSha256: publisherDigest,
    observedAtMs: nowMs,
    maximumAgeMs,
  });
  runtime.validateImmutablePaperTradingStateSnapshot(bridgedSnapshot, nowMs);
  validateFlatSnapshot(bridgedSnapshot, { publisherDigest, targetSha, requireFresh: true, nowMs });

  await writeJsonAtomically(outputSnapshotPath, bridgedSnapshot);
  const persisted = await readJson(outputSnapshotPath, 'SNAPSHOT_BRIDGE_OUTPUT_READ_FAILED');
  runtime.validateImmutablePaperTradingStateSnapshot(persisted, nowMs);
  validateFlatSnapshot(persisted, { publisherDigest, targetSha, requireFresh: true, nowMs });
  if (canonicalJson(persisted) !== canonicalJson(bridgedSnapshot)) fail('SNAPSHOT_BRIDGE_OUTPUT_MISMATCH');

  return Object.freeze({
    schemaVersion: SNAPSHOT_BRIDGE_SCHEMA_VERSION,
    status: 'TARGET_SNAPSHOT_STAGED',
    sourceShaBefore: beforeSnapshot.sourceSha,
    sourceShaAfter: targetSha,
    targetRuntimeVerified: true,
    publisherAccountBound: true,
    economicStatePreserved: true,
    metadataMutationCount: 1,
    snapshotCommitted: false,
    scheduleMutation: 0,
    productionAppMutation: 0,
    productionDbMutation: 0,
    secretMutation: 0,
    environmentMutation: 0,
    realFinancialMutation: 0,
    privateBrokerExchangeApi: 0,
    realOrder: 0,
    liveTrading: false,
    executionAuthority: 'NONE',
    naturalCycleCredit: 0,
    naturalSampleCredit: 0,
    naturalSettlementCredit: 0,
    sensitiveValuesEmitted: false,
  });
}

const isDirect = process.argv[1]
  && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isDirect) {
  bridgePaperForwardNoDeploySnapshot({
    targetSha: String(process.env.TARGET_SHA ?? '').trim().toLowerCase(),
    publisherDigest: String(process.env.PUBLISHER_ACCOUNT_ID_SHA256 ?? '').trim().toLowerCase(),
    bindingPath: String(process.env.PUBLISHER_BINDING_PATH ?? ''),
    sourceSnapshotPath: String(process.env.PAPER_STATE_SNAPSHOT_PATH ?? ''),
    outputSnapshotPath: String(process.env.OUTPUT_PAPER_STATE_SNAPSHOT_PATH ?? ''),
    runtimeBundlePath: String(process.env.AUTHORITATIVE_RUNTIME_BUNDLE_PATH ?? ''),
    runtimeManifestPath: String(process.env.AUTHORITATIVE_RUNTIME_MANIFEST_PATH ?? ''),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`[paper-no-deploy-snapshot-bridge] ${String(error?.code ?? error?.message ?? 'SNAPSHOT_BRIDGE_FAILED')}\n`);
    process.exit(1);
  });
}
