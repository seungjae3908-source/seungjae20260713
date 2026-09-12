import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart gives the route fetch one scheduler turn before competing cold work', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');

  const routeImport = "import('/src/pages/ai-chart.tsx')";
  const sharedWork = 'const startAiChartSharedWork = () => {';
  const sharedDataImport = "import('/src/lib/unified-chart-data.ts')";
  const appImport = "void import('/src/main.tsx');";
  const deferredStart = 'window.setTimeout(startAiChartSharedWork, 0);';
  const immediateFallback = 'startAiChartSharedWork();';

  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/lib\/unified-chart-data\.ts'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/main\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/window\.setTimeout\(startAiChartSharedWork, 0\)/g)).toHaveLength(1);

  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(sharedWork));
  expect(html.indexOf(sharedWork)).toBeLessThan(html.indexOf(sharedDataImport));
  expect(html.indexOf(sharedDataImport)).toBeLessThan(html.indexOf(appImport));
  expect(html.indexOf(appImport)).toBeLessThan(html.indexOf(deferredStart));

  const directRouteBranch = html.slice(html.indexOf('if (directAiChartRoute && aiChartRoutePrewarm) {'));
  expect(directRouteBranch).toContain(deferredStart);
  expect(directRouteBranch).toContain('} else {');
  expect(directRouteBranch).toContain(immediateFallback);

  expect(html).not.toMatch(/setTimeout\([^,]+,\s*[1-9][0-9]+\)/);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
});
