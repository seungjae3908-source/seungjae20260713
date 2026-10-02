import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  SNAPSHOT_BRIDGE_SCHEMA_VERSION,
  bridgePaperForwardNoDeploySnapshot,
} from '../../ops/bridge-paper-forward-no-deploy-snapshot.mjs';
import {
  createImmutablePaperTradingStateSnapshot,
} from '../runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs';

const OLD_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const PUBLISHER_DIGEST = 'c'.repeat(64);
const BEFORE_MS = Date.parse('2026-09-15T03:00:00.000Z');
const NOW_MS = Date.parse('2026-09-15T04:00:00.000Z');
const RUNTIME_BUNDLE = fileURLToPath(new URL(
  '../runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs',
  import.meta.url,
));
const RUNTIME_MANIFEST = fileURLToPath(new URL(
  '../runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.manifest.json',
  import.meta.url,
));

function paperState({ open = false } = {}) {
  return {
    schemaVersion: 1,
    account: {
      id: 'paper_account_1',
      initialBalance: 10_000,
      cashBalance: 10_010,
      realizedPnl: 10,
      unrealizedPnl: 0,
      equity: 10_010,
      usedMargin: 0,
      availableMargin: 10_010,
      createdAt: '2026-09-15T02:00:00.000Z',
      updatedAt: '2026-09-15T03:00:00.000Z',
    },
    orders: [],
    positions: open ? [{
      id: 'position-1', symbol: 'BTCUSDT', status: 'open', remainingQuantity: 0.1,
      currentPrice: 65_000, notionalValue: 6_500,
    }] : [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: '2026-09-15',
      weekKey: '2026-W38',
      dailyRealizedPnl: 10,
      weeklyRealizedPnl: 10,
      consecutiveLosses: 0,
    },
    processedEventIds: ['paper-flat-recovery:existing'],
    createdAt: '2026-09-15T02:00:00.000Z',
    updatedAt: '2026-09-15T03:00:00.000Z',
  };
}

function economicState(state) {
  const copy = structuredClone(state);
  delete copy.updatedAt;
  delete copy.account.updatedAt;
  delete copy.processedEventIds;
  return copy;
}

async function fixture({ open = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'paper-no-deploy-snapshot-bridge-'));
  const bindingPath = join(root, 'publisher-binding.json');
  const sourceSnapshotPath = join(root, 'publisher', 'paper-state-v2.json');
  const outputSnapshotPath = join(root, 'publisher', '.paper-state-v2.bridged');
  await mkdir(dirname(sourceSnapshotPath), { recursive: true });
  const snapshot = createImmutablePaperTradingStateSnapshot({
    state: paperState({ open }),
    sourceOwner: 'authenticated-paper-trading-evaluate-v2',
    sourceSha: OLD_SHA,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: ['authenticated-member-session'],
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    observedAtMs: BEFORE_MS,
    maximumAgeMs: 3_900_000,
  });
  await writeFile(sourceSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(bindingPath, `${JSON.stringify({
    schemaVersion: 'paper-state-publisher-runtime-binding-v1',
    paperRuntimeSourceSha: TARGET_SHA,
    snapshotPath: sourceSnapshotPath,
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  }, null, 2)}\n`);
  return { root, bindingPath, sourceSnapshotPath, outputSnapshotPath, snapshot };
}

test('isolated target runtime stages an exact-SHA flat snapshot without economic mutation', async () => {
  const value = await fixture();
  const evidence = await bridgePaperForwardNoDeploySnapshot({
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER_DIGEST,
    bindingPath: value.bindingPath,
    sourceSnapshotPath: value.sourceSnapshotPath,
    outputSnapshotPath: value.outputSnapshotPath,
    runtimeBundlePath: RUNTIME_BUNDLE,
    runtimeManifestPath: RUNTIME_MANIFEST,
    nowMs: NOW_MS,
  });
  const bridged = JSON.parse(await readFile(value.outputSnapshotPath, 'utf8'));

  assert.equal(evidence.schemaVersion, SNAPSHOT_BRIDGE_SCHEMA_VERSION);
  assert.equal(evidence.status, 'TARGET_SNAPSHOT_STAGED');
  assert.equal(evidence.sourceShaBefore, OLD_SHA);
  assert.equal(evidence.sourceShaAfter, TARGET_SHA);
  assert.equal(evidence.economicStatePreserved, true);
  assert.equal(evidence.snapshotCommitted, false);
  assert.equal(evidence.scheduleMutation, 0);
  assert.equal(evidence.productionAppMutation, 0);
  assert.equal(evidence.productionDbMutation, 0);
  assert.equal(evidence.privateBrokerExchangeApi, 0);
  assert.equal(evidence.realOrder, 0);
  assert.equal(evidence.naturalCycleCredit, 0);
  assert.equal(bridged.sourceSha, TARGET_SHA);
  assert.equal(bridged.sourceOwner, SNAPSHOT_BRIDGE_SCHEMA_VERSION);
  assert.equal(bridged.state.updatedAt, new Date(NOW_MS).toISOString());
  assert.equal(bridged.state.account.updatedAt, new Date(NOW_MS).toISOString());
  assert.deepEqual(economicState(bridged.state), economicState(value.snapshot.state));
  assert.equal(bridged.state.processedEventIds.length, value.snapshot.state.processedEventIds.length + 1);
});

test('bridge fails closed for non-flat state before creating output', async () => {
  const value = await fixture({ open: true });
  await assert.rejects(
    bridgePaperForwardNoDeploySnapshot({
      targetSha: TARGET_SHA,
      publisherDigest: PUBLISHER_DIGEST,
      bindingPath: value.bindingPath,
      sourceSnapshotPath: value.sourceSnapshotPath,
      outputSnapshotPath: value.outputSnapshotPath,
      runtimeBundlePath: RUNTIME_BUNDLE,
      runtimeManifestPath: RUNTIME_MANIFEST,
      nowMs: NOW_MS,
    }),
    /SNAPSHOT_NOT_FLAT/,
  );
  await assert.rejects(access(value.outputSnapshotPath));
});

test('bridge fails closed when the target runtime bundle does not match its manifest', async () => {
  const value = await fixture();
  const tamperedRuntime = join(value.root, 'authoritative-paper-runtime-v1.mjs');
  await copyFile(RUNTIME_BUNDLE, tamperedRuntime);
  await writeFile(tamperedRuntime, '\n// tampered\n', { flag: 'a' });
  await assert.rejects(
    bridgePaperForwardNoDeploySnapshot({
      targetSha: TARGET_SHA,
      publisherDigest: PUBLISHER_DIGEST,
      bindingPath: value.bindingPath,
      sourceSnapshotPath: value.sourceSnapshotPath,
      outputSnapshotPath: value.outputSnapshotPath,
      runtimeBundlePath: tamperedRuntime,
      runtimeManifestPath: RUNTIME_MANIFEST,
      nowMs: NOW_MS,
    }),
    /SNAPSHOT_BRIDGE_RUNTIME_MANIFEST_INVALID/,
  );
  await assert.rejects(access(value.outputSnapshotPath));
});
