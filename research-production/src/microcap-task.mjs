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
  ['extendedHoursBars', 'EXTENDED_HOURS_BARS_MISSING'],
  ['vwap', 'VWAP_VALIDATION_MISSING'],
  ['firstPullback', 'FIRST_PULLBACK_VALIDATION_MISSING'],
  ['rebreak', 'REBREAK_VALIDATION_MISSING'],
  ['volumeReacceleration', 'VOLUME_REACCELERATION_VALIDATION_MISSING'],
  ['ladderExit', 'LADDER_EXIT_VALIDATION_MISSING'],
  ['breakevenVwapProtection', 'BREAKEVEN_VWAP_PROTECTION_MISSING'],
  ['timeStop', 'TIME_STOP_VALIDATION_MISSING'],
  ['tenYearMinuteHistory', 'TEN_YEAR_ALL_SESSION_MINUTE_HISTORY_MISSING'],
  ['pointInTimeFloat', 'POINT_IN_TIME_FLOAT_MISSING'],
  ['archivedFreshCatalyst', 'ARCHIVED_FRESH_CATALYST_MISSING'],
  ['pointInTimeDilutionOfferingFilter', 'POINT_IN_TIME_DILUTION_FILTER_MISSING'],
]);
const ALLOWED_DIAGNOSTIC_STATUSES = new Set([
  'RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY',
  'PARTIAL_RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY',
  'DATA_UNAVAILABLE_RECENT_DIAGNOSTIC',
]);
const ALLOWED_PIT_STATUSES = new Set([
  'NO_INTRADAY_ENTRIES',
  'DATA_BLOCKED_UPSTREAM_DIAGNOSTIC',
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

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function assertResearchOnlyEvidence(value, label) {
  if (value.canonicalEvidenceEligible !== false || value.canonicalSampleDelta !== 0) {
    throw new Error(`${label} must never grant canonical sample credit`);
  }
  if (value.profitabilityProven !== false || value.profitabilityPromotionAllowed !== false) {
    throw new Error(`${label} must never claim profitability`);
  }
  if (value.executionAuthority !== 'NONE' || value.liveTradingAllowed !== false || value.privateApiAllowed !== false) {
    throw new Error(`${label} must retain executionAuthority=NONE and public research-only safety`);
  }
}

function sourceWindowFromDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
    throw new Error('microcap diagnostic diagnostics missing');
  }
  return Object.fromEntries(Object.entries(diagnostics).map(([symbol, row]) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`microcap diagnostic row invalid: ${symbol}`);
    const bars = nonNegativeInteger(row.bars, `microcap diagnostic bars for ${symbol}`);
    const firstBar = row.firstBar ?? null;
    const lastBar = row.lastBar ?? null;
    if (bars > 0 && (typeof firstBar !== 'string' || !firstBar || typeof lastBar !== 'string' || !lastBar)) {
      throw new Error(`microcap diagnostic source window missing for ${symbol}`);
    }
    if (bars === 0 && (firstBar !== null || lastBar !== null)) {
      throw new Error(`microcap diagnostic empty source window invalid for ${symbol}`);
    }
    if (bars > 0) {
      const firstMs = Date.parse(firstBar);
      const lastMs = Date.parse(lastBar);
      if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || firstMs > lastMs) {
        throw new Error(`microcap diagnostic source window timestamps invalid for ${symbol}`);
      }
    }
    return [symbol, { firstBar, lastBar, bars }];
  }));
}

export function buildMicrocapObservationFingerprint({ diagnostic, pitRiskGate }) {
  const sourceWindow = sourceWindowFromDiagnostics(diagnostic?.diagnostics);
  return fingerprint({
    source: diagnostic.source,
    symbols: diagnostic.symbols,
    successfulSymbols: diagnostic.successfulSymbols,
    unavailableSymbols: diagnostic.unavailableSymbols,
    failures: diagnostic.failures,
    sourceWindow,
    entryModel: diagnostic.entryModel,
    entries: diagnostic.entries,
    bestRecentBy1PctCost: diagnostic.bestRecentBy1PctCost,
    summaries: diagnostic.summaries,
    pitRiskGate: {
      status: pitRiskGate.status,
      entryCount: pitRiskGate.entryCount,
      counts: pitRiskGate.counts,
      decisions: pitRiskGate.decisions,
    },
  });
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
    profitabilityProven: false,
    profitabilityPromotionAllowed: false,
    executionAuthority: 'NONE',
    liveTradingAllowed: false,
    privateApiAllowed: false,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  });
}

export function assessMicrocapDiagnostic(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('microcap diagnostic result must be an object');
  const status = String(result.status ?? '');
  if (!ALLOWED_DIAGNOSTIC_STATUSES.has(status)) throw new Error(`unexpected microcap diagnostic status: ${String(result.status)}`);
  assertResearchOnlyEvidence(result, 'microcap diagnostic');
  if (!Array.isArray(result.symbols) || !Array.isArray(result.successfulSymbols) || !Array.isArray(result.unavailableSymbols)) {
    throw new Error('microcap diagnostic symbol coverage missing');
  }
  for (const [field, values] of [
    ['symbols', result.symbols],
    ['successfulSymbols', result.successfulSymbols],
    ['unavailableSymbols', result.unavailableSymbols],
  ]) {
    if (values.some((value) => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
      throw new Error(`microcap diagnostic ${field} invalid`);
    }
  }
  const symbolSet = new Set(result.symbols);
  const successfulSet = new Set(result.successfulSymbols);
  const unavailableSet = new Set(result.unavailableSymbols);
  if ([...successfulSet].some((symbol) => !symbolSet.has(symbol) || unavailableSet.has(symbol))
    || [...unavailableSet].some((symbol) => !symbolSet.has(symbol))
    || successfulSet.size + unavailableSet.size !== symbolSet.size) {
    throw new Error('microcap diagnostic symbol coverage does not reconcile');
  }
  if (result.schemaVersion !== 1 || result.source !== 'Yahoo public chart 1m range=7d includePrePost=true') {
    throw new Error('microcap diagnostic producer identity invalid');
  }
  if (!Array.isArray(result.entries)) throw new Error('microcap diagnostic entries missing');
  if (!result.failures || typeof result.failures !== 'object' || Array.isArray(result.failures)) {
    throw new Error('microcap diagnostic failures missing');
  }
  if (Object.values(result.failures).some((value) => typeof value !== 'string' || !value)) {
    throw new Error('microcap diagnostic failure evidence invalid');
  }
  if (typeof result.entryModel !== 'string' || !result.entryModel
    || !result.summaries || typeof result.summaries !== 'object' || Array.isArray(result.summaries)
    || !(result.bestRecentBy1PctCost === null || (typeof result.bestRecentBy1PctCost === 'string' && result.bestRecentBy1PctCost))) {
    throw new Error('microcap diagnostic result evidence missing');
  }
  sourceWindowFromDiagnostics(result.diagnostics);
  const diagnosticSymbols = new Set(Object.keys(result.diagnostics));
  if ([...diagnosticSymbols].some((symbol) => !symbolSet.has(symbol))
    || [...successfulSet].some((symbol) => !diagnosticSymbols.has(symbol))
    || [...unavailableSet].some((symbol) => !Object.hasOwn(result.failures, symbol))) {
    throw new Error('microcap diagnostic diagnostics/failures do not reconcile to symbol coverage');
  }
  const expectedDataAvailable = successfulSet.size > 0;
  if (result.dataAvailable !== expectedDataAvailable) throw new Error('microcap diagnostic dataAvailable contradicts status');
  if (status === 'RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY' && (unavailableSet.size !== 0 || successfulSet.size === 0)) {
    throw new Error('complete microcap diagnostic cannot contain unavailable symbols');
  }
  if (status === 'PARTIAL_RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY' && (unavailableSet.size === 0 || successfulSet.size === 0)) {
    throw new Error('partial microcap diagnostic requires unavailable symbols');
  }
  if (status === 'DATA_UNAVAILABLE_RECENT_DIAGNOSTIC' && successfulSet.size !== 0) {
    throw new Error('unavailable microcap diagnostic cannot contain successful symbols');
  }
  if (status === 'DATA_UNAVAILABLE_RECENT_DIAGNOSTIC' && result.entries.length !== 0) {
    throw new Error('unavailable microcap diagnostic cannot contain entries');
  }
  const state = result.validationState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('microcap diagnostic validationState missing');
  const dataBlocked = [];
  if (status === 'PARTIAL_RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY') dataBlocked.push('RECENT_DIAGNOSTIC_PARTIAL');
  if (status === 'DATA_UNAVAILABLE_RECENT_DIAGNOSTIC') dataBlocked.push('RECENT_DIAGNOSTIC_DATA_UNAVAILABLE');
  for (const [key, reason] of PROMOTION_BLOCKERS) {
    if (state[key] !== true) dataBlocked.push(reason);
  }
  return Object.freeze({
    sourceStatus: status,
    status: dataBlocked.length ? 'DATA_BLOCKED' : 'DIAGNOSTIC_COMPLETE',
    entryCount: result.entries.length,
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
  if (result.schemaVersion !== 1) throw new Error('PIT risk-gate schemaVersion invalid');
  const status = String(result.status ?? '');
  if (!ALLOWED_PIT_STATUSES.has(status)) throw new Error(`unexpected PIT risk-gate status: ${String(result.status)}`);
  if (result.pointInTimeRiskGate !== true) throw new Error('point-in-time risk gate evidence missing');
  assertResearchOnlyEvidence(result, 'PIT risk gate');
  const counts = result.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('PIT risk-gate counts missing');
  const blocked = nonNegativeInteger(counts.blocked, 'PIT risk-gate blocked count');
  const rejected = nonNegativeInteger(counts.rejected, 'PIT risk-gate rejected count');
  const eligible = nonNegativeInteger(counts.eligible, 'PIT risk-gate eligible count');
  const entryCount = nonNegativeInteger(result.entryCount, 'PIT risk-gate entryCount');
  if (blocked + rejected + eligible !== entryCount) throw new Error('PIT risk-gate counts do not reconcile to entryCount');
  if (!Array.isArray(result.decisions) || result.decisions.length !== entryCount) {
    throw new Error('PIT risk-gate decisions do not reconcile to entryCount');
  }
  const derivedCounts = { blocked: 0, rejected: 0, eligible: 0 };
  for (const decision of result.decisions) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('PIT risk-gate decision invalid');
    if (decision.decision === 'DATA_BLOCKED') derivedCounts.blocked += 1;
    else if (decision.decision === 'REJECT_RISK') derivedCounts.rejected += 1;
    else if (decision.decision === 'ELIGIBLE_FOR_FILTERED_RESEARCH') derivedCounts.eligible += 1;
    else throw new Error(`unexpected PIT risk-gate decision: ${String(decision.decision)}`);
  }
  if (derivedCounts.blocked !== blocked || derivedCounts.rejected !== rejected || derivedCounts.eligible !== eligible) {
    throw new Error('PIT risk-gate decisions contradict counts');
  }
  if (status === 'DATA_BLOCKED_PIT_RISK_EVIDENCE' && blocked === 0) throw new Error('blocked PIT risk-gate status requires blocked entries');
  if (status === 'PIT_RISK_GATE_EVALUATED' && (entryCount === 0 || blocked !== 0)) throw new Error('evaluated PIT risk-gate status contradicts counts');
  if ((status === 'NO_INTRADAY_ENTRIES' || status === 'DATA_BLOCKED_UPSTREAM_DIAGNOSTIC') && entryCount !== 0) {
    throw new Error('empty/upstream-blocked PIT risk-gate status contradicts entryCount');
  }
  return Object.freeze({
    status,
    entryCount,
    blocked,
    rejected,
    eligible,
    dataBlocked: blocked > 0 || status === 'DATA_BLOCKED_PIT_RISK_EVIDENCE' || status === 'DATA_BLOCKED_UPSTREAM_DIAGNOSTIC',
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
    return Object.freeze({
      status: 'already_running',
      researchSha: sha,
      canonicalEvidenceEligible: false,
      canonicalSampleDelta: 0,
      profitabilityProven: false,
      profitabilityPromotionAllowed: false,
      executionAuthority: 'NONE',
      liveTradingAllowed: false,
      privateApiAllowed: false,
    });
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
    const sourceWindow = sourceWindowFromDiagnostics(diagnostic.diagnostics);
    const observationFingerprint = buildMicrocapObservationFingerprint({ diagnostic, pitRiskGate });
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
      profitabilityProven: false,
      profitabilityPromotionAllowed: false,
      executionAuthority: 'NONE',
      liveTradingAllowed: false,
      privateApiAllowed: false,
      dataBlocked,
      pointInTimeRiskGate: {
        status: pitAssessment.status,
        entryCount: pitAssessment.entryCount,
        blocked: pitAssessment.blocked,
        rejected: pitAssessment.rejected,
        eligible: pitAssessment.eligible,
      },
      source: diagnostic.source,
      sourceStatus: assessment.sourceStatus,
      symbols: diagnostic.symbols,
      successfulSymbols: diagnostic.successfulSymbols,
      unavailableSymbols: diagnostic.unavailableSymbols,
      failures: diagnostic.failures,
      sourceWindow,
      entryCount: assessment.entryCount,
      bestRecentBy1PctCost: diagnostic.bestRecentBy1PctCost,
      summaries: diagnostic.summaries,
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
