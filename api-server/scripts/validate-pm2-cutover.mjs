import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dryRun = process.argv.includes('--dry-run');
const apiRoot = path.resolve(process.cwd());
const entry = path.resolve(
  process.env.PM2_CANDIDATE_ENTRY ?? path.join(apiRoot, '.canary-dist', 'index.mjs'),
);
const port = Number(process.env.PM2_CANDIDATE_PORT ?? 18130);
const name = String(
  process.env.PM2_CANDIDATE_NAME ?? `stock-api-cutover-preflight-${process.pid}`,
);
const productionName = String(process.env.PM2_PRODUCTION_NAME ?? 'stock-app');
const baseUrl = `http://127.0.0.1:${port}`;

if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8080) {
  throw new Error('PM2_PREFLIGHT_UNSAFE_PORT');
}
if (name === productionName || name === 'stock-app' || name === 'stock-api') {
  throw new Error('PM2_PREFLIGHT_UNSAFE_PROCESS_NAME');
}

async function pm2(args) {
  return execFileAsync('pm2', args, {
    cwd: apiRoot,
    env: {
      ...process.env,
      PORT: String(port),
      API_PORT: String(port),
      API_CANARY: 'true',
      ALERT_WORKER_DRY_RUN: 'true',
    },
    windowsHide: true,
    timeout: 30_000,
  });
}

async function processList() {
  const { stdout } = await pm2(['jlist']);
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error('PM2_JLIST_INVALID');
  return rows.map((row) => ({
    name: String(row?.name ?? ''),
    pid: Number(row?.pid ?? 0),
    status: String(row?.pm2_env?.status ?? ''),
    mode: String(row?.pm2_env?.exec_mode ?? ''),
  }));
}

async function health(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { Connection: 'close' },
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      latest = await health('/api/health');
      if (latest.ok) return latest;
    } catch {
      // Candidate is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PM2_CANDIDATE_HEALTH_TIMEOUT:${latest?.status ?? 'NO_RESPONSE'}`);
}

const planned = {
  command: ['pm2', 'start', entry, '--name', name],
  mode: 'fork',
  instances: 1,
  port,
  productionProcess: productionName,
  productionPort: 8080,
  productionStopBeforeValidation: false,
};

if (dryRun) {
  console.log(JSON.stringify({
    event: 'pm2_cutover_dry_run',
    planned,
    zeroDowntimeCapable: false,
    blockingCode: 'ZERO_DOWNTIME_SWITCH_UNAVAILABLE_WITH_DIRECT_PORT_BIND',
  }));
  process.exit(0);
}

const before = await processList();
const productionBefore = before.find((row) => row.name === productionName) ?? null;
let candidate = null;
let candidateHealth = null;
let searchChecks = [];
try {
  await pm2(['start', entry, '--name', name]);
  candidateHealth = await waitForHealth();
  searchChecks = await Promise.all(
    [
      '/api/search/quotes?q=AAPL',
      `/api/search?q=${encodeURIComponent('삼성전자')}`,
    ].map(async (pathname) => {
      const result = await health(pathname);
      return { pathname, status: result.status, ok: result.ok };
    }),
  );
  const during = await processList();
  candidate = during.find((row) => row.name === name) ?? null;
  if (!candidate || candidate.status !== 'online') {
    throw new Error('PM2_CANDIDATE_NOT_ONLINE');
  }
  if (candidate.mode !== 'fork_mode') {
    throw new Error(`PM2_CANDIDATE_MODE_UNSAFE:${candidate.mode}`);
  }
} finally {
  try {
    await pm2(['delete', name]);
  } catch {
    // The candidate may have exited before cleanup.
  }
}

const after = await processList();
const productionAfter = after.find((row) => row.name === productionName) ?? null;
const productionUnchanged =
  productionBefore === null
    ? productionAfter === null
    : productionAfter?.pid === productionBefore.pid &&
      productionAfter?.status === productionBefore.status;

console.log(JSON.stringify({
  event: 'pm2_cutover_preflight',
  planned,
  pm2Version: (await pm2(['--version'])).stdout.trim(),
  candidate,
  candidateHealth: {
    status: candidateHealth?.status ?? null,
    ok: candidateHealth?.ok ?? false,
  },
  searchChecks,
  productionUnchanged,
  zeroDowntimeCapable: false,
  blockingCode: 'ZERO_DOWNTIME_SWITCH_UNAVAILABLE_WITH_DIRECT_PORT_BIND',
}));

if (!productionUnchanged) process.exitCode = 1;
