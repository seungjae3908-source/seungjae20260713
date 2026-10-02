import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { preflightResearchProduction, PROFILES, sanitizeChildEnv } from './engine.mjs';

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
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
      let prior = {};
      try {
        prior = JSON.parse(await readFile(path, 'utf8'));
      } catch {}
      if (await processIsAlive(Number(prior.pid))) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

async function runSharedTask({ task, workspaceRoot, stateRoot, researchSha, cycleId, inheritedEnv }) {
  const taskDir = join(stateRoot, 'runs', cycleId, task.id);
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  const stdoutPath = join(taskDir, 'stdout.log');
  const stderrPath = join(taskDir, 'stderr.log');
  const stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const startedAt = Date.now();
  let timedOut = false;

  const child = spawn(process.execPath, task.args, {
    cwd: workspaceRoot,
    env: {
      ...sanitizeChildEnv(inheritedEnv),
      RESEARCH_PRODUCTION: 'true',
      RESEARCH_CODE_SHA: researchSha,
      LIVE_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_API_ENABLED: 'false',
      PRIVATE_ACCOUNT_ACCESS: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
      ORDER_AUTHORITY: 'false',
    },
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

  const { code, signal } = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (exitCode, exitSignal) => resolvePromise({ code: exitCode, signal: exitSignal }));
  }).finally(() => clearTimeout(timer));

  await Promise.allSettled([finished(stdout), finished(stderr)]);
  const accepted = !timedOut && (task.acceptedExitCodes ?? [0]).includes(code ?? -1);
  const record = {
    schemaVersion: 'research-production-task-v1',
    id: task.id,
    researchSha,
    startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    exitCode: code,
    signal,
    timedOut,
    status: accepted ? (code === 0 ? 'success' : 'blocked_data') : 'failed',
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

function dependencyFailure(task, prior) {
  return {
    schemaVersion: 'research-production-task-v1',
    id: task.id,
    researchSha: prior.researchSha,
    status: 'failed',
    error: `DEPENDENCY_FAILED:${prior.id}`,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  };
}

export async function runLongHistoryPipeline({
  repoRoot,
  stateRoot,
  researchSha,
  env = process.env,
  verifyGitHead = true,
}) {
  const preflight = await preflightResearchProduction({
    repoRoot,
    stateRoot,
    researchSha,
    env,
    verifyGitHead,
  });
  const cycleId = `${new Date().toISOString().replace(/[:.]/g, '-')}-long-history-${preflight.researchSha.slice(0, 12)}`;
  const lockPath = join(preflight.stateRoot, 'locks', 'long-history.lock');
  const locked = await acquireLock(lockPath, {
    cycleId,
    pid: process.pid,
    startedAt: Date.now(),
    researchSha: preflight.researchSha,
  });
  if (!locked) return Object.freeze({ status: 'already_running', profile: 'long-history', researchSha: preflight.researchSha });

  const sharedWorkspace = join(preflight.stateRoot, 'runs', cycleId, 'shared', 'workspace', 'market-prediction-lab');
  const results = [];
  try {
    await mkdir(dirname(sharedWorkspace), { recursive: true, mode: 0o700 });
    await cp(preflight.labRoot, sharedWorkspace, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });

    for (const [index, task] of PROFILES['long-history'].entries()) {
      const seed = results[0];
      if (index > 0 && seed?.status !== 'success') {
        results.push(dependencyFailure(task, { ...seed, researchSha: preflight.researchSha }));
        continue;
      }
      const result = await runSharedTask({
        task,
        workspaceRoot: sharedWorkspace,
        stateRoot: preflight.stateRoot,
        researchSha: preflight.researchSha,
        cycleId,
        inheritedEnv: env,
      });
      results.push(result);
    }

    const failed = results.filter((row) => row.status === 'failed');
    const summary = {
      schemaVersion: 'research-production-cycle-v1',
      cycleId,
      profile: 'long-history',
      researchSha: preflight.researchSha,
      generatedAt: Date.now(),
      concurrency: 1,
      taskCount: results.length,
      successCount: results.filter((row) => row.status === 'success').length,
      blockedDataCount: results.filter((row) => row.status === 'blocked_data').length,
      failedCount: failed.length,
      status: failed.length === 0 ? 'complete' : 'partial_failure',
      sharedWorkspace,
      results,
      safety: preflight.safety,
    };
    await atomicJson(join(preflight.stateRoot, 'runs', cycleId, 'cycle.json'), summary);
    await atomicJson(join(preflight.stateRoot, 'latest', 'long-history.json'), summary);
    return Object.freeze(summary);
  } finally {
    await rm(lockPath, { force: true });
  }
}
