import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart document starts the existing route import before the app entry', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const routeGuard = "if (window.location.pathname.endsWith('/ai-chart'))";
  const routeImport = "void import('/src/pages/ai-chart.tsx');";
  const appEntry = '<script type="module" src="/src/main.tsx"></script>';

  expect(html).toContain(routeGuard);
  expect(html).toContain(routeImport);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.indexOf(routeGuard)).toBeLessThan(html.indexOf(routeImport));
  expect(html.indexOf(routeImport)).toBeLessThan(html.indexOf(appEntry));
});
