import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function waitForLine(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT_WAITING_FOR:${pattern}`)), timeoutMs);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(pattern)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(buffer);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`SERVER_EXITED:${code}:${buffer}`));
    });
  });
}

async function assertHealth(port, expectedSha) {
  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.serviceSha, expectedSha);
  assert.equal(health.bindHost, '127.0.0.1');
  assert.equal(health.safety.executionAuthority, 'NONE');
  assert.equal(health.safety.privateTradingApiAllowed, false);
  assert.equal(health.safety.realOrderAllowed, false);
  return health;
}

test('server exposes safe loopback health and evaluate endpoint', async (t) => {
  const port = 18891;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MARKET_INTELLIGENCE_HOST: '127.0.0.1',
      MARKET_INTELLIGENCE_PORT: String(port),
      MARKET_INTELLIGENCE_SERVICE_SHA: 'test-sha',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForLine(child, 'market_intelligence_started');
  await assertHealth(port, 'test-sha');

  const evaluateResponse = await fetch(`http://127.0.0.1:${port}/v1/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      market: 'CRYPTO_SPOT',
      symbol: 'KRW-BTC',
      asOf: Date.now(),
      orderBook: { bids: [[100, 2]], asks: [[101, 1]], ts: Date.now() },
      trades: [{ side: 'buy', price: 100.5, size: 1, ts: Date.now() }],
    }),
  });
  assert.equal(evaluateResponse.status, 200);
  const evaluated = await evaluateResponse.json();
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.result.scanner.mode, 'SOFT_INTELLIGENCE_LAYER');
  assert.equal(evaluated.result.autoTrading.orderAllowed, false);
});

test('server starts when invoked through the production-style current symlink', async (t) => {
  const port = 18892;
  const sidecarRoot = fileURLToPath(new URL('..', import.meta.url));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'market-intelligence-symlink-'));
  const currentLink = path.join(tempRoot, 'current');
  await symlink(sidecarRoot, currentLink, 'dir');
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, [path.join(currentLink, 'src/server.mjs')], {
    env: {
      ...process.env,
      MARKET_INTELLIGENCE_HOST: '127.0.0.1',
      MARKET_INTELLIGENCE_PORT: String(port),
      MARKET_INTELLIGENCE_SERVICE_SHA: 'symlink-sha',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForLine(child, 'market_intelligence_started');
  await assertHealth(port, 'symlink-sha');
});
