import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const stripAnsi = (value) => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const sanitizeText = (value, max = 1_000) => stripAnsi(value)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
  .replace(/\b[0-9a-f]{40}\b/giu, '<sha>')
  .replace(/\b[0-9a-f]{64}\b/giu, '<digest>')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '<uuid>')
  .slice(0, max);

const safePath = (value) => {
  const raw = String(value ?? '');
  if (!raw.startsWith('/')) return '[invalid-url]';
  return raw.split('?')[0].slice(0, 500);
};

const countPlaywright = (report) => {
  const records = [];
  let ordinal = 0;
  const visit = (suite, parents = []) => {
    const nextParents = suite?.title ? [...parents, suite.title] : parents;
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
          ordinal: ordinal += 1,
          title: sanitizeText(spec.title ?? 'unnamed spec', 500),
          fullTitle: sanitizeText([...nextParents, spec.title ?? 'unnamed spec'].filter(Boolean).join(' > '), 1_000),
          project: sanitizeText(test.projectName ?? 'default', 100),
          status,
          detail: sanitizeText(lastResult?.error?.message ?? '', 2_000),
        });
      }
    }
    for (const child of suite?.suites ?? []) visit(child, nextParents);
  };
  for (const suite of report?.suites ?? []) visit(suite, []);
  return records;
};

export const classifyFailureSurface = ({ title = '', url = '', detail = '' }) => {
  const haystack = `${title} ${url} ${detail}`.toLowerCase();
  if (url === '/api/auth/profile' || /auth|login|profile|session|관리자|회원/.test(haystack)) return 'AUTH_ADMIN';
  if (/ai[- ]?chart|ai차트|chart/.test(haystack)) return 'AI_CHART';
  if (/scanner|검색기/.test(haystack)) return 'SCANNER';
  if (/paper|모의|settlement|journal/.test(haystack)) return 'PAPER_JOURNAL';
  if (/portfolio|포트폴리오/.test(haystack)) return 'PORTFOLIO';
  if (/account|broker|integration|계좌/.test(haystack)) return 'ACCOUNT_INTEGRATION';
  if (/mobile|viewport|navigation|bottom navigation|메뉴/.test(haystack)) return 'NAVIGATION_MOBILE';
  if (/health|pm2|deploy|sha|runtime/.test(haystack)) return 'RUNTIME_IDENTITY';
  if (/database|supabase|data api|watchlist/.test(haystack)) return 'DATA_API';
  return 'OTHER';
};

const failureMessageKey = (detail) => {
  const line = sanitizeText(detail, 1_000)
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean) ?? 'unknown failure';
  return line.replace(/\d+(?:\.\d+)?(?:ms|s)?/giu, '<n>');
};

const safeHttpDiagnostic = (value) => ({
  test: sanitizeText(value?.test ?? '', 500),
  url: safePath(value?.url),
  status: Number.isFinite(Number(value?.status)) ? Number(value.status) : 0,
  detail: sanitizeText(value?.detail ?? '', 1_000),
});

const browserDiagnostics = (browser) => ({
  console: Array.isArray(browser?.console_errors) ? browser.console_errors.map((value) => ({
    test: sanitizeText(value?.test ?? '', 500),
    url: safePath(value?.url ?? '/'),
    detail: sanitizeText(value?.detail ?? value, 1_000),
  })) : [],
  page: Array.isArray(browser?.page_errors) ? browser.page_errors.map((value) => ({
    test: sanitizeText(value?.test ?? '', 500),
    url: safePath(value?.url ?? '/'),
    detail: sanitizeText(value?.detail ?? value, 1_000),
  })) : [],
  rejection: Array.isArray(browser?.unhandled_rejections) ? browser.unhandled_rejections.map((value) => ({
    test: sanitizeText(value?.test ?? '', 500),
    url: safePath(value?.url ?? '/'),
    detail: sanitizeText(value?.detail ?? value, 1_000),
  })) : [],
  http: Array.isArray(browser?.unexpected_http_errors)
    ? browser.unexpected_http_errors.map(safeHttpDiagnostic)
    : [],
});


const AI_CHART_TIMING_FIELDS = [
  'coldDocumentMs', 'coldChunkMs', 'firstRouteChunkMs', 'firstShellMs',
  'firstUsableChartMs', 'warmRouteMs', 'warmUsableChartMs',
];
const AI_CHART_EXPECTED_SESSIONS = 3;
const AI_CHART_LATENCY_LIMIT_MS = 5_000;

const safeAiChartSession = (value) => {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.session)
    || value.session < 1 || value.session > AI_CHART_EXPECTED_SESSIONS) return null;
  const session = { session: value.session };
  for (const field of AI_CHART_TIMING_FIELDS) {
    // Reject missing, negative, non-finite or implausible values. Do not
    // transform missing evidence into 0ms or include account/private fields.
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])
      || value[field] < 0 || value[field] > 120_000) return null;
    session[field] = Math.round(value[field]);
  }
  return session;
};

const aiChartTimingSummary = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid];
  return {
    medianMs: Math.round(median),
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted.at(-1),
    overFiveSeconds: sorted.filter((value) => value > AI_CHART_LATENCY_LIMIT_MS).length,
  };
};

export const summarizeAiChartLatency = (browser) => {
  const chart = browser?.authenticated_ai_chart;
  const rawSessions = Array.isArray(chart?.sessions) ? chart.sessions : [];
  const safeSessions = rawSessions.map(safeAiChartSession).filter(Boolean);
  const uniqueSessions = new Set(safeSessions.map((item) => item.session));
  const sessionOrder = [...safeSessions].sort((a, b) => a.session - b.session);
  const metrics = sessionOrder.length === 0 ? null : Object.fromEntries(
    AI_CHART_TIMING_FIELDS.map((field) => [
      field, aiChartTimingSummary(sessionOrder.map((item) => item[field])),
    ]),
  );
  // A partial or duplicate sample can accidentally share the same p95 and
  // median as a complete three-session run. Never certify summary consistency
  // before all three distinct canonical session identities are present.
  const completeSessionSet = rawSessions.length === AI_CHART_EXPECTED_SESSIONS
    && safeSessions.length === AI_CHART_EXPECTED_SESSIONS
    && uniqueSessions.size === AI_CHART_EXPECTED_SESSIONS;
  const consistentCanonicalSummary = Boolean(
    completeSessionSet && metrics && chart?.summary && AI_CHART_TIMING_FIELDS.every((field) => {
      const declared = chart.summary[field];
      const computed = metrics[field];
      return declared && computed
        && ['medianMs', 'p95Ms', 'maxMs', 'overFiveSeconds'].every(
          (key) => typeof declared[key] === 'number' && declared[key] === computed[key],
        );
    }),
  );
  const complete = completeSessionSet && consistentCanonicalSummary;
  const p95Breached = complete && (
    metrics.firstUsableChartMs.p95Ms > AI_CHART_LATENCY_LIMIT_MS
    || metrics.warmUsableChartMs.p95Ms > AI_CHART_LATENCY_LIMIT_MS
    || metrics.firstUsableChartMs.overFiveSeconds > 0
    || metrics.warmUsableChartMs.overFiveSeconds > 0
  );
  const status = rawSessions.length === 0
    ? 'NOT_COLLECTED'
    : !complete
      ? 'PARTIAL_OR_INCONSISTENT'
      : p95Breached
        ? 'BREACH'
        : 'WITHIN_LIMIT';
  return {
    status,
    expected_sessions: AI_CHART_EXPECTED_SESSIONS,
    observed_sessions: safeSessions.length,
    raw_session_count: rawSessions.length,
    threshold_ms: AI_CHART_LATENCY_LIMIT_MS,
    // Never retain URL, auth token, login identity, headers or the input
    // snapshot beyond these seven whitelisted numeric timing measurements.
    sessions: sessionOrder.slice(0, AI_CHART_EXPECTED_SESSIONS),
    metrics,
    source_summary_consistent: consistentCanonicalSummary,
  };
};

const addClusterEvidence = (clusters, key, evidence) => {
  const existing = clusters.get(key) ?? {
    key,
    surface: evidence.surface,
    confidence: evidence.confidence,
    firstOrdinal: evidence.ordinal ?? Number.MAX_SAFE_INTEGER,
    tests: new Set(),
    urls: new Set(),
    statuses: new Set(),
    evidence: [],
  };
  existing.firstOrdinal = Math.min(existing.firstOrdinal, evidence.ordinal ?? Number.MAX_SAFE_INTEGER);
  if (evidence.test) existing.tests.add(evidence.test);
  if (evidence.url && evidence.url !== '[invalid-url]') existing.urls.add(evidence.url);
  if (Number.isFinite(evidence.status) && evidence.status > 0) existing.statuses.add(evidence.status);
  existing.evidence.push({
    kind: evidence.kind,
    test: evidence.test ?? '',
    url: evidence.url ?? '',
    status: evidence.status ?? 0,
    detail: sanitizeText(evidence.detail ?? '', 1_000),
  });
  clusters.set(key, existing);
};

export const buildDiagnosticReport = ({
  targetSha = '',
  runner = null,
  playwright = null,
  browser = null,
  accountProvisioning = null,
  accountCleanup = null,
  runtime = null,
}) => {
  const normalizedTarget = String(targetSha ?? '').trim().toLowerCase();
  const tests = countPlaywright(playwright);
  const browserFinding = browserDiagnostics(browser);
  const failedTests = tests.filter((record) => record.status === 'failed');
  const skippedTests = tests.filter((record) => record.status === 'skipped');
  const passedTests = tests.filter((record) => record.status === 'passed');
  const aiChartLatency = summarizeAiChartLatency(browser);
  const aiChartTimingRequired = tests.some((record) =>
    record.fullTitle.includes('regular: futures, scanner, paper trading, and safe AI preview'));
  const clusters = new Map();

  for (const failure of failedTests) {
    const matchingHttp = browserFinding.http.filter((entry) => entry.test.includes(failure.title) || failure.fullTitle.includes(entry.test));
    if (matchingHttp.length > 0) {
      for (const http of matchingHttp) {
        const surface = classifyFailureSurface({ title: failure.fullTitle, url: http.url, detail: http.detail });
        addClusterEvidence(clusters, `HTTP:${http.status}:${http.url}`, {
          kind: 'HTTP',
          test: failure.fullTitle,
          url: http.url,
          status: http.status,
          detail: `${failure.detail}\n${http.detail}`,
          surface,
          confidence: 'EXACT_HTTP_SURFACE',
          ordinal: failure.ordinal,
        });
      }
      continue;
    }
    const message = failureMessageKey(failure.detail);
    const surface = classifyFailureSurface({ title: failure.fullTitle, detail: message });
    addClusterEvidence(clusters, `ASSERTION:${surface}:${message}`, {
      kind: 'ASSERTION',
      test: failure.fullTitle,
      detail: failure.detail,
      surface,
      confidence: 'SAME_ASSERTION_SIGNATURE',
      ordinal: failure.ordinal,
    });
  }

  for (const http of browserFinding.http) {
    const alreadyCovered = [...clusters.values()].some((cluster) => cluster.evidence.some((item) => item.kind === 'HTTP' && item.url === http.url && item.status === http.status && item.test === http.test));
    if (alreadyCovered) continue;
    const surface = classifyFailureSurface({ title: http.test, url: http.url, detail: http.detail });
    addClusterEvidence(clusters, `HTTP:${http.status}:${http.url}`, {
      kind: 'HTTP',
      test: http.test,
      url: http.url,
      status: http.status,
      detail: http.detail,
      surface,
      confidence: 'EXACT_HTTP_SURFACE',
    });
  }

  for (const [kind, findings] of [['CONSOLE', browserFinding.console], ['PAGE_ERROR', browserFinding.page], ['UNHANDLED_REJECTION', browserFinding.rejection]]) {
    for (const finding of findings) {
      const message = failureMessageKey(finding.detail);
      const surface = classifyFailureSurface({ title: finding.test, url: finding.url, detail: finding.detail });
      addClusterEvidence(clusters, `${kind}:${surface}:${message}`, {
        kind,
        test: finding.test,
        url: finding.url,
        detail: finding.detail,
        surface,
        confidence: 'SAME_RUNTIME_SIGNATURE',
      });
    }
  }

  const created = Number(accountProvisioning?.created ?? 0);
  const deleted = Number(accountCleanup?.deleted ?? 0);
  const remaining = Number(accountCleanup?.profiles_remaining ?? -1);
  if (accountProvisioning && (accountProvisioning.status !== 'passed' || created !== 4 || accountProvisioning.credentials_recorded !== false)) {
    addClusterEvidence(clusters, 'ACCOUNT_LIFECYCLE:PROVISIONING', {
      kind: 'ACCOUNT_LIFECYCLE',
      test: 'ephemeral staging account provisioning',
      detail: String(accountProvisioning.detail ?? `created=${created}`),
      surface: 'AUTH_ADMIN',
      confidence: 'EXACT_CONTRACT_FAILURE',
      ordinal: 0,
    });
  }
  if (accountCleanup && (accountCleanup.status !== 'passed' || deleted !== 4 || remaining !== 0)) {
    addClusterEvidence(clusters, 'ACCOUNT_LIFECYCLE:CLEANUP', {
      kind: 'ACCOUNT_LIFECYCLE',
      test: 'ephemeral staging account cleanup',
      detail: String(accountCleanup.detail ?? `deleted=${deleted}; profiles_remaining=${remaining}`),
      surface: 'AUTH_ADMIN',
      confidence: 'EXACT_CONTRACT_FAILURE',
      ordinal: Number.MAX_SAFE_INTEGER - 1,
    });
  }

  const runtimeTarget = String(runtime?.deploySha ?? runtime?.sha ?? runtime?.commitSha ?? '').trim().toLowerCase();
  if (runtime && (!runtime.ok || runtimeTarget !== normalizedTarget)) {
    addClusterEvidence(clusters, 'RUNTIME_IDENTITY:HEALTH_SHA', {
      kind: 'RUNTIME_IDENTITY',
      test: 'staging health identity',
      url: '/api/health',
      detail: `ok=${String(runtime?.ok)} deploySha=${runtimeTarget || 'missing'}`,
      surface: 'RUNTIME_IDENTITY',
      confidence: 'EXACT_CONTRACT_FAILURE',
      ordinal: 0,
    });
  }

  // Report both the measured breach and missing measurements. Never classify
  // an unmeasured AI Chart journey as a fast one.
  if (aiChartTimingRequired && aiChartLatency.status !== 'WITHIN_LIMIT') {
    const complete = aiChartLatency.status === 'BREACH';
    const coldP95 = aiChartLatency.metrics?.firstUsableChartMs?.p95Ms ?? 'missing';
    const warmP95 = aiChartLatency.metrics?.warmUsableChartMs?.p95Ms ?? 'missing';
    addClusterEvidence(
      clusters,
      complete ? 'AI_CHART:COLD_OR_WARM_P95_BREACH' : 'AI_CHART:LATENCY_EVIDENCE_INCOMPLETE',
      {
        kind: 'AI_CHART_PERFORMANCE',
        test: 'authenticated AI Chart cold/warm first-usable',
        detail: `status=${aiChartLatency.status}; cold_p95_ms=${coldP95}; warm_p95_ms=${warmP95}; measured=${aiChartLatency.observed_sessions}/${AI_CHART_EXPECTED_SESSIONS}; limit_ms=${AI_CHART_LATENCY_LIMIT_MS}`,
        surface: 'AI_CHART',
        confidence: complete ? 'EXACT_PERFORMANCE_SAMPLES' : 'EVIDENCE_INCOMPLETE',
        ordinal: tests.find((record) => record.fullTitle.includes('regular: futures, scanner, paper trading, and safe AI preview'))?.ordinal ?? 0,
      },
    );
  }

  const requiredArtifacts = {
    runner: Boolean(runner),
    playwright: Boolean(playwright),
    browser: Boolean(browser),
    accountProvisioning: Boolean(accountProvisioning),
    accountCleanup: Boolean(accountCleanup),
    runtime: Boolean(runtime),
    aiChartTiming: !aiChartTimingRequired || ['WITHIN_LIMIT', 'BREACH'].includes(aiChartLatency.status),
  };
  const collectionComplete = Object.values(requiredArtifacts).every(Boolean) && tests.length > 0;

  const orderedClusters = [...clusters.values()]
    .sort((a, b) => a.firstOrdinal - b.firstOrdinal || a.key.localeCompare(b.key))
    .map((cluster, index) => ({
      rank: index + 1,
      role: index === 0 ? 'PRIMARY_ROOT_CAUSE_CANDIDATE' : 'SECONDARY_FAILURE_CLUSTER',
      key: cluster.key,
      surface: cluster.surface,
      confidence: cluster.confidence,
      tests: [...cluster.tests].sort(),
      urls: [...cluster.urls].sort(),
      statuses: [...cluster.statuses].sort((a, b) => a - b),
      evidence: cluster.evidence.slice(0, 20),
    }));

  const clean = collectionComplete
    && failedTests.length === 0
    && skippedTests.length === 0
    && browserFinding.console.length === 0
    && browserFinding.page.length === 0
    && browserFinding.rejection.length === 0
    && browserFinding.http.length === 0
    && orderedClusters.length === 0
    && Number(runner?.runner_exit_code ?? -1) === 0;

  const diagnosticStatus = !collectionComplete
    ? 'INCOMPLETE'
    : clean
      ? 'COMPLETE_CLEAN'
      : 'COMPLETE_WITH_FINDINGS';

  return {
    schema: 'FULL_RELEASE_DIAGNOSTIC_CERTIFICATION_SYSTEM',
    diagnostic_status: diagnosticStatus,
    certification_eligible: false,
    release_ready_claim: false,
    target_sha: normalizedTarget,
    scope: sanitizeText(runner?.scope ?? 'unknown', 100),
    runner_exit_code: Number.isFinite(Number(runner?.runner_exit_code)) ? Number(runner.runner_exit_code) : null,
    collection_complete: collectionComplete,
    required_artifacts: requiredArtifacts,
    authenticated_ai_chart_latency: aiChartLatency,
    tests: {
      total: tests.length,
      passed: passedTests.length,
      failed: failedTests.length,
      skipped: skippedTests.length,
    },
    diagnostics: {
      console_errors: browserFinding.console.length,
      page_errors: browserFinding.page.length,
      unhandled_rejections: browserFinding.rejection.length,
      unexpected_http_errors: browserFinding.http.length,
    },
    account_lifecycle: {
      created,
      deleted,
      profiles_remaining: remaining,
    },
    blocked_tests: skippedTests.map((record) => ({ title: record.fullTitle, detail: record.detail })),
    primary_root_cause_candidate: orderedClusters[0] ?? null,
    secondary_failure_clusters: orderedClusters.slice(1),
    failure_clusters: orderedClusters,
    generated_at: new Date().toISOString(),
  };
};

const readJson = (artifactDir, name) => {
  const filePath = path.join(artifactDir, name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const mergeUnique = (values) => {
  const seen = new Set();
  const merged = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
};

export const readMergedBrowserDiagnostics = (artifactDir) => {
  const workerFiles = fs.existsSync(artifactDir)
    ? fs.readdirSync(artifactDir)
      .filter((name) => /^staging-browser-results-\d+\.json$/u.test(name))
      .sort()
    : [];
  if (workerFiles.length === 0) return readJson(artifactDir, 'staging-browser-results.json');
  const values = workerFiles.map((name) => readJson(artifactDir, name)).filter(Boolean);
  if (values.length === 0) return null;
  return {
    console_errors: mergeUnique(values.flatMap((value) => value.console_errors ?? [])),
    page_errors: mergeUnique(values.flatMap((value) => value.page_errors ?? [])),
    unhandled_rejections: mergeUnique(values.flatMap((value) => value.unhandled_rejections ?? [])),
    unexpected_http_errors: mergeUnique(values.flatMap((value) => value.unexpected_http_errors ?? [])),
    // Preserve only the structured performance slots from canonical worker
    // telemetry. The report serializer later whitelists numeric fields.
    authenticated_ai_chart: {
      sessions: values.flatMap((value) => Array.isArray(value.authenticated_ai_chart?.sessions)
        ? value.authenticated_ai_chart.sessions : []),
      summary: values.map((value) => value.authenticated_ai_chart?.summary).find(Boolean) ?? null,
    },
    source_worker_files: workerFiles,
  };
};

export const runCli = () => {
  const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? 'staging-artifacts');
  const targetSha = String(process.env.TARGET_SHA ?? process.env.STAGING_TARGET_SHA ?? '').trim().toLowerCase();
  const result = buildDiagnosticReport({
    targetSha,
    runner: readJson(artifactDir, 'staging-diagnostic-run.json'),
    playwright: readJson(artifactDir, 'playwright-report.json'),
    browser: readMergedBrowserDiagnostics(artifactDir),
    accountProvisioning: readJson(artifactDir, 'staging-account-provisioning.json'),
    accountCleanup: readJson(artifactDir, 'staging-account-cleanup.json'),
    runtime: readJson(artifactDir, 'staging-diagnostic-runtime.json'),
  });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'staging-diagnostic-report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
  if (result.diagnostic_status === 'INCOMPLETE') process.exitCode = 2;
};

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) runCli();
