import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import { assertResearchSafety, preflightResearchProduction, sanitizeChildEnv } from './engine.mjs';

const STEP_TIMEOUT = 45 * 60_000;
const step = (id, args) => Object.freeze({ id, args: Object.freeze(args), timeoutMs: STEP_TIMEOUT });

export const HISTORICAL_PIPELINES = Object.freeze([
  Object.freeze({ id: 'crypto-futures-derivatives', steps: Object.freeze([
    step('market-dataset-candidates', ['scripts/run-market-suite.js', 'live-market-suite', 'docs/market-suite-result.json', 'docs/candidate-models']),
    step('futures-generalization', ['scripts/run-futures-generalization-suite.js', 'docs/futures-generalization-suite-result.json']),
    step('futures-pnl', ['scripts/run-futures-pnl-suite.js', 'docs/futures-pnl-suite-result.json']),
    step('futures-regime', ['scripts/run-futures-regime-execution-suite.js', 'docs/futures-regime-execution-suite-result.json']),
    step('funding-history', ['scripts/run-derivatives-suite.js', 'live-derivatives-suite', 'docs/derivatives-suite-result.json', 'docs/candidate-models-v2']),
    step('market-structure', ['scripts/run-market-structure-suite.js', 'live-market-structure-suite', 'docs/market-structure-suite-result.json', 'docs/candidate-models-v3']),
  ]) }),
  Object.freeze({ id: 'crypto-spot', steps: Object.freeze([
    step('upbit-spot', ['scripts/run-upbit-spot-suite.js', 'docs/upbit-spot-suite-result.json']),
    step('upbit-spot-pnl', ['scripts/run-upbit-spot-pnl-suite.js', 'docs/upbit-spot-pnl-suite-result.json']),
    step('upbit-spot-alternatives', ['scripts/run-upbit-spot-alternative-suite.js', 'docs/upbit-spot-alternative-suite-result.json']),
  ]) }),
  Object.freeze({ id: 'stocks', steps: Object.freeze([
    step('stock-market-candidates', ['scripts/run-stock-market-suite.js', 'live-stock-market-suite', 'docs/stock-market-suite-result.json', 'docs/stock-candidate-models']),
    step('stock-pnl', ['scripts/run-stock-pnl-suite.js', 'docs/stock-pnl-suite-result.json']),
    step('stock-generalization', ['scripts/run-stock-generalization-suite.js', 'docs/stock-generalization-suite-result.json']),
    step('us-pullback', ['scripts/run-us-pullback-suite.js', 'docs/us-pullback-suite-result.json']),
    step('stock-regime', ['scripts/run-stock-regime-suite.js', 'docs/stock-regime-suite-result.json']),
  ]) }),
]);

const REQUIRED = Object.freeze([
  'src/automated-research-orchestrator.js', 'src/automated-v1-research.js',
  ...new Set(HISTORICAL_PIPELINES.flatMap((pipeline) => pipeline.steps.map((entry) => entry.args[0]))),
]);

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function atomicJson(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.tmp-${process.pid}-${Date.now()}`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path); }
function checkoutSha(repoRoot) { return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().toLowerCase(); }

export function buildHistoricalPipelinePlan() {
  return HISTORICAL_PIPELINES.map((pipeline) => Object.freeze({ id: pipeline.id, stepCount: pipeline.steps.length, steps: pipeline.steps }));
}

export async function preflightHistoricalPipelines({ repoRoot, stateRoot, researchSha, env = process.env, basePreflight = null, verifyGitHead = true }) {
  assertResearchSafety({ env, stateRoot, repoRoot });
  if (!/^[0-9a-f]{40}$/i.test(researchSha ?? '')) throw new Error('historical research requires exact 40-character SHA');
  const base = basePreflight ?? await preflightResearchProduction({ repoRoot, stateRoot, researchSha, env, verifyGitHead });
  if (verifyGitHead && checkoutSha(repoRoot) !== researchSha.toLowerCase()) throw new Error('historical exact checkout SHA mismatch');
  const labRoot = join(resolve(repoRoot), 'market-prediction-lab');
  const missing = [];
  for (const relative of REQUIRED) if (!(await exists(join(labRoot, relative)))) missing.push(relative);
  if (missing.length) throw new Error(`historical pipeline prerequisites missing: ${missing.join(', ')}`);
  const orchestrator = await import(pathToFileURL(join(labRoot, 'src/automated-research-orchestrator.js')).href);
  const automatedV1 = await import(pathToFileURL(join(labRoot, 'src/automated-v1-research.js')).href);
  const contract = orchestrator.buildAutomatedResearchContract({ researchCodeSha: researchSha, providers: {} });
  const candidates = orchestrator.generateParameterCandidates({ maxCandidates: 32 });
  if (contract?.candidateSearch?.method !== 'bounded_coarse_narrow_fine' || contract?.candidateSearch?.cartesianProductAllowed !== false) throw new Error('Quant Lab candidate narrowing contract mismatch');
  if (contract?.artifactSafety?.liveOrderAllowed !== false || contract?.artifactSafety?.privateAccountRequestAllowed !== false) throw new Error('Quant Lab safety contract mismatch');
  if (typeof automatedV1.runAutomatedV1Research !== 'function' || !Array.isArray(candidates) || candidates.length < 8) throw new Error('Quant Lab automated V1 adapter/candidate generator unavailable');
  return Object.freeze({ status: 'ready', ...base, historical: { pipelineCount: HISTORICAL_PIPELINES.length, stepCount: HISTORICAL_PIPELINES.reduce((sum, p) => sum + p.steps.length, 0), quantMethod: contract.candidateSearch.method, automatedV1AdapterAvailable: true } });
}

async function processAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
async function lock(path, payload) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const handle = await open(path, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(payload)}\n`); await handle.close(); return true; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; let prior = {}; try { prior = JSON.parse(await readFile(path, 'utf8')); } catch {} if (await processAlive(Number(prior.pid))) return false; await rm(path, { force: true }); }
  }
  return false;
}

async function runStep({ entry, workspace, taskDir, env }) {
  const dir = join(taskDir, 'steps', entry.id); await mkdir(dir, { recursive: true, mode: 0o700 });
  const out = createWriteStream(join(dir, 'stdout.log'), { flags: 'wx', mode: 0o600 }); const err = createWriteStream(join(dir, 'stderr.log'), { flags: 'wx', mode: 0o600 });
  const startedAt = Date.now(); let timedOut = false;
  const child = spawn(process.execPath, entry.args, { cwd: workspace, env: { ...sanitizeChildEnv(env), RESEARCH_PRODUCTION: 'true', RESEARCH_CODE_SHA: env.RESEARCH_CODE_SHA, LIVE_TRADING: 'false', REAL_ORDER_ENABLED: 'false', PRIVATE_API_ENABLED: 'false', PRIVATE_ACCOUNT_ACCESS: 'false', PRIVATE_TRADING_API_ALLOWED: 'false', ORDER_AUTHORITY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out); child.stderr.pipe(err);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); }, entry.timeoutMs); timer.unref();
  const { code, signal } = await new Promise((resolvePromise, rejectPromise) => { child.once('error', rejectPromise); child.once('close', (code, signal) => resolvePromise({ code, signal })); }).finally(() => clearTimeout(timer));
  await Promise.allSettled([finished(out), finished(err)]);
  const record = { id: entry.id, args: entry.args, startedAt, endedAt: Date.now(), exitCode: code, signal, timedOut, status: !timedOut && code === 0 ? 'success' : 'failed' };
  await atomicJson(join(dir, 'result.json'), record); return record;
}

async function runPipeline({ pipeline, labRoot, stateRoot, cycleId, env }) {
  const taskDir = join(stateRoot, 'runs', cycleId, pipeline.id); const workspace = join(taskDir, 'workspace', 'market-prediction-lab');
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 }); await cp(labRoot, workspace, { recursive: true, force: false, errorOnExist: true, dereference: false });
  const steps = []; const startedAt = Date.now();
  for (const entry of pipeline.steps) { const result = await runStep({ entry, workspace, taskDir, env }); steps.push(result); if (result.status !== 'success') break; }
  const record = { schemaVersion: 'research-production-historical-task-v2', id: pipeline.id, startedAt, endedAt: Date.now(), status: steps.length === pipeline.steps.length && steps.every((s) => s.status === 'success') ? 'success' : 'failed', stepCount: steps.length, plannedStepCount: pipeline.steps.length, workspace, steps };
  await atomicJson(join(taskDir, 'result.json'), record); return record;
}

export async function runHistoricalPipelines({ repoRoot, stateRoot, researchSha, concurrency = Math.max(1, Math.min(3, cpus().length)), env = process.env, verifyGitHead = true }) {
  const preflight = await preflightHistoricalPipelines({ repoRoot, stateRoot, researchSha, env, verifyGitHead }); const labRoot = join(resolve(repoRoot), 'market-prediction-lab');
  const cycleId = `${new Date().toISOString().replace(/[:.]/g, '-')}-fast-historical-${researchSha.slice(0, 12)}`; const lockPath = join(stateRoot, 'locks', 'fast-historical.lock');
  if (!(await lock(lockPath, { pid: process.pid, cycleId, researchSha, startedAt: Date.now() }))) return { status: 'already_running', researchSha };
  const results = []; let cursor = 0; const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 3));
  try {
    await Promise.all(Array.from({ length: safeConcurrency }, async () => { while (cursor < HISTORICAL_PIPELINES.length) { const index = cursor++; const pipeline = HISTORICAL_PIPELINES[index]; try { results[index] = await runPipeline({ pipeline, labRoot, stateRoot, cycleId, env: { ...env, RESEARCH_CODE_SHA: researchSha } }); } catch (error) { results[index] = { id: pipeline.id, status: 'failed', error: String(error?.stack ?? error).slice(0, 4000), stepCount: 0, liveTrading: false, privateApi: false, orderAuthority: false }; } } }));
    const summary = { schemaVersion: 'research-production-historical-cycle-v2', cycleId, profile: 'fast-historical', researchSha, generatedAt: Date.now(), concurrency: safeConcurrency, taskCount: results.length, plannedStepCount: HISTORICAL_PIPELINES.reduce((sum, p) => sum + p.steps.length, 0), executedStepCount: results.reduce((sum, r) => sum + (r.stepCount ?? 0), 0), failedCount: results.filter((r) => r.status === 'failed').length, status: results.every((r) => r.status === 'success') ? 'complete' : 'partial_failure', results, safety: preflight.safety };
    await atomicJson(join(stateRoot, 'runs', cycleId, 'cycle.json'), summary); await atomicJson(join(stateRoot, 'latest', 'fast-historical.json'), summary); return summary;
  } finally { await rm(lockPath, { force: true }); }
}
