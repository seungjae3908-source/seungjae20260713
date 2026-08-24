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
  setFrontendStaticCacheHeaders,
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
