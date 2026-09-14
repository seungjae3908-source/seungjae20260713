import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prioritizes route preload while bounding competing cold work', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');

  const routeImport = "import('/src/pages/ai-chart.tsx')";
  const sharedWork = 'const startAiChartSharedWork = () => {';
  const sharedDataImport = "import('/src/lib/unified-chart-data.ts')";
  const appImport = "void import('/src/main.tsx');";
  const routeSettledStart = 'void aiChartRoutePrewarm.then(';
  const boundedBootstrap = 'const boundedBootstrap = window.setTimeout(startAiChartSharedWork, 750);';
  const clearBoundedBootstrap = 'window.clearTimeout(boundedBootstrap);';
  const immediateFallback = 'startAiChartSharedWork();';

  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/lib\/unified-chart-data\.ts'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/main\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/aiChartRoutePrewarm\.then\(/g)).toHaveLength(1);
  expect(html.match(/window\.setTimeout\(startAiChartSharedWork,\s*750\)/g)).toHaveLength(1);
  expect(html).not.toMatch(/window\.setTimeout\(startAiChartSharedWork,\s*0\)/);

  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(sharedWork));
  expect(html.indexOf(sharedWork)).toBeLessThan(html.indexOf(sharedDataImport));
  expect(html.indexOf(sharedDataImport)).toBeLessThan(html.indexOf(appImport));
  expect(html.indexOf(appImport)).toBeLessThan(html.indexOf(routeSettledStart));

  const directRouteBranch = html.slice(html.indexOf('if (directAiChartRoute && aiChartRoutePrewarm) {'));
  expect(directRouteBranch).toContain(boundedBootstrap);
  expect(directRouteBranch).toContain(routeSettledStart);
  expect(directRouteBranch.match(/window\.clearTimeout\(boundedBootstrap\);/g)).toHaveLength(2);
  expect(directRouteBranch.match(/window\.clearTimeout\(boundedBootstrap\);\s*startAiChartSharedWork\(\);/g)).toHaveLength(2);
  expect(directRouteBranch.indexOf(boundedBootstrap)).toBeLessThan(directRouteBranch.indexOf(routeSettledStart));
  expect(directRouteBranch).toContain(clearBoundedBootstrap);
  expect(directRouteBranch).toContain('} else {');
  expect(directRouteBranch).toContain(immediateFallback);

  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
});
