import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';

import { buildResearchAiEvidence, RESEARCH_AI_WORKER_SAFETY } from './research-ai-review-worker.mjs';
import { digestAiFormulaTrainValueV1 } from './ai-formula-train-producer-v1.mjs';
import { prepareAiFormulaTrainProposalsV1 } from './ai-formula-train-producer-v1.mjs';

export const AI_FORMULA_READBACK_CONTRACT_V1 = 'research-ai-formula-evidence-readback/v1';

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const PROFILES = Object.freeze(['forward', 'fast-historical', 'long-history']);
const ROLES = Object.freeze({ forward: 'CRITIC', 'fast-historical': 'PROPOSER', 'long-history': 'PROPOSER' });
const STATUS = new Set(['COMPLETE', 'PARTIAL_COVERAGE_COMPLETE', 'PARTIAL_AI_UNAVAILABLE', 'DEFERRED_RETRY', 'NO_NEW_EVIDENCE', 'WAITING_FOR_FREE_AI']);
const MAX_SCAN_BYTES = 96 * 1024;
const MAX_REVIEW_BYTES = 48 * 1024;
const MAX_CYCLE_BYTES = 4 * 1024 * 1024;
const MAX_LOOKUP = 3;
const FORBIDDEN_ROOTS = ['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app'];

function fail(code) { throw new Error(code); }

async function safeDirectory(path, { shared = false } = {}) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()
    || (st.mode & (shared ? 0o027 : 0o077)) !== 0
    || (typeof process.getuid === 'function' && st.uid !== process.getuid())
    || await realpath(path) !== path) fail('AI_FORMULA_READBACK_DIRECTORY_UNSAFE');
}

async function safeJson(path, maxBytes) {
  await safeDirectory(dirname(path));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') fail('AI_FORMULA_READBACK_FILE_UNSAFE');
    throw error;
  }
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.nlink !== 1 || start.size < 2
      || start.size > maxBytes || (start.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && start.uid !== process.getuid())) {
      fail('AI_FORMULA_READBACK_FILE_UNSAFE');
    }
    const bytes = await handle.readFile();
    const end = await handle.stat();
    if (bytes.length !== start.size || end.ino !== start.ino
      || end.size !== start.size || end.mtimeMs !== start.mtimeMs
      || end.nlink !== 1) fail('AI_FORMULA_READBACK_FILE_CHANGED');
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { fail('AI_FORMULA_READBACK_JSON_INVALID'); }
  } finally { await handle.close(); }
}

function safetyValid(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === Object.keys(RESEARCH_AI_WORKER_SAFETY).sort().join(',')
    && Object.entries(RESEARCH_AI_WORKER_SAFETY).every(([key, required]) => value[key] === required);
}

function dispositionCount(rows) {
  const result = { CRITIC: 0, PROPOSER: 0, PROPOSAL_ONLY: 0 };
  for (const row of rows) {
    if (row.status !== 'VERIFIED_AI_REVIEW') continue;
    result[row.role] += 1;
    if (row.role === 'PROPOSER' && row.disposition === 'RESEARCH_PROPOSAL_ONLY') result.PROPOSAL_ONLY += 1;
  }
  return Object.freeze(result);
}

function report(researchSha, scanStatus, rows, blockers, observedAt) {
  const counts = dispositionCount(rows);
  const historicalProposers = rows.filter((r) => r.status === 'VERIFIED_AI_REVIEW'
    && r.role === 'PROPOSER' && r.disposition === 'RESEARCH_PROPOSAL_ONLY').length;
  const status = blockers.length > 0 ? 'BLOCKED_EVIDENCE'
    : historicalProposers > 0 ? 'REVIEWED_PROPOSAL_AWAITING_APPROVED_FORMULA_AND_TRAIN_SOURCE'
      : 'WAITING_HISTORICAL_PROPOSER_EVIDENCE';
  return Object.freeze({
    schemaVersion: 1,
    contract: AI_FORMULA_READBACK_CONTRACT_V1,
    researchSha, observedAt, scanStatus, status,
    counts,
    rows: Object.freeze(rows.map((r) => Object.freeze(r))),
    blockerCodes: Object.freeze([...new Set(blockers)].sort()),
    historicalProposerReady: historicalProposers > 0,
    canonicalFormulaBound: false,
    originalTrainSourceVerified: false,
    automaticFormulaGeneration: false,
    independentOosVerified: false,
    fullCostVerified: false,
    paperAdmissionAllowed: false,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
    storageMutationCount: 0,
    externalProviderCalls: 0,
  });
}

function validateScan(scan, researchSha, now) {
  if (!scan || scan.schemaVersion !== 'research-production-ai-scan-v1'
    || scan.researchSha !== researchSha || !STATUS.has(scan.status)
    || !safetyValid(scan.safety)
    || !Number.isSafeInteger(scan.observedAt) || scan.observedAt < 1 || scan.observedAt > now
    || !Array.isArray(scan.reviews) || scan.reviews.length > MAX_LOOKUP
    || scan.evidenceCredit !== 0 && scan.evidenceCredit !== undefined
    || scan.profitabilityProven !== false && scan.profitabilityProven !== undefined
    || scan.champion !== null && scan.champion !== undefined) {
    fail('AI_FORMULA_READBACK_SCAN_INVALID');
  }
  const seenProfiles = new Set(), seenDigests = new Set();
  for (const row of scan.reviews) {
    if (!PROFILES.includes(row?.profile) || !SHA64.test(String(row?.evidenceDigest ?? ''))
      || row.role !== ROLES[row.profile] || row.status !== 'READY'
      || seenProfiles.has(row.profile) || seenDigests.has(row.evidenceDigest)) {
      fail('AI_FORMULA_READBACK_SCAN_REVIEW_INVALID');
    }
    seenProfiles.add(row.profile);
    seenDigests.add(row.evidenceDigest);
  }
}

/**
 * Read-only, exact cycle-bound proof for the next AI→Formula research step.
 * It never reads a credential, changes a source artifact, executes a candidate,
 * invents OOS/Paper evidence or trusts the AI response as a formula.
 */
export async function inspectAiFormulaResearchEvidenceV1({
  stateRoot, researchSha, now = Date.now(),
} = {}) {
  if (!SHA40.test(String(researchSha ?? ''))) fail('AI_FORMULA_READBACK_SHA_REQUIRED');
  if (!Number.isSafeInteger(now) || now < 1) fail('AI_FORMULA_READBACK_CLOCK_INVALID');
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) fail('AI_FORMULA_READBACK_ROOT_ABSOLUTE_REQUIRED');
  const root = resolve(stateRoot);
  if (FORBIDDEN_ROOTS.some((p) => root === p || root.startsWith(p + '/'))) {
    fail('AI_FORMULA_READBACK_APP_STORAGE_FORBIDDEN');
  }
  await safeDirectory(root, { shared: true });
  const aiDir = join(root, 'ai-review');
  let scan;
  try { scan = await safeJson(join(aiDir, 'latest.json'), MAX_SCAN_BYTES); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return report(researchSha, 'MISSING', [], ['AI_SCAN_NOT_YET_RECORDED'], null);
  }
  if (!scan) return report(researchSha, 'MISSING', [], ['AI_SCAN_NOT_YET_RECORDED'], null);
  if (scan.researchSha !== researchSha) {
    return report(researchSha, 'STALE_RELEASE', [], ['AI_SCAN_STALE_RELEASE'], scan.observedAt ?? null);
  }
  validateScan(scan, researchSha, now);
  const rows = [], blockers = [];
  for (const info of scan.reviews) {
    const profile = info.profile;
    const expected = info.evidenceDigest;
    const cycle = await safeJson(join(root, 'latest', profile + '.json'), MAX_CYCLE_BYTES);
    if (!cycle) {
      rows.push({ profile, role: info.role, status: 'MISSING_CURRENT_CYCLE' });
      blockers.push('CURRENT_CYCLE_MISSING');
      continue;
    }
    if (cycle.researchSha !== researchSha) {
      rows.push({ profile, role: info.role, status: 'STALE_CURRENT_CYCLE' });
      blockers.push('CURRENT_CYCLE_STALE_RELEASE');
      continue;
    }
    let projection;
    try { projection = buildResearchAiEvidence(cycle, researchSha); }
    catch {
      rows.push({ profile, role: info.role, status: 'INVALID_CURRENT_CYCLE' });
      blockers.push('CURRENT_CYCLE_SCHEMA_INVALID');
      continue;
    }
    if (projection.evidenceDigest !== expected || projection.role !== info.role) {
      rows.push({ profile, role: info.role, status: 'CYCLE_REVIEW_DIGEST_MISMATCH' });
      blockers.push('CURRENT_CYCLE_AI_DIGEST_MISMATCH');
      continue;
    }
    const artifact = await safeJson(join(aiDir, 'reviews', expected + '.json'), MAX_REVIEW_BYTES);
    if (!artifact) {
      rows.push({ profile, role: info.role, status: 'MISSING_AI_ARTIFACT' });
      blockers.push('AI_ARTIFACT_MISSING');
      continue;
    }
    if (artifact.profile !== profile || artifact.researchSha !== researchSha
      || artifact.evidenceDigest !== expected || artifact.sourceCycleId !== cycle.cycleId
      || artifact.role !== info.role || artifact.provider !== scan.provider
      || artifact.model !== scan.model || artifact.observedAt > scan.observedAt
      || !Number.isSafeInteger(cycle.generatedAt) || cycle.generatedAt > artifact.observedAt) {
      rows.push({ profile, role: info.role, status: 'AI_ARTIFACT_PROVENANCE_MISMATCH' });
      blockers.push('AI_ARTIFACT_PROVENANCE_MISMATCH');
      continue;
    }
    try {
      await prepareAiFormulaTrainProposalsV1({
        researchSha, aiReviewArtifact: artifact, approvedBindings: [], now, stage: false,
      });
    } catch {
      rows.push({ profile, role: info.role, status: 'INVALID_AI_REVIEW' });
      blockers.push('AI_ARTIFACT_REVIEW_INVALID');
      continue;
    }
    rows.push({
      profile, role: info.role, status: 'VERIFIED_AI_REVIEW',
      disposition: artifact.review.disposition,
      hypothesisCount: artifact.review.hypotheses.length,
      evidenceDigest: expected,
      reviewContentDigest: digestAiFormulaTrainValueV1(artifact.review),
      aiArtifactDigest: digestAiFormulaTrainValueV1(artifact),
      sourceCycleId: artifact.sourceCycleId,
    });
  }
  if (scan.reviews.length === 0) blockers.push('NO_CURRENT_AI_REVIEW');
  // A scan can retain stale historical profiles after an exact release switch.
  // Their lack of current evidence is a not-ready status, not fabricated success.
  return report(researchSha, scan.status, rows, blockers, scan.observedAt);
}
