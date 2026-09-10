import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  V3LiquidityIndependencePublisherError,
  publishV3LiquidityIndependenceSummary,
  validateV3LiquidityIndependenceSummary,
} from '../src/v3-liquidity-independence-state-publisher.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digestBody(body) {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function makeSummary({ slot = 48, trainBuy = 3, trainSell = 2, rawAcceptedN = 110, overrides = {} } = {}) {
  const train = trainBuy + trainSell;
  const body = {
    schemaVersion: 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
    producerSha: 'a'.repeat(40),
    upstreamIngestRunId: 33935833024,
    upstreamIngestArtifactId: 9937249632,
    upstreamIngestArtifactDigest: 'b'.repeat(64),
    sourceInventoryDigest: 'c'.repeat(64),
    targetSlotIndex: slot,
    genuineScheduledSlotN: train,
    rawAcceptedN,
    effectiveIndependentN: train,
    independentBuyN: trainBuy,
    independentSellN: trainSell,
    independenceAuditDigest: 'd'.repeat(64),
    independentSplitSourceDigest: 'e'.repeat(64),
    v3IndependentSplitIndexDigest: 'f'.repeat(64),
    frozenSplitCounts: {
      TRAIN: train,
      TRAIN_BUY: trainBuy,
      TRAIN_SELL: trainSell,
      VALIDATION: 0,
      VALIDATION_BUY: 0,
      VALIDATION_SELL: 0,
      OOS: 0,
      OOS_BUY: 0,
      OOS_SELL: 0,
    },
    frozenV3SplitIndexPresent: true,
    v2SplitReceiptPresent: false,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    ...overrides,
  };
  body.reportDigest = digestBody(body);
  return body;
}

function makeSource(summary, { runId = 33935881010, overrides = {} } = {}) {
  return {
    workflowName: 'Public Forward Liquidity V3 Independence Consume',
    workflowRunId: runId,
    runAttempt: 1,
    event: 'workflow_run',
    branch: 'main',
    conclusion: 'success',
    headSha: summary.producerSha,
    artifactId: 9960137408,
    artifactName: `public-forward-liquidity-v3-authoritative-independence-slot-${summary.targetSlotIndex}-${runId}-1`,
    artifactDigest: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  };
}

function asText(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'v3-independence-publisher-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertCode(code) {
  return (error) => error instanceof V3LiquidityIndependencePublisherError && error.code === code;
}

test('publishes authenticated summary into the exact Research state path with readback verification', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary();
    const result = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(summary),
      authenticatedSource: makeSource(summary),
    });

    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.targetSlotIndex, 48);
    assert.equal(result.replacedExisting, false);
    assert.match(result.fileDigest, /^[0-9a-f]{64}$/u);
    assert.equal(
      result.targetPath,
      join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json'),
    );

    const persisted = JSON.parse(await readFile(result.targetPath, 'utf8'));
    assert.equal(validateV3LiquidityIndependenceSummary(persisted).reportDigest, summary.reportDigest);
    assert.equal(persisted.executionAuthority, 'NONE');
    assert.equal(persisted.fullCostReady, false);
    assert.equal(persisted.evidenceComplete, 0);
  });
});

test('rejects an invalid reportDigest without creating publication directories', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary();
    summary.reportDigest = '0'.repeat(64);
    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('SOURCE_INVALID'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});

test('rejects execution authority escalation and leaves state untouched', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary({ overrides: { executionAuthority: 'ORDER' } });
    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('SOURCE_INVALID'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});

test('rejects unreconciled split counts', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary();
    summary.frozenSplitCounts.TRAIN = 6;
    summary.reportDigest = digestBody(Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'reportDigest')));
    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('SOURCE_INVALID'),
    );
  });
});

test('requires metadata binding to the exact successful #813 artifact', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary();
    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary, { overrides: { branch: 'feature' } }),
      }),
      assertCode('SOURCE_UNAUTHENTICATED'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});

test('same slot and same reportDigest is idempotent and does not rewrite', async () => {
  await withRoot(async (root) => {
    const summary = makeSummary();
    const first = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(summary),
      authenticatedSource: makeSource(summary),
    });
    const before = await readFile(first.targetPath);
    const second = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(summary),
      authenticatedSource: makeSource(summary),
    });
    const after = await readFile(first.targetPath);

    assert.equal(second.status, 'UNCHANGED');
    assert.deepEqual(after, before);
  });
});

test('rejects same-slot digest conflict and preserves the published summary', async () => {
  await withRoot(async (root) => {
    const firstSummary = makeSummary();
    const first = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(firstSummary),
      authenticatedSource: makeSource(firstSummary),
    });
    const before = await readFile(first.targetPath);
    const conflict = makeSummary({ trainBuy: 4, trainSell: 1 });

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(conflict),
        authenticatedSource: makeSource(conflict),
      }),
      assertCode('SAME_SLOT_CONFLICT'),
    );
    assert.deepEqual(await readFile(first.targetPath), before);
  });
});

test('rejects an older slot and preserves the newer publication', async () => {
  await withRoot(async (root) => {
    const newer = makeSummary({ slot: 49 });
    const first = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(newer),
      authenticatedSource: makeSource(newer),
    });
    const before = await readFile(first.targetPath);
    const stale = makeSummary({ slot: 48 });

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(stale),
        authenticatedSource: makeSource(stale),
      }),
      assertCode('STALE_SOURCE'),
    );
    assert.deepEqual(await readFile(first.targetPath), before);
  });
});

test('newer slot replaces atomically only when cumulative evidence does not roll back', async () => {
  await withRoot(async (root) => {
    const firstSummary = makeSummary({ slot: 48, trainBuy: 3, trainSell: 2 });
    const first = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(firstSummary),
      authenticatedSource: makeSource(firstSummary),
    });
    const next = makeSummary({ slot: 49, trainBuy: 4, trainSell: 2, rawAcceptedN: 132 });
    const result = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(next),
      authenticatedSource: makeSource(next, { runId: 33935890000 }),
    });

    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.replacedExisting, true);
    const persisted = JSON.parse(await readFile(first.targetPath, 'utf8'));
    assert.equal(persisted.targetSlotIndex, 49);
    assert.equal(persisted.effectiveIndependentN, 6);
  });
});

test('newer slot with decreasing cumulative evidence fails closed', async () => {
  await withRoot(async (root) => {
    const firstSummary = makeSummary({ slot: 48, trainBuy: 4, trainSell: 2 });
    const first = await publishV3LiquidityIndependenceSummary({
      stateRoot: root,
      summaryText: asText(firstSummary),
      authenticatedSource: makeSource(firstSummary),
    });
    const before = await readFile(first.targetPath);
    const rollback = makeSummary({ slot: 49, trainBuy: 3, trainSell: 2 });

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(rollback),
        authenticatedSource: makeSource(rollback, { runId: 33935890000 }),
      }),
      assertCode('ROLLBACK_DETECTED'),
    );
    assert.deepEqual(await readFile(first.targetPath), before);
  });
});

test('rejects symlink state roots and symlink publication targets', async () => {
  const base = await mkdtemp(join(tmpdir(), 'v3-independence-symlink-'));
  try {
    const realRoot = join(base, 'real');
    const linkRoot = join(base, 'link');
    await mkdir(realRoot);
    await symlink(realRoot, linkRoot);
    const summary = makeSummary();

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: linkRoot,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('STATE_ROOT_INVALID'),
    );

    const safeRoot = join(base, 'safe');
    const outside = join(base, 'outside.json');
    await mkdir(join(safeRoot, 'forward', 'liquidity'), { recursive: true });
    await writeFile(outside, 'do-not-touch\n');
    const target = join(safeRoot, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json');
    await symlink(outside, target);

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: safeRoot,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('TARGET_PATH_UNSAFE'),
    );
    assert.equal(await readFile(outside, 'utf8'), 'do-not-touch\n');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('requires a pre-existing absolute state root', async () => {
  const summary = makeSummary();
  await assert.rejects(
    publishV3LiquidityIndependenceSummary({
      stateRoot: join(tmpdir(), `missing-v3-independence-${Date.now()}`),
      summaryText: asText(summary),
      authenticatedSource: makeSource(summary),
    }),
    assertCode('STATE_ROOT_MISSING'),
  );
});

test('fails closed while a cooperative publication lock is present', async () => {
  await withRoot(async (root) => {
    const directory = join(root, 'forward', 'liquidity');
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, '.v3-authoritative-independence-summary.publish.lock');
    await writeFile(lockPath, '{"owner":"test"}\n');
    const summary = makeSummary();

    await assert.rejects(
      publishV3LiquidityIndependenceSummary({
        stateRoot: root,
        summaryText: asText(summary),
        authenticatedSource: makeSource(summary),
      }),
      assertCode('PUBLISH_BUSY'),
    );
    await assert.rejects(lstat(join(directory, 'v3-authoritative-independence-summary.json')), { code: 'ENOENT' });
  });
});
