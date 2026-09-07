import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prewarm starts app and route graphs in parallel after the root exists', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const appEntryImport = "void import('/src/main.tsx');";
  const routePrewarmImport = "void import('/src/pages/ai-chart.tsx');";
  const prewarmGuard = "window.location.pathname.endsWith('/ai-chart')";
  const root = '<div id="root"></div>';
  const moduleScripts = html.match(/<script\s+type="module"[^>]*>/g) ?? [];

  expect(html).toContain(prewarmGuard);
  expect(html).toContain(appEntryImport);
  expect(html).toContain(routePrewarmImport);
  expect(html.match(/import\('\/src\/main\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
  expect(moduleScripts).toHaveLength(1);
  for (const script of moduleScripts) {
    expect(script, 'the canonical app entry must retain native module defer ordering').not.toMatch(/\sasync(?:\s|>)/);
  }
  expect(html.indexOf(root)).toBeLessThan(html.indexOf(appEntryImport));
  expect(html.indexOf(appEntryImport)).toBeLessThan(html.indexOf(routePrewarmImport));
});
