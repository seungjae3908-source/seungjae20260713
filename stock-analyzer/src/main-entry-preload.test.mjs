import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('starts the application entry before the direct AI Chart route chunk', () => {
  const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const aiChartPreloadIndex = mainSource.indexOf("import('@/pages/ai-chart')");
  const appLoadIndex = mainSource.indexOf("import('./App')");

  assert.match(indexSource, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  assert.doesNotMatch(indexSource, /pages\/ai-chart/);
  assert.match(mainSource, /window\.location\.pathname\.endsWith\('\/ai-chart'\)/);
  assert.notEqual(aiChartPreloadIndex, -1);
  assert.notEqual(appLoadIndex, -1);
  assert.equal(appLoadIndex < aiChartPreloadIndex, true);
  assert.match(mainSource, /appModulePromise\.then\(\(\{ default: App \}\) =>/);
});

test('defers service-worker precache beyond the direct AI Chart cold usability window', () => {
  const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

  assert.match(mainSource, /const AI_CHART_SERVICE_WORKER_DELAY_MS = 6_000;/);
  assert.match(
    mainSource,
    /if \(window\.location\.pathname\.endsWith\('\/ai-chart'\)\) \{\s*window\.setTimeout\(register, AI_CHART_SERVICE_WORKER_DELAY_MS\);\s*return;/,
  );
  assert.match(mainSource, /void register\(\);/);
});
