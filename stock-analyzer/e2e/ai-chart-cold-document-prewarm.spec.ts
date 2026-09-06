import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart document preloads the route without introducing async module script ordering', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const routePreload = '<link rel="modulepreload" href="/src/pages/ai-chart.tsx" />';
  const headEnd = '</head>';
  const root = '<div id="root"></div>';
  const appEntryTag = '<script type="module" src="/src/main.tsx">';
  const moduleScripts = html.match(/<script\s+type="module"[^>]*>/g) ?? [];

  expect(html).toContain(routePreload);
  expect(html).toContain(`${appEntryTag}</script>`);
  expect(html.match(/rel="modulepreload"\s+href="\/src\/pages\/ai-chart\.tsx"/g)).toHaveLength(1);
  expect(html).not.toContain("import('/src/pages/ai-chart.tsx')");
  expect(moduleScripts).toHaveLength(1);
  expect(moduleScripts[0], 'canonical app entry must retain native module defer ordering for the React root mount').toBe(appEntryTag);
  expect(moduleScripts[0]).not.toMatch(/\sasync(?:\s|>)/);
  expect(html.indexOf(routePreload)).toBeLessThan(html.indexOf(headEnd));
  expect(html.indexOf(routePreload)).toBeLessThan(html.indexOf(appEntryTag));
  expect(html.indexOf(root)).toBeLessThan(html.indexOf(appEntryTag));
});
