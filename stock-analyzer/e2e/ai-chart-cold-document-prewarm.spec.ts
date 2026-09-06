import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart document keeps every module script async so prewarm is not downgraded to defer', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const prewarmScript = '<script type="module" async>';
  const routeGuard = "if (window.location.pathname.endsWith('/ai-chart'))";
  const routeImport = "void import('/src/pages/ai-chart.tsx');";
  const headEnd = '</head>';
  const appEntry = '<script type="module" async src="/src/main.tsx"></script>';
  const moduleScripts = html.match(/<script\s+type="module"[^>]*>/g) ?? [];

  expect(html).toContain(prewarmScript);
  expect(html).toContain(routeGuard);
  expect(html).toContain(routeImport);
  expect(html).toContain(appEntry);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(moduleScripts).toHaveLength(2);
  expect(moduleScripts.every((script) => /\sasync(?:\s|>)/.test(script))).toBe(true);
  expect(html.indexOf(prewarmScript)).toBeLessThan(html.indexOf(routeGuard));
  expect(html.indexOf(routeGuard)).toBeLessThan(html.indexOf(routeImport));
  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(headEnd));
  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(appEntry));
});
