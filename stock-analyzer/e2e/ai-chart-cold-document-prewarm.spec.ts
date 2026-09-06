import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart document starts app and route imports from the head before the app entry', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const prewarmScript = '<script type="module" async>';
  const routeGuard = "if (window.location.pathname.endsWith('/ai-chart'))";
  const appImport = "void import('/src/App.tsx');";
  const routeImport = "void import('/src/pages/ai-chart.tsx');";
  const headEnd = '</head>';
  const appEntry = '<script type="module" src="/src/main.tsx"></script>';

  expect(html).toContain(prewarmScript);
  expect(html).toContain(routeGuard);
  expect(html).toContain(appImport);
  expect(html).toContain(routeImport);
  expect(html.match(/import\('\/src\/App\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.indexOf(prewarmScript)).toBeLessThan(html.indexOf(routeGuard));
  expect(html.indexOf(routeGuard)).toBeLessThan(html.indexOf(appImport));
  expect(html.indexOf(appImport)).toBeLessThan(html.indexOf(routeImport));
  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(headEnd));
  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(appEntry));
});
