import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  FRONTEND_DEFAULT_CACHE_CONTROL,
  FRONTEND_IMMUTABLE_CACHE_CONTROL,
  FRONTEND_REVALIDATE_CACHE_CONTROL,
  frontendStaticCacheControl,
  planFrontendStaticWarmup,
  resolveProductionFrontendDist,
  setFrontendStaticCacheHeaders,
  warmFrontendStaticFiles,
} from './frontend-static-cache';

const frontendDist = path.resolve('stock-analyzer/dist');
const asset = (relative: string) => path.join(frontendDist, ...relative.split('/'));

test('fingerprinted frontend assets use an immutable one-year cache policy', () => {
  assert.equal(
    frontendStaticCacheControl(frontendDist, asset('assets/ai-chart-3B368tc1.js')),
    FRONTEND_IMMUTABLE_CACHE_CONTROL,
  );
  assert.equal(
    frontendStaticCacheControl(frontendDist, asset('assets/index-zLc9is-C.css')),
    FRONTEND_IMMUTABLE_CACHE_CONTROL,
  );
  assert.equal(
    frontendStaticCacheControl(frontendDist, asset('workbox-a1_B2.js')),
    FRONTEND_IMMUTABLE_CACHE_CONTROL,
  );
});

test('the app shell and service-worker control files always revalidate', () => {
  for (const relative of ['index.html', 'sw.js', 'registerSW.js', 'push-sw.js', 'manifest.webmanifest']) {
    assert.equal(
      frontendStaticCacheControl(frontendDist, asset(relative)),
      FRONTEND_REVALIDATE_CACHE_CONTROL,
      relative,
    );
  }
});

test('other public files use a bounded cache and paths outside the dist root fail closed', () => {
  assert.equal(
    frontendStaticCacheControl(frontendDist, asset('icons/apple-touch-icon.png')),
    FRONTEND_DEFAULT_CACHE_CONTROL,
  );
  assert.equal(
    frontendStaticCacheControl(frontendDist, path.resolve(frontendDist, '..', 'index.html')),
    FRONTEND_REVALIDATE_CACHE_CONTROL,
  );
});

test('the Express header adapter applies the resolved policy', () => {
  const headers = new Map<string, string>();
  setFrontendStaticCacheHeaders(
    { setHeader(name, value) { headers.set(name, value); } },
    frontendDist,
    asset('assets/technical-workspace-DD-QAOoQ.js'),
  );
  assert.equal(headers.get('Cache-Control'), FRONTEND_IMMUTABLE_CACHE_CONTROL);
});

test('Production startup warmup prioritizes the app shell and critical lazy chunks within strict bounds', async (context) => {
  const runtimeDist = await mkdtemp(path.join(tmpdir(), 'frontend-static-warmup-'));
  const assetsDir = path.join(runtimeDist, 'assets');
  await mkdir(assetsDir);
  await writeFile(path.join(runtimeDist, 'index.html'), '<main>shell</main>');
  await writeFile(path.join(assetsDir, 'ai-chart-aaaa.js'), 'a'.repeat(17));
  await writeFile(path.join(assetsDir, 'backtests-bbbb.js'), 'b'.repeat(19));
  await writeFile(path.join(assetsDir, 'paper-trading-cccc.js'), 'c'.repeat(23));
  await writeFile(path.join(assetsDir, 'other-dddd.js'), 'd'.repeat(29));
  await writeFile(path.join(assetsDir, 'style-eeee.css'), 'e'.repeat(31));
  await writeFile(path.join(assetsDir, 'ignored.png'), 'not-warmable');
  context.after(() => rm(runtimeDist, { recursive: true, force: true }));

  const plan = planFrontendStaticWarmup(runtimeDist, { maxFiles: 4, maxBytes: 1024 });
  assert.deepEqual(
    plan.files.map((filePath) => path.basename(filePath)),
    ['index.html', 'ai-chart-aaaa.js', 'backtests-bbbb.js', 'paper-trading-cccc.js'],
  );
  assert.equal(plan.criticalFiles, 3);
  assert.equal(plan.truncated, true);

  const result = warmFrontendStaticFiles(runtimeDist, { maxFiles: 4, maxBytes: 1024 });
  assert.equal(result.warmedFiles, 4);
  assert.equal(result.warmedBytes, result.plannedBytes);
  assert.equal(result.errors, 0);
});

test('Production frontend dist resolver finds the deployed public build without network access', async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'frontend-static-resolve-'));
  const runtimeDist = path.join(runtimeRoot, 'stock-analyzer', 'dist', 'public');
  await mkdir(runtimeDist, { recursive: true });
  await writeFile(path.join(runtimeDist, 'index.html'), '<main>shell</main>');
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));

  assert.equal(resolveProductionFrontendDist(runtimeRoot), runtimeDist);
});

test('Express serves fingerprinted assets as immutable while the SPA shell revalidates', async (context) => {
  const runtimeDist = await mkdtemp(path.join(tmpdir(), 'frontend-static-cache-'));
  await mkdir(path.join(runtimeDist, 'assets'));
  await writeFile(path.join(runtimeDist, 'assets', 'ai-chart-fingerprint.js'), 'export default true;');
  await writeFile(path.join(runtimeDist, 'index.html'), '<main>shell</main>');

  const app = express();
  app.use(express.static(runtimeDist, {
    setHeaders(response, filePath) {
      setFrontendStaticCacheHeaders(response, runtimeDist, filePath);
    },
  }));
  app.use((_request, response) => {
    response.setHeader('Cache-Control', FRONTEND_REVALIDATE_CACHE_CONTROL);
    response.sendFile(path.join(runtimeDist, 'index.html'));
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDist, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const assetResponse = await fetch(`${origin}/assets/ai-chart-fingerprint.js`);
  const shellResponse = await fetch(`${origin}/ai-chart`);

  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('cache-control'), FRONTEND_IMMUTABLE_CACHE_CONTROL);
  assert.equal(shellResponse.status, 200);
  assert.equal(shellResponse.headers.get('cache-control'), FRONTEND_REVALIDATE_CACHE_CONTROL);
});
