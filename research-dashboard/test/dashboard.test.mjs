import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildResearchOverview, createResearchDashboardServer } from '../server.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-dashboard-'));
  await mkdir(join(root, 'latest'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'status'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'state'), { recursive: true });
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
    cycles: [{ id: 1 }], positions: [{ id: 1 }], settlements: [{ id: 1 }, { id: 2 }],
  }));
  await writeFile(join(root, 'forward', 'shadow-summary.json'), JSON.stringify({ groups: {
    rule0: { total: 5, settled: 3, pending: 2, predictionHealth: { collapsed: false }, metrics: { macroF1: .51, balancedAccuracy: .55 } },
  }}));
  await writeFile(join(root, 'forward', 'shadow-state.json'), JSON.stringify({ bucket: { records: [
    { status: 'settled' }, { status: 'settled' }, { status: 'pending' },
  ]}}));
  return root;
}

test('overview exposes only summarized read-only research evidence', async () => {
  const root = await fixture();
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.safety.readOnlyDashboard, true);
  assert.equal(overview.safety.forbiddenAuthorityObserved, false);
  assert.equal(overview.paper.ledger.settlementCount, 2);
  assert.equal(overview.shadow.records.settledRecords, 2);
  assert.equal(overview.shadow.groups[0].collapsed, false);
  assert.equal(overview.profitability.proven, false);
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
