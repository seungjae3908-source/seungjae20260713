import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  V3IndependenceProductionCallerError,
  runV3IndependenceProductionPublication,
} from '../bin/publish-v3-independence.mjs';
import { V3LiquidityIndependencePublisherError } from '../src/v3-liquidity-independence-state-publisher.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function bodyDigest(body) {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function makeSummary({ slot = 48, trainBuy = 3, trainSell = 2 } = {}) {
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
    rawAcceptedN: 110,
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
  };
  body.reportDigest = bodyDigest(body);
  return body;
}

function makeSource(summary, { branch = 'main' } = {}) {
  const workflowRunId = 33935881010;
  return {
    workflowName: 'Public Forward Liquidity V3 Independence Consume',
    workflowRunId,
    runAttempt: 1,
    event: 'workflow_run',
    branch,
    conclusion: 'success',
    headSha: summary.producerSha,
    artifactId: 9960137408,
    artifactName: `public-forward-liquidity-v3-authoritative-independence-slot-${summary.targetSlotIndex}-${workflowRunId}-1`,
    artifactDigest: `sha256:${'1'.repeat(64)}`,
  };
}

const repoRoot = resolve(process.cwd());
const exactCodeSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

async function withInputs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'v3-production-caller-'));
  const summary = makeSummary();
  const summaryFile = join(root, 'summary.json');
  const sourceFile = join(root, 'source.json');
  await writeFile(summaryFile, `${JSON.stringify(summary)}\n`);
  await writeFile(sourceFile, `${JSON.stringify(makeSource(summary))}\n`);
  try {
    await fn({ root, summary, summaryFile, sourceFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function callerCode(code) {
  return (error) => error instanceof V3IndependenceProductionCallerError && error.code === code;
}

function publisherCode(code) {
  return (error) => error instanceof V3LiquidityIndependencePublisherError && error.code === code;
}

test('binds repoRoot identity to command-scoped git safe.directory without global mutation', async () => {
  const callerSource = await readFile(
    resolve(repoRoot, 'research-production/bin/publish-v3-independence.mjs'),
    'utf8',
  );
  assert.equal(
    callerSource.includes("['-c', `safe.directory=${physicalRoot}`, '-C', physicalRoot, 'rev-parse', 'HEAD']"),
    true,
  );
  assert.equal(callerSource.includes('git config --global'), false);
});

test('publishes authenticated #813 evidence through the production caller with zero authority', async () => {
  await withInputs(async ({ root, summary, summaryFile, sourceFile }) => {
    const result = await runV3IndependenceProductionPublication({
      stateRoot: root,
      summaryFile,
      sourceFile,
      repoRoot,
      expectedCodeSha: exactCodeSha,
      environment: {},
    });

    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.codeSha, exactCodeSha);
    assert.equal(result.targetSlotIndex, summary.targetSlotIndex);
    assert.equal(result.effectiveIndependentN, 5);
    assert.equal(result.independentBuyN, 3);
    assert.equal(result.independentSellN, 2);
    assert.equal(result.oosOutcomeCredit, 0);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceComplete, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.liveTrading, false);
    assert.equal(result.privateApi, false);
    assert.equal(result.realOrders, 0);

    const persisted = JSON.parse(await readFile(result.targetPath, 'utf8'));
    assert.equal(persisted.reportDigest, summary.reportDigest);
  });
});

test('same authenticated slot is idempotent and returns UNCHANGED', async () => {
  await withInputs(async ({ root, summaryFile, sourceFile }) => {
    const args = {
      stateRoot: root,
      summaryFile,
      sourceFile,
      repoRoot,
      expectedCodeSha: exactCodeSha,
      environment: {},
    };
    const first = await runV3IndependenceProductionPublication(args);
    const before = await readFile(first.targetPath);
    const second = await runV3IndependenceProductionPublication(args);
    assert.equal(second.status, 'UNCHANGED');
    assert.deepEqual(await readFile(first.targetPath), before);
  });
});

test('rejects caller checkout mismatch before Research state mutation', async () => {
  await withInputs(async ({ root, summaryFile, sourceFile }) => {
    await assert.rejects(
      runV3IndependenceProductionPublication({
        stateRoot: root,
        summaryFile,
        sourceFile,
        repoRoot,
        expectedCodeSha: '0'.repeat(40),
        environment: {},
      }),
      callerCode('CODE_IDENTITY_MISMATCH'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});

test('rejects live/private/order authority before Research state mutation', async () => {
  await withInputs(async ({ root, summaryFile, sourceFile }) => {
    await assert.rejects(
      runV3IndependenceProductionPublication({
        stateRoot: root,
        summaryFile,
        sourceFile,
        repoRoot,
        expectedCodeSha: exactCodeSha,
        environment: { LIVE_TRADING: 'true' },
      }),
      callerCode('AUTHORITY_ESCALATION_BLOCKED'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});

test('rejects non-authoritative source metadata without publishing', async () => {
  await withInputs(async ({ root, summary, summaryFile, sourceFile }) => {
    await writeFile(sourceFile, `${JSON.stringify(makeSource(summary, { branch: 'feature' }))}\n`);
    await assert.rejects(
      runV3IndependenceProductionPublication({
        stateRoot: root,
        summaryFile,
        sourceFile,
        repoRoot,
        expectedCodeSha: exactCodeSha,
        environment: {},
      }),
      publisherCode('SOURCE_UNAUTHENTICATED'),
    );
    await assert.rejects(lstat(join(root, 'forward')), { code: 'ENOENT' });
  });
});
