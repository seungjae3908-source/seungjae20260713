import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildResearchOverview, createResearchDashboardServer } from '../server.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function reportDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function v3Summary(overrides = {}) {
  const body = {
    schemaVersion: 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
    producerSha: '1'.repeat(40),
    upstreamIngestRunId: '33935833024',
    upstreamIngestArtifactId: '9960130145',
    upstreamIngestArtifactDigest: '2'.repeat(64),
    sourceInventoryDigest: '3'.repeat(64),
    targetSlotIndex: 48,
    genuineScheduledSlotN: 15,
    rawAcceptedN: 335,
    effectiveIndependentN: 15,
    independentBuyN: 10,
    independentSellN: 5,
    independenceAuditDigest: '4'.repeat(64),
    independentSplitSourceDigest: '5'.repeat(64),
    v3IndependentSplitIndexDigest: '6'.repeat(64),
    frozenSplitCounts: {
      TRAIN: 15,
      TRAIN_BUY: 10,
      TRAIN_SELL: 5,
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
  return { ...body, reportDigest: reportDigest(body) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-dashboard-'));
  await mkdir(join(root, 'latest'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'status'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'state'), { recursive: true });
  await mkdir(join(root, 'forward', 'liquidity'), { recursive: true });
  const now = Date.now();
  await writeFile(join(root, 'latest', 'forward.json'), JSON.stringify({
    status: 'complete', cycleId: 'cycle-1', researchSha: 'a'.repeat(40), generatedAt: now,
    concurrency: 1, taskCount: 2, successCount: 2, blockedDataCount: 0, failedCount: 0,
    results: [{ id: 'paper-forward', status: 'success', durationMs: 1000 }, { id: 'shadow-forward', status: 'success', durationMs: 2000 }],
  }));
  await writeFile(join(root, 'forward', 'paper', 'status', 'runtime-status.json'), JSON.stringify({
    status: 'running', scheduleActive: true, allProvidersReady: true,
    publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: true,
    privateRequestCount: 0, financialMutationCount: 0, orderCount: 0, liveTrading: false, orderAuthority: false,
    lanes: [{ market: 'KR', status: 'ready' }, { market: 'US', status: 'ready' }],
  }));
  await writeFile(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json'), JSON.stringify({
    cycles: [{ id: 1 }], samples: [], positions: [{ id: 1 }], settlements: [{ id: 1 }, { id: 2 }],
  }));
  await writeFile(join(root, 'forward', 'shadow-summary.json'), JSON.stringify({ groups: {
    rule0: {
      total: 5, settled: 3, pending: 2,
      candidate: {
        predictionHealth: { collapsed: false }, macroF1: .51, balancedAccuracy: .55,
        perClass: { bullish: { recall: .4 }, neutral: { recall: .5 }, bearish: { recall: 0 } },
      },
    },
  }}));
  await writeFile(join(root, 'forward', 'shadow-state.json'), JSON.stringify({
    bucket: { records: [{ status: 'settled' }, { status: 'settled' }, { status: 'pending' }] },
    groups: {
      'crypto-futures-15m': {
        canonicalEvidence: {
          handoff: {
            strategyHealthHandoff: {
              schemaVersion: 'prediction-lab-strategy-health-shadow-handoff-v1',
              strategyIdentityDigest: 'a'.repeat(64),
              evidenceDigest: 'b'.repeat(64),
              executionAuthority: 'NONE',
            },
          },
        },
      },
    },
  }));
  await writeFile(
    join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json'),
    JSON.stringify(v3Summary()),
  );
  return root;
}

test('overview exposes only summarized read-only research evidence', async () => {
  const root = await fixture();
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.safety.readOnlyDashboard, true);
  assert.equal(overview.safety.authorityEvidenceComplete, true);
  assert.equal(overview.safety.forbiddenAuthorityObserved, false);
  assert.equal(overview.paper.runtime.privateRequestCount, 0);
  assert.equal(overview.paper.runtime.liveTrading, false);
  assert.equal(overview.paper.ledger.settlementCount, 2);
  assert.equal(overview.shadow.records.settledRecords, 2);
  assert.equal(overview.shadow.groups[0].collapsed, false);
  assert.equal(overview.shadow.groups[0].bearRecall, 0);
  assert.equal(overview.shadow.canonicalHandoffs.length, 1);
  assert.equal(overview.shadow.canonicalHandoffs[0].group, 'crypto-futures-15m');
  assert.equal(overview.shadow.canonicalHandoffs[0].handoff.evidenceDigest, 'b'.repeat(64));
  assert.equal(overview.research.liquidityIndependence.status, 'PRESENT');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, 15);
  assert.equal(overview.research.liquidityIndependence.independentBuyN, 10);
  assert.equal(overview.research.liquidityIndependence.independentSellN, 5);
  assert.equal(overview.research.liquidityIndependence.frozenSplitCounts.TRAIN, 15);
  assert.equal(overview.research.liquidityIndependence.frozenSplitCounts.OOS, 0);
  assert.equal(overview.profitability.proven, false);
});

test('missing V3 independence summary stays missing instead of becoming historical seven or zero', async () => {
  const root = await fixture();
  await rm(join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json'));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.liquidityIndependence.present, false);
  assert.equal(overview.research.liquidityIndependence.status, 'MISSING');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, null);
  assert.equal(overview.research.liquidityIndependence.independentBuyN, null);
  assert.equal(overview.research.liquidityIndependence.independentSellN, null);
});

test('tampered V3 independence summary is invalidated and cannot leak partial counts', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json');
  const summary = JSON.parse(await readFile(path, 'utf8'));
  summary.effectiveIndependentN = 7;
  await writeFile(path, JSON.stringify(summary));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.research.liquidityIndependence.present, true);
  assert.equal(overview.research.liquidityIndependence.status, 'INVALID');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, null);
});

test('digest-valid downstream authority escalation is still rejected', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json');
  await writeFile(path, JSON.stringify(v3Summary({ fullCostReady: true })));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.liquidityIndependence.status, 'INVALID');
  assert.equal(overview.research.liquidityIndependence.fullCostReady, null);
  assert.equal(overview.profitability.proven, false);
});

test('missing runtime safety evidence stays missing instead of becoming zero or false', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forward', 'paper', 'status', 'runtime-status.json'), JSON.stringify({
    status: 'running', scheduleActive: true, allProvidersReady: true,
    publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: true,
    lanes: [{ market: 'KR', status: 'ready' }],
  }));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.paper.runtime.privateRequestCount, null);
  assert.equal(overview.paper.runtime.financialMutationCount, null);
  assert.equal(overview.paper.runtime.orderCount, null);
  assert.equal(overview.paper.runtime.liveTrading, null);
  assert.equal(overview.paper.runtime.orderAuthority, null);
  assert.equal(overview.paper.runtime.safetyEvidenceComplete, false);
  assert.equal(overview.safety.authorityEvidenceComplete, false);
  assert.equal(overview.safety.forbiddenAuthorityObserved, false);
  assert.equal(overview.research.status, 'safety_evidence_incomplete');
});

test('missing ledger and shadow arrays stay missing instead of becoming zero', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json'), JSON.stringify({ version: 1 }));
  await writeFile(join(root, 'forward', 'shadow-state.json'), JSON.stringify({ bucket: { status: 'empty-shape' } }));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.paper.ledger.cycleCount, null);
  assert.equal(overview.paper.ledger.positionCount, null);
  assert.equal(overview.paper.ledger.settlementCount, null);
  assert.equal(overview.shadow.records.totalRecords, null);
  assert.equal(overview.shadow.records.settledRecords, null);
  assert.equal(overview.shadow.records.pendingRecords, null);
});

test('dashboard refuses write methods', async () => {
  const root = await fixture();
  const server = createResearchDashboardServer({ stateRoot: root, publicRoot: join(process.cwd(), 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/research/overview`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error, 'read_only_dashboard');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('health endpoint declares zero trading authority', async () => {
  const root = await fixture();
  const server = createResearchDashboardServer({ stateRoot: root, publicRoot: join(process.cwd(), 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.readOnly, true);
    assert.equal(body.liveTrading, false);
    assert.equal(body.privateApi, false);
    assert.equal(body.orderAuthority, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
