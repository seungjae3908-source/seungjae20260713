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

async function startServer(stateFile, port) {
  const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA,
      SIGNAL_INTELLIGENCE_HOST: '127.0.0.1',
      SIGNAL_INTELLIGENCE_PORT: String(port),
      SIGNAL_INTELLIGENCE_STATE_FILE: stateFile,
      SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS: '600000',
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
