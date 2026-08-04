#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeStagingArtifacts } from './sanitize-staging-playwright-artifacts.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-artifact-sanitizer-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

fixture((root) => {
  const report = {
    suites: [{ title: 'scanner readiness', specs: [{ ok: true }] }],
    headers: [
      { name: 'Authorization', value: 'Bearer example-token-value-123456789' },
      { name: 'cOoKiE', value: 'session=private-cookie-value' },
    ],
    access_token: 'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop',
    refresh_token: 'refresh-private-value',
    apikey: 'private-api-key-value',
    password: 'temporary-password-value',
    user: 'temporary-user@example.test',
    diagnostic: { status: 'passed', elapsedMs: 123 },
  };
  const target = write(root, 'playwright-report.json', JSON.stringify(report));
  const result = sanitizeStagingArtifacts(root);
  assert.equal(result.safe, true);
  assert.equal(result.fileCount, 1);
  const sanitized = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(sanitized.suites[0].title, 'scanner readiness');
  assert.deepEqual(sanitized.diagnostic, { status: 'passed', elapsedMs: 123 });
  assert.equal(sanitized.headers[0].value, '[REDACTED]');
  assert.equal(sanitized.headers[1].value, '[REDACTED]');
  assert.equal(sanitized.access_token, '[REDACTED]');
  assert.equal(sanitized.refresh_token, '[REDACTED]');
  assert.equal(sanitized.apikey, '[REDACTED]');
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.user, '[REDACTED_EMAIL]');
});

fixture((root) => {
  const target = write(root, 'diagnostics.txt', [
    'aUtHoRiZaTiOn: Bearer another-private-token-123456',
    'Set-Cookie=session=another-private-cookie',
    'SUPABASE_SECRET_KEY=private-supabase-key',
    'email=staging-person@example.com',
    'normal_status=passed',
  ].join('\n'));
  sanitizeStagingArtifacts(root);
  const sanitized = fs.readFileSync(target, 'utf8');
  assert.doesNotMatch(sanitized, /another-private|example\.com/);
  assert.match(sanitized, /normal_status=passed/);
});

fixture((root) => {
  write(root, 'playwright-test-results/case/trace.zip', Buffer.from('not-a-real-zip'));
  assert.throws(() => sanitizeStagingArtifacts(root), /Raw Playwright trace is forbidden/);
});

fixture((root) => {
  const binary = Buffer.concat([
    Buffer.from([0, 1, 2, 3]),
    Buffer.from('Bearer binary-private-token-123456789'),
  ]);
  write(root, 'video.webm', binary);
  assert.throws(() => sanitizeStagingArtifacts(root), /Unsafe staging artifact content/);
});

fixture((root) => {
  write(root, 'safe-diagnostics.json', JSON.stringify({
    target_sha: '7b35f8c2dee8f2e3a2025d62422cfa886e6e7d68',
    status: 'passed',
    console_errors: 0,
    page_errors: 0,
  }));
  const result = sanitizeStagingArtifacts(root);
  assert.equal(result.redactionCount, 0);
});

const repositoryRoot = path.resolve(process.cwd(), '..');
const config = fs.readFileSync(path.join(repositoryRoot, 'stock-analyzer/playwright.config.ts'), 'utf8');
const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/staging-readiness.yml'), 'utf8');
assert.match(config, /trace:\s*stagingMode\s*\?\s*'off'\s*:\s*'retain-on-failure'/);
assert.match(config, /screenshot:\s*'only-on-failure'/);
assert.match(config, /video:\s*'retain-on-failure'/);
assert.match(workflow, /name: Sanitize and verify staging artifacts before upload/);
assert.match(workflow, /id: sanitize_artifacts/);
assert.match(workflow, /node api-server\/scripts\/sanitize-staging-playwright-artifacts\.mjs "\$STAGING_ARTIFACT_DIR"/);
assert.match(workflow, /if: always\(\) && steps\.sanitize_artifacts\.outcome == 'success'/);
assert.ok(workflow.indexOf('Sanitize and verify staging artifacts before upload') < workflow.indexOf('Upload immutable staging verdict and diagnostics'));

console.log('Staging artifact sanitization contract passed.');
