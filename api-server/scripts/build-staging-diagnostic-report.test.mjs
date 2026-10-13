import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDiagnosticReport, classifyFailureSurface, readMergedBrowserDiagnostics } from './build-staging-diagnostic-report.mjs';

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

const chartFixture = (coldValues, warmValues = coldValues) => {
  const fields = [
    'coldDocumentMs', 'coldChunkMs', 'firstRouteChunkMs', 'firstShellMs',
    'firstUsableChartMs', 'warmRouteMs', 'warmUsableChartMs',
  ];
  const sessions = coldValues.map((cold, index) => ({
    session: index + 1,
    coldDocumentMs: 400, coldChunkMs: 900, firstRouteChunkMs: 700,
    firstShellMs: 750, firstUsableChartMs: cold,
    warmRouteMs: 90, warmUsableChartMs: warmValues[index],
  }));
  const summary = Object.fromEntries(fields.map((field) => {
    const sorted = sessions.map((s) => s[field]).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return [field, {
      medianMs: Math.round(median),
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
      maxMs: sorted.at(-1),
      overFiveSeconds: sorted.filter((n) => n > 5_000).length,
      userAcceptableWaitMs: 5_000,
    }];
  }));
  return {
    authenticated_ai_chart: { sessions, summary },
    console_errors: [], page_errors: [], unhandled_rejections: [], unexpected_http_errors: [],
  };
};
const aiChartPlaywright = (status = 'passed') => playwrightReport([
  { title: 'regular: futures, scanner, paper trading, and safe AI preview are available without real orders', status },
]);

test('real AI Chart cold p95 breach remains an actionable failure with 3 immutable timings', () => {
  const report = buildDiagnosticReport(base({
    runnerExitCode: 1,
    playwright: aiChartPlaywright('failed'),
    browser: chartFixture([4_100, 4_700, 6_342], [800, 900, 950]),
  }));
  assert.equal(report.diagnostic_status, 'COMPLETE_WITH_FINDINGS');
  assert.equal(report.collection_complete, true);
  assert.equal(report.authenticated_ai_chart_latency.status, 'BREACH');
  assert.equal(report.authenticated_ai_chart_latency.metrics.firstUsableChartMs.p95Ms, 6_342);
  assert.equal(report.authenticated_ai_chart_latency.metrics.warmUsableChartMs.p95Ms, 950);
  assert.ok(report.failure_clusters.some((item) =>
    item.key === 'AI_CHART:COLD_OR_WARM_P95_BREACH' && item.surface === 'AI_CHART'));
  assert.equal(report.certification_eligible, false);
  assert.equal(report.release_ready_claim, false);
});

test('measured AI Chart within 5s remains diagnostic-only even when clean', () => {
  const report = buildDiagnosticReport(base({
    playwright: aiChartPlaywright(),
    browser: chartFixture([1_200, 1_550, 1_900], [300, 450, 700]),
  }));
  assert.equal(report.diagnostic_status, 'COMPLETE_CLEAN');
  assert.equal(report.authenticated_ai_chart_latency.status, 'WITHIN_LIMIT');
  assert.equal(report.authenticated_ai_chart_latency.observed_sessions, 3);
  assert.equal(report.authenticated_ai_chart_latency.metrics.firstUsableChartMs.p95Ms, 1_900);
  assert.equal(report.release_ready_claim, false);
});

test('missing chart timing must remain INCOMPLETE instead of fabricated 0ms success', () => {
  const report = buildDiagnosticReport(base({
    playwright: aiChartPlaywright(),
    browser: { console_errors: [], page_errors: [], unhandled_rejections: [], unexpected_http_errors: [] },
  }));
  assert.equal(report.diagnostic_status, 'INCOMPLETE');
  assert.equal(report.required_artifacts.aiChartTiming, false);
  assert.equal(report.authenticated_ai_chart_latency.status, 'NOT_COLLECTED');
  assert.equal(report.authenticated_ai_chart_latency.metrics, null);
  assert.ok(report.failure_clusters.some((x) => x.key === 'AI_CHART:LATENCY_EVIDENCE_INCOMPLETE'));
  assert.equal(report.release_ready_claim, false);
});

test('partial and inconsistent chart samples cannot be promoted to 5s PASS', () => {
  const chart = chartFixture([2_100, 2_200, 2_300]);
  chart.authenticated_ai_chart.sessions[1].firstUsableChartMs = -1;
  chart.authenticated_ai_chart.sessions[0].accessToken = 'private-should-never-appear';
  const report = buildDiagnosticReport(base({ playwright: aiChartPlaywright(), browser: chart }));
  assert.equal(report.diagnostic_status, 'INCOMPLETE');
  assert.equal(report.authenticated_ai_chart_latency.status, 'PARTIAL_OR_INCONSISTENT');
  assert.equal(report.authenticated_ai_chart_latency.observed_sessions, 2);
  assert.equal(report.authenticated_ai_chart_latency.source_summary_consistent, false);
  assert.equal(JSON.stringify(report).includes('private-should-never-appear'), false);
  assert.equal(report.release_ready_claim, false);

  const duplicated = chartFixture([500, 600, 700]);
  duplicated.authenticated_ai_chart.sessions[1].session = 1;
  const duplicateReport = buildDiagnosticReport(base({ playwright: aiChartPlaywright(), browser: duplicated }));
  assert.equal(duplicateReport.authenticated_ai_chart_latency.status, 'PARTIAL_OR_INCONSISTENT');
  assert.equal(duplicateReport.collection_complete, false);
});

test('per-worker AI Chart timing survives non-serial diagnostic aggregation, sanitized', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-ai-chart-diag-'));
  try {
    fs.writeFileSync(path.join(root, 'staging-browser-results-101.json'), JSON.stringify({
      ...chartFixture([4_900, 4_950, 5_500]),
      privateToken: 'never-copy-me',
    }));
    fs.writeFileSync(path.join(root, 'staging-browser-results-102.json'), JSON.stringify({
      console_errors: [], page_errors: [], unhandled_rejections: [], unexpected_http_errors: [],
      authenticated_ai_chart: { sessions: [], summary: null },
    }));
    const merged = readMergedBrowserDiagnostics(root);
    const report = buildDiagnosticReport(base({ runnerExitCode: 1, playwright: aiChartPlaywright('failed'), browser: merged }));
    assert.equal(report.authenticated_ai_chart_latency.status, 'BREACH');
    assert.equal(report.authenticated_ai_chart_latency.metrics.firstUsableChartMs.p95Ms, 5_500);
    assert.equal(JSON.stringify(report).includes('never-copy-me'), false);
    assert.equal(report.release_ready_claim, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
