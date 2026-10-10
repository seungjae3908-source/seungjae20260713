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

test('Production warmup prioritizes direct Vite HTML dependencies and the complete AI Chart renderer graph before unrelated lazy chunks', async (context) => {
  const runtimeDist = await mkdtemp(path.join(tmpdir(), 'frontend-ai-chart-critical-'));
  const assetsDir = path.join(runtimeDist, 'assets');
  await mkdir(assetsDir);
  context.after(() => rm(runtimeDist, { recursive: true, force: true }));
  await writeFile(path.join(runtimeDist, 'index.html'), [
    '<html><head>',
    '<link rel="stylesheet" href="/assets/index-style-aaa.css">',
    '<script type="module" crossorigin src="/assets/index-start-bbb.js"></script>',
    '</head><body></body></html>',
  ].join('\n'));
  for (const [name, contents] of [
    ['index-style-aaa.css', 'p{color:inherit}'],
    ['index-start-bbb.js', 'import "./ai-chart-abc123.js"'],
    ['ai-chart-abc123.js', 'export const page=true'],
    ['unified-analysis-chart-abc123.js', 'export const render=true'],
    ['lightweight-charts.production-Bh68vz78.js', 'export const candles=true'],
    ['backtests-bbbb.js', 'export const backtest=true'],
    ['paper-trading-cccc.js', 'export const paper=true'],
    ['ai-chart-position-panel-impl-cccc.js', 'export const optional=true'],
    ['aaa-other-cccc.js', 'export const a=true'],
    ['zzz-other-cccc.js', 'export const z=true'],
  ] as Array<[string, string]>) {
    await writeFile(path.join(assetsDir, name), contents);
  }
  const result = planFrontendStaticWarmup(runtimeDist, { maxFiles: 6, maxBytes: 10_000 });
  assert.deepEqual(result.files.map((entry) => path.basename(entry)), [
    'index.html', 'index-start-bbb.js', 'index-style-aaa.css',
    'ai-chart-abc123.js', 'lightweight-charts.production-Bh68vz78.js',
    'unified-analysis-chart-abc123.js',
  ]);
  assert.equal(result.truncated, true);
  assert.equal(result.criticalFiles, 3);
  assert.equal(result.files.some((entry) => entry.includes('backtests')), false);
  assert.equal(result.files.some((entry) => entry.includes('ai-chart-position-panel-impl')), false);
  const warmed = warmFrontendStaticFiles(runtimeDist, { maxFiles: 6, maxBytes: 10_000 });
  assert.equal(warmed.warmedFiles, 6);
  assert.equal(warmed.warmedBytes, warmed.plannedBytes);
  assert.equal(warmed.errors, 0);
});

test('AI Chart warmup stays bounded, does not prioritize unsafe URL attributes and preserves immutable asset cache', async (context) => {
  const runtimeDist = await mkdtemp(path.join(tmpdir(), 'frontend-ai-chart-budget-'));
  const assetsDir = path.join(runtimeDist, 'assets');
  await mkdir(assetsDir);
  context.after(() => rm(runtimeDist, { recursive: true, force: true }));
  await writeFile(path.join(runtimeDist, 'index.html'), [
    '<script src="https://other.example/assets/fake-external.js"></script>',
    '<script src="/assets/../secrets.js"></script>',
    '<script src="/assets/index-entry-xyz.js?token=private"></script>',
    '<script type="module" src="/assets/index-entry-xyz.js"></script>',
  ].join('\n'));
  await writeFile(path.join(assetsDir, 'index-entry-xyz.js'), 'I'.repeat(10));
  await writeFile(path.join(assetsDir, 'lightweight-charts.production-xyz.js'), 'L'.repeat(40));
  await writeFile(path.join(assetsDir, 'ai-chart-xyz.js'), 'A'.repeat(11));
  await writeFile(path.join(assetsDir, 'fake-external.js'), 'E'.repeat(5));
  await writeFile(path.join(assetsDir, 'secrets.js'), 'S'.repeat(5));

  const tiny = planFrontendStaticWarmup(runtimeDist, { maxFiles: 3, maxBytes: 500 });
  assert.deepEqual(tiny.files.map((entry) => path.basename(entry)), [
    'index.html', 'index-entry-xyz.js', 'ai-chart-xyz.js',
  ]);
  assert.equal(tiny.truncated, true);
  assert.equal(tiny.criticalFiles, 1);

  const htmlBytes = Buffer.byteLength(await (await import('node:fs/promises')).readFile(path.join(runtimeDist, 'index.html')));
  const byteBudget = htmlBytes + 10 + 11 + 39;
  const capped = planFrontendStaticWarmup(runtimeDist, { maxFiles: 5, maxBytes: byteBudget });
  assert.ok(capped.plannedBytes <= byteBudget);
  assert.equal(capped.truncated, true);
  assert.equal(capped.files.some((entry) => entry.endsWith('lightweight-charts.production-xyz.js')), false);
  assert.equal(frontendStaticCacheControl(runtimeDist, path.join(assetsDir, 'ai-chart-xyz.js')), FRONTEND_IMMUTABLE_CACHE_CONTROL);
});
