/**
 * Read-only consumer for paperForwardDetail.
 *
 * Reads {stateRoot}/latest/forward.json, extracts paperForwardDetail from the
 * 'paper-forward' task record, validates schema and 11 fields, and returns a
 * frozen verdict. NEVER writes files, NEVER mutates state, NEVER executes
 * paper/live trades. executionAuthority is always 'NONE'.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PAPER_FORWARD_CLI_SCHEMA = 'paper-forward-schedule-cli-v5';
const PAPER_FORWARD_CYCLE_SCHEMA = 'research-production-cycle-v1';
const EXECUTION_AUTHORITY = 'NONE';

export const PAPER_FORWARD_DETAIL_FIELDS = Object.freeze([
  'schemaVersion',
  'status',
  'canonicalEntryCount',
  'entryCount',
  'entryEligibleCount',
  'canonicalPositionCount',
  'canonicalSettlementCount',
  'evidenceCompleteCount',
  'paperStateTransport',
  'firstZeroStage',
  'firstZeroReason',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isWhitespaceOnlyString(v) {
  return typeof v === 'string' && v.length > 0 && v.trim().length === 0;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function blocked(blockers, extra = {}) {
  return Object.freeze({
    ok: false,
    executionAuthority: EXECUTION_AUTHORITY,
    blockers: Object.freeze(blockers),
    detail: null,
    parseError: extra.parseError ?? null,
    stdoutWriteError: extra.stdoutWriteError ?? null,
  });
}

function cloneDetail(detail) {
  const out = {
    taskCycleId: detail.taskCycleId,
    paperForwardCycleId: detail.paperForwardCycleId,
  };
  for (const field of PAPER_FORWARD_DETAIL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(detail, field)) {
      out[field] = detail[field];
    }
  }
  return Object.freeze(out);
}

function validateDetail(detail) {
  const blockers = [];
  if (!isPlainObject(detail)) {
    blockers.push('DETAIL_NOT_OBJECT');
    return { ok: false, blockers };
  }
  if (!isNonEmptyString(detail.taskCycleId)) {
    blockers.push('TASK_CYCLE_ID_INVALID');
  } else if (isWhitespaceOnlyString(detail.taskCycleId)) {
    blockers.push('TASK_CYCLE_ID_WHITESPACE_ONLY');
  }
  if (!isNonEmptyString(detail.paperForwardCycleId)) {
    blockers.push('PAPER_FORWARD_CYCLE_ID_INVALID');
  } else if (isWhitespaceOnlyString(detail.paperForwardCycleId)) {
    blockers.push('PAPER_FORWARD_CYCLE_ID_WHITESPACE_ONLY');
  }
  if (isNonEmptyString(detail.taskCycleId) && detail.taskCycleId === detail.paperForwardCycleId) {
    blockers.push('CYCLE_IDS_MUST_BE_DISTINCT');
  }
  for (const field of PAPER_FORWARD_DETAIL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(detail, field)) {
      blockers.push(`FIELD_MISSING:${field}`);
    }
  }
  if (detail.schemaVersion !== undefined && detail.schemaVersion !== PAPER_FORWARD_CLI_SCHEMA) {
    blockers.push('SCHEMA_VERSION_MISMATCH');
  }
  return { ok: blockers.length === 0, blockers };
}

export async function readPaperForwardDetail({ stateRoot } = {}) {
  if (!isNonEmptyString(stateRoot)) {
    return blocked(['STATE_ROOT_INVALID']);
  }
  const latestPath = join(stateRoot, 'latest', 'forward.json');
  let cycle;
  try {
    const text = await readFile(latestPath, 'utf8');
    cycle = JSON.parse(text);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
    return blocked([`LATEST_READ_OR_PARSE_FAILED:${code}`]);
  }
  if (!isPlainObject(cycle) || cycle.schemaVersion !== PAPER_FORWARD_CYCLE_SCHEMA) {
    return blocked(['CYCLE_SCHEMA_INVALID']);
  }
  if (!Array.isArray(cycle.results)) {
    return blocked(['RESULTS_NOT_ARRAY']);
  }
  const task = cycle.results.find((r) => isPlainObject(r) && r.id === 'paper-forward');
  if (!task) {
    return blocked(['PAPER_FORWARD_TASK_MISSING']);
  }
  const detail = task.paperForwardDetail;
  if (!isPlainObject(detail)) {
    return blocked(
      ['PAPER_FORWARD_DETAIL_MISSING'],
      { parseError: task.paperForwardParseError ?? null, stdoutWriteError: task.stdoutWriteError ?? null },
    );
  }
  const validation = validateDetail(detail);
  const extra = {
    parseError: task.paperForwardParseError ?? null,
    stdoutWriteError: task.stdoutWriteError ?? null,
  };
  if (!validation.ok) {
    return Object.freeze({
      ok: false,
      executionAuthority: EXECUTION_AUTHORITY,
      blockers: Object.freeze(validation.blockers),
      detail: cloneDetail(detail),
      parseError: extra.parseError,
      stdoutWriteError: extra.stdoutWriteError,
    });
  }
  return Object.freeze({
    ok: true,
    executionAuthority: EXECUTION_AUTHORITY,
    blockers: Object.freeze([]),
    detail: cloneDetail(detail),
    parseError: extra.parseError,
    stdoutWriteError: extra.stdoutWriteError,
  });
}

export function detectDuplicateCycle({ priorDetails, currentDetail } = {}) {
  if (!isPlainObject(currentDetail) || !isNonEmptyString(currentDetail.paperForwardCycleId)) {
    return { ok: false, reason: 'CURRENT_DETAIL_INVALID' };
  }
  if (!Array.isArray(priorDetails)) {
    return { ok: false, reason: 'PRIOR_NOT_ARRAY' };
  }
  const id = currentDetail.paperForwardCycleId;
  const hits = priorDetails.filter(
    (d) => isPlainObject(d) && d.paperForwardCycleId === id,
  );
  if (hits.length > 0) {
    return { ok: false, reason: 'DUPLICATE_PAPER_FORWARD_CYCLE_ID', count: hits.length };
  }
  return { ok: true, count: 0 };
}

export const PAPER_FORWARD_DETAIL_CONSUMER_SCHEMA = 'paper-forward-detail-consumer-v1';
export { PAPER_FORWARD_CLI_SCHEMA, EXECUTION_AUTHORITY };
