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
    SEARCH_UNIVERSE_TIMEOUT_MS: '1800',
    SEARCH_TIMEOUT_MS: '3000',
    SEARCH_QUOTES_TIMEOUT_MS: '6000',
    MEMORY_CACHE_MAX_ENTRIES: '400',
    SPECIAL_FEED_BATCH_SIZE: '2',
    SPECIAL_FEED_CACHE_FILE: path.join(runDir, 'special-feed.snapshot.json'),
    SIGNAL_WORKER_INTERVAL_MS: '20000',
    SIGNAL_PROVIDER_TIMEOUT_MS: '8000',
    SIGNAL_MARKET_TIMEOUT_MS: '22000',
    SIGNAL_CYCLE_TIMEOUT_MS: '25000',
    SIGNAL_SPOT_PROVIDER: process.env.CANARY_SPOT_PROVIDER ?? 'upbit',
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
const MAX_LOG_ROWS = 4_000;
const MAX_EVENTS = 2_000;

function ringPush(rows, value, maximum) {
  rows.push(value);
  if (rows.length > maximum) {
    rows.splice(0, rows.length - maximum);
  }
}

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
      ringPush(stored, { kind, line }, MAX_LOG_ROWS);
      logs.set(label, stored);
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.event === 'string') {
            ringPush(events, { label, ...parsed }, MAX_EVENTS);
          }
        } catch {
          // Non-JSON provider logs are intentionally not parsed.
        }
      }
    }
  });
}

function startProcess(label, modulePath, extra = {}) {
  const exposeGc = extra.CANARY_EXPOSE_GC === 'true';
  const child = fork(modulePath, [], {
    cwd: apiRoot,
    env: safeEnvironment(extra),
    silent: true,
    windowsHide: true,
    execArgv: [
      '--enable-source-maps',
      ...(exposeGc ? ['--expose-gc'] : []),
    ],
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
  if (process.platform === 'win32' && child.connected) {
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

function signalProcess(child, signal) {
  if (process.platform === 'win32' && child.connected) {
    child.send({ type: 'canary-signal', signal });
    return;
  }
  child.kill(signal);
}

const requestMetrics = {
  durations: [],
  total: 0,
  status2xx: 0,
  status4xx: 0,
  status5xx: 0,
  orderApiCalls: 0,
  timeouts: 0,
  fallbacks: 0,
  fallbackByMarketReason: {},
  fallbackContributors: {},
};

function incrementMetric(target, market, reason) {
  const key = `${market}:${reason}`;
  target[key] = (target[key] ?? 0) + 1;
}

function fallbackReasons(body) {
  const reasons = new Set();
  const warnings = Array.isArray(body?.warnings)
    ? body.warnings.map(String)
    : [];
  if (body?.source === 'last-good') reasons.add('LAST_GOOD');
  if (body?.source === 'catalog') reasons.add('CATALOG_FALLBACK');
  if (Array.isArray(body?.results) && body.results.length === 0) {
    reasons.add('EMPTY_RESULT');
  }
  for (const warning of warnings) {
    if (warning.includes('INJECTED_TIMEOUT')) reasons.add('INJECTED_TIMEOUT');
    if (warning.includes('LAST_GOOD')) reasons.add('LAST_GOOD');
    if (warning.includes('CATALOG_FALLBACK')) {
      reasons.add('CATALOG_FALLBACK');
    }
    if (warning.includes('CACHE_STALE')) reasons.add('CACHE_STALE');
    if (warning.includes('NOT_CONFIGURED')) reasons.add('NOT_CONFIGURED');
    if (warning.includes('EMPTY_RESULT')) reasons.add('EMPTY_RESULT');
    if (warning.includes('TIMEOUT')) reasons.add('PROVIDER_TIMEOUT');
    if (warning.includes('PROVIDER_ERROR')) reasons.add('PROVIDER_ERROR');
    if (warning.includes('QUOTE_PARTIAL_FAILURE')) {
      reasons.add('QUOTE_PARTIAL_FAILURE');
    }
    if (warning.includes('NO_QUOTE_FALLBACK_AVAILABLE')) {
      reasons.add('NO_QUOTE_FALLBACK');
    }
  }
  if (reasons.size === 0 && body?.partial === true) {
    reasons.add('OTHER_PARTIAL');
  }
  return [...reasons];
}

function primaryFallbackReason(reasons) {
  const priority = [
    'INJECTED_TIMEOUT',
    'PROVIDER_TIMEOUT',
    'PROVIDER_ERROR',
    'LAST_GOOD',
    'CACHE_STALE',
    'NOT_CONFIGURED',
    'EMPTY_RESULT',
    'CATALOG_FALLBACK',
    'QUOTE_PARTIAL_FAILURE',
    'NO_QUOTE_FALLBACK',
    'OTHER_PARTIAL',
  ];
  return priority.find((reason) => reasons.includes(reason)) ?? 'OTHER';
}

async function request(pathname, options = {}) {
  const { metricMarket = 'unknown', ...fetchOptions } = options;
  if (
    /\/(?:orders?|trade|buy|sell)(?:\/|$)/i.test(pathname) ||
    String(fetchOptions.method ?? 'GET').toUpperCase() !== 'GET'
  ) {
    requestMetrics.orderApiCalls += 1;
  }
  const startedAt = performance.now();
  requestMetrics.total += 1;
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...fetchOptions,
      headers: {
        Connection: 'close',
        ...(fetchOptions.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const duration = performance.now() - startedAt;
    requestMetrics.durations.push(duration);
    if (response.status >= 200 && response.status < 300) {
      requestMetrics.status2xx += 1;
    } else if (response.status >= 400 && response.status < 500) {
      requestMetrics.status4xx += 1;
    } else if (response.status >= 500) {
      requestMetrics.status5xx += 1;
    }
    const body = await response.json().catch(() => ({}));
    if (
      body?.partial === true ||
      body?.source === 'catalog' ||
      body?.source === 'last-good'
    ) {
      requestMetrics.fallbacks += 1;
      const reasons = fallbackReasons(body);
      incrementMetric(
        requestMetrics.fallbackByMarketReason,
        metricMarket,
        primaryFallbackReason(reasons),
      );
      for (const reason of reasons) {
        incrementMetric(
          requestMetrics.fallbackContributors,
          metricMarket,
          reason,
        );
      }
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
let forcedShutdownResult = null;
let currentApiLabel = 'api-0';
let apiRestartIndex = 0;

async function verifyForcedShutdownTimeout() {
  await stopProcess(currentApiLabel);
  await waitForHealth(false);

  const label = 'api-forced-timeout';
  const child = startProcess(label, bundlePaths.api, {
    API_SHUTDOWN_TIMEOUT_MS: '1000',
  });
  await waitForHealth(true);
  const slow = fetch(`${baseUrl}/api/canary/slow?ms=5000`, {
    headers: { Connection: 'close' },
  })
    .then((response) => ({ completed: response.ok, aborted: false }))
    .catch(() => ({ completed: false, aborted: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  signalProcess(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  signalProcess(child, 'SIGTERM');
  const exit = await child.exitPromise;
  const slowResult = await slow;
  await waitForHealth(false);
  const forcedLogged = Boolean(
    [...events]
      .reverse()
      .find(
        (event) =>
          event.label === label &&
          event.event === 'api_shutdown_forced',
      ),
  );
  const repeatedSignalIgnored = Boolean(
    [...events]
      .reverse()
      .find(
        (event) =>
          event.label === label &&
          event.event === 'api_shutdown_signal_ignored',
      ),
  );

  apiRestartIndex += 1;
  currentApiLabel = `api-${apiRestartIndex}`;
  await startApi(currentApiLabel);
  forcedShutdownResult = {
    exitCode: exit.code,
    slowRequestAborted: slowResult.aborted,
    forcedLogged,
    repeatedSignalIgnored,
    portReleased: true,
    restartSucceeded: true,
  };
}

async function gracefulRestart() {
  const child = processes.get(currentApiLabel);
  const slow = request('/api/canary/slow?ms=1200');
  await new Promise((resolve) => setTimeout(resolve, 150));
  signalProcess(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  signalProcess(child, 'SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 100));

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
  const repeatedSignalIgnored = Boolean(
    [...events]
      .reverse()
      .find(
        (event) =>
          event.label === currentApiLabel &&
          event.event === 'api_shutdown_signal_ignored',
      ),
  );

  apiRestartIndex += 1;
  currentApiLabel = `api-${apiRestartIndex}`;
  await startApi(currentApiLabel);
  gracefulRestarts.push({
    slowRequestCompleted: slowResult.response.ok,
    newRequestBlocked,
    exitCode: exit.code,
    portReleased: true,
    restartSucceeded: true,
    repeatedSignalIgnored,
  });
}

async function runSearchBatch() {
  const same = Array.from({ length: 5 }, () =>
    request('/api/search/quotes?q=AAPL', { metricMarket: 'US' }),
  );
  const different = ['MSFT', 'NVDA', 'AMZN', 'META', 'TSLA'].map((ticker) =>
    request(`/api/search/quotes?q=${ticker}`, { metricMarket: 'US' }),
  );
  const korean = request(
    `/api/search?q=${encodeURIComponent('삼성전자')}`,
    { metricMarket: 'KR' },
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
const workerRssCheckpoints = {};
const gcResults = {};
const signalPreflight = {};
const duplicateResults = {};

function latestSignalLongEvent() {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.label === 'signal-long' &&
        event.event === 'worker_cycle' &&
        event.worker === 'signal-worker',
    );
}

async function collectGcCheckpoint(minute) {
  if (gcResults[minute]) return gcResults[minute];
  const signal = processes.get('signal-long');
  if (!signal || signal.exitCode != null || !signal.connected) {
    throw new Error(`CANARY_GC_WORKER_UNAVAILABLE:${minute}`);
  }
  signal.send({ type: 'canary-gc', checkpoint: minute });
  const result = await waitForEvent(
    'signal-long',
    (event) =>
      event.event === 'worker_gc' &&
      Number(event.checkpoint) === minute,
    30_000,
  );
  gcResults[minute] = result;
  workerRssCheckpoints[minute] = Number(
    result.after?.runtime?.memory?.rss ?? 0,
  );
  return result;
}

try {
  await startApi(currentApiLabel);
  await verifyForcedShutdownTimeout();

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

  const providerTimeout = startProcess(
    'signal-provider-timeout',
    bundlePaths.signal,
    {
      SIGNAL_PROVIDER_TIMEOUT_MS: '1000',
      SIGNAL_MARKET_TIMEOUT_MS: '5000',
      SIGNAL_CYCLE_TIMEOUT_MS: '8000',
      SIGNAL_CANARY_TIMEOUT_PROVIDERS: 'dart,finnhub-news',
    },
  );
  const providerTimeoutCycle = await waitForEvent(
    'signal-provider-timeout',
    (event) => event.event === 'worker_cycle',
    15_000,
  );
  signalPreflight.providerTimeout = {
    durationMs: providerTimeoutCycle.durationMs,
    markets: providerTimeoutCycle.result?.markets,
    cycle: providerTimeoutCycle.result?.cycle,
    diagnostics: providerTimeoutCycle.result?.diagnostics,
  };
  await stopProcess('signal-provider-timeout');

  const cycleTimeout = startProcess(
    'signal-cycle-timeout',
    bundlePaths.signal,
    {
      SIGNAL_MARKET_TIMEOUT_MS: '60000',
      SIGNAL_CYCLE_TIMEOUT_MS: '8000',
      SIGNAL_CANARY_HANG_MARKETS: 'KR,US,spot,futures',
    },
  );
  const cycleTimeoutEvent = await waitForEvent(
    'signal-cycle-timeout',
    (event) => event.event === 'worker_cycle',
    15_000,
  );
  signalPreflight.cycleTimeout = {
    durationMs: cycleTimeoutEvent.durationMs,
    markets: cycleTimeoutEvent.result?.markets,
    cycle: cycleTimeoutEvent.result?.cycle,
    diagnostics: cycleTimeoutEvent.diagnostics,
  };
  await stopProcess('signal-cycle-timeout');

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
  signalPreflight.failuresByMarket = {};
  for (const market of ['KR', 'US', 'spot', 'futures']) {
    const label = `signal-forced-failure-${market}`;
    const failedMarket = startProcess(label, bundlePaths.signal, {
      SIGNAL_CANARY_FAIL_MARKETS: market,
      SIGNAL_PROVIDER_TIMEOUT_MS: '1000',
      SIGNAL_MARKET_TIMEOUT_MS: '5000',
      SIGNAL_CYCLE_TIMEOUT_MS: '8000',
    });
    const failedCycle = await waitForEvent(
      label,
      (event) => event.event === 'worker_cycle',
      45_000,
    );
    signalPreflight.failuresByMarket[market] = {
      failed: failedCycle.result?.markets?.[market],
      peers: Object.fromEntries(
        ['KR', 'US', 'spot', 'futures']
          .filter((peer) => peer !== market)
          .map((peer) => [peer, failedCycle.result?.markets?.[peer]]),
      ),
    };
    await stopProcess(label);
  }
  signalPreflight.lastGood =
    signalPreflight.failuresByMarket.futures?.failed;
  signal = startProcess('signal-long', bundlePaths.signal, {
    CANARY_EXPOSE_GC: 'true',
  });
  await waitForEvent(
    'signal-long',
    (event) => event.event === 'worker_cycle',
    45_000,
  );
  const initialSignalEvent = latestSignalLongEvent();
  workerRssCheckpoints[0] = Number(
    initialSignalEvent?.diagnostics?.runtime?.memory?.rss ?? 0,
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

    for (const minute of [0, 10, 20, 30, 45]) {
      const target = minute * 60_000;
      if (
        rssCheckpoints[minute] == null &&
        elapsedMs >= Math.max(0, target - requestIntervalMs)
      ) {
        rssCheckpoints[minute] = rssBytes;
      }
    }
    for (const minute of [10, 20, 30]) {
      if (gcResults[minute] == null && elapsedMs >= minute * 60_000) {
        await collectGcCheckpoint(minute);
      }
    }

    if (Date.now() >= nextProgressAt) {
      const latestWorker = latestSignalLongEvent();
      console.log(
        JSON.stringify({
          event: 'canary_progress',
          elapsedMinutes: Number((elapsedMs / 60_000).toFixed(2)),
          rssMiB: Number((rssBytes / 1024 / 1024).toFixed(2)),
          requests: requestMetrics.total,
          status2xx: requestMetrics.status2xx,
          status4xx: requestMetrics.status4xx,
          status5xx: requestMetrics.status5xx,
          fallbacks: requestMetrics.fallbacks,
          fallbackByMarketReason:
            requestMetrics.fallbackByMarketReason,
          fallbackContributors:
            requestMetrics.fallbackContributors,
          signalWorker: latestWorker?.diagnostics ?? null,
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

  if (durationMs >= 45 * 60_000) {
    await collectGcCheckpoint(45);
  }
  const finalHealth = await request('/api/health');
  if (durationMs >= 45 * 60_000) {
    rssCheckpoints[45] = Number(finalHealth.body.rssBytes ?? 0);
  }
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
const longSignalCycles = signalCycles.filter(
  (event) => event.label === 'signal-long',
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
function signalFallbackReason(status) {
  const warning = String(status?.warning ?? '');
  if (warning.includes('INJECTED_TIMEOUT')) return 'INJECTED_TIMEOUT';
  if (warning.includes('TIMEOUT')) return 'PROVIDER_TIMEOUT';
  if (warning.includes('NOT_CONFIGURED')) return 'NOT_CONFIGURED';
  if (warning.includes('EMPTY')) return 'EMPTY_RESULT';
  if (warning && status?.status === 'ERROR') return 'PROVIDER_ERROR';
  if (status?.staleUsed === true) return 'LAST_GOOD';
  if (status?.status === 'PARTIAL') return 'OTHER_PARTIAL';
  return null;
}
const marketCycleMetrics = Object.fromEntries(
  ['KR', 'US', 'spot', 'futures'].map((market) => {
    const statuses = longSignalCycles
      .map((event) => event.result?.markets?.[market])
      .filter(Boolean);
    const durations = statuses.map((status) =>
      Number(status.durationMs ?? 0),
    );
    return [
      market,
      {
        successes: statuses.filter(
          (status) =>
            status.status === 'OK' || status.status === 'PARTIAL',
        ).length,
        failures: statuses.filter(
          (status) => status.status === 'ERROR',
        ).length,
        notConfigured: statuses.filter(
          (status) => status.status === 'NOT_CONFIGURED',
        ).length,
        lastGoodUsed: statuses.filter(
          (status) => status.staleUsed === true,
        ).length,
        averageDurationMs:
          durations.length > 0
            ? durations.reduce((total, value) => total + value, 0) /
              durations.length
            : 0,
        maximumDurationMs:
          durations.length > 0 ? Math.max(...durations) : 0,
        latestResultCount:
          statuses.length > 0
            ? Number(statuses.at(-1)?.resultCount ?? 0)
            : 0,
      },
    ];
  }),
);
const workerFallbackByMarketReason = {};
for (const cycle of longSignalCycles) {
  for (const market of ['KR', 'US', 'spot', 'futures']) {
    const reason = signalFallbackReason(cycle.result?.markets?.[market]);
    if (reason) {
      incrementMetric(workerFallbackByMarketReason, market, reason);
    }
  }
}
const injectedFallbackByMarketReason = {};
for (const market of ['KR', 'US', 'spot', 'futures']) {
  const reason = signalFallbackReason(
    signalPreflight.failuresByMarket?.[market]?.failed,
  );
  if (reason) {
    incrementMetric(injectedFallbackByMarketReason, market, reason);
  }
}
const signalWorkerRssSamples = longSignalCycles
  .map((event) =>
    Number(event.diagnostics?.runtime?.memory?.rss ?? 0),
  )
  .filter((value) => Number.isFinite(value) && value > 0);
const latestSignalDiagnostics =
  longSignalCycles.at(-1)?.diagnostics ?? null;

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
    minute45Bytes: rssCheckpoints[45] ?? null,
    maximumBytes: maximumRssBytes,
    samples: rssSamples.length,
  },
  signalWorkerRss: {
    startBytes: workerRssCheckpoints[0] ?? null,
    minute10Bytes: workerRssCheckpoints[10] ?? null,
    minute20Bytes: workerRssCheckpoints[20] ?? null,
    minute30Bytes: workerRssCheckpoints[30] ?? null,
    minute45Bytes: workerRssCheckpoints[45] ?? null,
    maximumBytes:
      signalWorkerRssSamples.length > 0
        ? Math.max(...signalWorkerRssSamples)
        : 0,
    samples: signalWorkerRssSamples.length,
  },
  api: {
    requests: requestMetrics.total,
    averageMs:
      durations.length > 0
        ? durations.reduce((total, value) => total + value, 0) /
          durations.length
        : 0,
    maximumMs: durations.length > 0 ? Math.max(...durations) : 0,
    status2xx: requestMetrics.status2xx,
    status4xx: requestMetrics.status4xx,
    status5xx: requestMetrics.status5xx,
    orderApiCalls: requestMetrics.orderApiCalls,
    timeouts: requestMetrics.timeouts,
    fallbacks: requestMetrics.fallbacks,
    fallbackByMarketReason:
      requestMetrics.fallbackByMarketReason,
    fallbackContributors:
      requestMetrics.fallbackContributors,
    gracefulRestarts,
    forcedShutdown: forcedShutdownResult,
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
    marketCycleMetrics,
    workerFallbackByMarketReason,
    injectedFallbackByMarketReason,
    latestSignalDiagnostics,
    gc: gcResults,
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
    row.restartSucceeded &&
    row.repeatedSignalIgnored,
);
const forcedShutdownPassed =
  forcedShutdownResult?.exitCode === 1 &&
  forcedShutdownResult?.slowRequestAborted === true &&
  forcedShutdownResult?.forcedLogged === true &&
  forcedShutdownResult?.repeatedSignalIgnored === true &&
  forcedShutdownResult?.portReleased === true &&
  forcedShutdownResult?.restartSucceeded === true;
const configuredMarkets = signalPreflight.configured ?? {};
const fourMarketsProcessed = ['KR', 'US', 'spot', 'futures'].every(
  (market) =>
    configuredMarkets[market] &&
    configuredMarkets[market].status !== 'ERROR',
);
const unconfiguredExplicit =
  signalPreflight.unconfigured?.spot?.status === 'NOT_CONFIGURED' &&
  signalPreflight.unconfigured?.futures?.status === 'NOT_CONFIGURED';
const forcedFailuresPassed = ['KR', 'US', 'spot', 'futures'].every(
  (market) => {
    const row = signalPreflight.failuresByMarket?.[market];
    return (
      row?.failed?.status === 'PARTIAL' &&
      (
        row?.failed?.staleUsed === true ||
        (
          Number(row?.failed?.resultCount ?? 0) === 0 &&
          row?.failed?.source === 'none'
        )
      ) &&
      Object.values(row.peers ?? {}).every(
        (peer) => peer?.status !== 'ERROR',
      )
    );
  },
);
const gcPassed =
  durationMs < 45 * 60_000 ||
  [10, 20, 30, 45].every(
    (minute) => gcResults[minute]?.available === true,
  );
const providerTimeoutPassed =
  Number(signalPreflight.providerTimeout?.durationMs ?? Infinity) <= 3_000 &&
  Number(
    signalPreflight.providerTimeout?.cycle?.providerTotals?.['KR:dart']
      ?.timeouts ?? 0,
  ) > 0 &&
  Number(signalPreflight.providerTimeout?.diagnostics?.timerCount ?? -1) === 0 &&
  Number(
    signalPreflight.providerTimeout?.diagnostics?.cache?.pendingLoads ?? -1,
  ) === 0 &&
  Number(
    signalPreflight.providerTimeout?.diagnostics?.pendingPromises ?? -1,
  ) === 0;
const cycleTimeoutPassed =
  signalPreflight.cycleTimeout?.cycle?.timedOut === true &&
  signalPreflight.cycleTimeout?.cycle?.failureCode ===
    'SIGNAL_CYCLE_TIMEOUT' &&
  Number(signalPreflight.cycleTimeout?.durationMs ?? Infinity) <= 10_000 &&
  Number(
    signalPreflight.cycleTimeout?.diagnostics?.worker?.timerCount ?? -1,
  ) === 0 &&
  Number(
    signalPreflight.cycleTimeout?.diagnostics?.worker?.pendingPromises ?? -1,
  ) === 0;

if (
  !duplicateBlocked ||
  !gracefulPassed ||
  !forcedShutdownPassed ||
  !fourMarketsProcessed ||
  !unconfiguredExplicit ||
  !forcedFailuresPassed ||
  !gcPassed ||
  !providerTimeoutPassed ||
  !cycleTimeoutPassed ||
  actualNotifications !== 0 ||
  requestMetrics.orderApiCalls !== 0 ||
  !result.workers.alertDryRunOnly
) {
  process.exitCode = 1;
}
