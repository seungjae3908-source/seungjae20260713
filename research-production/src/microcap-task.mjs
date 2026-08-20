import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertResearchSafety, preflightResearchProduction, sanitizeChildEnv } from './engine.mjs';

const execFileAsync = promisify(execFile);
const PYTHON = 'python3';
const STEP_TIMEOUT_MS = 20 * 60_000;
const SEC_DILUTION_SCRIPT = 'scripts/build-us-microcap-sec-dilution-evidence-v1.py';
const INTRADAY_LADDER_SCRIPT = 'scripts/run-us-microcap-intraday-ladder-v1.py';
const PIT_RISK_GATE_SCRIPT = 'scripts/apply-us-microcap-pit-risk-gate-v1.py';
const REQUIRED_SCRIPTS = Object.freeze([
  SEC_DILUTION_SCRIPT,
  INTRADAY_LADDER_SCRIPT,
  PIT_RISK_GATE_SCRIPT,
]);
const PROMOTION_BLOCKERS = Object.freeze([
  ['tenYearMinuteHistory', 'TEN_YEAR_ALL_SESSION_MINUTE_HISTORY_MISSING'],
  ['pointInTimeFloat', 'POINT_IN_TIME_FLOAT_MISSING'],
  ['archivedFreshCatalyst', 'ARCHIVED_FRESH_CATALYST_MISSING'],
  ['pointInTimeDilutionOfferingFilter', 'POINT_IN_TIME_DILUTION_FILTER_MISSING'],
]);
const ALLOWED_PIT_STATUSES = new Set([
  'NO_INTRADAY_ENTRIES',
  'DATA_BLOCKED_PIT_RISK_EVIDENCE',
  'PIT_RISK_GATE_EVALUATED',
]);

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function pinnedSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('microcap task requires exact 40-character research SHA');
  return sha;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
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
      try { prior = JSON.parse(await readFile(path, 'utf8')); } catch {}
      if (await processAlive(Number(prior.pid))) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

export function buildMicrocapResearchTaskPlan({ researchSha }) {
  const sha = pinnedSha(researchSha);
  return Object.freeze({
    schemaVersion: 'research-production-microcap-task-plan-v2',
    id: 'us-microcap-recent-intraday-diagnostic',
    researchSha: sha,
    runtime: PYTHON,
    steps: Object.freeze([
      Object.freeze({ id: 'sec-dilution-contract-self-test', args: Object.freeze([SEC_DILUTION_SCRIPT, '--self-test']) }),
      Object.freeze({
        id: 'recent-intraday-ladder',
        args: Object.freeze([
          INTRADAY_LADDER_SCRIPT,
          '--output-json', 'docs/us-microcap-intraday-ladder-v1.json',
          '--output-md', 'docs/us-microcap-intraday-ladder-v1.md',
        ]),
      }),
      Object.freeze({
        id: 'point-in-time-risk-gate',
        args: Object.freeze([
          PIT_RISK_GATE_SCRIPT,
          '--ladder-json', 'docs/us-microcap-intraday-ladder-v1.json',
          '--output-json', 'docs/us-microcap-pit-risk-gate-v1.json',
          '--output-md', 'docs/us-microcap-pit-risk-gate-v1.md',
        ]),
      }),
    ]),
    canonicalEvidenceEligible: false,
    canonicalSampleDelta: 0,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  });
}

export function assessMicrocapDiagnostic(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('microcap diagnostic result must be an object');
  if (result.status !== 'RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY') throw new Error(`unexpected microcap diagnostic status: ${String(result.status)}`);
  const state = result.validationState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('microcap diagnostic validationState missing');
  const dataBlocked = [];
  for (const [key, reason] of PROMOTION_BLOCKERS) {
    if (state[key] !== true) dataBlocked.push(reason);
  }
  return Object.freeze({
    status: dataBlocked.length ? 'DATA_BLOCKED' : 'DIAGNOSTIC_COMPLETE',
    dataBlocked: Object.freeze(dataBlocked),
    promotionEvidenceEligible: false,
    canonicalEvidenceEligible: false,
    canonicalSampleDelta: 0,
    duplicateCountingAllowed: false,
    reason: 'Recent Yahoo 1m diagnostics are mechanics/cost research only and cannot be promoted as canonical profitability evidence.',
  });
}

export function assessMicrocapPitRiskGate(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('microcap PIT risk-gate result must be an object');
  if (!ALLOWED_PIT_STATUSES.has(String(result.status ?? ''))) throw new Error(`unexpected PIT risk-gate status: ${String(result.status)}`);
  if (result.pointInTimeRiskGate !== true) throw new Error('point-in-time risk gate evidence missing');
  if (result.canonicalEvidenceEligible !== false || Number(result.canonicalSampleDelta) !== 0) {
    throw new Error('PIT risk gate must never grant canonical sample credit');
  }
  const counts = result.counts && typeof result.counts === 'object' ? result.counts : {};
  const blocked = Number(counts.blocked ?? 0);
  const rejected = Number(counts.rejected ?? 0);
  const eligible = Number(counts.eligible ?? 0);
  if (![blocked, rejected, eligible].every(Number.isFinite) || blocked < 0 || rejected < 0 || eligible < 0) {
    throw new Error('invalid PIT risk-gate counts');
  }
  return Object.freeze({
    status: String(result.status),
    blocked,
    rejected,
    eligible,
    dataBlocked: blocked > 0 || result.status === 'DATA_BLOCKED_PIT_RISK_EVIDENCE',
    canonicalEvidenceEligible: false,
    canonicalSampleDelta: 0,
  });
}

export async function preflightMicrocapResearchTask({ repoRoot, stateRoot, researchSha, env = process.env, verifyGitHead = true, basePreflight = null }) {
  assertResearchSafety({ env, stateRoot, repoRoot });
  const sha = pinnedSha(researchSha);
  const base = basePreflight ?? await preflightResearchProduction({ repoRoot, stateRoot, researchSha: sha, env, verifyGitHead });
  const labRoot = join(resolve(repoRoot), 'market-prediction-lab');
  const missing = [];
  for (const relative of REQUIRED_SCRIPTS) if (!(await exists(join(labRoot, relative)))) missing.push(relative);
  if (missing.length) throw new Error(`microcap Research Production prerequisites missing: ${missing.join(', ')}`);
  await execFileAsync(PYTHON, ['--version'], {
    cwd: labRoot,
    env: sanitizeChildEnv(env),
    timeout: 15_000,
    windowsHide: true,
  });
  return Object.freeze({
    status: 'ready',
    ...base,
    microcap: Object.freeze({
      taskId: 'us-microcap-recent-intraday-diagnostic',
      runtime: PYTHON,
      requiredScripts: REQUIRED_SCRIPTS,
      pitRiskGateRequired: true,
      canonicalEvidenceEligible: false,
      canonicalSampleDelta: 0,
    }),
  });
}

async function runPython({ labRoot, args, env }) {
  const { stdout = '', stderr = '' } = await execFileAsync(PYTHON, args, {
    cwd: labRoot,
    env: {
      ...sanitizeChildEnv(env),
      RESEARCH_PRODUCTION: 'true',
      RESEARCH_CODE_SHA: env.RESEARCH_CODE_SHA,
      LIVE_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_API_ENABLED: 'false',
      PRIVATE_ACCOUNT_ACCESS: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
      ORDER_AUTHORITY: 'false',
    },
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return Object.freeze({ stdout: String(stdout).slice(-16_000), stderr: String(stderr).slice(-16_000) });
}

export async function runMicrocapResearchTask({ repoRoot, stateRoot, researchSha, env = process.env, verifyGitHead = true }) {
  const sha = pinnedSha(researchSha);
  const preflight = await preflightMicrocapResearchTask({ repoRoot, stateRoot, researchSha: sha, env, verifyGitHead });
  const cycleId = `${new Date().toISOString().replace(/[:.]/g, '-')}-microcap-${sha.slice(0, 12)}`;
  const lockPath = join(resolve(stateRoot), 'locks', 'microcap-research.lock');
  if (!(await acquireLock(lockPath, { pid: process.pid, cycleId, researchSha: sha, startedAt: Date.now() }))) {
    return Object.freeze({ status: 'already_running', researchSha: sha, canonicalSampleDelta: 0 });
  }

  try {
    const taskRoot = join(resolve(stateRoot), 'runs', cycleId, 'us-microcap-recent-intraday-diagnostic');
    const workspace = join(taskRoot, 'workspace', 'market-prediction-lab');
    await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
    await cp(preflight.labRoot, workspace, { recursive: true, force: false, errorOnExist: true, dereference: false });
    const childEnv = { ...env, RESEARCH_CODE_SHA: sha };

    const secSelfTest = await runPython({ labRoot: workspace, args: [SEC_DILUTION_SCRIPT, '--self-test'], env: childEnv });
    const pitSelfTest = await runPython({ labRoot: workspace, args: [PIT_RISK_GATE_SCRIPT, '--self-test'], env: childEnv });
    const diagnosticJson = join(workspace, 'docs', 'us-microcap-intraday-ladder-v1.json');
    const diagnosticMd = join(workspace, 'docs', 'us-microcap-intraday-ladder-v1.md');
    const pitJson = join(workspace, 'docs', 'us-microcap-pit-risk-gate-v1.json');
    const pitMd = join(workspace, 'docs', 'us-microcap-pit-risk-gate-v1.md');
    const ladder = await runPython({
      labRoot: workspace,
      args: [
        INTRADAY_LADDER_SCRIPT,
        '--output-json', diagnosticJson,
        '--output-md', diagnosticMd,
      ],
      env: childEnv,
    });
    const pitRun = await runPython({
      labRoot: workspace,
      args: [
        PIT_RISK_GATE_SCRIPT,
        '--ladder-json', diagnosticJson,
        '--output-json', pitJson,
        '--output-md', pitMd,
      ],
      env: childEnv,
    });
    const diagnostic = JSON.parse(await readFile(diagnosticJson, 'utf8'));
    const pitRiskGate = JSON.parse(await readFile(pitJson, 'utf8'));
    const assessment = assessMicrocapDiagnostic(diagnostic);
    const pitAssessment = assessMicrocapPitRiskGate(pitRiskGate);
    const dataBlocked = [...new Set([
      ...assessment.dataBlocked,
      ...(pitAssessment.dataBlocked ? ['POINT_IN_TIME_RISK_GATE_BLOCKED'] : []),
    ])];
    const sourceWindow = Object.fromEntries(Object.entries(diagnostic.diagnostics ?? {}).map(([symbol, row]) => [symbol, {
      firstBar: row?.firstBar ?? null,
      lastBar: row?.lastBar ?? null,
      bars: Number(row?.bars ?? 0),
    }]));
    const observationFingerprint = fingerprint({
      researchSha: sha,
      source: diagnostic.source,
      symbols: diagnostic.symbols,
      sourceWindow,
      entryModel: diagnostic.entryModel,
      bestRecentBy1PctCost: diagnostic.bestRecentBy1PctCost,
      summaries: diagnostic.summaries,
      pitRiskGate: {
        status: pitAssessment.status,
        blocked: pitAssessment.blocked,
        rejected: pitAssessment.rejected,
        eligible: pitAssessment.eligible,
      },
    });
    let prior = null;
    try { prior = JSON.parse(await readFile(join(resolve(stateRoot), 'latest', 'microcap.json'), 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const duplicateObservation = prior?.observationFingerprint === observationFingerprint;
    const summary = {
      schemaVersion: 'research-production-microcap-cycle-v2',
      cycleId,
      researchSha: sha,
      generatedAt: Date.now(),
      status: duplicateObservation ? 'DUPLICATE_OBSERVATION' : (dataBlocked.length ? 'DATA_BLOCKED' : assessment.status),
      observationFingerprint,
      duplicateObservation,
      canonicalSampleDelta: 0,
      promotionEvidenceEligible: false,
      canonicalEvidenceEligible: false,
      dataBlocked,
      pointInTimeRiskGate: {
        status: pitAssessment.status,
        blocked: pitAssessment.blocked,
        rejected: pitAssessment.rejected,
        eligible: pitAssessment.eligible,
      },
      source: diagnostic.source,
      sourceWindow,
      entryCount: Array.isArray(diagnostic.entries) ? diagnostic.entries.length : 0,
      bestRecentBy1PctCost: diagnostic.bestRecentBy1PctCost ?? null,
      summaries: diagnostic.summaries ?? {},
      child: {
        secSelfTest: { status: secSelfTest.stdout.includes('PASS') || secSelfTest.stdout.includes('OK') ? 'success' : 'unknown', stderr: secSelfTest.stderr },
        pitRiskGateSelfTest: { status: pitSelfTest.stdout.includes('PIT_RISK_GATE_SELF_TEST_OK') ? 'success' : 'unknown', stderr: pitSelfTest.stderr },
        ladder: { status: 'success', stderr: ladder.stderr },
        pitRiskGate: { status: 'success', stderr: pitRun.stderr },
      },
      safety: preflight.safety,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
    };
    await atomicJson(join(taskRoot, 'result.json'), summary);
    await atomicJson(join(resolve(stateRoot), 'latest', 'microcap.json'), summary);
    return Object.freeze(summary);
  } finally {
    await rm(lockPath, { force: true });
  }
}
