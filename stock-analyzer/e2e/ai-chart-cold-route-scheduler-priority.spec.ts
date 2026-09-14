import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart starts auth-capable app bootstrap without competing renderer work', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');

  const routeImport = "import('/src/pages/ai-chart.tsx')";
  const appWork = 'const startAppBootstrap = () => {';
  const sharedDataImport = "import('/src/lib/unified-chart-data.ts')";
  const appImport = "void import('/src/main.tsx');";
  const routeSettledStart = 'void aiChartRoutePrewarm.then(';
  const immediateBootstrap = 'window.setTimeout(startAppBootstrap, 0);';
  const immediateFallback = 'startAppBootstrap();';

  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/lib\/unified-chart-data\.ts'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/main\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/aiChartRoutePrewarm\.then\(/g)).toHaveLength(1);
  expect(html.match(/window\.setTimeout\(startAppBootstrap,\s*0\)/g)).toHaveLength(1);
  expect(html).not.toMatch(/window\.setTimeout\(startAppBootstrap,\s*[1-9][0-9]*\)/);

  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(appWork));
  expect(html.indexOf(appWork)).toBeLessThan(html.indexOf(appImport));
  expect(html.indexOf(appImport)).toBeLessThan(html.indexOf(routeSettledStart));
  expect(html.indexOf(routeSettledStart)).toBeLessThan(html.indexOf(sharedDataImport));

  const directRouteBranch = html.slice(html.indexOf('if (directAiChartRoute && aiChartRoutePrewarm) {'));
  expect(directRouteBranch).toContain(immediateBootstrap);
  expect(directRouteBranch).toContain(routeSettledStart);
  expect(directRouteBranch.indexOf(immediateBootstrap)).toBeLessThan(directRouteBranch.indexOf(routeSettledStart));
  expect(directRouteBranch).toContain("import('/src/lib/unified-chart-data.ts')");
  expect(directRouteBranch).toContain(".then(() => import('/src/components/unified-analysis-chart.tsx'))");
  expect(directRouteBranch).toContain('} else {');
  expect(directRouteBranch).toContain(immediateFallback);

  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
});
