import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const buildDir = path.join(apiRoot, '.canary-dist');
const runDir = path.join(apiRoot, '.canary-run');
const port = Number(process.env.CANARY_PORT ?? 18127);
const baseUrl = `http://127.0.0.1:${port}`;
const durationMs = Number.isFinite(Number(process.env.CANARY_DURATION_SECONDS))
  ? Math.max(30, Number(process.env.CANARY_DURATION_SECONDS)) * 1_000
  : Math.max(1, Number(process.env.CANARY_DURATION_MINUTES ?? 30)) * 60_000;
const requestIntervalMs = Math.max(
  5_000,
  Number(process.env.CANARY_REQUEST_INTERVAL_MS ?? 15_000),
);
const restartIntervalMs = Math.max(
  15_000,
  Number(process.env.CANARY_RESTART_INTERVAL_SECONDS ?? 600) * 1_000,
);
const restartCount = Math.max(
  0,
  Math.trunc(Number(process.env.CANARY_RESTART_COUNT ?? 2)),
);
const allowDirty = process.env.CANARY_ALLOW_DIRTY === 'true';

await rm(runDir, { recursive: true, force: true });
await mkdir(runDir, { recursive: true });

const buildMeta = JSON.parse(
  await readFile(path.join(buildDir, 'build-meta.json'), 'utf8'),
);
if (buildMeta.mode !== 'canary') {
  throw new Error('CANARY_BUILD_MODE_MISMATCH');
}
if (buildMeta.sourceDirty && !allowDirty) {
  throw new Error('CANARY_BUILD_SOURCE_IS_DIRTY');
}

const bundlePaths = {
  api: path.join(buildDir, 'index.mjs'),
  signal: path.join(buildDir, 'signal-worker.mjs'),
  alert: path.join(buildDir, 'alert-worker.mjs'),
};
for (const [name, bundlePath] of Object.entries(bundlePaths)) {
  const bytes = await readFile(bundlePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (buildMeta.artifacts?.[path.basename(bundlePath)]?.sha256 !== actual) {
    throw new Error(`CANARY_BUILD_HASH_MISMATCH:${name}`);
  }
}

const indexSource = await readFile(bundlePaths.api, 'utf8');
for (const forbidden of [
  'startPriceAlertMonitor(',
  'startStrongSignalMonitor(',
  'price alert monitor enabled',
]) {
  if (indexSource.includes(forbidden)) {
    throw new Error(`CANARY_FORBIDDEN_MONITOR:${forbidden}`);
  }
}

const sensitiveEnvironmentNames = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'DART_API_KEY',
  'FINNHUB_API_KEY',
  'KIWOOM_APP_KEY',
  'KIWOOM_SECRET_KEY',
  'UPBIT_ACCESS_KEY',
  'UPBIT_SECRET_KEY',
  'BITGET_API_KEY',
  'BITGET_SECRET_KEY',
  'BITGET_PASSPHRASE',
  'AUTO_TRADE_KEY',
  'X_AUTO_TRADE_KEY',
];

function safeEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const name of sensitiveEnvironmentNames) delete env[name];
  return {
    ...env,
    NODE_ENV: 'test',
    API_CANARY: 'true',
    API_SHUTDOWN_TIMEOUT_MS: '5000',
    PORT: String(port),
    API_PORT: String(port),
    SEARCH_UNIVERSE_TIMEOUT_MS: '500',
    SEARCH_TIMEOUT_MS: '3000',
    SEARCH_QUOTES_TIMEOUT_MS: '6000',
    SPECIAL_FEED_BATCH_SIZE: '2',
    SPECIAL_FEED_CACHE_FILE: path.join(runDir, 'special-feed.snapshot.json'),
    SIGNAL_WORKER_INTERVAL_MS: '20000',
    SIGNAL_PROVIDER_TIMEOUT_MS: '10000',
    SIGNAL_SPOT_PROVIDER: process.env.CANARY_SPOT_PROVIDER ?? '',
    SIGNAL_FUTURES_PROVIDER: 'bitget',
    PRICE_ALERT_MONITOR_INTERVAL_MS: '30000',
    ALERT_WORKER_DRY_RUN: 'true',
    WORKER_LOCK_DIR: path.join(runDir, 'locks'),
    ...extra,
  };
}

const processes = new Map();
const logs = new Map();
const events = [];

function captureLines(label, stream, kind) {
  let buffered = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    buffered += chunk;
    const rows = buffered.split(/\r?\n/);
    buffered = rows.pop() ?? '';
    for (const line of rows) {
      if (!line.trim()) continue;
      const stored = logs.get(label) ?? [];
      if (stored.length < 4_000) stored.push({ kind, line });
      logs.set(label, stored);
      if (line.startsWith('{')) {
        try {
          events.push({ label, ...JSON.parse(line) });
        } catch {
          // Non-JSON provider logs are intentionally not parsed.
        }
      }
    }
  });
}

function startProcess(label, modulePath, extra = {}) {
  const child = fork(modulePath, [], {
    cwd: apiRoot,
    env: safeEnvironment(extra),
    silent: true,
    windowsHide: true,
    execArgv: ['--enable-source-maps'],
  });
  child.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  captureLines(label, child.stdout, 'stdout');
  captureLines(label, child.stderr, 'stderr');
  processes.set(label, child);
  return child;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CANARY_WAIT_TIMEOUT:${label}`);
}

async function waitForEvent(label, predicate, timeoutMs = 30_000) {
  return waitFor(
    () => [...events].reverse().find((event) => event.label === label && predicate(event)),
    timeoutMs,
    label,
  );
}

async function stopProcess(label, timeoutMs = 30_000) {
  const child = processes.get(label);
  if (!child || child.exitCode != null) return;
  if (child.connected) {
    child.send({ type: 'canary-signal', signal: 'SIGTERM' });
  } else {
    child.kill('SIGTERM');
  }
  const result = await Promise.race([
    child.exitPromise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ timeout: true }), timeoutMs),
    ),
  ]);
  if (result?.timeout && child.exitCode == null) {
    child.kill('SIGKILL');
    await child.exitPromise;
  }
}

const requestMetrics = {
  durations: [],
  total: 0,
  status5xx: 0,
  timeouts: 0,
  fallbacks: 0,
};

async function request(pathname, options = {}) {
  const startedAt = performance.now();
  requestMetrics.total += 1;
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        Connection: 'close',
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const duration = performance.now() - startedAt;
    requestMetrics.durations.push(duration);
    if (response.status >= 500) requestMetrics.status5xx += 1;
    const body = await response.json().catch(() => ({}));
    if (
      body?.partial === true ||
      body?.source === 'catalog' ||
      body?.source === 'last-good'
    ) {
      requestMetrics.fallbacks += 1;
    }
    if (
      Array.isArray(body?.warnings) &&
      body.warnings.some((warning) => String(warning).includes('TIMEOUT'))
    ) {
      requestMetrics.timeouts += 1;
    }
    return { response, body, duration };
  } catch (error) {
    const duration = performance.now() - startedAt;
    requestMetrics.durations.push(duration);
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      String(error.name).includes('Timeout')
    ) {
      requestMetrics.timeouts += 1;
    }
    throw error;
  }
}

async function waitForHealth(expected = true, timeoutMs = 15_000) {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          headers: { Connection: 'close' },
          signal: AbortSignal.timeout(1_000),
        });
        return expected ? response.ok : false;
      } catch {
        return expected ? false : true;
      }
    },
    timeoutMs,
    expected ? 'health-up' : 'health-down',
  );
}

async function startApi(label = 'api') {
  const child = startProcess(label, bundlePaths.api);
  await waitForHealth(true);
  const health = await request('/api/health');
  if (
    health.body.commitSha !== buildMeta.commitSha ||
    health.body.buildTime !== buildMeta.buildTime ||
    health.body.mode !== 'canary'
  ) {
    throw new Error('CANARY_HEALTH_BUILD_METADATA_MISMATCH');
  }
  return child;
}

const gracefulRestarts = [];
let currentApiLabel = 'api-0';
let apiRestartIndex = 0;

async function gracefulRestart() {
  const child = processes.get(currentApiLabel);
  const slow = request('/api/canary/slow?ms=1200');
  await new Promise((resolve) => setTimeout(resolve, 150));
  child.send({ type: 'canary-signal', signal: 'SIGTERM' });
  await new Promise((resolve) => setTimeout(resolve, 150));

  let newRequestBlocked = false;
  try {
    await fetch(`${baseUrl}/api/health`, {
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(500),
    });
  } catch {
    newRequestBlocked = true;
  }
  const slowResult = await slow;
  const exit = await child.exitPromise;
  await waitForHealth(false);

  apiRestartIndex += 1;
  currentApiLabel = `api-${apiRestartIndex}`;
  await startApi(currentApiLabel);
  gracefulRestarts.push({
    slowRequestCompleted: slowResult.response.ok,
    newRequestBlocked,
    exitCode: exit.code,
    portReleased: true,
    restartSucceeded: true,
  });
}

async function runSearchBatch() {
  const same = Array.from({ length: 5 }, () =>
    request('/api/search/quotes?q=AAPL'),
  );
  const different = ['MSFT', 'NVDA', 'AMZN', 'META', 'TSLA'].map((ticker) =>
    request(`/api/search/quotes?q=${ticker}`),
  );
  const korean = request(
    `/api/search?q=${encodeURIComponent('삼성전자')}`,
  );
  await Promise.allSettled([...same, ...different, korean]);
}

async function stopAll() {
  for (const label of [...processes.keys()].reverse()) {
    await stopProcess(label);
  }
}

const canaryStartedAt = Date.now();
const rssSamples = [];
const rssCheckpoints = {};
let maximumRssBytes = 0;
const signalPreflight = {};
const duplicateResults = {};

try {
  await startApi(currentApiLabel);

  const unconfigured = startProcess(
    'signal-unconfigured',
    bundlePaths.signal,
    {
      SIGNAL_SPOT_PROVIDER: '',
      SIGNAL_FUTURES_PROVIDER: '',
    },
  );
  const unconfiguredCycle = await waitForEvent(
    'signal-unconfigured',
    (event) => event.event === 'worker_cycle',
    45_000,
  );
  signalPreflight.unconfigured = unconfiguredCycle.result?.markets;
  await stopProcess('signal-unconfigured');

  let signal = startProcess('signal-main', bundlePaths.signal);
  const firstSignalCycle = await waitForEvent(
    'signal-main',
    (event) => event.event === 'worker_cycle',
    45_000,
  );
  signalPreflight.configured = firstSignalCycle.result?.markets;

  const duplicateSignal = startProcess(
    'signal-duplicate',
    bundlePaths.signal,
  );
  duplicateResults.signal = await duplicateSignal.exitPromise;

  await stopProcess('signal-main');
  const failedMarket = startProcess(
    'signal-forced-failure',
    bundlePaths.signal,
    { SIGNAL_CANARY_FAIL_MARKETS: 'futures' },
  );
  const failedCycle = await waitForEvent(
    'signal-forced-failure',
    (event) => event.event === 'worker_cycle',
    45_000,
  );
  signalPreflight.lastGood = failedCycle.result?.markets?.futures;
  await stopProcess('signal-forced-failure');
  signal = startProcess('signal-long', bundlePaths.signal);
  await waitForEvent(
    'signal-long',
    (event) => event.event === 'worker_cycle',
    45_000,
  );

  const alert = startProcess('alert-main', bundlePaths.alert);
  await waitForEvent(
    'alert-main',
    (event) => event.event === 'worker_started',
    20_000,
  );
  const duplicateAlert = startProcess(
    'alert-duplicate',
    bundlePaths.alert,
  );
  duplicateResults.alert = await duplicateAlert.exitPromise;
  await waitForEvent(
    'alert-main',
    (event) => event.event === 'worker_cycle',
    30_000,
  );

  const loopStartedAt = Date.now();
  let nextRestartAt = loopStartedAt + restartIntervalMs;
  let restartsRemaining = restartCount;
  let nextProgressAt = loopStartedAt;

  while (Date.now() - loopStartedAt < durationMs) {
    const elapsedMs = Date.now() - loopStartedAt;
    if (restartsRemaining > 0 && Date.now() >= nextRestartAt) {
      await gracefulRestart();
      restartsRemaining -= 1;
      nextRestartAt += restartIntervalMs;
    }

    await runSearchBatch();
    const health = await request('/api/health');
    const rssBytes = Number(health.body.rssBytes ?? 0);
    if (Number.isFinite(rssBytes) && rssBytes > 0) {
      rssSamples.push({ elapsedMs, rssBytes });
      maximumRssBytes = Math.max(maximumRssBytes, rssBytes);
    }

    for (const minute of [0, 10, 20, 30]) {
      const target = minute * 60_000;
      if (
        rssCheckpoints[minute] == null &&
        elapsedMs >= Math.max(0, target - requestIntervalMs)
      ) {
        rssCheckpoints[minute] = rssBytes;
      }
    }

    if (Date.now() >= nextProgressAt) {
      console.log(
        JSON.stringify({
          event: 'canary_progress',
          elapsedMinutes: Number((elapsedMs / 60_000).toFixed(2)),
          rssMiB: Number((rssBytes / 1024 / 1024).toFixed(2)),
          requests: requestMetrics.total,
          status5xx: requestMetrics.status5xx,
          fallbacks: requestMetrics.fallbacks,
        }),
      );
      nextProgressAt += 60_000;
    }

    const remaining = durationMs - (Date.now() - loopStartedAt);
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(requestIntervalMs, remaining)),
    );
  }

  const finalHealth = await request('/api/health');
  rssCheckpoints[30] = Number(finalHealth.body.rssBytes ?? 0);
} finally {
  await stopAll();
}

const completedAt = Date.now();
const durations = requestMetrics.durations;
const signalCycles = events.filter(
  (event) =>
    event.event === 'worker_cycle' &&
    event.worker === 'signal-worker',
);
const alertCycles = events.filter(
  (event) =>
    event.event === 'worker_cycle' &&
    event.worker === 'alert-worker',
);
const actualNotifications = alertCycles.reduce(
  (total, event) => total + Number(event.result?.actualSent ?? 0),
  0,
);

const result = {
  source: {
    commitSha: buildMeta.commitSha,
    buildTime: buildMeta.buildTime,
    sourceDirty: buildMeta.sourceDirty,
  },
  build: buildMeta.artifacts,
  durationMs: completedAt - canaryStartedAt,
  rss: {
    startBytes: rssCheckpoints[0] ?? null,
    minute10Bytes: rssCheckpoints[10] ?? null,
    minute20Bytes: rssCheckpoints[20] ?? null,
    minute30Bytes: rssCheckpoints[30] ?? null,
    maximumBytes: maximumRssBytes,
    samples: rssSamples.length,
  },
  api: {
    requests: requestMetrics.total,
    averageMs:
      durations.length > 0
        ? durations.reduce((total, value) => total + value, 0) /
          durations.length
        : 0,
    maximumMs: durations.length > 0 ? Math.max(...durations) : 0,
    status5xx: requestMetrics.status5xx,
    timeouts: requestMetrics.timeouts,
    fallbacks: requestMetrics.fallbacks,
    gracefulRestarts,
  },
  workers: {
    duplicateResults,
    signalPreflight,
    signalCyclesCompleted: signalCycles.filter(
      (event) => event.status === 'completed',
    ).length,
    signalCyclesFailed: signalCycles.filter(
      (event) => event.status === 'failed',
    ).length,
    alertCyclesCompleted: alertCycles.filter(
      (event) => event.status === 'completed',
    ).length,
    alertCyclesFailed: alertCycles.filter(
      (event) => event.status === 'failed',
    ).length,
    actualNotifications,
    alertDryRunOnly: alertCycles.every(
      (event) => event.result?.dryRun === true,
    ),
  },
};

await writeFile(
  path.join(runDir, 'result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);
for (const [label, rows] of logs) {
  await writeFile(
    path.join(runDir, `${label}.log`),
    `${rows.map((row) => `[${row.kind}] ${row.line}`).join('\n')}\n`,
    'utf8',
  );
}

console.log(JSON.stringify({ event: 'canary_complete', result }, null, 2));

const duplicateBlocked =
  duplicateResults.signal?.code === 73 &&
  duplicateResults.alert?.code === 73;
const gracefulPassed = gracefulRestarts.every(
  (row) =>
    row.slowRequestCompleted &&
    row.newRequestBlocked &&
    row.exitCode === 0 &&
    row.portReleased &&
    row.restartSucceeded,
);
const configuredMarkets = signalPreflight.configured ?? {};
const fourMarketsProcessed = ['KR', 'US', 'spot', 'futures'].every(
  (market) =>
    configuredMarkets[market] &&
    configuredMarkets[market].status !== 'ERROR',
);
const unconfiguredExplicit =
  signalPreflight.unconfigured?.spot?.status === 'NOT_CONFIGURED' &&
  signalPreflight.unconfigured?.futures?.status === 'NOT_CONFIGURED';
const lastGoodPassed =
  signalPreflight.lastGood?.staleUsed === true &&
  signalPreflight.lastGood?.status === 'PARTIAL';

if (
  !duplicateBlocked ||
  !gracefulPassed ||
  !fourMarketsProcessed ||
  !unconfiguredExplicit ||
  !lastGoodPassed ||
  actualNotifications !== 0 ||
  !result.workers.alertDryRunOnly
) {
  process.exitCode = 1;
}
