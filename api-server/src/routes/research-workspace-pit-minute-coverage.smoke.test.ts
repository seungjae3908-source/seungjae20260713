import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createResearchWorkspaceRouter } from './research-workspace';
import { sealPITMinuteDayCompactReceiptV1 } from
  '../../../market-prediction-lab/src/four-market-pit-minute-compact-selected-window-v1.js';

const DAY = 86_400_000;
const D0 = Date.parse('2026-09-18T00:00:00Z');
const shaA = 'a'.repeat(64);
const endpoint = '/api/research/video/evidence/workspace/pit-minute-coverage';
const parameters = '?market=CRYPTO_SPOT&startDate=2026-09-18&endDate=2026-09-19&chunkDays=7';

function onePrivateCompactReceipt() {
  const manifest = {
    sourceClass: 'TEST_FIXTURE', sourceId: 'TEST_ADMIN_READ_ONLY_PROVENANCE',
    rawMembershipDigestSha256: shaA,
    coverageStartMs: D0 - 90 * DAY, coverageEndMs: D0 + 90 * DAY,
  };
  const summary = {
    market: 'CRYPTO_SPOT', venue: 'UPBIT_KRW',
    tradingDate: '2026-09-18', dateBasis: 'UTC_CRYPTO_DAY',
    status: 'INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY',
    reason: 'HISTORICAL_MEMBER_MINUTE_SOURCE_MISSING_PARTIAL_OR_BLOCKED',
    pitRosterDigestSha256: shaA,
    pitRosterSourceId: manifest.sourceId,
    pitGateStatus: 'TEST_FIXTURE_ONLY', sourceStatus: 'TEST_FIXTURE_ONLY',
    sessionCalendarDigestSha256: 'b'.repeat(64),
    pageReceiptDigestsSha256: 'c'.repeat(64),
    completeDayPageAudit: true,
    archivedMembers: 0, missingSourceMembers: 2,
    sourceLimitedMembers: 0, revisedSourceMembers: 0,
    unreadableMembers: 0, lifecycleBlockedMembers: 0,
    sourceMinuteRows: 0, sourceSessionsCovered: 0,
    retrospectiveSourceMembers: 0, retrospectiveMinuteRows: 0,
    missingSourceSessionCount: 2,
    inspectedPITMemberCount: 2, archiveReceiptPageCount: 1,
    localArchiveRowsPresentForEverySelectedPITMember: false,
    historicallyDelistedMembersPreservedInManifest: true,
    checkedArchiveSourcesOnly: true,
    retrospectiveMinutesAreNotAsOfScannerEvidence: true,
    stockCalendarIndependentlyAuthenticated: false,
    fullMarketOpportunityDenominatorVerified: false,
    trueMarketWideRecall: null, actualFillCount: null,
    profitabilityProven: false, executionAuthority: 'NONE',
    liveTrading: false, autoTrading: false, realOrders: false,
  };
  return sealPITMinuteDayCompactReceiptV1({ summary, manifest });
}
async function responseData(r: Response) {
  const body = await r.text();
  assert.match(r.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(body, /(?:api[_-]?key|authorization|password|private.?key|stack|\/root\/|\/home\/|\/var\/)/i);
  return JSON.parse(body) as Record<string, any>;
}

test('research minute source admin HTTP: auth, GET only, private compact output, PIT fail closed', async () => {
  const prior = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
    root: process.env.RESEARCH_PIT_MINUTE_COVERAGE_ROOT,
  };
  process.env.SUPABASE_URL = 'http://127.0.0.1:1/TEST_AUTH_CONFIG_ONLY';
  process.env.SUPABASE_ANON_KEY = 'TEST_ANON_PUBLIC_KEY';
  delete process.env.RESEARCH_PIT_MINUTE_COVERAGE_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'pit-minute-http-readonly-'));
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use((req: AuthenticatedRequest, _res, next) => {
    const role = req.header('x-fixture-role');
    if (!role || role === 'anonymous') return next();
    const admin = role === 'admin';
    req.member = {
      id: '11111111-1111-1111-1111-111111111111',
      login_name: 'test', display_name: 'test',
      role: admin ? 'admin' : 'user',
      membership_level: admin ? 'admin' : 'regular',
      status: 'approved', is_active: true,
    };
    req.accessToken = 'TEST_ONLY_NO_REMOTE_AUTH';
    next();
  });
  app.use('/api/research/video/evidence/workspace', createResearchWorkspaceRouter());
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const admin = { 'x-fixture-role': 'admin' };
    const member = { 'x-fixture-role': 'member' };

    // Parent/current profile capability gate must run before touching source.
    assert.equal((await fetch(base + endpoint + parameters)).status, 401);
    assert.equal((await fetch(base + endpoint + parameters, {
      headers: member,
    })).status, 403);

    const unset = await fetch(base + endpoint + parameters, { headers: admin });
    assert.equal(unset.status, 200);
    assert.match(unset.headers.get('cache-control') ?? '', /no-store/);
    assert.match(unset.headers.get('vary') ?? '', /Authorization/);
    assert.equal(unset.headers.get('x-content-type-options'), 'nosniff');
    const blocked = await responseData(unset);
    assert.equal(blocked.available, false);
    assert.equal(blocked.reason, 'SERVER_REPORT_ROOT_NOT_CONFIGURED');
    assert.equal(blocked.executionAuthority, 'NONE');
    assert.equal(blocked.trueMarketWideRecall, null);

    for (const bad of [
      '?market=CRYPTO_SPOT&startDate=2026-02-30&endDate=2026-03-01',
      '?market=CRYPTO_SPOT&startDate=2026-09-20&endDate=2026-09-18',
      '?market=CRYPTO_SPOT&startDate=2026-09-18&endDate=2026-09-19&cursorDate=2026-09-20',
      '?market=CRYPTO_SPOT&startDate=2026-09-18&endDate=2026-09-19&chunkDays=99',
      '?market=CRYPTO_SPOT&startDate=2026-09-18&endDate=2026-09-19&root=%2Fetc%2Fpasswd',
      '?market=CRYPTO_SPOT&market=KR_STOCK&startDate=2026-09-18&endDate=2026-09-19',
    ]) {
      const r = await fetch(base + endpoint + bad, { headers: admin });
      assert.equal(r.status, 400, bad);
      assert.equal((await responseData(r)).reason, 'INVALID_SELECTION');
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const r = await fetch(base + endpoint + parameters, { method, headers: admin });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'GET');
    }

    process.env.RESEARCH_PIT_MINUTE_COVERAGE_ROOT = root;
    const absent = await responseData(await fetch(base + endpoint + parameters, {
      headers: admin,
    }));
    assert.equal(absent.available, false);
    assert.equal(absent.reason, 'MARKET_COMPACT_REPORTS_NOT_PRESENT');

    const marketDir = join(root, 'CRYPTO_SPOT');
    mkdirSync(marketDir, { mode: 0o700 });
    writeFileSync(join(marketDir, '2026-09-18.json'),
      JSON.stringify(onePrivateCompactReceipt()), { mode: 0o600 });

    const found = await responseData(await fetch(base + endpoint + parameters, {
      headers: admin,
    }));
    assert.equal(found.available, true);
    assert.equal(found.status, 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK');
    assert.equal(found.report.expectedHistoricalTradingDays, 2);
    assert.equal(found.report.missingSourceDays, 1);
    assert.equal(found.report.dailyReadiness[1].originalMinuteRows, null);
    assert.equal(found.providerGETCount, 0);
    assert.equal(found.financialMutationCount, 0);
    assert.equal(found.profitabilityProven, false);
    assert.equal(found.executionAuthority, 'NONE');
    assert.equal(found.trueMarketWideRecall, null);

    chmodSync(join(marketDir, '2026-09-18.json'), 0o644);
    const invalid = await fetch(base + endpoint + parameters, { headers: admin });
    assert.equal(invalid.status, 503);
    const invalidBody = await responseData(invalid);
    assert.equal(invalidBody.available, false);
    assert.equal(invalidBody.reason, 'PRIVATE_COMPACT_SOURCE_READ_OR_VALIDATION_FAILED');
    assert.equal(invalidBody.executionAuthority, 'NONE');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SUPABASE_URL', prior.url);
    restore('SUPABASE_ANON_KEY', prior.key);
    restore('RESEARCH_PIT_MINUTE_COVERAGE_ROOT', prior.root);
  }
});
