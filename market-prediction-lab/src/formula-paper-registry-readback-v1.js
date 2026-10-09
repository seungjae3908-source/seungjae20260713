import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1 } from './formula-auto-backtest-queue-v1.js';
import { createEvidenceBackedFormulaSignalEvaluatorV1 } from './evidence-backed-formula-entry-evaluator-v1.js';

/**
 * Observation boundary only. A historical PASS is never an entry signal,
 * a canonical Paper admission receipt, an OOS result, or trading authority.
 */
export const FORMULA_PAPER_REGISTRY_READBACK_CONTRACT_V1 = 'formula-paper-registry-readback/v1';
const SHA40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_BYTES = 8 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function report(status, reason, count = null, shaExact = null) {
  return Object.freeze({
    schemaVersion: 1,
    contract: FORMULA_PAPER_REGISTRY_READBACK_CONTRACT_V1,
    status,
    reason,
    entryCount: count,
    sourceShaExact: shaExact,
    historicalBacktestPassIsEntry: false,
    futureSignalVerified: false,
    freshPublicEvidenceVerified: false,
    canonicalPaperAdmissionVerified: false,
    settlementVerified: false,
    fullCostReady: false,
    profitabilityProven: false,
    candidateCredit: 0,
    financialMutationCount: 0,
    privateRequestCount: 0,
    orderCount: 0,
    paperDispatchAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrder: false,
    privateTradingApi: false,
    executionAuthority: 'NONE',
  });
}

function validEntry(entry, researchCodeSha) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const safe = entry.source === 'FORMULA_AUTO_BACKTEST_PASS'
    && entry.researchCodeSha === researchCodeSha
    && entry.paperState === 'REGISTERED_WAITING_FUTURE_SIGNAL'
    && entry.futureSignalRequired === true
    && entry.freshPublicEvidenceRequired === true
    && entry.canonicalPaperAdmissionRequired === true
    && entry.simulationAuthorityRequired === true
    && entry.directTradeOnBacktestPass === false
    && entry.enabledForPaperEvaluation === true
    && entry.retainedForAudit === true
    && entry.liveTrading === false
    && entry.autoTrading === false
    && entry.realOrder === false
    && entry.privateTradingApi === false
    && entry.executionAuthority === 'NONE'
    && typeof entry.registryId === 'string' && HEX64.test(entry.registryId)
    && typeof entry.itemDigest === 'string' && HEX64.test(entry.itemDigest)
    && typeof entry.formulaCandidateId === 'string'
    && typeof entry.generatedCandidateId === 'string'
    && typeof entry.parameterIdentity === 'string'
    && HEX64.test(entry.parameterIdentity)
    && entry.formulaCandidate?.candidateId === entry.formulaCandidateId
    && entry.generatedCandidate?.generatedCandidateId === entry.generatedCandidateId;
  if (!safe) return false;
  // Identity-only registryId is not evidence that the embedded DSL, market,
  // leverage side, or selected parameters are authentic. Validate the same
  // canonical formula evaluator contract used by the historical backtester.
  const formula = entry.formulaCandidate;
  const generated = entry.generatedCandidate;
  if (entry.market !== formula?.market
    || entry.direction !== formula?.direction
    || entry.timeframe !== formula?.timeframe
    || entry.strategyHash !== formula?.formulaHash
    || entry.strategyFamily !== formula?.strategyFamily
    || entry.formulaCandidateId !== formula?.candidateId
    || generated?.formulaCandidateId !== formula?.candidateId
    || generated?.generatedCandidateId !== entry.generatedCandidateId
    || generated?.formulaHash !== formula?.formulaHash
    || generated?.parameterIdentity !== entry.parameterIdentity
    || generated?.safety?.executionAuthority !== 'NONE') return false;
  try {
    const verified = createEvidenceBackedFormulaSignalEvaluatorV1({
      formulaCandidate: formula,
      generatedCandidate: generated,
    });
    if (verified?.evaluatorContract?.executionAuthority !== 'NONE'
      || verified?.evaluatorContract?.closedCandleSignalOnly !== true) return false;
  } catch {
    return false;
  }
  return digest({
    itemDigest: entry.itemDigest,
    formulaCandidateId: entry.formulaCandidateId,
    generatedCandidateId: entry.generatedCandidateId,
    parameterIdentity: entry.parameterIdentity,
  }) === entry.registryId;
}

/** Never returns the raw registry, filesystem path, strategy formula, or owner data. */
export async function readFormulaPaperRegistryReadbackV1({
  registryPath = null,
  researchCodeSha = null,
} = {}) {
  if (!registryPath) return report('MISSING', 'FORMULA_PAPER_REGISTRY_NOT_CONFIGURED');
  if (typeof researchCodeSha !== 'string' || !SHA40.test(researchCodeSha)) {
    return report('INVALID', 'FORMULA_PAPER_REGISTRY_RESEARCH_SHA_REQUIRED', null, false);
  }
  if (typeof registryPath !== 'string' || registryPath !== registryPath.trim()
    || !isAbsolute(registryPath) || resolve(registryPath) !== registryPath
    || basename(registryPath) !== 'formula-paper-strategy-registry.json') {
    return report('INVALID', 'FORMULA_PAPER_REGISTRY_PATH_INVALID', null, false);
  }
  let value;
  try {
    const parentPath = dirname(registryPath);
    const parent = await lstat(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || (parent.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())
      || await realpath(parentPath) !== parentPath) {
      return report('INVALID', 'FORMULA_PAPER_REGISTRY_PARENT_UNSAFE', null, false);
    }
    // Use one no-follow descriptor for metadata and bytes: lstat then
    // readFile(path) would allow symlink substitution between the two calls.
    const handle = await open(
      registryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1
        || before.size > MAX_BYTES || before.size === 0
        || (before.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
        return report('INVALID', 'FORMULA_PAPER_REGISTRY_FILE_UNSAFE', null, false);
      }
      const content = await handle.readFile('utf8');
      const after = await handle.stat();
      if (Buffer.byteLength(content, 'utf8') !== before.size
        || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) {
        return report('INVALID', 'FORMULA_PAPER_REGISTRY_FILE_CHANGED', null, false);
      }
      value = JSON.parse(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return error?.code === 'ENOENT'
      ? report('MISSING', 'FORMULA_PAPER_REGISTRY_FILE_MISSING')
      : report('INVALID', 'FORMULA_PAPER_REGISTRY_READ_FAILED', null, false);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.contract !== FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1
    || value.researchCodeSha !== researchCodeSha
    || value.acceptedSourceState !== 'PASS'
    || !Array.isArray(value.rejectedSourceStates)
    || value.rejectedSourceStates.join(',') !== 'HOLD,RESERVE,EXCLUDE'
    || value.directTradeOnBacktestPass !== false
    || value.futureSignalRequired !== true
    || value.canonicalPaperAdmissionRequired !== true
    || value.deletionAllowed !== false
    || value.liveTrading !== false
    || value.autoTrading !== false
    || value.realOrder !== false
    || value.privateTradingApi !== false
    || value.executionAuthority !== 'NONE'
    || !Array.isArray(value.entries)
    || value.entries.length > 10_000
    || value.entryCount !== value.entries.length
    || new Set(value.entries.map((entry) => entry?.registryId)).size !== value.entries.length
    || !value.entries.every((entry) => validEntry(entry, researchCodeSha))) {
    return report('INVALID', 'FORMULA_PAPER_REGISTRY_CONTRACT_INVALID', null, false);
  }
  return value.entryCount === 0
    ? report('EMPTY', 'FORMULA_PAPER_REGISTRY_NO_ATTESTED_PASS', 0, true)
    : report('WAITING_FUTURE_SIGNAL', 'FORMULA_PAPER_REGISTRY_ADMISSION_NOT_VERIFIED', value.entryCount, true);
}
