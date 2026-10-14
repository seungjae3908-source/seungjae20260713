import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1,
  buildFormulaProducedTrainInputV1,
  processFormulaAutoBacktestQueueV1,
} from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import { createResearchFailureObservationV1 } from '../../market-prediction-lab/src/autonomous-alpha-factory-phase3-v1.js';
import {
  appendResearchFailureObservationV1,
  buildResearchFailureDecisionV1,
  createResearchFailureMemoryV1,
} from './research-failure-memory.mjs';
import {
  loadResearchFailureMemoryV1,
  persistResearchFailureMemoryV1,
} from './research-failure-memory-store.mjs';

export const AUTONOMOUS_RESEARCH_DOSSIER_CONTRACT_V1 = 'autonomous-research-source-dossier/v1';
export const AUTONOMOUS_RESEARCH_LOOP_STATE_CONTRACT_V1 = 'autonomous-research-closed-loop-state/v1';
export const AUTONOMOUS_RESEARCH_NEXT_DIRECTIVE_CONTRACT_V1 = 'autonomous-research-next-directive/v1';

const HASH64 = /^[a-f0-9]{64}$/u;
const SHA40 = /^[a-f0-9]{40}$/u;
const SAFE_JSON = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.json$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_ROOTS = Object.freeze(['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app']);
const CLASSIFICATIONS = new Set(['ORIGINAL_RULES', 'DECLARED_VARIANT', 'RESEARCH_HYPOTHESIS']);
const SOURCE_TYPES = new Set([
  'PEER_REVIEWED_PAPER',
  'GITHUB_OPEN_SOURCE',
  'PUBLIC_VIDEO',
  'PUBLIC_BLOG',
  'PUBLIC_COMMUNITY',
  'PUBLIC_TRADING_RECORD',
]);
const NOVELTY_PRIORITY = Object.freeze({ NOVEL_FAMILY: 0, NOVEL_VARIANT: 1, KNOWN_VARIANT: 2 });

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactSha(value, label = 'researchCodeSha') {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError(`${label} must be an exact SHA`);
  return sha;
}

function exactDigest(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!HASH64.test(result)) throw new TypeError(`${label} must be SHA-256 hex`);
  return result;
}

function text(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > maximum || /[\0\r\n]/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function stringList(value, label, { maximum = 32, allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  const rows = value.map((entry, index) => text(entry, `${label}[${index}]`));
  if (new Set(rows).size !== rows.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze(rows);
}

function iso(value, label) {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be canonical ISO`);
  return value;
}

function httpsUrl(value, label) {
  const raw = text(value, label, 2_000);
  let url;
  try { url = new URL(raw); } catch { throw new TypeError(`${label} must be a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError(`${label} must be public HTTPS`);
  return url.toString();
}

function stateRoot(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !isAbsolute(raw)) throw new Error('AUTONOMOUS_RESEARCH_STATE_ROOT_ABSOLUTE_REQUIRED');
  const root = resolve(raw);
  if (FORBIDDEN_ROOTS.some((entry) => root === entry || root.startsWith(entry + '/'))) {
    throw new Error('AUTONOMOUS_RESEARCH_PROTECTED_APP_STORAGE_FORBIDDEN');
  }
  return root;
}

function dossierCore(value) {
  return {
    schemaVersion: 1,
    contract: AUTONOMOUS_RESEARCH_DOSSIER_CONTRACT_V1,
    researchCodeSha: value.researchCodeSha,
    discoveredAt: value.discoveredAt,
    sourceEvidence: value.sourceEvidence,
    strategy: value.strategy,
    producerInput: value.producerInput,
    safety: value.safety,
  };
}

function normalizeSourceEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !SOURCE_TYPES.has(raw.sourceType)) {
    throw new TypeError('sourceEvidence is invalid');
  }
  const retrievedAt = iso(raw.retrievedAt, 'sourceEvidence.retrievedAt');
  const publishedAt = raw.publishedAt == null ? null : iso(raw.publishedAt, 'sourceEvidence.publishedAt');
  if (publishedAt && Date.parse(publishedAt) > Date.parse(retrievedAt)) throw new Error('SOURCE_PUBLISHED_AFTER_RETRIEVAL');
  const revision = raw.sourceRevision == null ? null : exactSha(raw.sourceRevision, 'sourceEvidence.sourceRevision');
  return deepFreeze({
    sourceId: text(raw.sourceId, 'sourceEvidence.sourceId', 180),
    sourceType: raw.sourceType,
    canonicalUrl: httpsUrl(raw.canonicalUrl, 'sourceEvidence.canonicalUrl'),
    title: text(raw.title, 'sourceEvidence.title', 500),
    authors: stringList(raw.authors, 'sourceEvidence.authors', { maximum: 20 }),
    publishedAt,
    retrievedAt,
    sourceRevision: revision,
    contentSha256: exactDigest(raw.contentSha256, 'sourceEvidence.contentSha256'),
    license: deepFreeze({
      status: text(raw.license?.status, 'sourceEvidence.license.status', 80),
      canonicalUrl: httpsUrl(raw.license?.canonicalUrl, 'sourceEvidence.license.canonicalUrl'),
      contentSha256: exactDigest(raw.license?.contentSha256, 'sourceEvidence.license.contentSha256'),
    }),
    rules: deepFreeze({
      entry: stringList(raw.rules?.entry, 'sourceEvidence.rules.entry'),
      exit: stringList(raw.rules?.exit, 'sourceEvidence.rules.exit'),
      risk: stringList(raw.rules?.risk, 'sourceEvidence.rules.risk', { allowEmpty: true }),
      claimedPerformance: stringList(raw.rules?.claimedPerformance ?? [], 'sourceEvidence.rules.claimedPerformance', { allowEmpty: true }),
      limitations: stringList(raw.rules?.limitations, 'sourceEvidence.rules.limitations'),
    }),
    accessVerified: raw.accessVerified === true,
    httpStatus: raw.httpStatus === 200 ? 200 : null,
  });
}

function normalizeStrategy(raw, sourceEvidence, producerInput) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !CLASSIFICATIONS.has(raw.classification)) {
    throw new TypeError('strategy is invalid');
  }
  const novelty = text(raw.novelty, 'strategy.novelty', 40);
  if (!Object.hasOwn(NOVELTY_PRIORITY, novelty)) throw new Error('STRATEGY_NOVELTY_INVALID');
  const core = {
    strategyId: text(raw.strategyId, 'strategy.strategyId', 180),
    family: text(raw.family, 'strategy.family', 120),
    classification: raw.classification,
    novelty,
    market: text(raw.market, 'strategy.market', 40),
    timeframe: text(raw.timeframe, 'strategy.timeframe', 40),
    direction: text(raw.direction, 'strategy.direction', 20),
    sourceId: sourceEvidence.sourceId,
    sourceContentSha256: sourceEvidence.contentSha256,
    transformations: stringList(raw.transformations ?? [], 'strategy.transformations', { allowEmpty: true }),
    unresolvedRules: stringList(raw.unresolvedRules ?? [], 'strategy.unresolvedRules', { allowEmpty: true }),
    formulaItemDigest: producerInput?.itemDigest ?? null,
  };
  if (core.classification === 'ORIGINAL_RULES' && core.transformations.length > 0) {
    throw new Error('ORIGINAL_RULES_CANNOT_HAVE_TRANSFORMATIONS');
  }
  if (core.classification === 'RESEARCH_HYPOTHESIS' && producerInput != null) {
    throw new Error('RESEARCH_HYPOTHESIS_CANNOT_STAGE_FORMULA');
  }
  if (core.classification !== 'RESEARCH_HYPOTHESIS' && producerInput == null) {
    throw new Error('EXECUTABLE_RESEARCH_STRATEGY_REQUIRES_FORMULA');
  }
  const strategyIdentityDigest = digest(core);
  return deepFreeze({ ...core, strategyIdentityDigest });
}

function safetyEnvelope() {
  return deepFreeze({
    researchOnly: true,
    paidProviderAllowed: false,
    syntheticPerformanceAllowed: false,
    duplicateExecutionAllowed: false,
    paperActivationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    privateTradingApi: false,
    realOrder: false,
    executionAuthority: 'NONE',
  });
}

export function createAutonomousResearchDossierV1({
  researchCodeSha,
  discoveredAt,
  sourceEvidence: rawSourceEvidence,
  strategy: rawStrategy,
  formulaQueueItem = null,
} = {}) {
  const sha = exactSha(researchCodeSha);
  const sourceEvidence = normalizeSourceEvidence(rawSourceEvidence);
  if (sourceEvidence.accessVerified !== true || sourceEvidence.httpStatus !== 200) {
    throw new Error('SOURCE_ACCESS_NOT_ACTUALLY_VERIFIED');
  }
  const producerInput = formulaQueueItem == null ? null : buildFormulaProducedTrainInputV1({ item: formulaQueueItem, researchCodeSha: sha });
  const strategy = normalizeStrategy(rawStrategy, sourceEvidence, producerInput);
  const core = dossierCore({
    researchCodeSha: sha,
    discoveredAt: iso(discoveredAt, 'discoveredAt'),
    sourceEvidence,
    strategy,
    producerInput,
    safety: safetyEnvelope(),
  });
  return deepFreeze({ ...core, dossierDigest: digest(core) });
}

export function assertAutonomousResearchDossierV1(value) {
  if (!exactKeys(value, ['schemaVersion', 'contract', 'researchCodeSha', 'discoveredAt', 'sourceEvidence',
    'strategy', 'producerInput', 'safety', 'dossierDigest'])
    || value.contract !== AUTONOMOUS_RESEARCH_DOSSIER_CONTRACT_V1 || value.schemaVersion !== 1
    || !HASH64.test(value.dossierDigest ?? '') || value.dossierDigest !== digest(dossierCore(value))) {
    throw new Error('AUTONOMOUS_RESEARCH_DOSSIER_INVALID');
  }
  const rebuilt = createAutonomousResearchDossierV1({
    researchCodeSha: value.researchCodeSha,
    discoveredAt: value.discoveredAt,
    sourceEvidence: value.sourceEvidence,
    strategy: value.strategy,
    formulaQueueItem: value.producerInput?.item ?? null,
  });
  if (rebuilt.dossierDigest !== value.dossierDigest
    || rebuilt.strategy.strategyIdentityDigest !== value.strategy.strategyIdentityDigest
    || rebuilt.producerInput?.itemDigest !== value.producerInput?.itemDigest) {
    throw new Error('AUTONOMOUS_RESEARCH_DOSSIER_REBUILD_MISMATCH');
  }
  return value;
}

async function secureDirectory(path, { create = false, shared = false } = {}) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & (shared ? 0o027 : 0o077)) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new Error('AUTONOMOUS_RESEARCH_DIRECTORY_UNSAFE');
  }
}

async function safeJson(path, { maximumBytes = MAX_JSON_BYTES, optional = false } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') throw new Error('AUTONOMOUS_RESEARCH_FILE_UNSAFE');
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximumBytes
      || (before.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
      throw new Error('AUTONOMOUS_RESEARCH_FILE_UNSAFE');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error('AUTONOMOUS_RESEARCH_FILE_CHANGED');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('AUTONOMOUS_RESEARCH_JSON_INVALID'); }
  } finally { await handle.close(); }
}

async function writeOnce(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await safeJson(path);
    if (digest(existing) !== digest(value)) throw new Error('AUTONOMOUS_RESEARCH_EXISTING_FILE_CONFLICT');
    return false;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export async function stageAutonomousResearchDossierV1({ stateRoot: rawRoot, dossier } = {}) {
  assertAutonomousResearchDossierV1(dossier);
  const root = stateRoot(rawRoot);
  await secureDirectory(root, { create: true, shared: true });
  const inbox = join(root, 'autonomous-research', 'inbox');
  await secureDirectory(inbox, { create: true });
  const created = await writeOnce(join(inbox, `${dossier.dossierDigest}.json`), dossier);
  return deepFreeze({ status: created ? 'STAGED' : 'ALREADY_STAGED', dossierDigest: dossier.dossierDigest, executionAuthority: 'NONE' });
}

function stateCore({ researchCodeSha, createdAt, updatedAt, records, safety }) {
  return { schemaVersion: 1, contract: AUTONOMOUS_RESEARCH_LOOP_STATE_CONTRACT_V1, researchCodeSha, createdAt, updatedAt, records, safety };
}

function newState(researchCodeSha, observedAt) {
  const core = stateCore({ researchCodeSha, createdAt: observedAt, updatedAt: observedAt, records: Object.freeze([]), safety: safetyEnvelope() });
  return deepFreeze({ ...core, stateDigest: digest(core) });
}

function assertState(value, researchCodeSha) {
  if (!exactKeys(value, ['schemaVersion', 'contract', 'researchCodeSha', 'createdAt', 'updatedAt', 'records', 'safety', 'stateDigest'])
    || value.contract !== AUTONOMOUS_RESEARCH_LOOP_STATE_CONTRACT_V1 || value.schemaVersion !== 1
    || value.researchCodeSha !== researchCodeSha || !Array.isArray(value.records)
    || value.stateDigest !== digest(stateCore(value)) || value.safety?.executionAuthority !== 'NONE') {
    throw new Error('AUTONOMOUS_RESEARCH_LOOP_STATE_INVALID');
  }
  const dossierDigests = value.records.map((row) => row.dossierDigest);
  if (new Set(dossierDigests).size !== dossierDigests.length) throw new Error('AUTONOMOUS_RESEARCH_LOOP_STATE_DUPLICATE');
  return value;
}

function nextState(state, records, observedAt) {
  const core = stateCore({ ...state, updatedAt: observedAt, records: Object.freeze(records), safety: safetyEnvelope() });
  return deepFreeze({ ...core, stateDigest: digest(core) });
}

function historicalMetrics(result) {
  const candidates = Array.isArray(result?.tournament?.candidates) ? result.tournament.candidates : [];
  const rows = candidates.map((candidate) => candidate?.stageRecords?.find((stage) => stage?.stage === 'HISTORICAL_BACKTEST'))
    .filter(Boolean).map((stage) => stage.evidence?.metrics).filter(Boolean);
  if (rows.length === 0) return null;
  const best = [...rows].sort((left, right) => Number(right.return ?? -Infinity) - Number(left.return ?? -Infinity))[0];
  return deepFreeze({
    trades: Number.isSafeInteger(best.trades) ? best.trades : null,
    netReturn: Number.isFinite(best.return) ? best.return : null,
    winRate: Number.isFinite(best.winRate) ? best.winRate : null,
    profitFactor: Number.isFinite(best.profitFactor) ? best.profitFactor : null,
    maximumDrawdown: Number.isFinite(best.maximumDrawdown) ? best.maximumDrawdown : null,
    expectancy: Number.isFinite(best.expectancy) ? best.expectancy : null,
    finalCapital: Number.isFinite(best.finalCapital) ? best.finalCapital : null,
  });
}

function validateResult(result, dossier) {
  if (!result || result.contract !== FORMULA_AUTO_BACKTEST_RESULT_CONTRACT_V1 || result.schemaVersion !== 1
    || result.itemDigest !== dossier.producerInput.itemDigest || result.formulaId !== dossier.producerInput.item.formulaCandidate.candidateId
    || result.executionAuthority !== 'NONE' || result.liveTrading !== false || result.autoTrading !== false
    || result.privateTradingApi !== false || result.realOrder !== false) {
    throw new Error('AUTONOMOUS_RESEARCH_BACKTEST_RESULT_INVALID');
  }
  return result;
}

async function registryDisposition(root, itemDigest) {
  const [canonicalRegistry, researchRegistry] = await Promise.all([
    safeJson(join(root, 'latest', 'formula-paper-strategy-registry.json'), { optional: true }),
    safeJson(join(root, 'latest', 'formula-research-paper-experiment-registry.json'), { optional: true }),
  ]);
  if (canonicalRegistry?.entries?.some((entry) => entry.itemDigest === itemDigest)) return 'BACKTEST_CANDIDATE';
  if (researchRegistry?.entries?.some((entry) => entry.itemDigest === itemDigest)) return 'BACKTEST_CANDIDATE';
  return null;
}

function resultDisposition(result, registry) {
  if (registry === 'BACKTEST_CANDIDATE') return registry;
  if (result.state === 'EXCLUDE') return 'REJECT';
  return 'IMPROVE';
}

function safeFailureCodes(result) {
  const raw = Array.isArray(result.blockers) ? result.blockers : [];
  const rows = raw.map((value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_:.-]/gu, '_').slice(0, 120))
    .filter(Boolean);
  if (rows.length === 0) rows.push(String(result.reason ?? 'BACKTEST_NOT_PROMOTABLE').toUpperCase().replace(/[^A-Z0-9_:.-]/gu, '_').slice(0, 120));
  return [...new Set(rows)].slice(0, 32);
}

function recordForHypothesis(dossier, observedAt) {
  return deepFreeze({
    dossierDigest: dossier.dossierDigest,
    strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
    sourceId: dossier.sourceEvidence.sourceId,
    strategyId: dossier.strategy.strategyId,
    family: dossier.strategy.family,
    classification: dossier.strategy.classification,
    lifecycle: Object.freeze(['DISCOVERED', 'RESEARCH_HYPOTHESIS', 'IMPROVE']),
    disposition: 'IMPROVE',
    reason: 'FORMULA_NOT_SAFELY_REPRESENTABLE',
    itemDigest: null,
    metrics: null,
    paperRegistered: false,
    completedAt: observedAt,
    executionAuthority: 'NONE',
  });
}

function recordForBlockedDuplicate(dossier, decision, observedAt) {
  return deepFreeze({
    dossierDigest: dossier.dossierDigest,
    strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
    sourceId: dossier.sourceEvidence.sourceId,
    strategyId: dossier.strategy.strategyId,
    family: dossier.strategy.family,
    classification: dossier.strategy.classification,
    lifecycle: Object.freeze(['DISCOVERED', 'DUPLICATE_BLOCKED']),
    disposition: 'IMPROVE',
    reason: decision.status,
    itemDigest: dossier.producerInput?.itemDigest ?? null,
    metrics: null,
    paperRegistered: false,
    completedAt: observedAt,
    executionAuthority: 'NONE',
  });
}

function recordForResult(dossier, result, disposition, metrics, observedAt) {
  return deepFreeze({
    dossierDigest: dossier.dossierDigest,
    strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
    sourceId: dossier.sourceEvidence.sourceId,
    strategyId: dossier.strategy.strategyId,
    family: dossier.strategy.family,
    classification: dossier.strategy.classification,
    lifecycle: Object.freeze(['DISCOVERED', 'FORMULA_READY', 'BACKTESTING', disposition]),
    disposition,
    reason: result.reason,
    resultState: result.state,
    itemDigest: result.itemDigest,
    metrics,
    paperRegistered: disposition === 'BACKTEST_CANDIDATE',
    completedAt: observedAt,
    executionAuthority: 'NONE',
  });
}

function candidateSort(failedFamilies) {
  return (left, right) => {
    const leftFailed = failedFamilies.has(left.strategy.family) ? 1 : 0;
    const rightFailed = failedFamilies.has(right.strategy.family) ? 1 : 0;
    return leftFailed - rightFailed
      || NOVELTY_PRIORITY[left.strategy.novelty] - NOVELTY_PRIORITY[right.strategy.novelty]
      || left.discoveredAt.localeCompare(right.discoveredAt)
      || left.dossierDigest.localeCompare(right.dossierDigest);
  };
}

function directiveFromRecords({ researchCodeSha, observedAt, records, failureMemory }) {
  const failed = records.filter((row) => ['IMPROVE', 'REJECT'].includes(row.disposition));
  const failureCodes = failureMemory.observations.flatMap((entry) => entry.failureObservation.failureCodes);
  return {
    schemaVersion: 1,
    contract: AUTONOMOUS_RESEARCH_NEXT_DIRECTIVE_CONTRACT_V1,
    researchCodeSha,
    observedAt,
    completedDossierCount: records.length,
    blockedStrategyIdentityDigests: Object.freeze([...new Set(failed.map((row) => row.strategyIdentityDigest))].sort().slice(0, 64)),
    failedFamilies: Object.freeze([...new Set(failed.map((row) => row.family))].sort().slice(0, 64)),
    failureCodes: Object.freeze([...new Set(failureCodes)].sort().slice(0, 64)),
    selectionPolicy: deepFreeze({
      continueResearch: true,
      preferNovelFamily: true,
      sameIdentityRetryAllowed: false,
      sameParametersRetryAllowed: false,
      paperWaitingBlocksResearch: false,
      paidFallbackAllowed: false,
    }),
    safety: safetyEnvelope(),
  };
}

function directiveCore(value) {
  return {
    schemaVersion: 1,
    contract: AUTONOMOUS_RESEARCH_NEXT_DIRECTIVE_CONTRACT_V1,
    researchCodeSha: value.researchCodeSha,
    observedAt: value.observedAt,
    completedDossierCount: value.completedDossierCount,
    blockedStrategyIdentityDigests: value.blockedStrategyIdentityDigests,
    failedFamilies: value.failedFamilies,
    failureCodes: value.failureCodes,
    selectionPolicy: value.selectionPolicy,
    safety: value.safety,
  };
}

function buildDirective(args) {
  const core = directiveFromRecords(args);
  return deepFreeze({ ...core, directiveDigest: digest(core) });
}

export function assertAutonomousResearchNextDirectiveV1(value, { researchCodeSha = null } = {}) {
  if (!exactKeys(value, ['schemaVersion', 'contract', 'researchCodeSha', 'observedAt', 'completedDossierCount',
    'blockedStrategyIdentityDigests', 'failedFamilies', 'failureCodes', 'selectionPolicy', 'safety', 'directiveDigest'])
    || value.contract !== AUTONOMOUS_RESEARCH_NEXT_DIRECTIVE_CONTRACT_V1 || value.schemaVersion !== 1
    || value.directiveDigest !== digest(directiveCore(value)) || !HASH64.test(value.directiveDigest ?? '')
    || (researchCodeSha != null && value.researchCodeSha !== exactSha(researchCodeSha))
    || value.selectionPolicy?.continueResearch !== true || value.selectionPolicy?.sameIdentityRetryAllowed !== false
    || value.selectionPolicy?.paperWaitingBlocksResearch !== false || value.safety?.executionAuthority !== 'NONE') {
    throw new Error('AUTONOMOUS_RESEARCH_NEXT_DIRECTIVE_INVALID');
  }
  return value;
}

export async function loadAutonomousResearchNextDirectiveV1({ stateRoot: rawRoot, researchCodeSha } = {}) {
  const root = stateRoot(rawRoot);
  const value = await safeJson(join(root, 'latest', 'autonomous-research-next-directive.json'), { optional: true, maximumBytes: 256 * 1024 });
  if (value == null) return null;
  return assertAutonomousResearchNextDirectiveV1(value, { researchCodeSha });
}

async function loadDossiers(root, researchCodeSha) {
  const inbox = join(root, 'autonomous-research', 'inbox');
  await secureDirectory(inbox, { create: true });
  const names = (await readdir(inbox)).filter((name) => name.endsWith('.json')).sort();
  if (names.length > 10_000 || names.some((name) => !SAFE_JSON.test(name))) throw new Error('AUTONOMOUS_RESEARCH_INBOX_INVALID');
  const dossiers = [];
  for (const name of names) {
    const dossier = await safeJson(join(inbox, name));
    assertAutonomousResearchDossierV1(dossier);
    if (dossier.researchCodeSha !== researchCodeSha || name !== `${dossier.dossierDigest}.json`) {
      throw new Error('AUTONOMOUS_RESEARCH_DOSSIER_RELEASE_OR_NAME_MISMATCH');
    }
    dossiers.push(dossier);
  }
  return dossiers;
}

async function stageProducerInput(root, dossier) {
  const outbox = join(root, 'formula-backtest', 'producer-outbox');
  await secureDirectory(outbox, { create: true });
  const path = join(outbox, `${dossier.producerInput.itemDigest}.json`);
  return writeOnce(path, dossier.producerInput);
}

function summary(state, dossiers, failureMemory, observedAt) {
  const counts = { BACKTEST_CANDIDATE: 0, IMPROVE: 0, REJECT: 0 };
  for (const row of state.records) if (Object.hasOwn(counts, row.disposition)) counts[row.disposition] += 1;
  const completed = new Set(state.records.map((row) => row.dossierDigest));
  return deepFreeze({
    schemaVersion: 1,
    contract: 'autonomous-research-closed-loop-summary/v1',
    researchCodeSha: state.researchCodeSha,
    observedAt,
    discoveredStrategyCount: dossiers.length,
    completedStrategyCount: state.records.length,
    remainingStrategyCount: dossiers.filter((row) => !completed.has(row.dossierDigest)).length,
    researchHypothesisCount: state.records.filter((row) => row.classification === 'RESEARCH_HYPOTHESIS').length,
    formulaGeneratedCount: state.records.filter((row) => row.itemDigest != null).length,
    actualBacktestCount: state.records.filter((row) => row.metrics != null).length,
    paperRegisteredCount: counts.BACKTEST_CANDIDATE,
    actualPaperEntryCount: 0,
    actualPaperExitCount: 0,
    dispositions: Object.freeze(counts),
    failureObservationCount: failureMemory.observations.length,
    continueResearch: true,
    waitingForFuturePaperSignalBlocksResearch: false,
    runtimeActivated: false,
    executionAuthority: 'NONE',
  });
}

export async function runAutonomousResearchClosedLoopV1({
  stateRoot: rawRoot,
  researchCodeSha: rawSha,
  maximumStrategiesPerCycle = 4,
  now = () => new Date().toISOString(),
  processQueue = processFormulaAutoBacktestQueueV1,
} = {}) {
  const root = stateRoot(rawRoot);
  const researchCodeSha = exactSha(rawSha);
  if (!Number.isSafeInteger(maximumStrategiesPerCycle) || maximumStrategiesPerCycle < 1 || maximumStrategiesPerCycle > 16) {
    throw new Error('AUTONOMOUS_RESEARCH_CYCLE_LIMIT_INVALID');
  }
  if (typeof processQueue !== 'function') throw new TypeError('processQueue must be a function');
  await secureDirectory(root, { create: true, shared: true });
  const observedAt = iso(now(), 'now');
  const loopRoot = join(root, 'autonomous-research');
  const latestRoot = join(root, 'latest');
  await secureDirectory(loopRoot, { create: true });
  await secureDirectory(latestRoot, { create: true });
  const statePath = join(loopRoot, 'state.json');
  const memoryPath = join(loopRoot, 'failure-memory.json');
  const memorySummaryPath = join(loopRoot, 'failure-memory-summary.json');
  let state = await safeJson(statePath, { optional: true });
  state = state == null ? newState(researchCodeSha, observedAt) : assertState(state, researchCodeSha);
  let failureMemory;
  try {
    failureMemory = await loadResearchFailureMemoryV1({ memoryPath, researchSha: researchCodeSha });
  } catch (error) {
    if (error?.code === 'ENOENT') failureMemory = createResearchFailureMemoryV1({ researchSha: researchCodeSha });
    else throw error;
  }
  const dossiers = await loadDossiers(root, researchCodeSha);
  const completed = new Set(state.records.map((row) => row.dossierDigest));
  const failedFamilies = new Set(state.records.filter((row) => ['IMPROVE', 'REJECT'].includes(row.disposition)).map((row) => row.family));
  const candidates = dossiers.filter((row) => !completed.has(row.dossierDigest)).sort(candidateSort(failedFamilies));
  let attempted = 0;
  let queueExecutions = 0;
  let deferredThisCycle = 0;

  for (const dossier of candidates) {
    if (attempted >= maximumStrategiesPerCycle) break;
    attempted += 1;
    let record;
    if (dossier.strategy.classification === 'RESEARCH_HYPOTHESIS') {
      record = recordForHypothesis(dossier, observedAt);
      const failure = createResearchFailureObservationV1({
        strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
        stage: 'FORMULA_COMPILATION',
        status: 'MISSING_EVIDENCE',
        failureCodes: ['FORMULA_NOT_SAFELY_REPRESENTABLE'],
        observedAt: dossier.discoveredAt,
        evidence: {
          dossierDigest: dossier.dossierDigest,
          unresolvedRules: dossier.strategy.unresolvedRules,
        },
      });
      failureMemory = appendResearchFailureObservationV1(failureMemory, failure);
      await persistResearchFailureMemoryV1({ memoryPath, summaryPath: memorySummaryPath, memory: failureMemory });
    } else {
      const failureDecision = buildResearchFailureDecisionV1(failureMemory, {
        strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
      });
      if (failureDecision.automaticSameStrategyRetryAllowed === false) {
        record = recordForBlockedDuplicate(dossier, failureDecision, observedAt);
      } else {
        await stageProducerInput(root, dossier);
        await processQueue({ stateRoot: root, researchCodeSha, maximumItems: 50 });
        queueExecutions += 1;
        const storedResult = await safeJson(
          join(root, 'formula-backtest', 'results', `${dossier.producerInput.itemDigest}.json`),
          { optional: true },
        );
        // The shared bounded queue may contain more than one batch. Preserve
        // this dossier as pending so the next scheduled run resumes it after
        // the existing queue cursor advances, instead of failing the cycle or
        // inventing a missing result.
        if (storedResult == null) {
          deferredThisCycle += 1;
          continue;
        }
        const result = validateResult(storedResult, dossier);
        const metrics = historicalMetrics(result);
        const registry = await registryDisposition(root, result.itemDigest);
        const disposition = resultDisposition(result, registry);
        record = recordForResult(dossier, result, disposition, metrics, observedAt);
        if (disposition !== 'BACKTEST_CANDIDATE') {
          const failure = createResearchFailureObservationV1({
            strategyIdentityDigest: dossier.strategy.strategyIdentityDigest,
            stage: 'HISTORICAL_BACKTEST',
            status: result.state === 'HOLD' ? 'MISSING_EVIDENCE' : 'FAIL',
            failureCodes: safeFailureCodes(result),
            observedAt: iso(result.evaluatedAt, 'result.evaluatedAt'),
            evidence: { itemDigest: result.itemDigest, resultState: result.state, resultReason: result.reason },
          });
          failureMemory = appendResearchFailureObservationV1(failureMemory, failure);
          await persistResearchFailureMemoryV1({ memoryPath, summaryPath: memorySummaryPath, memory: failureMemory });
        }
      }
    }
    state = nextState(state, [...state.records, record], observedAt);
    await atomicJson(statePath, state);
  }

  if (failureMemory.observations.length === 0) {
    await persistResearchFailureMemoryV1({ memoryPath, summaryPath: memorySummaryPath, memory: failureMemory });
  }
  const directive = buildDirective({ researchCodeSha, observedAt, records: state.records, failureMemory });
  await atomicJson(join(latestRoot, 'autonomous-research-next-directive.json'), directive);
  const report = summary(state, dossiers, failureMemory, observedAt);
  const result = deepFreeze({
    ...report,
    attemptedThisCycle: attempted,
    queueExecutions,
    deferredThisCycle,
    nextAction: report.remainingStrategyCount > 0 ? 'CONTINUE_STAGED_RESEARCH' : 'DISCOVER_NEW_STRATEGY',
    stateDigest: state.stateDigest,
    directiveDigest: directive.directiveDigest,
  });
  await atomicJson(join(latestRoot, 'autonomous-research-closed-loop.json'), result);
  return result;
}
