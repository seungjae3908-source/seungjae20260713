import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticReport, classifyFailureSurface } from './build-staging-diagnostic-report.mjs';

const targetSha = 'a'.repeat(40);

const playwrightReport = (records) => ({
  suites: [
    {
      title: 'phase10-staging-readiness.spec.ts',
      suites: [
        {
          title: 'real staging release readiness',
          specs: records.map((record) => ({
            title: record.title,
            tests: [
              {
                projectName: 'chromium',
                status: record.status === 'passed' ? 'expected' : record.status === 'skipped' ? 'skipped' : 'unexpected',
                results: [
                  {
                    status: record.status,
                    error: record.detail ? { message: record.detail } : undefined,
                  },
                ],
              },
            ],
          })),
        },
      ],
    },
  ],
});

const base = ({ playwright, browser, runnerExitCode = 0 }) => ({
  targetSha,
  runner: { scope: 'all', runner_exit_code: runnerExitCode },
  playwright,
  browser,
  accountProvisioning: { status: 'passed', created: 4, credentials_recorded: false },
  accountCleanup: { status: 'passed', deleted: 4, profiles_remaining: 0 },
  runtime: { ok: true, deploySha: targetSha },
});

test('classifies exact auth profile failures as AUTH_ADMIN', () => {
  assert.equal(classifyFailureSurface({ url: '/api/auth/profile', title: 'admin login' }), 'AUTH_ADMIN');
});

test('clusters a failed admin assertion with its exact HTTP 403 surface', () => {
  const report = buildDiagnosticReport(base({
    runnerExitCode: 1,
    playwright: playwrightReport([
      { title: 'anonymous health', status: 'passed' },
      { title: 'admin: member management', status: 'failed', detail: 'Error: authenticated UI must expose at least one visible logout action' },
      { title: 'mobile 390x844: major screens', status: 'passed' },
    ]),
    browser: {
      console_errors: [],
      page_errors: [],
      unhandled_rejections: [],
      unexpected_http_errors: [
        {
          test: 'phase10-staging-readiness.spec.ts > real staging release readiness > admin: member management',
          url: '/api/auth/profile?attempt=1',
          status: 403,
          detail: 'GET 403',
        },
      ],
    },
  }));

  assert.equal(report.diagnostic_status, 'COMPLETE_WITH_FINDINGS');
  assert.equal(report.collection_complete, true);
  assert.equal(report.tests.total, 3);
  assert.equal(report.tests.failed, 1);
  assert.equal(report.tests.skipped, 0);
  assert.equal(report.failure_clusters.length, 1);
  assert.equal(report.primary_root_cause_candidate.key, 'HTTP:403:/api/auth/profile');
  assert.equal(report.primary_root_cause_candidate.surface, 'AUTH_ADMIN');
  assert.equal(report.primary_root_cause_candidate.confidence, 'EXACT_HTTP_SURFACE');
  assert.deepEqual(report.primary_root_cause_candidate.statuses, [403]);
  assert.equal(report.certification_eligible, false);
  assert.equal(report.release_ready_claim, false);
});

test('keeps skipped tests visible as blocked instead of calling the sweep clean', () => {
  const report = buildDiagnosticReport(base({
    runnerExitCode: 1,
    playwright: playwrightReport([
      { title: 'admin failure', status: 'failed', detail: 'Error: profile rejected' },
      { title: 'mobile later path', status: 'skipped', detail: '' },
    ]),
    browser: {
      console_errors: [],
      page_errors: [],
      unhandled_rejections: [],
      unexpected_http_errors: [],
    },
  }));

  assert.equal(report.diagnostic_status, 'COMPLETE_WITH_FINDINGS');
  assert.equal(report.tests.skipped, 1);
  assert.equal(report.blocked_tests.length, 1);
});

test('a clean diagnostic sweep is COMPLETE_CLEAN but never a release certification', () => {
  const report = buildDiagnosticReport(base({
    playwright: playwrightReport([
      { title: 'anonymous health', status: 'passed' },
      { title: 'admin management', status: 'passed' },
      { title: 'mobile journey', status: 'passed' },
    ]),
    browser: {
      console_errors: [],
      page_errors: [],
      unhandled_rejections: [],
      unexpected_http_errors: [],
    },
  }));

  assert.equal(report.diagnostic_status, 'COMPLETE_CLEAN');
  assert.equal(report.failure_clusters.length, 0);
  assert.equal(report.certification_eligible, false);
  assert.equal(report.release_ready_claim, false);
});

test('missing evidence is INCOMPLETE rather than zero', () => {
  const report = buildDiagnosticReport({
    targetSha,
    runner: { scope: 'all', runner_exit_code: 0 },
    playwright: null,
    browser: null,
    accountProvisioning: null,
    accountCleanup: null,
    runtime: null,
  });

  assert.equal(report.diagnostic_status, 'INCOMPLETE');
  assert.equal(report.collection_complete, false);
  assert.equal(report.release_ready_claim, false);
});
