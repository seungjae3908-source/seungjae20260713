import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TARGET_SHA = '6cab952a01bc3cd5cb112991edeedeb792f51304';
const verifierPath = fileURLToPath(new URL('../../api-server/scripts/verify-staging-verdict.mjs', import.meta.url));

const currentRequiredChecks = [
  'immutable target SHA',
  'full account and browser validation enabled',
  'ephemeral staging account provisioning',
  'ephemeral staging account cleanup',
  'browser: desktop: login, refresh session retention, responsive layout, and logout []',
  'browser: mobile: login, refresh session retention, responsive layout, and logout []',
  'browser: desktop: major screens, search/detail, domestic/overseas/coin, watchlist, alerts, and settings []',
  'browser: mobile 320x740: major screens []',
  'browser: mobile 360x800: major screens []',
  'browser: mobile 390x844: major screens []',
  'browser: mobile 412x915: major screens []',
  'browser: mobile 430x932: major screens []',
  'browser: mobile: search/detail, domestic/overseas/coin, watchlist, alerts, and settings []',
  'browser console errors',
  'browser page errors',
  'unhandled browser rejections',
  'unexpected HTTP errors',
  'runtime: deployed SHA matches target',
  'runtime: internal health check',
  'runtime: internal health SHA matches target',
  'runtime: external health check',
  'runtime: external health SHA matches target',
  'runtime: PM2 process online',
  'runtime: PM2 restart count stable',
  'database migration and rollback assessment',
];

const legacyAggregateMobileCheck =
  'browser: mobile: major screens, search/detail, domestic/overseas/coin, watchlist, alerts, and settings []';

function buildVerdict(checkNames) {
  const checks = checkNames.map((name) => ({ name, status: 'passed', detail: '' }));
  return {
    target_sha: TARGET_SHA,
    deployed_sha: TARGET_SHA,
    total: checks.length,
    passed: checks.length,
    failed: 0,
    skipped: 0,
    console_errors: 0,
    page_errors: 0,
    unhandled_rejections: 0,
    unexpected_http_errors: 0,
    ephemeral_accounts_created: 4,
    ephemeral_accounts_deleted: 4,
    ephemeral_profiles_remaining: 0,
    pm2_status: 'online',
    restart_count: 265,
    restart_count_delta: 0,
    release_ready: true,
    verdict: '정의된 검증 범위 내 미발견 오류 0개 — 운영 배포 가능',
    checks,
    source_run_id: '32832213953',
  };
}

function runVerifier(checkNames) {
  const dir = mkdtempSync(join(tmpdir(), 'staging-verdict-contract-'));
  const fixturePath = join(dir, 'staging-verdict.json');
  writeFileSync(fixturePath, `${JSON.stringify(buildVerdict(checkNames), null, 2)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [verifierPath, fixturePath], {
    env: { ...process.env, TARGET_SHA },
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('Production verifier accepts the current stronger mobile Staging evidence contract', () => {
  const result = runVerifier(currentRequiredChecks);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /release-ready verdict verified/u);
});

test('every current mobile viewport remains individually release-blocking when missing', () => {
  for (const viewportCheck of currentRequiredChecks.filter((name) => /browser: mobile \d+x\d+: major screens/u.test(name))) {
    const result = runVerifier(currentRequiredChecks.filter((name) => name !== viewportCheck));
    assert.notEqual(result.status, 0, `missing ${viewportCheck} unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`required staging check is missing: ${viewportCheck.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  }
});

test('the deleted legacy aggregate mobile test name cannot substitute for current viewport evidence', () => {
  const without320 = currentRequiredChecks.filter((name) => name !== 'browser: mobile 320x740: major screens []');
  const result = runVerifier([...without320, legacyAggregateMobileCheck]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required staging check is missing: browser: mobile 320x740: major screens \[\]/u);
});
