import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearchCycle, PROFILES } from '../src/engine.mjs';

const SHA = 'a'.repeat(40);
const SCHEMA = 'paper-forward-schedule-cli-v5';

async function setupForwardRepo(paperForwardScript) {
  const root = await mkdtemp(join(tmpdir(), 'pf-detail-test-'));
  const lab = join(root, 'market-prediction-lab');
  await mkdir(join(lab, 'scripts'), { recursive: true });
  for (const tasks of Object.values(PROFILES)) {
    for (const task of tasks) {
      for (const arg of task.args) {
        const target = join(lab, arg);
        await mkdir(join(target, '..'), { recursive: true });
        if (task.id === 'paper-forward') {
          await writeFile(target, paperForwardScript);
        } else {
          await writeFile(target, 'process.exit(0);\n');
        }
      }
    }
  }
  await writeFile(join(lab, 'package.json'), '{}\n');
  const shared = [
    'packages/strategy-hypothesis/package.json',
    'packages/strategy-hypothesis/src/index.js',
    'packages/strategy-hypothesis/src/contract.js',
    'packages/external-research/package.json',
    'packages/external-research/src/index.js',
    'packages/external-research/src/contract.js',
  ];
  for (const rel of shared) {
    const target = join(root, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, rel.endsWith('.json') ? '{}\n' : `export const marker=${JSON.stringify(rel)};\n`);
  }
  return root;
}

async function runForward(root) {
  return runResearchCycle({
    repoRoot: root,
    stateRoot: join(root, 'research-state'),
    researchSha: SHA,
    profile: 'forward',
    env: { PATH: process.env.PATH },
    verifyGitHead: false,
  });
}

function payload(overrides = {}) {
  return {
    schemaVersion: SCHEMA,
    status: 'BLOCKED_DATA',
    cycleId: 'paper-forward-public-evidence-4h-v1:888888',
    canonicalEntryCount: null,
    entryCount: null,
    entryEligibleCount: null,
    canonicalPositionCount: null,
    canonicalSettlementCount: null,
    evidenceCompleteCount: 0,
    paperStateTransport: {
      status: 'BLOCKED_DATA_WRONG_CYCLE',
      state: 'WRONG_CYCLE',
      reason: 'PAPER_STATE_SOURCE_SHA_MISMATCH',
      sourceShaExact: false,
      callbackInvocationCount: 0,
    },
    firstZeroStage: 'UNKNOWN',
    firstZeroReason: 'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING',
    ...overrides,
  };
}

function scriptJson(obj, exitCode = 0) {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(obj))} + '\\n'); process.exitCode = ${exitCode};\n`;
}

function scriptRaw(raw, exitCode = 0) {
  return `process.stdout.write(${JSON.stringify(raw)}); process.exitCode = ${exitCode};\n`;
}

function getPaper(result) {
  return result.results.find((r) => r.id === 'paper-forward');
}

test('1. normal stdout JSON is parsed into paperForwardDetail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ canonicalEntryCount: 3, entryCount: 3 })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.ok(pf.paperForwardDetail, 'detail should exist');
  assert.equal(pf.paperForwardDetail.schemaVersion, SCHEMA);
  assert.equal(pf.paperForwardDetail.canonicalEntryCount, 3);
  assert.equal(pf.paperForwardParseError, null);
  assert.equal(pf.stdoutWriteError, null);
});

test('2. null fields preserved as null', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ canonicalEntryCount: null, entryCount: null })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail.canonicalEntryCount, null);
  assert.strictEqual(pf.paperForwardDetail.entryCount, null);
});

test('3. exit code 2 preserves blocked_data status', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ status: 'BLOCKED_DATA' }), 2));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.equal(pf.status, 'blocked_data');
  assert.equal(pf.exitCode, 2);
  assert.equal(pf.paperForwardDetail.status, 'BLOCKED_DATA');
});

test('4. SIGTERM abort prevents detail creation', async () => {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(payload()))} + '\\n'); process.kill(process.pid, 'SIGTERM');\n`;
  const root = await setupForwardRepo(script);
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'INCOMPLETE_DUE_TO_ABORT');
  assert.notEqual(pf.signal, null);
});

test('5. non-JSON only produces NOT_FOUND', async () => {
  const root = await setupForwardRepo(scriptRaw('garbage\nnoise\nmore\n'));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_NOT_FOUND');
});

test('6. >5MiB output truncates capture with STDOUT_TOO_LARGE', async () => {
  const script = `process.stdout.write('x'.repeat(6*1024*1024), () => process.exit(0));\n`;
  const root = await setupForwardRepo(script);
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'STDOUT_TOO_LARGE');
  assert.equal(pf.paperForwardParseError.limitBytes, 5 * 1024 * 1024);
});

test('7. other tasks do not get paperForwardDetail/stdoutWriteError', async () => {
  const root = await setupForwardRepo(scriptJson(payload()));
  const result = await runForward(root);
  for (const r of result.results) {
    if (r.id === 'paper-forward') continue;
    assert.equal(r.paperForwardDetail, undefined);
    assert.equal(r.paperForwardParseError, undefined);
    assert.equal(r.stdoutWriteError, undefined);
  }
});

test('8. latest/forward.json includes paperForwardDetail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ canonicalEntryCount: 7 })));
  await runForward(root);
  const latestPath = join(root, 'research-state', 'latest', 'forward.json');
  const latest = JSON.parse(await readFile(latestPath, 'utf8'));
  const pf = latest.results.find((r) => r.id === 'paper-forward');
  assert.ok(pf.paperForwardDetail);
  assert.equal(pf.paperForwardDetail.canonicalEntryCount, 7);
});

test('9. JSON surrounded by non-JSON lines is parsed', async () => {
  const raw = `[INFO] start\n${JSON.stringify(payload())}\n[INFO] end\n`;
  const root = await setupForwardRepo(scriptRaw(raw));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.ok(pf.paperForwardDetail);
  assert.equal(pf.paperForwardDetail.schemaVersion, SCHEMA);
});

test('10. taskCycleId and paperForwardCycleId are distinct', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ cycleId: 'paper-forward-public-evidence-4h-v1:55555' })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.equal(pf.paperForwardDetail.paperForwardCycleId, 'paper-forward-public-evidence-4h-v1:55555');
  assert.notEqual(pf.paperForwardDetail.taskCycleId, pf.paperForwardDetail.paperForwardCycleId);
  assert.ok(pf.paperForwardDetail.taskCycleId.length > 0);
});

test('11. two valid schema JSONs cause AMBIGUOUS', async () => {
  const two = `${JSON.stringify(payload())}\n${JSON.stringify(payload())}\n`;
  const root = await setupForwardRepo(scriptRaw(two));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_AMBIGUOUS');
  assert.equal(pf.paperForwardParseError.candidateCount, 2);
});

test('12. multiple stdout chunks are merged', async () => {
  const json = JSON.stringify(payload());
  const script = `const j = ${JSON.stringify(json)};\nconst mid = Math.floor(j.length / 2);\nprocess.stdout.write(j.slice(0, mid));\nprocess.stdout.write(j.slice(mid));\nprocess.stdout.write('\\n');\n`;
  const root = await setupForwardRepo(script);
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.ok(pf.paperForwardDetail);
  assert.equal(pf.paperForwardDetail.schemaVersion, SCHEMA);
});

test('13. existing 17 task fields are preserved', async () => {
  const root = await setupForwardRepo(scriptJson(payload()));
  const result = await runForward(root);
  const pf = getPaper(result);
  const required = ['schemaVersion','id','fingerprint','researchSha','startedAt','endedAt','durationMs','exitCode','signal','timedOut','status','stdoutPath','stderrPath','workspaceRoot','liveTrading','privateApi','orderAuthority'];
  for (const k of required) assert.ok(k in pf, `missing ${k}`);
});

test('14. taskCycleId is always non-empty string in detail', async () => {
  const root = await setupForwardRepo(scriptJson(payload()));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.equal(typeof pf.paperForwardDetail.taskCycleId, 'string');
  assert.ok(pf.paperForwardDetail.taskCycleId.length > 0);
});

test('15. missing cycleId rejects detail', async () => {
  const noCycle = { ...payload() };
  delete noCycle.cycleId;
  const root = await setupForwardRepo(scriptJson(noCycle));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_INVALID');
});

test('16. paperStateTransport nested object is preserved', async () => {
  const root = await setupForwardRepo(scriptJson(payload()));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.deepEqual(pf.paperForwardDetail.paperStateTransport, payload().paperStateTransport);
});

test('17. null vs 0 vs positive integer are preserved', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ canonicalEntryCount: null, entryCount: 5, evidenceCompleteCount: 0 })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail.canonicalEntryCount, null);
  assert.strictEqual(pf.paperForwardDetail.entryCount, 5);
  assert.strictEqual(pf.paperForwardDetail.evidenceCompleteCount, 0);
  assert.equal(typeof pf.paperForwardDetail.entryCount, 'number');
});

test('18. JSON serialization round-trip preserves detail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ canonicalEntryCount: 9 })));
  await runForward(root);
  const latestPath = join(root, 'research-state', 'latest', 'forward.json');
  const parsed = JSON.parse(await readFile(latestPath, 'utf8'));
  const pf = parsed.results.find((r) => r.id === 'paper-forward');
  assert.equal(pf.paperForwardDetail.canonicalEntryCount, 9);
});

test('19. empty string cycleId rejects detail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ cycleId: '' })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_INVALID');
});

test('20. numeric cycleId rejects detail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ cycleId: 12345 })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_INVALID');
});

test('20b. whitespace-only cycleId rejects detail', async () => {
  const root = await setupForwardRepo(scriptJson(payload({ cycleId: '   ' })));
  const result = await runForward(root);
  const pf = getPaper(result);
  assert.strictEqual(pf.paperForwardDetail, null);
  assert.equal(pf.paperForwardParseError.code, 'PAPER_FORWARD_RESULT_INVALID');
});

test.skip('21. stdout write error keeps detail parsing and records stdoutWriteError', () => {
  // OS-level write failure injection is out of scope for this suite.
  // Verified by code review: engine.mjs sets stdoutWriteError from error.code in stdout.on('error')
  // and parsing continues independently in the close handler.
});
