import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const verdictPath = path.resolve(process.argv[2] ?? 'staging-artifacts/staging-verdict.json');
const targetSha = String(process.env.TARGET_SHA ?? process.argv[3] ?? '').trim().toLowerCase();

const fail = (message) => {
  console.error(`[staging-verdict] ${message}`);
  process.exit(1);
};

if (!/^[0-9a-f]{40}$/.test(targetSha)) fail('an exact lowercase TARGET_SHA is required');
if (!fs.existsSync(verdictPath)) fail(`verdict file is missing: ${verdictPath}`);

const verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
const requiredFields = [
  'target_sha',
  'deployed_sha',
  'total',
  'passed',
  'failed',
  'skipped',
  'console_errors',
  'unexpected_http_errors',
  'pm2_status',
  'restart_count',
  'release_ready',
  'verdict',
];
for (const field of requiredFields) {
  if (!(field in verdict)) fail(`required field is missing: ${field}`);
}

if (verdict.target_sha !== targetSha) fail(`target SHA mismatch: ${verdict.target_sha}`);
if (verdict.deployed_sha !== targetSha) fail(`deployed SHA mismatch: ${verdict.deployed_sha}`);
if (verdict.release_ready !== true) fail('release_ready is not true');
if (verdict.failed !== 0) fail(`failed checks must be 0, found ${verdict.failed}`);
if (verdict.skipped !== 0) fail(`skipped checks must be 0, found ${verdict.skipped}`);
if (verdict.total !== verdict.passed + verdict.failed + verdict.skipped) fail('test totals are inconsistent');
if (verdict.total <= 0 || verdict.passed !== verdict.total) fail('all defined checks must pass');
if (verdict.console_errors !== 0) fail(`console errors must be 0, found ${verdict.console_errors}`);
if ((verdict.page_errors ?? 0) !== 0) fail(`page errors must be 0, found ${verdict.page_errors}`);
if ((verdict.unhandled_rejections ?? 0) !== 0) fail(`unhandled rejections must be 0, found ${verdict.unhandled_rejections}`);
if (verdict.unexpected_http_errors !== 0) fail(`unexpected HTTP errors must be 0, found ${verdict.unexpected_http_errors}`);
if (verdict.pm2_status !== 'online') fail(`PM2 status must be online, found ${verdict.pm2_status}`);
if (!Number.isInteger(verdict.restart_count) || verdict.restart_count < 0) fail('restart_count must be a non-negative integer');
if ((verdict.restart_count_delta ?? -1) !== 0) fail(`PM2 restart count changed during stability probe: ${verdict.restart_count_delta}`);
if (verdict.verdict !== '정의된 검증 범위 내 미발견 오류 0개 — 운영 배포 가능') fail('success verdict text is not exact');

console.log('[staging-verdict] release-ready verdict verified');
console.log(`- target SHA: ${targetSha}`);
console.log(`- checks: ${verdict.passed}/${verdict.total} passed`);
console.log('- failed: 0');
console.log('- skipped: 0');
console.log('- browser/runtime/PM2 gate: passed');
