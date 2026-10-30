import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const RESEARCH_CYCLE = join(REPO_ROOT, 'research-production', 'bin', 'research-cycle.mjs');
const PFD_CLI_SCHEMA = 'paper-forward-schedule-cli-v5';

const SAMPLE_DETAIL = {
  taskCycleId: 'task-cycle-1',
  paperForwardCycleId: 'paper-forward-cycle-1',
  schemaVersion: PFD_CLI_SCHEMA,
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
};

function buildCycle({ detail } = {}) {
  const task = {
    schemaVersion: 'research-production-task-v1',
    id: 'paper-forward',
    status: 'success',
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  };
  if (detail !== undefined) task.paperForwardDetail = detail;
  return {
    schemaVersion: 'research-production-cycle-v1',
    cycleId: 'cycle-1-forward-aaaaaaaaaaaa',
    profile: 'forward',
    researchSha: 'a'.repeat(40),
    generatedAt: Date.now(),
    concurrency: 1,
    taskCount: 1,
    successCount: 1,
    blockedDataCount: 0,
    failedCount: 0,
    status: 'complete',
    results: [task],
    safety: {},
  };
}

async function writeLatest(stateRoot, cycle) {
  await mkdir(join(stateRoot, 'latest'), { recursive: true });
  await writeFile(join(stateRoot, 'latest', 'forward.json'), JSON.stringify(cycle, null, 2));
}

async function runVerify(stateRoot) {
  try {
    const { stdout } = await execFileAsync('node', [RESEARCH_CYCLE, 'verify', '--state-root', stateRoot]);
    return { code: 0, verdict: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code ?? 1, verdict: JSON.parse(err.stdout) };
  }
}

test('1. verify returns ok:true for valid latest/forward.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const r = await runVerify(root);
    assert.equal(r.code, 0);
    assert.equal(r.verdict.ok, true);
    assert.deepEqual(r.verdict.blockers, []);
    assert.equal(r.verdict.detail.taskCycleId, 'task-cycle-1');
    assert.equal(r.verdict.detail.paperForwardCycleId, 'paper-forward-cycle-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2. verify propagates consumer blockers (whitespace cycle id)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, paperForwardCycleId: '   ' } }));
    const r = await runVerify(root);
    assert.notEqual(r.code, 0);
    assert.equal(r.verdict.ok, false);
    assert.ok(r.verdict.blockers.includes('PAPER_FORWARD_CYCLE_ID_WHITESPACE_ONLY'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('3. verify handles missing --state-root without creating default', async () => {
  const env = { ...process.env };
  delete env.RESEARCH_STATE_ROOT;
  let defaultExistedBefore = true;
  try { await stat('/var/lib/investment-research-production'); } catch { defaultExistedBefore = false; }
  let code = 0, verdict;
  try {
    const { stdout } = await execFileAsync('node', [RESEARCH_CYCLE, 'verify'], { env });
    verdict = JSON.parse(stdout);
  } catch (err) {
    code = err.code ?? 1;
    verdict = JSON.parse(err.stdout);
  }
  assert.notEqual(code, 0);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.executionAuthority, 'NONE');
  assert.ok(verdict.blockers.length > 0);
  if (!defaultExistedBefore) {
    await assert.rejects(
      () => stat('/var/lib/investment-research-production'),
      (err) => err.code === 'ENOENT',
    );
  }
});

test('4. verify returns blocker when stateRoot does not exist, and does not create it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  await rm(root, { recursive: true, force: true });
  const r = await runVerify(root);
  assert.notEqual(r.code, 0);
  assert.equal(r.verdict.ok, false);
  assert.ok(r.verdict.blockers.some((b) => b.startsWith('LATEST_READ_OR_PARSE_FAILED')));
  await assert.rejects(() => stat(root), (err) => err.code === 'ENOENT');
});

test('5. verify handles corrupt latest/forward.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await mkdir(join(root, 'latest'), { recursive: true });
    await writeFile(join(root, 'latest', 'forward.json'), '{not json');
    const r = await runVerify(root);
    assert.notEqual(r.code, 0);
    assert.equal(r.verdict.ok, false);
    assert.ok(r.verdict.blockers.some((b) => b.startsWith('LATEST_READ_OR_PARSE_FAILED')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('6. verify always reports executionAuthority NONE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const ok = await runVerify(root);
    assert.equal(ok.verdict.executionAuthority, 'NONE');
    await writeLatest(root, buildCycle({ detail: { ...SAMPLE_DETAIL, paperForwardCycleId: ' ' } }));
    const bad = await runVerify(root);
    assert.equal(bad.verdict.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('7. verify does not create or remove files under stateRoot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const before = (await readdir(root, { recursive: true })).sort();
    await runVerify(root);
    const after = (await readdir(root, { recursive: true })).sort();
    assert.deepEqual(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('8. verify preserves latest/forward.json bytes and mtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcv-'));
  try {
    await writeLatest(root, buildCycle({ detail: SAMPLE_DETAIL }));
    const path = join(root, 'latest', 'forward.json');
    const beforeBytes = await readFile(path, 'utf8');
    const beforeStat = await stat(path);
    await runVerify(root);
    const afterBytes = await readFile(path, 'utf8');
    const afterStat = await stat(path);
    assert.equal(beforeBytes, afterBytes);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    assert.equal(beforeStat.size, afterStat.size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('9. unknown command still fails closed (CLI regression)', async () => {
  try {
    await execFileAsync('node', [RESEARCH_CYCLE, 'not-a-command']);
    assert.fail('should have thrown');
  } catch (err) {
    const parsed = JSON.parse(err.stderr);
    assert.equal(parsed.status, 'failed_closed');
    assert.equal(parsed.liveTrading, false);
    assert.equal(parsed.privateApi, false);
    assert.equal(parsed.orderAuthority, false);
    assert.ok(String(parsed.error).includes('unsupported command'));
  }
});
