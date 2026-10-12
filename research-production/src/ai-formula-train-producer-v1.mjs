import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { assertFormulaCandidateV1 } from '../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import {
  FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
  buildFormulaProducedTrainInputV1,
  validateFormulaAutoBacktestQueueItemV1,
} from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';

export const AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1 = 'research-ai-formula-train-producer/v1';
export const AI_FORMULA_TRAIN_FEEDBACK_CONTRACT_V1 = 'research-ai-formula-train-feedback/v1';

const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const HYPOTHESIS_ID = /^[A-Za-z][A-Za-z0-9_-]{0,119}$/u;
const MAX_ITEM_BYTES = 8 * 1024 * 1024;
const MAX_PROPOSALS = 4;
const FORBIDDEN_PRIVATE_ROOTS = ['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app'];

function fail(reason) {
  throw new Error(reason);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function digestAiFormulaTrainValueV1(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function equalKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function positiveTimestamp(ms, now) {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= now + 5 * 60_000;
}

function validateAiArtifact(review, researchSha, now) {
  if (!review || review.schemaVersion !== 'research-production-ai-review-v1'
    || review.status !== 'READY' || review.researchSha !== researchSha
    || !SHA64.test(String(review.evidenceDigest ?? ''))
    || typeof review.sourceCycleId !== 'string' || !review.sourceCycleId
    || !positiveTimestamp(review.observedAt, now)
    || !['gemini', 'groq'].includes(review.provider)
    || typeof review.model !== 'string' || !review.model
    || !['CRITIC', 'PROPOSER'].includes(review.role)
    || review.evidenceCredit !== 0
    || review.profitabilityProven !== false || review.champion !== null
    || review.safety?.executionAuthority !== 'NONE'
    || review.safety?.liveTrading !== false
    || review.safety?.privateTradingApiAllowed !== false
    || review.safety?.orderAllowed !== false) {
    fail('AI_FORMULA_REVIEW_PROOF_INVALID');
  }
  const result = review.review;
  if (!result || !['RESEARCH_PROPOSAL_ONLY', 'NEEDS_REVIEW', 'BLOCKED_DATA'].includes(result.disposition)
    || !Array.isArray(result.hypotheses) || result.hypotheses.length > MAX_PROPOSALS) {
    fail('AI_FORMULA_REVIEW_DISPOSITION_INVALID');
  }
  const seen = new Set();
  for (const h of result.hypotheses) {
    if (!HYPOTHESIS_ID.test(String(h?.hypothesisId ?? '')) || seen.has(h.hypothesisId)
      || typeof h.thesis !== 'string' || typeof h.falsification !== 'string'
      || !Array.isArray(h.requiredEvidence)) fail('AI_FORMULA_HYPOTHESIS_INVALID');
    seen.add(h.hypothesisId);
  }
}

function validateBinding(binding, review, candidateIds) {
  const fields = ['aiHypothesisId', 'reviewEvidenceDigest', 'sourceCycleId', 'formulaCandidate', 'dataset'];
  if (!equalKeys(binding, fields)
    || !HYPOTHESIS_ID.test(binding.aiHypothesisId)
    || binding.reviewEvidenceDigest !== review.evidenceDigest
    || binding.sourceCycleId !== review.sourceCycleId) fail('AI_FORMULA_BINDING_INVALID');
  assertFormulaCandidateV1(binding.formulaCandidate);
  const formula = binding.formulaCandidate;
  if (!MARKETS.has(formula.market)
    || (formula.market !== 'CRYPTO_FUTURES' && formula.direction !== 'LONG')
    || (formula.market === 'CRYPTO_FUTURES' && !['LONG', 'SHORT'].includes(formula.direction))
    || formula.provenance?.datasetRole !== 'TRAIN'
    || candidateIds.has(formula.candidateId)) fail('AI_FORMULA_DIRECTION_OR_DUPLICATE_INVALID');
  candidateIds.add(formula.candidateId);
}

function buildItem(binding, queuedAt) {
  const item = {
    schemaVersion: 1,
    contract: FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
    queuedAt,
    formulaCandidate: structuredClone(binding.formulaCandidate),
    dataset: structuredClone(binding.dataset),
  };
  const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
  if (size <= 0 || size > MAX_ITEM_BYTES) fail('AI_FORMULA_TRAIN_ITEM_SIZE_INVALID');
  validateFormulaAutoBacktestQueueItemV1(item);
  return item;
}

function rootPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('AI_FORMULA_STATE_ROOT_ABSOLUTE_REQUIRED');
  const root = resolve(value);
  if (FORBIDDEN_PRIVATE_ROOTS.some((p) => root === p || root.startsWith(p + '/'))) {
    fail('AI_FORMULA_APP_STORAGE_FORBIDDEN');
  }
  return root;
}

async function checkDir(path, { allowSharedRoot = false, create = false } = {}) {
  if (create) await mkdir(path, { mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()
    || (st.mode & (allowSharedRoot ? 0o027 : 0o077)) !== 0
    || (typeof process.getuid === 'function' && st.uid !== process.getuid())
    || (await realpath(path)) !== path) fail('AI_FORMULA_PRIVATE_DIRECTORY_UNSAFE');
}

async function ensureOutbox(stateRoot) {
  const root = rootPath(stateRoot);
  await checkDir(root, { allowSharedRoot: true });
  const parent = join(root, 'formula-backtest');
  try { await checkDir(parent); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await checkDir(parent, { create: true });
  }
  const outbox = join(parent, 'producer-outbox');
  try { await checkDir(outbox); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await checkDir(outbox, { create: true });
  }
  const existing = await readdir(outbox);
  if (existing.length > 10_000) fail('AI_FORMULA_PRODUCER_BACKLOG_EXCEEDED');
  return outbox;
}

async function readExisting(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes
      || (before.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
      fail('AI_FORMULA_EXISTING_FILE_UNSAFE');
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    if (body.length !== before.size || after.size !== before.size
      || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) {
      fail('AI_FORMULA_EXISTING_FILE_CHANGED');
    }
    return body.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function stageOnce(outbox, record) {
  const name = record.itemDigest + '.json';
  if (!SHA64.test(record.itemDigest)) fail('AI_FORMULA_INTAKE_DIGEST_INVALID');
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8');
  if (bytes.length > MAX_ITEM_BYTES) fail('AI_FORMULA_INTAKE_BYTES_EXCEEDED');
  const path = join(outbox, name);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readExisting(path, MAX_ITEM_BYTES));
    if (!equalKeys(existing, ['schemaVersion', 'contract', 'researchCodeSha', 'itemDigest', 'item'])
      || existing.itemDigest !== record.itemDigest
      || digestAiFormulaTrainValueV1(existing.item) !== record.itemDigest
      || JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(record))) {
      fail('AI_FORMULA_IMMUTABLE_INTAKE_CONFLICT');
    }
    return 'ALREADY_STAGED';
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(outbox, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return 'STAGED';
}

export async function prepareAiFormulaTrainProposalsV1({
  researchSha, aiReviewArtifact, approvedBindings = [], verifyOriginalSource = null,
  now = Date.now(), stage = false, stateRoot = null, env = process.env,
} = {}) {
  if (!SHA40.test(String(researchSha ?? ''))) fail('AI_FORMULA_RESEARCH_SHA_INVALID');
  if (!positiveTimestamp(now, now)) fail('AI_FORMULA_CLOCK_INVALID');
  validateAiArtifact(aiReviewArtifact, researchSha, now);
  if (!Array.isArray(approvedBindings) || approvedBindings.length > MAX_PROPOSALS) {
    fail('AI_FORMULA_BOUND_CAPACITY_EXCEEDED');
  }
  const ai = aiReviewArtifact;
  const canPropose = ai.role === 'PROPOSER' && ai.review.disposition === 'RESEARCH_PROPOSAL_ONLY';
  if (stage && String(env?.RESEARCH_AI_FORMULA_TRAIN_STAGE_ENABLED ?? '').toLowerCase() !== 'true') {
    fail('AI_FORMULA_STAGING_DISABLED');
  }
  const bindings = new Map();
  const candidateIds = new Set();
  for (const binding of approvedBindings) {
    validateBinding(binding, ai, candidateIds);
    if (bindings.has(binding.aiHypothesisId)
      || !ai.review.hypotheses.some((h) => h.hypothesisId === binding.aiHypothesisId)) {
      fail('AI_FORMULA_BINDING_NOT_IN_REVIEW');
    }
    bindings.set(binding.aiHypothesisId, binding);
  }

  const planned = [];
  const reports = [];
  for (const hypothesis of ai.review.hypotheses) {
    const binding = bindings.get(hypothesis.hypothesisId);
    let state = canPropose ? 'HOLD_NO_APPROVED_FORMULA_OR_TRAIN_DATA' : 'HOLD_REVIEW_ONLY';
    let itemDigest = null;
    let formulaCandidateId = binding?.formulaCandidate?.candidateId ?? null;
    if (canPropose && binding) {
      const item = buildItem(binding, new Date(now).toISOString());
      const digestValue = digestAiFormulaTrainValueV1(binding.dataset);
      const proof = typeof verifyOriginalSource === 'function'
        ? await verifyOriginalSource({
          researchSha, aiEvidenceDigest: ai.evidenceDigest, sourceCycleId: ai.sourceCycleId,
          hypothesisId: hypothesis.hypothesisId,
          formulaCandidate: binding.formulaCandidate, dataset: binding.dataset,
          datasetDigest: digestValue,
        }) : null;
      if (proof?.status === 'VERIFIED_TRAIN_SOURCE'
        && proof.researchSha === researchSha
        && proof.aiEvidenceDigest === ai.evidenceDigest
        && proof.hypothesisId === hypothesis.hypothesisId
        && proof.datasetIdentity === binding.dataset.datasetIdentity
        && proof.datasetDigest === digestValue
        && proof.datasetRole === 'TRAIN'
        && proof.sourceRightsVerified === true
        && proof.sourceProvenanceVerified === true
        && positiveTimestamp(proof.observedAtMs, now)
        && proof.observedAtMs >= binding.dataset.period.endTime) {
        const record = buildFormulaProducedTrainInputV1({ item, researchCodeSha: researchSha });
        planned.push(record);
        itemDigest = record.itemDigest;
        state = 'READY_TRAIN_ONLY';
      } else state = 'HOLD_ORIGINAL_DATA_UNVERIFIED';
    }
    reports.push({
      aiHypothesisId: hypothesis.hypothesisId, formulaCandidateId, itemDigest, state,
      economicEvidenceCredit: 0, oosVerified: false, paperAdmissionAllowed: false,
    });
  }
  if (stage && planned.length) {
    const outbox = await ensureOutbox(stateRoot);
    const staging = new Map();
    for (const record of planned) staging.set(record.itemDigest, await stageOnce(outbox, record));
    for (const report of reports) if (report.itemDigest) {
      report.state = staging.get(report.itemDigest) === 'STAGED'
        ? 'STAGED_TRAIN_ONLY' : 'ALREADY_STAGED_TRAIN_ONLY';
    }
  }

  const staged = reports.filter((r) => r.state === 'STAGED_TRAIN_ONLY').length;
  return Object.freeze({
    schemaVersion: 1,
    contract: AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1,
    researchSha,
    aiEvidenceDigest: ai.evidenceDigest,
    aiRole: ai.role,
    readOnlyPreview: stage !== true,
    eligibleForTrainCount: planned.length,
    staged,
    held: reports.length - planned.length,
    proposals: Object.freeze(reports.map((r) => Object.freeze(r))),
    sourceCallbackVerifiedOnly: true,
    externalSourceIndependentlyAttested: false,
    independentOosVerified: false,
    fullCostVerified: false,
    profitabilityProven: false,
    paperDispatchAllowed: false,
    realOrderAllowed: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function buildAiFormulaTrainFeedbackV1({ researchSha, queueSummary } = {}) {
  if (!SHA40.test(String(researchSha ?? ''))
    || queueSummary?.contract !== 'research-formula-auto-backtest-summary/v1'
    || queueSummary.executionAuthority !== 'NONE'
    || queueSummary.liveTrading !== false
    || queueSummary.autoTrading !== false
    || queueSummary.realOrder !== false
    || queueSummary.paperOrderAuthorityGranted !== false
    || queueSummary.canonicalFutureSignalVerified !== false
    || queueSummary.oosAndSettlementVerified !== false
    || !Array.isArray(queueSummary.rows)) fail('AI_FORMULA_FEEDBACK_UNTRUSTED');
  const rows = queueSummary.rows.slice(0, 4).map((r) => {
    if (!['PASS', 'HOLD', 'RESERVE', 'EXCLUDE'].includes(r?.state)
      || !SHA64.test(String(r?.itemDigest ?? ''))
      || !Array.isArray(r.blockers)) fail('AI_FORMULA_FEEDBACK_ROW_INVALID');
    const allowedCode = (v) => typeof v === 'string' && /^[A-Z0-9_]{1,120}$/u.test(v);
    if (r.blockers.some((b) => !allowedCode(b))) fail('AI_FORMULA_FEEDBACK_BLOCKER_INVALID');
    return Object.freeze({
      itemDigest: r.itemDigest, state: r.state,
      blockers: Object.freeze(r.blockers.slice(0, 8)),
      nextStep: r.state === 'EXCLUDE' ? 'RETAIN_AS_EXCLUDED'
        : r.state === 'RESERVE' ? 'REVIEW_RESEARCH_HYPOTHESIS'
          : 'WAIT_FOR_INDEPENDENT_EVIDENCE',
    });
  });
  return Object.freeze({
    schemaVersion: 1, contract: AI_FORMULA_TRAIN_FEEDBACK_CONTRACT_V1,
    researchSha, feedbackDigest: digestAiFormulaTrainValueV1(rows),
    rows: Object.freeze(rows),
    adviceOnly: true, orderAuthority: false,
    automaticFormulaMutation: false, automaticPromotion: false,
    executionAuthority: 'NONE',
  });
}
