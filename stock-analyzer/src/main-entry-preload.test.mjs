import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('starts direct AI Chart page preloading before the application graph without serializing bootstrap or prewarming its renderer', () => {
  const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const aiChartPreloadIndex = mainSource.indexOf("import('@/pages/ai-chart')");
  const appLoadIndex = mainSource.indexOf("import('./App')");
  const runtimeLoadIndex = mainSource.indexOf("import('./app-runtime')");

  assert.match(indexSource, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  assert.doesNotMatch(indexSource, /pages\/ai-chart/);
  assert.match(mainSource, /window\.location\.pathname\.endsWith('\/ai-chart'\)/);
  assert.match(mainSource, /const aiChartCriticalPreload = directAiChartRoute/);
  assert.notEqual(aiChartPreloadIndex, -1);
  assert.notEqual(appLoadIndex, -1);
  assert.notEqual(runtimeLoadIndex, -1);
  assert.equal(aiChartPreloadIndex < appLoadIndex, true);
  assert.equal(aiChartPreloadIndex < runtimeLoadIndex, true);
  assert.match(mainSource, /\.then\(\(\) => undefined, \(\) => undefined\)/);
  assert.match(mainSource, /void aiChartCriticalPreload;/);
  assert.doesNotMatch(mainSource, /void aiChartCriticalPreload\.then\(/);
  assert.match(mainSource, /void \(async \(\) => \{\s*const \[\{ default: App \}, \{ mountApp \}\] = await Promise\.all\(\[\s*import\('\.\/App'\),\s*import\('\.\/app-runtime'\),\s*\]\)/);
  assert.doesNotMatch(mainSource, /import\(['"]@\/components\/unified-analysis-chart['"]\)/);
  assert.doesNotMatch(mainSource, /^import\s/m);
});

test('defers service-worker precache beyond the direct AI Chart cold usability window', () => {
  const runtimeSource = readFileSync(new URL('./app-runtime.tsx', import.meta.url), 'utf8');

  assert.match(runtimeSource, /const AI_CHART_SERVICE_WORKER_DELAY_MS = 6_000;/);
  assert.match(
    runtimeSource,
    /if \(window\.location\.pathname\.endsWith('\/ai-chart'\)\) \{\s*window\.setTimeout\(register, AI_CHART_SERVICE_WORKER_DELAY_MS\);\s*return;/,
  );
  assert.match(runtimeSource, /void register\(\);/);
});
