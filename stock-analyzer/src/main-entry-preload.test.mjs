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
