import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const SHA = 'a'.repeat(40);

function candidate() {
  return {
    market: 'KR_STOCK', symbol: '005930', strategy: 'SWING', timeframe: '1D', direction: 'BUY',
    dataStatus: 'READY', quantEligible: true, profitEligible: true, riskReady: true,
    evidence: { expectedNetEdgeR: 1.1, tailLossPenaltyR: 0.1, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
  };
}

async function startServer(stateFile, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA,
      SIGNAL_INTELLIGENCE_HOST: '127.0.0.1',
      SIGNAL_INTELLIGENCE_PORT: String(port),
      SIGNAL_INTELLIGENCE_STATE_FILE: stateFile,
      SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS: '600000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, stdout: () => stdout, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${stderr}`);
}

test('server exposes read-only fresh snapshot and safety health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-'));
  const state = join(dir, 'snapshot.json');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const snapshot = runSignalIntelligenceV3([candidate()]);
  await writeFile(state, `${JSON.stringify(snapshot)}\n`);
  const server = await startServer(state, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.serviceSha, SHA);
    assert.equal(health.executionAuthority, 'NONE');
    assert.equal(health.privateTradingApiAllowed, false);
    assert.equal(health.realOrderAllowed, false);
    assert.equal(health.snapshotReady, true);

    const kr = await (await fetch(`http://127.0.0.1:${port}/v1/signals/kr`)).json();
    assert.equal(kr.ok, true);
    assert.equal(kr.candidates.length, 1);
    assert.equal(kr.candidates[0].symbol, '005930');

    const post = await fetch(`http://127.0.0.1:${port}/v1/signals`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('server fails signal reads closed when snapshot is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-'));
  const state = join(dir, 'missing.json');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const server = await startServer(state, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.snapshotReady, false);
    const response = await fetch(`http://127.0.0.1:${port}/v1/signals/kr`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.executionAuthority, 'NONE');
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-loopback bind is rejected', async () => {
  const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA,
      SIGNAL_INTELLIGENCE_HOST: '0.0.0.0',
      SIGNAL_INTELLIGENCE_PORT: '19999',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /SIGNAL_INTELLIGENCE_LOOPBACK_ONLY/);
});

test('future snapshots and wrong release hashes never pass freshness or signal reads', async () => {
  for (const [change, expected] of [
    [{ generatedAt: new Date(Date.now() + 3600_000).toISOString() }, 'SNAPSHOT_STALE'],
    [{ serviceSha: 'b'.repeat(40) }, 'SNAPSHOT_SERVICE_SHA_MISMATCH'],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'signal-v3-'));
    const state = join(dir, 'snapshot.json');
    await writeFile(state, JSON.stringify({ ...runSignalIntelligenceV3([candidate()]), ...change }));
    const port = 20000 + Math.floor(Math.random() * 1000);
    const server = await startServer(state, port);
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(health.snapshotFresh, false);
      const response = await fetch(`http://127.0.0.1:${port}/v1/signals/kr`);
      assert.equal(response.status, 503); assert.equal((await response.json()).error, expected);
    } finally {
      server.child.kill('SIGTERM'); await new Promise(r => server.child.once('exit', r));
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('full-profile retained history without current verified page evidence is not a fresh candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-')); const state = join(dir, 'snapshot.json');
  await writeFile(state, JSON.stringify({ ...runSignalIntelligenceV3([candidate()]), profile: { fullStrategyCoverage: true }, coverage: [] }));
  const port = 21000 + Math.floor(Math.random() * 1000); const server = await startServer(state, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.snapshotTimestampFresh, true); assert.equal(health.snapshotFresh, false);
    assert.equal(health.snapshotCurrentPageSourceReady, false);
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/signals/kr`)).json();
    assert.deepEqual(body.candidates, []);
  } finally {
    server.child.kill('SIGTERM'); await new Promise(r => server.child.once('exit', r)); await rm(dir, { recursive: true, force: true });
  }
});

test('NaN, Infinity and nonpositive freshness limits are rejected', async () => {
  for (const value of ['NaN', 'Infinity', '-1', '0']) {
    const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], { cwd: process.cwd(),
      env: { ...process.env, SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA, SIGNAL_INTELLIGENCE_HOST: '127.0.0.1',
        SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS: value }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    assert.notEqual(await new Promise(r => child.once('exit', r)), 0);
    assert.match(stderr, /SIGNAL_INTELLIGENCE_MAX_STATE_AGE_INVALID/);
  }
});
