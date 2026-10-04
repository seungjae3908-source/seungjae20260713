import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('starts the direct AI Chart route before the application graph without prewarming its renderer', () => {
  const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const aiChartPreloadIndex = mainSource.indexOf("import('@/pages/ai-chart')");
  const authBootstrapIndex = mainSource.indexOf("import('@/lib/auth-initial-bootstrap')");
  const appLoadIndex = mainSource.indexOf("import('./App')");
  const runtimeLoadIndex = mainSource.indexOf("import('./app-runtime')");

  assert.match(indexSource, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  assert.doesNotMatch(indexSource, /pages\/ai-chart/);
  assert.match(mainSource, /const directAiChartColdRoute = window\.location\.pathname\.endsWith\('\/ai-chart'\);/);
  assert.notEqual(aiChartPreloadIndex, -1);
  assert.notEqual(authBootstrapIndex, -1);
  assert.notEqual(appLoadIndex, -1);
  assert.notEqual(runtimeLoadIndex, -1);
  assert.equal(aiChartPreloadIndex < authBootstrapIndex, true);
  assert.equal(aiChartPreloadIndex < appLoadIndex, true);
  assert.equal(aiChartPreloadIndex < runtimeLoadIndex, true);
  assert.match(mainSource, /const AI_CHART_APP_GRAPH_HEAD_START_MS = 750;/);
  assert.match(mainSource, /const directAiChartRoutePromise = directAiChartColdRoute\s*\? import\('@\/pages\/ai-chart'\)\s*: null;/);
  assert.match(mainSource, /querySelectorAll<HTMLLinkElement>\('link\[rel="modulepreload"\]'\)/);
  assert.match(mainSource, /setAttribute\('fetchpriority', 'high'\)/);
  assert.match(mainSource, /import\('@\/lib\/auth-initial-bootstrap'\)/);
  assert.match(mainSource, /primeInitialAuthBootstrap\(\)/);
  assert.match(mainSource, /let applicationGraphStarted = false;/);
  assert.match(mainSource, /if \(applicationGraphStarted\) return;/);
  assert.match(mainSource, /function startApplicationGraph\(\)/);
  assert.match(mainSource, /const runtimeModulePromise = import\('\.\/app-runtime'\);/);
  assert.match(mainSource, /Promise\.all\(\[appModulePromise, runtimeModulePromise\]\)/);
  assert.match(mainSource, /window\.setTimeout\(startApplicationGraph, AI_CHART_APP_GRAPH_HEAD_START_MS\)/);
  assert.match(mainSource, /directAiChartRoutePromise\.then\(startAfterRouteSettles, startAfterRouteSettles\)/);
  assert.doesNotMatch(mainSource, /import\(['"]@\/components\/unified-analysis-chart['"]\)/);
  assert.doesNotMatch(mainSource, /^import\s/m);
});

test('defers service-worker precache beyond the direct AI Chart cold usability window', () => {
  const runtimeSource = readFileSync(new URL('./app-runtime.tsx', import.meta.url), 'utf8');

  assert.match(runtimeSource, /const AI_CHART_SERVICE_WORKER_DELAY_MS = 6_000;/);
  assert.match(
    runtimeSource,
    /if \(window\.location\.pathname\.endsWith\('\/ai-chart'\)\) \{\s*window\.setTimeout\(register, AI_CHART_SERVICE_WORKER_DELAY_MS\);\s*return;/,
  );
  assert.match(runtimeSource, /void register\(\);/);
});
