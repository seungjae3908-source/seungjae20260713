import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prewarm starts app and route graphs while preserving MIME-safe root ordering', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const appPrewarmImport = "void import('/src/App.tsx');";
  const routePrewarmImport = "void import('/src/pages/ai-chart.tsx');";
  const prewarmGuard = "window.location.pathname.endsWith('/ai-chart')";
  const headEnd = '</head>';
  const root = '<div id="root"></div>';
  const appEntryTag = '<script type="module" src="/src/main.tsx">';
  const moduleScripts = html.match(/<script\s+type="module"[^>]*>/g) ?? [];

  expect(html).toContain(prewarmGuard);
  expect(html).toContain(appPrewarmImport);
  expect(html).toContain(routePrewarmImport);
  expect(html).toContain(`${appEntryTag}</script>`);
  expect(html.match(/import\('\/src\/App\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
  expect(moduleScripts).toHaveLength(2);
  for (const script of moduleScripts) {
    expect(script, 'prewarm and canonical app entry must retain native module defer ordering').not.toMatch(/\sasync(?:\s|>)/);
  }
  expect(html.indexOf(appPrewarmImport)).toBeLessThan(html.indexOf(routePrewarmImport));
  expect(html.indexOf(routePrewarmImport)).toBeLessThan(html.indexOf(headEnd));
  expect(html.indexOf(root)).toBeLessThan(html.indexOf(appEntryTag));
});
