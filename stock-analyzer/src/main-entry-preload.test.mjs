import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('prioritizes the application shell before starting the direct AI Chart route chunk', () => {
  const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const aiChartPreloadIndex = mainSource.indexOf("import('@/pages/ai-chart')");
  const appLoadIndex = mainSource.indexOf("import('./App')");

  assert.match(mainSource, /window\.location\.pathname\.endsWith\('\/ai-chart'\)/);
  assert.notEqual(aiChartPreloadIndex, -1);
  assert.notEqual(appLoadIndex, -1);
  assert.equal(appLoadIndex < aiChartPreloadIndex, true);
  assert.match(mainSource, /appModulePromise\.then\(\(\{ default: App \}\) =>/);
});
