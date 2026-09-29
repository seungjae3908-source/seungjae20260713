#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = path.join(here, 'build-staging-verdict.mjs');
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-verdict-http-diagnostics-'));
const targetSha = 'a'.repeat(40);

const writeJson = (name, value) => {
  fs.writeFileSync(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

try {
  writeJson('staging-bootstrap-verification.json', {
    status: 'passed',
    schema_version: 'test',
    atomic_transaction: true,
    idempotency_passes: 2,
    auth_users_copied: 0,
    profile_rows_copied: 0,
    storage_objects_copied: 0,
    credentials_recorded: false,
  });
  writeJson('playwright-report.json', {
    suites: [{
      specs: [{
        title: 'market overview evidence',
        tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed' }] }],
      }],
    }],
  });
  writeJson('staging-browser-results.json', {
    console_errors: [],
    page_errors: [],
    unhandled_rejections: [],
    unexpected_http_errors: [{
      test: 'mobile market overview',
      url: '/api/market/sector-popular?market=KR',
      status: 502,
      detail: 'GET 502 Bad Gateway',
    }],
  });
  writeJson('staging-runtime-verification.json', {
    deployed_sha: targetSha,
    pm2_status: 'online',
    restart_count: 12,
    restart_count_delta: 0,
    checks: [],
  });
  writeJson('staging-database-verification.json', { status: 'passed', detail: 'not required' });
  writeJson('staging-account-provisioning.json', { status: 'passed', created: 4, credentials_recorded: false });
  writeJson('staging-account-cleanup.json', { status: 'passed', deleted: 4, profiles_remaining: 0 });

  const run = spawnSync(process.execPath, [builder], {
    env: {
      ...process.env,
      TARGET_SHA: targetSha,
      STAGING_RUN_FULL_VALIDATION: 'true',
      STAGING_ARTIFACT_DIR: artifactDir,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    },
    encoding: 'utf8',
  });

  assert.equal(run.status, 1, 'one real HTTP error must keep release_ready fail-closed');
  const verdict = JSON.parse(fs.readFileSync(path.join(artifactDir, 'staging-verdict.json'), 'utf8'));
  assert.equal(verdict.release_ready, false);
  assert.equal(verdict.unexpected_http_errors, 1);
  assert.deepEqual(verdict.unexpected_http_error_details, [{
    test: 'mobile market overview',
    url: '/api/market/sector-popular',
    status: 502,
    detail: 'GET 502 Bad Gateway',
  }]);

  const httpCheck = verdict.checks.find((check) => check.name === 'unexpected HTTP errors');
  assert.equal(httpCheck?.status, 'failed');
  assert.match(String(httpCheck?.detail ?? ''), /\/api\/market\/sector-popular/);
  assert.match(run.stdout, /\/api\/market\/sector-popular/);
  assert.doesNotMatch(run.stdout, /\?market=KR/);

  console.log('Staging verdict HTTP diagnostics contract passed.');
} finally {
  fs.rmSync(artifactDir, { recursive: true, force: true });
}
