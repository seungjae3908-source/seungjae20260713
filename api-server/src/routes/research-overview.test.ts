import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import { createResearchOverviewHandler } from './research-overview';

function overview() {
  return {
    schemaVersion: 'research-dashboard-overview-v1', generatedAt: Date.now(),
    state: { present: false, latestCycleAt: null },
    safety: { readOnlyDashboard: true, liveTrading: false, privateApi: false, orderAuthority: false, authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
    research: { status: 'missing', failedTasks: null, blockedDataTasks: null, cycles: [] },
    paper: { runtime: { present: false, status: 'not_started', safetyEvidenceComplete: false, lanes: [], privateRequestCount: null, financialMutationCount: null, orderCount: null, liveTrading: null, orderAuthority: null }, ledger: { present: false, cycleCount: null, positionCount: null, settlementCount: null } },
    shadow: { groups: [], records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null } },
    profitability: { proven: false, status: 'NOT_PROVEN', note: '근거 미수집' },
  };
}
async function response(read: typeof fetch) {
  const result = { status: 200, headers: {} as Record<string, unknown>, body: null as unknown };
  const res = { setHeader: (key: string, value: unknown) => { result.headers[key] = value; }, status: (value: number) => { result.status = value; return res; }, json: (value: unknown) => { result.body = value; return res; } };
  await createResearchOverviewHandler(read)({ query: { url: 'https://attacker.invalid' } } as unknown as Request, res as unknown as Response, () => {});
  return result;
}
test('member readback uses only fixed GET loopback and drops private upstream fields', async () => {
  let calls = 0;
  const result = await response(async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:18090/api/research/overview');
    assert.equal(init?.method, 'GET');
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ ...overview(), accountId: 'private-account', apiKey: 'private-key' }), { status: 200 });
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(result.headers.Vary, 'Authorization, Cookie');
  assert.ok(!JSON.stringify(result.body).includes('private-account'));
  assert.ok(!JSON.stringify(result.body).includes('private-key'));
});
test('failure and unsafe upstream state are unavailable, never fabricated healthy zero', async () => {
  for (const read of [async () => new Response('{}', { status: 503 }), async () => new Response(JSON.stringify({ ...overview(), safety: { liveTrading: true } })), async () => { throw new Error('secret connection detail'); }]) {
    const result = await response(read as typeof fetch);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'RESEARCH_DASHBOARD_UNAVAILABLE', message: '연구 상태를 불러오지 못했습니다.' });
  }
});
test('member GET is mounted after authentication while admin AI mutation remains isolated', () => {
  const root = /[\\/]api-server$/.test(process.cwd()) ? '..' : '.';
  const index = readFileSync(`${root}/api-server/src/routes/index.ts`, 'utf8');
  const mount = "router.use('/research', requireCapability('canAccessBasicInfo'), researchOverviewRouter);";
  assert.ok(index.indexOf(mount) > index.indexOf('router.use(requireAuthenticated);'));
  const copilot = readFileSync(`${root}/api-server/src/routes/research-copilot.ts`, 'utf8');
  assert.match(copilot, /requireAdmin/);
  const route = readFileSync(`${root}/api-server/src/routes/research-overview.ts`, 'utf8');
  assert.doesNotMatch(route, /router\.(?:post|put|patch|delete)\(/);
});
