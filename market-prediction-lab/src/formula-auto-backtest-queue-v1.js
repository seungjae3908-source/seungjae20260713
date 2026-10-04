import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { assertFormulaCandidateV1 } from './autonomous-strategy-formula-generator-v1.js';
import {
  buildEvidenceBackedFormulaExecutionParametersV1,
  createEvidenceBackedFormulaSignalEvaluatorV1,
} from './evidence-backed-formula-entry-evaluator-v1.js';
import {
  runOnePassCandidateBacktestV1,
  runResearchTournamentV1,
} from './research-tournament-engine-v1.js';

export const FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1 = 'research-formula-auto-backtest-queue-item/v1';
export const FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1 = 'research-formula-auto-backtest-result/v1';
export const FORMULA_AUTO_BACKTEST_SUMMARY_CONTRACT_V1 = 'research-formula-auto-backtest-summary/v1';
export const FORMULA_AUTO_BACKTEST_STATES_V1 = Object.freeze(['PASS', 'HOLD', 'RESERVE', 'EXCLUDE']);

const SAFE_FILE = /^[A-Za-z0-9._-]{1,180}\.json$/u;
const FORBIDDEN_CREDENTIAL_KEY = /^(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|password|passphrase|authorization|cookie|bearer|private[_-]?key|account[_-]?token)$/iu;
const STRUCTURAL_REJECT_CODES = new Set([
  'FORMULA_INVALID',
  'DUPLICATE_FORMULA',
  'PARAMETER_OUT_OF_BOUNDS',
  'DATASET_ROLE_INVALID',
  'TIMEFRAME_INCOMPATIBLE',
  'MARKET_INCOMPATIBLE',
  'DIRECTION_INCOMPATIBLE',
  'IMPOSSIBLE_CONDITION',
  'CONTRADICTORY_ENTRY_RULE',
  'INVALID_EXIT_CONFIGURATION',
  'OOS_OVERLAP',
  'PARAMETER_MUTATION',
  'STRATEGY_HASH_MUTATION',
  'LEAKAGE_DETECTED',
  'HOLDOUT_PREACCESS_FORBIDDEN',
  'HOLDOUT_CONTRACT_INVALID',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function containsCredentialKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCredentialKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_CREDENTIAL_KEY.test(key) || containsCredentialKey(child));
}

function ensureStateRoot(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !isAbsolute(raw)) throw new Error('FORMULA_QUEUE_STATE_ROOT_ABSOLUTE_REQUIRED');
  const root = resolve(raw);
  for (const protectedRoot of ['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app']) {
    if (root === protectedRoot || root.startsWith(protectedRoot + '/')) {
      throw new Error('FORMULA_QUEUE_PROTECTED_APP_STORAGE_FORBIDDEN');
    }
  }
  return root;
}

function validateBacktestInput(item, queuedAtMs) {
  const formula = item.formulaCandidate;
  const dataset = item.dataset;
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error('FORMULA_QUEUE_DATASET_REQUIRED');
  }
  if (dataset.datasetRole !== 'TRAIN' || typeof dataset.datasetIdentity !== 'string' || !dataset.datasetIdentity.trim()) {
    throw new Error('FORMULA_QUEUE_TRAIN_DATASET_IDENTITY_REQUIRED');
  }
  if (dataset.market !== formula.market
    || String(dataset.timeframe).toLowerCase() !== String(formula.timeframe).toLowerCase()
    || String(dataset.direction).toUpperCase() !== String(formula.direction).toUpperCase()) {
    throw new Error('FORMULA_QUEUE_DATASET_FORMULA_SCOPE_MISMATCH');
  }
  if (!Array.isArray(dataset.availableFields) || dataset.availableFields.length === 0) {
    throw new Error('FORMULA_QUEUE_AVAILABLE_FIELDS_REQUIRED');
  }
  const backtestInput = dataset.backtestInput;
  if (!backtestInput || typeof backtestInput !== 'object' || Array.isArray(backtestInput)
    || backtestInput.market !== formula.market
    || String(backtestInput.timeframe).toLowerCase() !== String(formula.timeframe).toLowerCase()
    || !Array.isArray(backtestInput.candles)) {
    throw new Error('FORMULA_QUEUE_BACKTEST_INPUT_SCOPE_MISMATCH');
  }
  const expectedSide = String(formula.direction).toUpperCase() === 'SHORT' ? 'short' : 'long';
  if (backtestInput.side !== expectedSide) throw new Error('FORMULA_QUEUE_BACKTEST_SIDE_MISMATCH');
  const period = dataset.period;
  if (!period || !Number.isSafeInteger(period.startTime) || !Number.isSafeInteger(period.endTime)
    || period.startTime >= period.endTime || period.includeFinalHoldout !== false
    || period.endTime > queuedAtMs) {
    throw new Error('FORMULA_QUEUE_PERIOD_INVALID_OR_FUTURE');
  }
  let previous = -1;
  for (const candle of backtestInput.candles) {
    if (!candle || !Number.isSafeInteger(candle.timestamp) || candle.timestamp <= previous || candle.timestamp > queuedAtMs) {
      throw new Error('FORMULA_QUEUE_CANDLE_TIME_INVALID_OR_FUTURE');
    }
    for (const key of ['open', 'high', 'low', 'close', 'volume']) {
      if (!finite(candle[key])) throw new Error('FORMULA_QUEUE_CANDLE_NON_FINITE');
    }
    previous = candle.timestamp;
  }
  if (backtestInput.candles.length !== dataset.candleCount) {
    throw new Error('FORMULA_QUEUE_CANDLE_COUNT_MISMATCH');
  }
  return dataset;
}

export function validateFormulaAutoBacktestQueueItemV1(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || item.schemaVersion !== 1 || item.contract !== FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1) {
    throw new Error('FORMULA_QUEUE_CONTRACT_INVALID');
  }
  const queuedAtMs = isoMs(item.queuedAt);
  if (queuedAtMs == null || queuedAtMs > Date.now() + 5 * 60_000) {
    throw new Error('FORMULA_QUEUE_TIMESTAMP_INVALID');
  }
  if (containsCredentialKey(item)) throw new Error('FORMULA_QUEUE_PRIVATE_CREDENTIAL_FORBIDDEN');
  assertFormulaCandidateV1(item.formulaCandidate);
  const dataset = validateBacktestInput(item, queuedAtMs);
  const expectedDatasetIdentity = item.formulaCandidate.provenance?.datasetIdentity;
  if (expectedDatasetIdentity !== dataset.datasetIdentity) {
    throw new Error('FORMULA_QUEUE_DATASET_IDENTITY_MISMATCH');
  }
  return Object.freeze({
    queuedAtMs,
    formulaCandidate: item.formulaCandidate,
    dataset,
  });
}

function generationBudget() {
  return Object.freeze({
    maxCandidatesPerHypothesis: 4,
    maxCandidatesPerRun: 4,
    maxGenerations: 1,
    maxParameterCombinations: 64,
    maxAstNodes: 64,
    maxRuntimeMs: 30_000,
    maxCpuMs: 30_000,
    maxMemoryBytes: 256 * 1024 * 1024,
  });
}

function tournamentBudget(candleCount) {
  return Object.freeze({
    maxCandidatesPerRun: 4,
    maxConcurrentBacktests: 1,
    maxTotalCandles: Math.max(100, Math.min(500_000, candleCount * 4)),
    maxRuntimeMs: 60_000,
    maxCpuPercent: 80,
    maxMemoryMb: 1024,
    maxWalkForwardWindows: 12,
    maxStressScenarios: 8,
  });
}

function tournamentPolicy() {
  return Object.freeze({
    minimumCandles: 100,
    minimumTrades: 30,
    minimumIndependentPeriods: 3,
    minimumRegimeSamples: Object.freeze({ BULL: 10, BEAR: 10, SIDEWAYS: 10 }),
    minimumWalkForwardWindows: 3,
    minimumPositiveWalkForwardRatio: 0.5,
    maximumFailureConcentration: 0.5,
    minimumNeighborhoodWidth: 2,
    multipleTestingBaseAlpha: 0.05,
  });
}

function historicalDependencies(validated) {
  const { formulaCandidate, dataset } = validated;
  const dependencies = {
    async loadDatasetMetadata() {
      return {
        datasetIdentity: dataset.datasetIdentity,
        datasetRole: 'TRAIN',
        market: dataset.market,
        timeframe: dataset.timeframe,
        direction: dataset.direction,
        candleCount: dataset.candleCount,
        independentPeriods: Number.isSafeInteger(dataset.sampleEvidence?.independentPeriods)
          ? dataset.sampleEvidence.independentPeriods : null,
        availableFields: dataset.availableFields,
      };
    },
    async runHistoricalBacktest({ generatedCandidate, datasetIdentity }) {
      if (formulaCandidate.market === 'CRYPTO_FUTURES') {
        return {
          status: 'MISSING_EVIDENCE',
          failureCode: 'REQUIRED_DATA_MISSING',
          failureReason: 'DERIVATIVES_SAFE_DSL_EVALUATOR_NOT_ENABLED',
        };
      }
      const { signalEvaluator, evaluatorContract } = createEvidenceBackedFormulaSignalEvaluatorV1({
        formulaCandidate,
        generatedCandidate,
      });
      const executionParameters = buildEvidenceBackedFormulaExecutionParametersV1({
        formulaCandidate,
        generatedCandidate,
      });
      const result = runOnePassCandidateBacktestV1({
        formulaCandidate,
        generatedCandidate,
        datasetIdentity,
        backtestInput: dataset.backtestInput,
        executionParameters,
        signalEvaluator,
        evaluatorContract,
        period: dataset.period,
        liquidityImpactEvidence: dataset.liquidityImpactEvidence ?? null,
      });
      const sample = dataset.sampleEvidence && Number.isSafeInteger(dataset.sampleEvidence.independentPeriods)
        && dataset.sampleEvidence.regimeCounts && typeof dataset.sampleEvidence.regimeCounts === 'object'
        ? {
            tradeCount: result.metrics.trades,
            independentPeriods: dataset.sampleEvidence.independentPeriods,
            regimeCounts: dataset.sampleEvidence.regimeCounts,
          }
        : null;
      return sample ? { ...result, sample } : result;
    },
  };
  const evidence = dataset.stageEvidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const bindings = [
      ['runOos', 'oos'],
      ['runPurgedOos', 'purgedOos'],
      ['runWalkForward', 'walkForward'],
      ['runCostStress', 'costStress'],
      ['runRegimeStress', 'regimeStress'],
      ['runParameterNeighborhood', 'parameterNeighborhood'],
      ['runStatisticalFirewall', 'statisticalFirewall'],
      ['runFinalHoldout', 'finalHoldout'],
    ];
    for (const [callbackName, key] of bindings) {
      if (evidence[key] !== undefined) dependencies[callbackName] = async () => structuredClone(evidence[key]);
    }
  }
  return dependencies;
}

function candidateState(candidate) {
  if (candidate?.researchSurvivor === true && candidate?.failure === null) return 'PASS';
  const failure = candidate?.failure;
  const last = Array.isArray(candidate?.stageRecords) ? candidate.stageRecords.at(-1) : null;
  if (!failure) return 'HOLD';
  if (last?.status === 'MISSING_EVIDENCE' || last?.status === 'NOT_EVALUABLE'
    || failure.failureCode === 'MISSING_CANONICAL_CALLBACK'
    || failure.failureCode === 'EVALUATION_RUNTIME_ERROR') return 'HOLD';
  if (STRUCTURAL_REJECT_CODES.has(failure.failureCode)) return 'EXCLUDE';
  return 'RESERVE';
}

export function classifyFormulaAutoBacktestResultV1(tournament) {
  const candidates = Array.isArray(tournament?.candidates) ? tournament.candidates : [];
  const states = candidates.map(candidateState);
  if (states.includes('PASS')) return 'PASS';
  if (states.includes('RESERVE')) return 'RESERVE';
  if (states.includes('HOLD')) return 'HOLD';
  return 'EXCLUDE';
}

export async function evaluateFormulaAutoBacktestQueueItemV1(item) {
  let validated;
  try {
    validated = validateFormulaAutoBacktestQueueItemV1(item);
  } catch (error) {
    return Object.freeze({
      state: 'EXCLUDE',
      reason: String(error?.message ?? error).slice(0, 300),
      tournament: null,
    });
  }
  const { formulaCandidate, dataset } = validated;
  const input = {
    formulaCandidates: [formulaCandidate],
    generationBudget: generationBudget(),
    search: {
      method: 'BOUNDED_GRID',
      seed: 17,
      requestedCandidates: 4,
      datasetIdentity: dataset.datasetIdentity,
      finalHoldoutAccess: false,
    },
    budget: tournamentBudget(dataset.candleCount),
    policy: tournamentPolicy(),
    resourceSnapshot: { cpuPercent: 0, memoryMb: 0, activeBacktests: 0 },
    observedAt: new Date(validated.queuedAtMs).toISOString(),
  };
  const tournament = await runResearchTournamentV1(input, historicalDependencies(validated));
  const state = classifyFormulaAutoBacktestResultV1(tournament);
  return Object.freeze({
    state,
    reason: state === 'PASS'
      ? 'FULL_RESEARCH_TOURNAMENT_SURVIVOR'
      : state === 'HOLD'
        ? 'MORE_CANONICAL_EVIDENCE_REQUIRED'
        : state === 'RESERVE'
          ? 'VALID_FORMULA_FAILED_PERFORMANCE_GATE'
          : 'STRUCTURAL_FORMULA_REJECTED',
    tournament,
  });
}

async function writeOnce(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temp = path + '.tmp-' + process.pid + '-' + Date.now();
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function processFormulaAutoBacktestQueueV1({
  stateRoot,
  maximumItems = 50,
} = {}) {
  const root = ensureStateRoot(stateRoot);
  const inbox = join(root, 'formula-backtest', 'inbox');
  const resultsRoot = join(root, 'formula-backtest', 'results');
  const latestPath = join(root, 'latest', 'formula-backtest-queue.json');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  let files = (await readdir(inbox)).filter((name) => SAFE_FILE.test(name)).sort().slice(0, maximumItems);
  const rows = [];
  for (const name of files) {
    const path = join(inbox, name);
    const info = await stat(path);
    if (!info.isFile() || info.isSymbolicLink?.()) continue;
    const item = JSON.parse(await readFile(path, 'utf8'));
    const itemDigest = digest(item);
    const resultPath = join(resultsRoot, itemDigest + '.json');
    let result;
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'));
      rows.push({ ...result, repeated: true });
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const evaluated = await evaluateFormulaAutoBacktestQueueItemV1(item);
    const formulaId = typeof item?.formulaCandidate?.candidateId === 'string'
      ? item.formulaCandidate.candidateId : basename(name, '.json');
    result = {
      schemaVersion: 1,
      contract: FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1,
      itemDigest,
      formulaId,
      queuedAt: typeof item?.queuedAt === 'string' ? item.queuedAt : null,
      evaluatedAt: new Date().toISOString(),
      state: evaluated.state,
      reason: evaluated.reason,
      tournamentId: evaluated.tournament?.tournamentId ?? null,
      candidateCount: evaluated.tournament?.candidates?.length ?? 0,
      researchSurvivorCount: evaluated.tournament?.researchSurvivorCount ?? 0,
      blockers: evaluated.tournament?.candidates?.flatMap((candidate) =>
        candidate?.failure ? [candidate.failure.failureCode] : []) ?? [evaluated.reason],
      tournament: evaluated.tournament,
      deleted: false,
      retainedForAudit: true,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      executionAuthority: 'NONE',
    };
    await writeOnce(resultPath, result);
    rows.push(result);
  }
  const counts = Object.fromEntries(FORMULA_AUTO_BACKTEST_STATES_V1.map((state) => [
    state, rows.filter((row) => row.state === state).length,
  ]));
  const summary = {
    schemaVersion: 1,
    contract: FORMULA_AUTO_BACKTEST_SUMMARY_CONTRACT_V1,
    generatedAt: new Date().toISOString(),
    scanned: files.length,
    counts,
    rows: rows.map((row) => ({
      formulaId: row.formulaId,
      itemDigest: row.itemDigest,
      state: row.state,
      reason: row.reason,
      evaluatedAt: row.evaluatedAt,
      tournamentId: row.tournamentId,
      candidateCount: row.candidateCount,
      researchSurvivorCount: row.researchSurvivorCount,
      blockers: row.blockers,
      retainedForAudit: true,
    })),
    deletionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrder: false,
    executionAuthority: 'NONE',
  };
  await atomicJson(latestPath, summary);
  return Object.freeze(summary);
}
