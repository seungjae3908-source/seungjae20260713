import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FORBIDDEN_ACTIVATION_KEYS = Object.freeze([
  'LIVE_TRADING',
  'LIVE_TRADING_ENABLED',
  'REAL_ORDER_ENABLED',
  'REAL_TRADING_ENABLED',
  'PRIVATE_API_ENABLED',
  'PRIVATE_ACCOUNT_ACCESS',
  'PRIVATE_TRADING_API_ALLOWED',
  'ORDER_AUTHORITY',
  'ORDER_SUBMISSION_ENABLED',
]);

const SAFE_CHILD_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'NODE_EXTRA_CA_CERTS',
]);

const REQUIRED_LAB_FILES = Object.freeze([
  'package.json',
  'scripts/run-stock-market-suite.js',
  'scripts/run-stock-generalization-suite.js',
  'scripts/run-upbit-spot-suite.js',
  'scripts/run-futures-generalization-suite.js',
  'scripts/run-futures-pnl-suite.js',
  'scripts/run-futures-regime-execution-suite.js',
  'scripts/run-derivatives-suite.js',
  'scripts/run-market-structure-suite.js',
  'scripts/run-long-history-v1-with-retry.js',
  'scripts/run-v3-history.js',
  'scripts/run-v4-history.js',
  'scripts/run-v5-history.js',
  'scripts/run-v6-history.js',
  'scripts/run-paper-forward-schedule.js',
  'scripts/run-shadow-cycle.js',
]);

export const PROFILES = Object.freeze({
  'fast-historical': Object.freeze([
    Object.freeze({ id: 'stocks-core', args: ['scripts/run-stock-market-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'stocks-generalization', args: ['scripts/run-stock-generalization-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'spot-upbit', args: ['scripts/run-upbit-spot-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'futures-generalization', args: ['scripts/run-futures-generalization-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'futures-pnl', args: ['scripts/run-futures-pnl-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'futures-regime', args: ['scripts/run-futures-regime-execution-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'funding-history', args: ['scripts/run-derivatives-suite.js'], timeoutMs: 45 * 60_000 }),
    Object.freeze({ id: 'market-structure', args: ['scripts/run-market-structure-suite.js'], timeoutMs: 45 * 60_000 }),
  ]),
  'long-history': Object.freeze([
    Object.freeze({ id: 'long-v1', args: ['scripts/run-long-history-v1-with-retry.js'], timeoutMs: 90 * 60_000 }),
    Object.freeze({ id: 'long-v3', args: ['scripts/run-v3-history.js'], timeoutMs: 90 * 60_000 }),
    Object.freeze({ id: 'long-v4', args: ['scripts/run-v4-history.js'], timeoutMs: 90 * 60_000 }),
    Object.freeze({ id: 'long-v5', args: ['scripts/run-v5-history.js'], timeoutMs: 90 * 60_000 }),
    Object.freeze({ id: 'long-v6', args: ['scripts/run-v6-history.js'], timeoutMs: 90 * 60_000 }),
  ]),
  forward: Object.freeze([
    Object.freeze({ id: 'paper-forward', kind: 'paper', args: ['scripts/run-paper-forward-schedule.js'], timeoutMs: 20 * 60_000, acceptedExitCodes: [0, 2] }),
    Object.freeze({ id: 'shadow-forward', kind: 'shadow', args: ['scripts/run-shadow-cycle.js'], timeoutMs: 30 * 60_000 }),
  ]),
});

function truthy(value) {
  return TRUTHY.has(String(value ?? '').trim().toLowerCase());
}

function assertPinnedSha(value) {
  if (!/^[0-9a-f]{40}$/i.test(String(value ?? ''))) {
    throw new Error('research SHA must be an exact 40-character commit SHA');
  }
  return String(value).toLowerCase();
}

function inside(parent, child) {
  const normalizedParent = resolve(parent) + sep;
  const normalizedChild = resolve(child) + sep;
  return normalizedChild.startsWith(normalizedParent);
}

export function sanitizeChildEnv(env = process.env) {
  const safe = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key].length > 0) safe[key] = env[key];
  }
  return safe;
}

function resolveCheckoutSha(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().toLowerCase();
  } catch (error) {
    throw new Error(`unable to verify exact research checkout SHA: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

export function assertResearchSafety({ env = process.env, stateRoot, repoRoot }) {
  const active = FORBIDDEN_ACTIVATION_KEYS.filter((key) => truthy(env[key]));
  if (active.length > 0) throw new Error(`research production refuses live/private activation: ${active.join(',')}`);
  if (!stateRoot || !isAbsolute(stateRoot)) throw new Error('research state root must be an absolute path');
  const forbiddenStateRoots = ['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app'];
  if (forbiddenStateRoots.some((root) => resolve(stateRoot) === root || inside(root, stateRoot))) {
    throw new Error(`research state root overlaps protected application storage: ${stateRoot}`);
  }
  if (repoRoot && inside(resolve(repoRoot, 'stock-analyzer'), stateRoot)) {
    throw new Error('research state root cannot live inside stock-analyzer');
  }
  return Object.freeze({
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
    protectedAppStorageSeparated: true,
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function preflightResearchProduction({ repoRoot, stateRoot, researchSha, env = process.env, verifyGitHead = true }) {
  const root = resolve(repoRoot);
  const labRoot = join(root, 'market-prediction-lab');
  const pinnedSha = assertPinnedSha(researchSha);
  const safety = assertResearchSafety({ env, stateRoot, repoRoot: root });
  const checkoutSha = verifyGitHead ? resolveCheckoutSha(root) : null;
  if (verifyGitHead && checkoutSha !== pinnedSha) {
    throw new Error(`research checkout SHA mismatch: expected ${pinnedSha}, actual ${checkoutSha}`);
  }
  const missing = [];
  for (const relative of REQUIRED_LAB_FILES) {
    if (!(await exists(join(labRoot, relative)))) missing.push(relative);
  }
  if (missing.length > 0) throw new Error(`research lab prerequisites missing: ${missing.join(', ')}`);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const probe = join(stateRoot, `.write-probe-${process.pid}`);
  await writeFile(probe, 'ok\n', { mode: 0o600 });
  await rm(probe, { force: true });
  const filesystem = await statfs(stateRoot);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const minimumFreeBytes = Number(env.RESEARCH_MIN_FREE_BYTES ?? 5 * 1024 ** 3);
  if (!Number.isFinite(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('RESEARCH_MIN_FREE_BYTES must be a non-negative number');
  if (freeBytes < minimumFreeBytes) {
    throw new Error(`research storage free space below safety floor: free=${freeBytes} required=${minimumFreeBytes}`);
  }
  return Object.freeze({
    status: 'ready',
    repoRoot: root,
    labRoot,
    stateRoot: resolve(stateRoot),
    researchSha: pinnedSha,
    checkoutSha,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    cpuCount: cpus().length,
    storage: Object.freeze({ freeBytes, minimumFreeBytes }),
    safety,
  });
}

export function buildTaskPlan({ profile, stateRoot, researchSha, activationAtMs = null }) {
  const pinnedSha = assertPinnedSha(researchSha);
  const selected = profile === 'all'
    ? [...PROFILES['fast-historical'], ...PROFILES['long-history'], ...PROFILES.forward]
    : PROFILES[profile];
  if (!selected) throw new Error(`unknown research profile: ${profile}`);
  return selected.map((task) => {
    const env = {
      RESEARCH_PRODUCTION: 'true',
      RESEARCH_CODE_SHA: pinnedSha,
      LIVE_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_API_ENABLED: 'false',
      PRIVATE_ACCOUNT_ACCESS: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
      ORDER_AUTHORITY: 'false',
    };
    const args = [...task.args];
    if (task.kind === 'paper') {
      env.PAPER_FORWARD_SCHEDULE_ACTIVE = 'true';
      env.PAPER_FORWARD_ROOT = join(stateRoot, 'forward', 'paper');
      env.PAPER_FORWARD_RESEARCH_SHA = pinnedSha;
      env.PAPER_FORWARD_ACTIVATION_AT_MS = String(Number.isFinite(activationAtMs) ? activationAtMs : Date.now());
      env.PAPER_FORWARD_TRIGGER_SOURCE = 'cron';
    }
    if (task.kind === 'shadow') {
      args.push(join(stateRoot, 'forward', 'shadow-state.json'));
      args.push(join(stateRoot, 'forward', 'shadow-summary.json'));
    }
    return Object.freeze({ ...task, args: Object.freeze(args), env: Object.freeze(env), acceptedExitCodes: task.acceptedExitCodes ?? [0] });
  });
}

async function readJsonOptional(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function resolveForwardActivationAtMs(stateRoot, requestedActivationAtMs = null) {
  const metadataPath = join(stateRoot, 'forward', 'activation.json');
  const existing = await readJsonOptional(metadataPath, null);
  if (existing) {
    if (!Number.isInteger(existing.activationAtMs) || existing.activationAtMs <= 0) {
      throw new Error('stored Paper forward activation timestamp is invalid');
    }
    if (Number.isFinite(requestedActivationAtMs) && requestedActivationAtMs !== existing.activationAtMs) {
      throw new Error('Paper forward activation timestamp is immutable after first research-production run');
    }
    return existing.activationAtMs;
  }
  const activationAtMs = Number.isFinite(requestedActivationAtMs) ? Number(requestedActivationAtMs) : Date.now();
  if (!Number.isInteger(activationAtMs) || activationAtMs <= 0) throw new Error('invalid Paper forward activation timestamp');
  await atomicJson(metadataPath, {
    schemaVersion: 'research-production-forward-activation-v1',
    activationAtMs,
    createdAt: Date.now(),
  });
  return activationAtMs;
}

function taskFingerprint({ task, researchSha }) {
  return createHash('sha256').update(JSON.stringify({ id: task.id, args: task.args, researchSha })).digest('hex');
}

async function runTask({ task, labRoot, stateRoot, researchSha, cycleId, inheritedEnv = process.env }) {
  const taskDir = join(stateRoot, 'runs', cycleId, task.id);
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  const workspaceRoot = join(taskDir, 'workspace', 'market-prediction-lab');
  await mkdir(dirname(workspaceRoot), { recursive: true, mode: 0o700 });
  await cp(labRoot, workspaceRoot, { recursive: true, force: false, errorOnExist: true, dereference: false });
  const stdoutPath = join(taskDir, 'stdout.log');
  const stderrPath = join(taskDir, 'stderr.log');
  const startedAt = Date.now();
  const fingerprint = taskFingerprint({ task, researchSha });
  const stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  let timedOut = false;
  const child = spawn(process.execPath, task.args, {
    cwd: workspaceRoot,
    env: { ...sanitizeChildEnv(inheritedEnv), ...task.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, task.timeoutMs);
  timer.unref();
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => clearTimeout(timer));
  stdout.end();
  stderr.end();
  const endedAt = Date.now();
  const accepted = !timedOut && task.acceptedExitCodes.includes(result.code ?? -1);
  const record = {
    schemaVersion: 'research-production-task-v1',
    id: task.id,
    fingerprint,
    researchSha,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    status: accepted ? (result.code === 0 ? 'success' : 'blocked_data') : 'failed',
    stdoutPath,
    stderrPath,
    workspaceRoot,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  };
  await atomicJson(join(taskDir, 'result.json'), record);
  return record;
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

async function acquireLock(path, payload) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`);
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = {};
      try { existing = await readJsonOptional(path, {}); } catch { existing = {}; }
      const alive = await processIsAlive(Number(existing.pid));
      if (alive) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

export async function runResearchCycle({ repoRoot, stateRoot, researchSha, profile, concurrency = Math.max(1, Math.min(4, cpus().length)), env = process.env, activationAtMs = null, verifyGitHead = true }) {
  const preflight = await preflightResearchProduction({ repoRoot, stateRoot, researchSha, env, verifyGitHead });
  const includesForward = profile === 'forward' || profile === 'all';
  const stableActivationAtMs = includesForward
    ? await resolveForwardActivationAtMs(preflight.stateRoot, activationAtMs)
    : (Number.isFinite(activationAtMs) ? Number(activationAtMs) : Date.now());
  const plan = buildTaskPlan({ profile, stateRoot: preflight.stateRoot, researchSha: preflight.researchSha, activationAtMs: stableActivationAtMs });
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 16, plan.length));
  const cycleId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${profile}-${preflight.researchSha.slice(0, 12)}`;
  const lockPath = join(preflight.stateRoot, 'locks', `${profile}.lock`);
  const locked = await acquireLock(lockPath, { cycleId, pid: process.pid, startedAt: Date.now(), researchSha: preflight.researchSha });
  if (!locked) return Object.freeze({ status: 'already_running', profile, researchSha: preflight.researchSha });
  const results = [];
  let cursor = 0;
  try {
    const workers = Array.from({ length: safeConcurrency }, async () => {
      while (cursor < plan.length) {
        const index = cursor++;
        const task = plan[index];
        try {
          results[index] = await runTask({ task, labRoot: preflight.labRoot, stateRoot: preflight.stateRoot, researchSha: preflight.researchSha, cycleId, inheritedEnv: env });
        } catch (error) {
          results[index] = {
            schemaVersion: 'research-production-task-v1',
            id: task.id,
            researchSha: preflight.researchSha,
            status: 'failed',
            error: String(error?.stack ?? error).slice(0, 4000),
            liveTrading: false,
            privateApi: false,
            orderAuthority: false,
          };
        }
      }
    });
    await Promise.all(workers);
    const failed = results.filter((row) => row?.status === 'failed');
    const summary = {
      schemaVersion: 'research-production-cycle-v1',
      cycleId,
      profile,
      researchSha: preflight.researchSha,
      generatedAt: Date.now(),
      concurrency: safeConcurrency,
      taskCount: results.length,
      successCount: results.filter((row) => row?.status === 'success').length,
      blockedDataCount: results.filter((row) => row?.status === 'blocked_data').length,
      failedCount: failed.length,
      status: failed.length === 0 ? 'complete' : 'partial_failure',
      results,
      safety: preflight.safety,
    };
    await atomicJson(join(preflight.stateRoot, 'runs', cycleId, 'cycle.json'), summary);
    await atomicJson(join(preflight.stateRoot, 'latest', `${profile}.json`), summary);
    return Object.freeze(summary);
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function readLatestCycle({ stateRoot, profile }) {
  const text = await readFile(join(stateRoot, 'latest', `${profile}.json`), 'utf8');
  return JSON.parse(text);
}
