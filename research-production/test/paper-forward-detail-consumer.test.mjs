import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readPaperForwardDetail,
  detectDuplicateCycle,
  PAPER_FORWARD_CLI_SCHEMA,
  EXECUTION_AUTHORITY,
} from '../src/paper-forward-detail-consumer.mjs';

const SAMPLE_DETAIL = Object.freeze({
  taskCycleId: 'task-cycle-1',
  paperForwardCycleId: 'paper-forward-cycle-1',
  schemaVersion: PAPER_FORWARD_CLI_SCHEMA,
  status: 'success',
  canonicalEntryCount: 2,
  entryCount: 1,
  entryEligibleCount: 3,
  canonicalPositionCount: 1,
  canonicalSettlementCount: 0,
  evidenceCompleteCount: 1,
  paperStateTransport: 'PUBLISHED',
  firstZeroStage: null,
  firstZeroReason: null,
});

async function makeStateRoot() {
  return mkdtemp(join(tmpdir(), 'pfd-consumer-test-'));
}

async function writeLatest(stateRoot, cycle) {
  await mkdir(join(stateRoot, 'latest'), { recursive: true });
  await writeFile(join(stateRoot, 'latest', 'forward.json'), JSON.stringify(cycle, null, 2));
}

function buildCycle({ detail, parseError, stdoutWriteError, id = 'paper-forward', includeTask = true } = {}) {
  const results = [];
  if (includeTask) {
    const task = {
      schemaVersion: 'research-production-task-v1',
      id,
      status: 'success',
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
    };
    if (detail !== undefined) task.paperForwardDetail = detail;
    if (parseError !== undefined) task.paperForwardParseError = parseError;
    if (stdoutWriteError !== undefined) task.stdoutWriteError = stdoutWriteError;
    results.push(task);
  }
  return {
    schemaVersion: 'research-production-cycle-v1',
    cycleId: 'cycle-1-forward-aaaaaaaaaaaa',
    profile: 'forward',
    researchSha: 'a'.repeat(40),
    generatedAt: Date.now(),
    concurrency: 1,
    taskCount: results.length,
    successCount: results.length,
    blockedDataCount: 0,
    failedCount: 0,
    status: 'complete',
    results,
    safety: Object.freeze({}),
  };
}

test('1. reads latest/forward.json and extracts paperForwardDetail', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.executionAuthority, EXECUTION_AUTHORITY);
    assert.deepEqual(r.blockers, []);
    assert.equal(r.detail.taskCycleId, 'task-cycle-1');
    assert.equal(r.detail.paperForwardCycleId, 'paper-forward-cycle-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2. preserves all 11 field types and null values', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, true);
    assert.equal(typeof r.detail.canonicalEntryCount, 'number');
    assert.equal(typeof r.detail.entryCount, 'number');
    assert.equal(typeof r.detail.entryEligibleCount, 'number');
    assert.equal(typeof r.detail.canonicalPositionCount, 'number');
    assert.equal(typeof r.detail.canonicalSettlementCount, 'number');
    assert.equal(typeof r.detail.evidenceCompleteCount, 'number');
    assert.equal(typeof r.detail.paperStateTransport, 'string');
    assert.equal(typeof r.detail.status, 'string');
    assert.equal(typeof r.detail.schemaVersion, 'string');
    assert.equal(r.detail.firstZeroStage, null);
    assert.equal(r.detail.firstZeroReason, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('3. rejects missing latest/forward.json', async () => {
  const root = await makeStateRoot();
  try {
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => b.startsWith('LATEST_READ_OR_PARSE_FAILED')));
    assert.equal(r.detail, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4. rejects corrupt JSON in latest/forward.json', async () => {
  const root = await makeStateRoot();
  try {
    await mkdir(join(root, 'latest'), { recursive: true });
    await writeFile(join(root, 'latest', 'forward.json'), '{not json');
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => b.startsWith('LATEST_READ_OR_PARSE_FAILED')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('5. rejects when cycle schemaVersion is not research-production-cycle-v1', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, { ...buildCycle({ detail: SAMPLE_DETAIL }), schemaVersion: 'wrong-cycle' });
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('CYCLE_SCHEMA_INVALID'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('6. rejects when paper-forward task is missing', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ includeTask: false }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('PAPER_FORWARD_TASK_MISSING'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('7. rejects when paperForwardDetail is missing', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({}));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('PAPER_FORWARD_DETAIL_MISSING'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('8. rejects whitespace-only paperForwardCycleId', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, paperForwardCycleId: '   ' } }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('PAPER_FORWARD_CYCLE_ID_WHITESPACE_ONLY'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('9. rejects whitespace-only taskCycleId', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, taskCycleId: '   ' } }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('TASK_CYCLE_ID_WHITESPACE_ONLY'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('10. rejects when taskCycleId equals paperForwardCycleId', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({
      detail: { ...SAMPLE_DETAIL, taskCycleId: 'same', paperForwardCycleId: 'same' },
    }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('CYCLE_IDS_MUST_BE_DISTINCT'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('11. rejects schemaVersion mismatch inside detail', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, schemaVersion: 'wrong-v1' } }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('SCHEMA_VERSION_MISMATCH'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('12. reports FIELD_MISSING for each missing field', async () => {
  const root = await makeStateRoot();
  try {
    const partial = { ...SAMPLE_DETAIL };
    delete partial.evidenceCompleteCount;
    delete partial.firstZeroReason;
    await writeLatest(root, buildCycle({ detail: partial }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes('FIELD_MISSING:evidenceCompleteCount'));
    assert.ok(r.blockers.includes('FIELD_MISSING:firstZeroReason'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('13. detectDuplicateCycle flags duplicate paperForwardCycleId', () => {
  const r = detectDuplicateCycle({
    priorDetails: [{ paperForwardCycleId: 'dup' }, { paperForwardCycleId: 'other' }],
    currentDetail: { paperForwardCycleId: 'dup' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DUPLICATE_PAPER_FORWARD_CYCLE_ID');
  assert.equal(r.count, 1);
});

test('14. detectDuplicateCycle passes for unique id', () => {
  const r = detectDuplicateCycle({
    priorDetails: [{ paperForwardCycleId: 'old' }],
    currentDetail: { paperForwardCycleId: 'new' },
  });
  assert.equal(r.ok, true);
});

test('15. source file mtime and bytes remain unchanged (read-only)', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const path = join(root, 'latest', 'forward.json');
    const beforeBytes = await readFile(path, 'utf8');
    const beforeStat = await stat(path);
    await readPaperForwardDetail({ stateRoot: root });
    const afterBytes = await readFile(path, 'utf8');
    const afterStat = await stat(path);
    assert.equal(beforeBytes, afterBytes);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    assert.equal(beforeStat.size, afterStat.size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('16. consumer creates no new files under stateRoot (no journal/ledger writes)', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const before = (await readdir(root, { recursive: true })).sort();
    await readPaperForwardDetail({ stateRoot: root });
    const after = (await readdir(root, { recursive: true })).sort();
    assert.deepEqual(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('17. executionAuthority is always NONE in every verdict', async () => {
  const root = await makeStateRoot();
  try {
    const empty = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(empty.executionAuthority, EXECUTION_AUTHORITY);
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const ok = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(ok.executionAuthority, EXECUTION_AUTHORITY);
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, paperForwardCycleId: '  ' } }));
    const bad = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(bad.executionAuthority, EXECUTION_AUTHORITY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('18. parseError and stdoutWriteError are passed through', async () => {
  const root = await makeStateRoot();
  try {
    await writeLatest(root, buildCycle({
      detail: SAMPLE_DETAIL,
      parseError: { code: 'PAPER_FORWARD_RESULT_NOT_FOUND' },
      stdoutWriteError: 'EPIPE',
    }));
    const r = await readPaperForwardDetail({ stateRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.parseError.code, 'PAPER_FORWARD_RESULT_NOT_FOUND');
    assert.equal(r.stdoutWriteError, 'EPIPE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
