import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
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

export const FORMULA_AUTO_BACKTEST_PRODUCER_INPUT_CONTRACT_V1 = 'research-formula-produced-train-input/v1';
export const FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1 = 'research-formula-auto-backtest-queue-item/v1';
export const FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1 = 'research-formula-auto-backtest-result/v1';
export const FORMULA_AUTO_BACKTEST_SUMMARY_CONTRACT_V1 = 'research-formula-auto-backtest-summary/v1';
export const FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1 = 'research-formula-paper-strategy-registry/v1';
export const FORMULA_AUTO_BACKTEST_STATES_V1 = Object.freeze(['PASS', 'HOLD', 'RESERVE', 'EXCLUDE']);

const SAFE_FILE = /^[A-Za-z0-9._-]{1,180}\.json$/u;
// Bounded, public research evidence. This is not a credential or trade path.
const MAX_QUEUE_JSON_BYTES = 64 * 1024 * 1024;
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
  // TRAIN uploads are not an OOS/forward/settlement authority. Synthetic or
  // unbound stageEvidence must never turn a backtest into a Paper PASS.
  // A future attested external-evidence reader must bind immutable digests
  // before stage callbacks can be enabled.
  if (dataset.stageEvidence != null) {
    throw new Error('FORMULA_QUEUE_UNATTESTED_STAGE_EVIDENCE_FORBIDDEN');
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
    || period.endTime > queuedAtMs || period.endTime > Date.now()) {
    throw new Error('FORMULA_QUEUE_PERIOD_INVALID_OR_FUTURE');
  }
  let previous = -1;
  for (const candle of backtestInput.candles) {
    if (!candle || !Number.isSafeInteger(candle.timestamp) || candle.timestamp <= previous
      || candle.timestamp > queuedAtMs || candle.timestamp > Date.now()) {
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

/**
 * Prior result files are immutable audit artifacts, not a second strategy
 * authority. A file with the expected digest *name* can still contain a
 * substituted PASS or weakened safety envelope. Never promote cached PASS:
 * this TRAIN-only reader has no attested OOS/forward/cost callbacks.
 */
function assertSafeCachedFormulaResultV1(result, expectedDigest, expectedFormulaId, queuedAt) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.contract !== FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1
    || result.schemaVersion !== 1
    || result.itemDigest !== expectedDigest
    || result.formulaId !== expectedFormulaId
    || result.queuedAt !== queuedAt
    || !FORMULA_AUTO_BACKTEST_STATES_V1.includes(result.state)
    || result.state === 'PASS'
    || result.deleted !== false
    || result.retainedForAudit !== true
    || result.liveTrading !== false
    || result.autoTrading !== false
    || result.realOrder !== false
    || result.privateTradingApi !== false
    || result.executionAuthority !== 'NONE'
    || !Number.isSafeInteger(result.candidateCount) || result.candidateCount < 0
    || result.researchSurvivorCount !== 0
    || typeof result.reason !== 'string' || result.reason.length > 300
    || !Array.isArray(result.blockers)
    || result.blockers.some((code) => typeof code !== 'string' || code.length > 300)) {
    throw new Error('FORMULA_QUEUE_CACHED_RESULT_UNSAFE');
  }
  return result;
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

export function buildFormulaPaperStrategyRegistryV1(rows = [], { researchCodeSha = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('FORMULA_PAPER_REGISTRY_ROWS_ARRAY_REQUIRED');
  if (researchCodeSha != null && !/^[0-9a-f]{40}$/iu.test(researchCodeSha)) throw new TypeError('FORMULA_PAPER_REGISTRY_RESEARCH_SHA_INVALID');
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    if (row?.state !== 'PASS' || !Array.isArray(row?.tournament?.candidates)) continue;
    for (const candidate of row.tournament.candidates) {
      if (candidate?.researchSurvivor !== true
        || candidate?.failure !== null
        || candidate?.tradingAuthority !== false
        || candidate?.safety?.executionAuthority !== 'NONE'
        || !candidate?.formulaCandidate
        || !candidate?.generatedCandidate) continue;
      const market = candidate.market;
      const direction = String(candidate.direction ?? '').toUpperCase();
      const allowedDirection = market === 'CRYPTO_FUTURES'
        ? (direction === 'LONG' || direction === 'SHORT')
        : (['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'].includes(market) && direction === 'LONG');
      if (!allowedDirection) continue;
      const registryId = digest({
        itemDigest: row.itemDigest,
        formulaCandidateId: candidate.formulaCandidateId,
        generatedCandidateId: candidate.generatedCandidateId,
        parameterIdentity: candidate.parameterIdentity,
      });
      if (seen.has(registryId)) continue;
      seen.add(registryId);
      entries.push(Object.freeze({
        registryId,
        source: 'FORMULA_AUTO_BACKTEST_PASS',
        researchCodeSha: researchCodeSha == null ? null : researchCodeSha.toLowerCase(),
        registeredAt: row.evaluatedAt ?? null,
        itemDigest: row.itemDigest ?? null,
        tournamentId: row.tournamentId ?? row.tournament?.tournamentId ?? null,
        formulaCandidateId: candidate.formulaCandidateId ?? null,
        generatedCandidateId: candidate.generatedCandidateId ?? null,
        strategyHash: candidate.strategyHash ?? null,
        parameterIdentity: candidate.parameterIdentity ?? null,
        strategyFamily: candidate.strategyFamily ?? null,
        market,
        timeframe: candidate.timeframe ?? null,
        direction,
        formulaCandidate: structuredClone(candidate.formulaCandidate),
        generatedCandidate: structuredClone(candidate.generatedCandidate),
        paperState: 'REGISTERED_WAITING_FUTURE_SIGNAL',
        futureSignalRequired: true,
        freshPublicEvidenceRequired: true,
        canonicalPaperAdmissionRequired: true,
        simulationAuthorityRequired: true,
        directTradeOnBacktestPass: false,
        enabledForPaperEvaluation: true,
        retainedForAudit: true,
        liveTrading: false,
        autoTrading: false,
        realOrder: false,
        privateTradingApi: false,
        executionAuthority: 'NONE',
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    contract: FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1,
    researchCodeSha: researchCodeSha == null ? null : researchCodeSha.toLowerCase(),
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries: Object.freeze(entries),
    acceptedSourceState: 'PASS',
    rejectedSourceStates: Object.freeze(['HOLD', 'RESERVE', 'EXCLUDE']),
    directTradeOnBacktestPass: false,
    futureSignalRequired: true,
    canonicalPaperAdmissionRequired: true,
    deletionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrder: false,
    privateTradingApi: false,
    executionAuthority: 'NONE',
  });
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


/**
 * Research producer -> TRAIN queue intake. This accepts only structurally
 * valid, private, immutable staged items bound to the pinned Research SHA.
 * It does NOT authenticate the upstream public data supplier, infer OOS,
 * mint PASS, create Paper admission, or dispatch any financial order.
 */
const INTAKE_FILE_NAME = /^[0-9a-f]{64}\.json$/u;
const MAX_INTAKE_BYTES = 8 * 1024 * 1024;

function validateIntakeSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error('FORMULA_INTAKE_EXACT_RESEARCH_SHA_REQUIRED');
  }
  return value;
}

export function buildFormulaProducedTrainInputV1({ item, researchCodeSha } = {}) {
  const sha = validateIntakeSha(researchCodeSha);
  validateFormulaAutoBacktestQueueItemV1(item);
  return Object.freeze({
    schemaVersion: 1,
    contract: FORMULA_AUTO_BACKTEST_PRODUCER_INPUT_CONTRACT_V1,
    researchCodeSha: sha,
    itemDigest: digest(item),
    item: structuredClone(item),
  });
}

async function assertPrivateIntakeDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || await realpath(path) !== path) {
    throw new Error('FORMULA_INTAKE_DIRECTORY_UNSAFE');
  }
}

// Input/result JSON can be researcher-provided. Reject symbolic links,
// oversized files, mutable in-place reads and writable shared files before
// interpreting any cached result as strategy evidence.
async function readBoundedQueueJson(path, unsafeReason) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(unsafeReason);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || before.size <= 0 || before.size > MAX_QUEUE_JSON_BYTES
      || (before.mode & 0o022) !== 0) throw new Error(unsafeReason);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.nlink !== 1) throw new Error(unsafeReason);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(unsafeReason); }
  } finally { await handle.close(); }
}

async function readPrivateIntakeJson(path) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('FORMULA_INTAKE_FILE_UNSAFE');
    throw error;
  }
  try {
    const first = await handle.stat();
    if (!first.isFile() || first.nlink !== 1 || first.size <= 0 || first.size > MAX_INTAKE_BYTES
      || (first.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && first.uid !== process.getuid())) {
      throw new Error('FORMULA_INTAKE_FILE_UNSAFE');
    }
    const bytes = await handle.readFile();
    const last = await handle.stat();
    if (bytes.length !== first.size || last.size !== first.size
      || last.ino !== first.ino || last.mtimeMs !== first.mtimeMs
      || last.nlink !== 1) {
      throw new Error('FORMULA_INTAKE_FILE_CHANGED_DURING_READ');
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('FORMULA_INTAKE_JSON_INVALID');
    }
  } finally {
    await handle.close();
  }
}

function intakeReport(status, count, imported, alreadyQueued) {
  return Object.freeze({
    status,
    stagedItemCount: count,
    imported,
    alreadyQueued,
    producerBound: false,
    upstreamPublicDataAttested: false,
    verifiedOos: false,
    paperDispatchAllowed: false,
    financialMutationCount: 0,
    privateRequestCount: 0,
    executionAuthority: 'NONE',
  });
}

export async function ingestFormulaProducedTrainInputsV1({
  stateRoot,
  researchCodeSha,
  maximumItems = 50,
} = {}) {
  const sha = validateIntakeSha(researchCodeSha);
  const root = ensureStateRoot(stateRoot);
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 50) {
    throw new Error('FORMULA_INTAKE_BATCH_LIMIT_INVALID');
  }
  const staged = join(root, 'formula-backtest', 'producer-outbox');
  const inbox = join(root, 'formula-backtest', 'inbox');
  let fileNames;
  try {
    fileNames = await readdir(staged);
  } catch (error) {
    if (error?.code === 'ENOENT') return intakeReport('MISSING_PRODUCER_OUTBOX', null, 0, 0);
    throw error;
  }
  await assertPrivateIntakeDirectory(staged);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await assertPrivateIntakeDirectory(inbox);
  const files = fileNames.filter((name) => name.endsWith('.json')).sort();
  if (files.length > 10_000 || files.some((name) => !INTAKE_FILE_NAME.test(name))) {
    throw new Error('FORMULA_INTAKE_FILENAME_OR_BACKLOG_INVALID');
  }
  let imported = 0;
  let alreadyQueued = 0;
  for (const name of files) {
    const record = await readPrivateIntakeJson(join(staged, name));
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'contract,item,itemDigest,researchCodeSha,schemaVersion'
      || record.schemaVersion !== 1
      || record.contract !== FORMULA_AUTO_BACKTEST_PRODUCER_INPUT_CONTRACT_V1
      || record.researchCodeSha !== sha
      || typeof record.itemDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(record.itemDigest)
      || name !== record.itemDigest + '.json'
      || digest(record.item) !== record.itemDigest) {
      throw new Error('FORMULA_INTAKE_PRODUCER_CONTRACT_INVALID');
    }
    // TRAIN-only canonical validator rejects future candles, mismatched
    // market/direction/timeframe, credentials and untrusted OOS/cost claims.
    validateFormulaAutoBacktestQueueItemV1(record.item);
    const destination = join(inbox, name);
    try {
      const previous = await readPrivateIntakeJson(destination);
      if (digest(previous) !== record.itemDigest) throw new Error('FORMULA_INTAKE_EXISTING_QUEUE_CONFLICT');
      alreadyQueued += 1;
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (imported >= maximumItems) continue;
    try {
      await writeOnce(destination, record.item);
      imported += 1;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const previous = await readPrivateIntakeJson(destination);
      if (digest(previous) !== record.itemDigest) throw new Error('FORMULA_INTAKE_EXISTING_QUEUE_CONFLICT');
      alreadyQueued += 1;
    }
  }
  return intakeReport(
    files.length === 0 ? 'EMPTY_PRODUCER_OUTBOX' : imported > 0 ? 'STAGED_TRAIN_IMPORTED' : 'STAGED_TRAIN_ALREADY_QUEUED',
    files.length, imported, alreadyQueued,
  );
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
  researchCodeSha = null,
} = {}) {
  const root = ensureStateRoot(stateRoot);
  const inbox = join(root, 'formula-backtest', 'inbox');
  const resultsRoot = join(root, 'formula-backtest', 'results');
  const latestPath = join(root, 'latest', 'formula-backtest-queue.json');
  const paperRegistryPath = join(root, 'latest', 'formula-paper-strategy-registry.json');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 50) {
    throw new Error('FORMULA_QUEUE_BATCH_LIMIT_INVALID');
  }
  // Rotate by the last inspected filename, rather than replaying the first
  // alphabetical 50 forever. Original inputs/results remain immutable.
  const stagedIntake = await ingestFormulaProducedTrainInputsV1({
    stateRoot: root,
    researchCodeSha,
    maximumItems,
  });
  const allFiles = (await readdir(inbox)).filter((name) => SAFE_FILE.test(name)).sort();
  let previousSummary = null;
  try {
    previousSummary = JSON.parse(await readFile(latestPath, 'utf8'));
    if (previousSummary.contract !== FORMULA_AUTO_BACKTEST_SUMMARY_CONTRACT_V1
      || previousSummary.executionAuthority !== 'NONE'
      || previousSummary.liveTrading !== false
      || previousSummary.autoTrading !== false) {
      throw new Error('FORMULA_QUEUE_PRIOR_SUMMARY_UNSAFE');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const previousCursor = typeof previousSummary?.lastProcessedFileName === 'string'
    ? previousSummary.lastProcessedFileName : null;
  let first = previousCursor == null ? 0 : allFiles.findIndex((name) => name > previousCursor);
  if (first < 0) first = 0;
  const files = [...allFiles.slice(first), ...allFiles.slice(0, first)].slice(0, maximumItems);
  const rows = [];
  for (const name of files) {
    const path = join(inbox, name);
    const item = await readBoundedQueueJson(path, 'FORMULA_QUEUE_INPUT_UNSAFE_FILE');
    const itemDigest = digest(item);
    const resultPath = join(resultsRoot, itemDigest + '.json');
    const formulaId = typeof item?.formulaCandidate?.candidateId === 'string'
      ? item.formulaCandidate.candidateId : basename(name, '.json');
    const queuedAt = typeof item?.queuedAt === 'string' ? item.queuedAt : null;
    let result;
    try {
      result = assertSafeCachedFormulaResultV1(
        await readBoundedQueueJson(resultPath, 'FORMULA_QUEUE_CACHED_RESULT_UNSAFE_FILE'),
        itemDigest, formulaId, queuedAt,
      );
      rows.push({ ...result, repeated: true });
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const evaluated = await evaluateFormulaAutoBacktestQueueItemV1(item);
    result = {
      schemaVersion: 1,
      contract: FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1,
      itemDigest,
      formulaId,
      queuedAt,
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
  // Existing PASS entries in the canonical registry must not disappear when
  // the next bounded batch examines different candidate files. Keep them only
  // within the same research SHA; historical releases never receive new credit.
  const newRegistry = buildFormulaPaperStrategyRegistryV1(rows, { researchCodeSha });
  let oldEntries = [];
  try {
    const oldRegistry = JSON.parse(await readFile(paperRegistryPath, 'utf8'));
    if (oldRegistry.contract !== FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1
      || oldRegistry.executionAuthority !== 'NONE'
      || oldRegistry.liveTrading !== false
      || oldRegistry.autoTrading !== false
      || oldRegistry.realOrder !== false
      || oldRegistry.privateTradingApi !== false
      || oldRegistry.directTradeOnBacktestPass !== false
      || !Array.isArray(oldRegistry.entries)
      || oldRegistry.entryCount !== oldRegistry.entries.length) {
      throw new Error('FORMULA_QUEUE_PRIOR_REGISTRY_UNSAFE');
    }
    const currentSha = researchCodeSha == null ? null : researchCodeSha.toLowerCase();
    if (oldRegistry.researchCodeSha === currentSha) {
      for (const entry of oldRegistry.entries) {
        if (entry?.source !== 'FORMULA_AUTO_BACKTEST_PASS'
          || entry.executionAuthority !== 'NONE'
          || entry.liveTrading !== false
          || entry.autoTrading !== false
          || entry.realOrder !== false
          || entry.privateTradingApi !== false
          || entry.directTradeOnBacktestPass !== false
          || entry.paperState !== 'REGISTERED_WAITING_FUTURE_SIGNAL'
          || entry.researchCodeSha !== currentSha
          || entry.futureSignalRequired !== true
          || entry.freshPublicEvidenceRequired !== true
          || entry.canonicalPaperAdmissionRequired !== true
          || entry.simulationAuthorityRequired !== true
          || entry.enabledForPaperEvaluation !== true
          || entry.retainedForAudit !== true
          || typeof entry.registryId !== 'string'
          || !/^[0-9a-f]{64}$/u.test(entry.registryId)
          || !/^[0-9a-f]{64}$/u.test(entry.itemDigest ?? '')) {
          throw new Error('FORMULA_QUEUE_PRIOR_REGISTRY_ENTRY_UNSAFE');
        }
      }
      oldEntries = oldRegistry.entries;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const registered = new Map(oldEntries.map((entry) => [entry.registryId, entry]));
  for (const entry of newRegistry.entries) registered.set(entry.registryId, entry);
  const entries = [...registered.values()].sort((a, b) => a.registryId.localeCompare(b.registryId));
  const paperRegistry = Object.freeze({ ...newRegistry, entryCount: entries.length, entries: Object.freeze(entries) });
  // Successful timer execution alone is not evidence of a Paper-ready strategy.
  const automationReadiness = allFiles.length === 0
    ? 'BLOCKED_DATA_NO_TRAIN_INPUT'
    : paperRegistry.entryCount === 0
      ? 'BLOCKED_DATA_OOS_NOT_ATTESTED'
      : 'WAITING_PROSPECTIVE_SIGNAL_AND_PAPER_ADMISSION';
  const summary = {
    schemaVersion: 1,
    contract: FORMULA_AUTO_BACKTEST_SUMMARY_CONTRACT_V1,
    automationReadiness,
    paperOrderAuthorityGranted: false,
    canonicalFutureSignalVerified: false,
    oosAndSettlementVerified: false,
    generatedAt: new Date().toISOString(),
    scanned: files.length,
    inboxCount: allFiles.length,
    stagedIntake,
    genuineResearchProducerVerified: false,
    lastProcessedFileName: files.at(-1) ?? previousCursor,
    counts,
    paperRegisteredCount: paperRegistry.entryCount,
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
  await atomicJson(paperRegistryPath, paperRegistry);
  return Object.freeze(summary);
}
