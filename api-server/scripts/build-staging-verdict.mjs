import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const targetSha = String(process.env.TARGET_SHA ?? '').trim().toLowerCase();
const fullValidation = String(process.env.STAGING_RUN_FULL_VALIDATION ?? '').toLowerCase() === 'true';
const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? 'staging-artifacts');
const outputPath = path.join(artifactDir, 'staging-verdict.json');

const readJson = (name) => {
  const filePath = path.join(artifactDir, name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const playwright = readJson('playwright-report.json');
const browser = readJson('staging-browser-results.json');
const runtime = readJson('staging-runtime-verification.json');
const database = readJson('staging-database-verification.json');
const accountProvisioning = readJson('staging-account-provisioning.json');
const accountCleanup = readJson('staging-account-cleanup.json');

let passed = 0;
let failed = 0;
let skipped = 0;
const checks = [];

const addCheck = (name, status, detail = '') => {
  if (!['passed', 'failed', 'skipped'].includes(status)) {
    throw new Error(`Invalid staging check status for ${name}: ${status}`);
  }
  checks.push({ name, status, detail });
  if (status === 'passed') passed += 1;
  if (status === 'failed') failed += 1;
  if (status === 'skipped') skipped += 1;
};

const countPlaywright = (report) => {
  const records = [];
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) {
        const results = Array.isArray(test.results) ? test.results : [];
        const lastResult = results.at(-1);
        const resultStatus = lastResult?.status;
        const status = test.status === 'skipped' || resultStatus === 'skipped'
          ? 'skipped'
          : resultStatus === 'passed' || test.status === 'expected' || test.status === 'flaky'
            ? 'passed'
            : 'failed';
        records.push({
          name: `${spec.title ?? 'unnamed spec'} [${test.projectName ?? 'default'}]`,
          status,
          detail: lastResult?.error?.message ?? '',
        });
      }
    }
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return records;
};

if (!/^[0-9a-f]{40}$/.test(targetSha)) {
  addCheck('immutable target SHA', 'failed', 'TARGET_SHA is missing or invalid');
} else {
  addCheck('immutable target SHA', 'passed', targetSha);
}

addCheck(
  'full account and browser validation enabled',
  fullValidation ? 'passed' : 'skipped',
  fullValidation ? 'STAGING_RUN_FULL_VALIDATION=true' : 'STAGING_RUN_FULL_VALIDATION was not true',
);

if (!accountProvisioning) {
  addCheck('ephemeral staging account provisioning', 'failed', 'staging-account-provisioning.json is missing');
} else {
  addCheck(
    'ephemeral staging account provisioning',
    accountProvisioning.status === 'passed' ? 'passed' : 'failed',
    accountProvisioning.status === 'passed'
      ? `${Number(accountProvisioning.created ?? 0)} temporary accounts created; credentials_recorded=${String(accountProvisioning.credentials_recorded)}`
      : String(accountProvisioning.detail ?? 'temporary account provisioning failed'),
  );
}

if (!accountCleanup) {
  addCheck('ephemeral staging account cleanup', 'failed', 'staging-account-cleanup.json is missing');
} else {
  addCheck(
    'ephemeral staging account cleanup',
    accountCleanup.status === 'passed' ? 'passed' : 'failed',
    accountCleanup.status === 'passed'
      ? `${Number(accountCleanup.deleted ?? 0)} temporary accounts deleted; profiles_remaining=${Number(accountCleanup.profiles_remaining ?? -1)}`
      : String(accountCleanup.detail ?? 'temporary account cleanup failed'),
  );
}

const playwrightChecks = countPlaywright(playwright);
if (!playwright) {
  addCheck('Playwright report produced', 'failed', 'playwright-report.json is missing');
} else if (playwrightChecks.length === 0) {
  addCheck('Playwright tests executed', 'failed', 'No Playwright test results were recorded');
} else {
  for (const check of playwrightChecks) addCheck(`browser: ${check.name}`, check.status, check.detail);
}

const consoleErrors = Array.isArray(browser?.console_errors) ? browser.console_errors.length : 0;
const pageErrors = Array.isArray(browser?.page_errors) ? browser.page_errors.length : 0;
const unhandledRejections = Array.isArray(browser?.unhandled_rejections) ? browser.unhandled_rejections.length : 0;
const unexpectedHttpErrors = Array.isArray(browser?.unexpected_http_errors) ? browser.unexpected_http_errors.length : 0;

if (!browser) {
  addCheck('browser diagnostic report produced', 'failed', 'staging-browser-results.json is missing');
} else {
  addCheck('browser console errors', consoleErrors === 0 ? 'passed' : 'failed', `${consoleErrors}`);
  addCheck('browser page errors', pageErrors === 0 ? 'passed' : 'failed', `${pageErrors}`);
  addCheck('unhandled browser rejections', unhandledRejections === 0 ? 'passed' : 'failed', `${unhandledRejections}`);
  addCheck('unexpected HTTP errors', unexpectedHttpErrors === 0 ? 'passed' : 'failed', `${unexpectedHttpErrors}`);
}

if (!runtime) {
  addCheck('staging runtime verification produced', 'failed', 'staging-runtime-verification.json is missing');
} else {
  for (const check of runtime.checks ?? []) {
    addCheck(`runtime: ${check.name}`, check.status, check.detail ?? '');
  }
}

if (!database) {
  addCheck('database migration and rollback assessment', 'failed', 'staging-database-verification.json is missing');
} else {
  addCheck('database migration and rollback assessment', database.status, database.detail ?? '');
}

const deployedSha = String(runtime?.deployed_sha ?? '').trim().toLowerCase();
const pm2Status = String(runtime?.pm2_status ?? 'unknown');
const restartCount = Number.isFinite(Number(runtime?.restart_count)) ? Number(runtime.restart_count) : -1;
const restartDelta = Number.isFinite(Number(runtime?.restart_count_delta)) ? Number(runtime.restart_count_delta) : -1;

const identityOk = /^[0-9a-f]{40}$/.test(targetSha) && deployedSha === targetSha;
const runtimeOk = pm2Status === 'online' && restartCount >= 0 && restartDelta === 0;
const releaseReady = fullValidation && failed === 0 && skipped === 0 && identityOk && runtimeOk;
const verdict = releaseReady
  ? '정의된 검증 범위 내 미발견 오류 0개 — 운영 배포 가능'
  : failed > 0
    ? '오류 발견 — 운영 배포 불가'
    : '배포 성공, 전체 검증 미완료 — 운영 배포 불가';

const result = {
  target_sha: targetSha,
  deployed_sha: deployedSha,
  total: passed + failed + skipped,
  passed,
  failed,
  skipped,
  console_errors: consoleErrors,
  page_errors: pageErrors,
  unhandled_rejections: unhandledRejections,
  unexpected_http_errors: unexpectedHttpErrors,
  ephemeral_accounts_created: Number(accountProvisioning?.created ?? 0),
  ephemeral_accounts_deleted: Number(accountCleanup?.deleted ?? 0),
  ephemeral_profiles_remaining: Number(accountCleanup?.profiles_remaining ?? -1),
  pm2_status: pm2Status,
  restart_count: restartCount,
  restart_count_delta: restartDelta,
  release_ready: releaseReady,
  verdict,
  checks,
  generated_at: new Date().toISOString(),
  source_run_id: String(process.env.GITHUB_RUN_ID ?? ''),
  source_run_attempt: String(process.env.GITHUB_RUN_ATTEMPT ?? ''),
};

fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));

if (!releaseReady) process.exitCode = 1;
