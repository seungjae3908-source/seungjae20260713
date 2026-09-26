import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prioritizes the route request without adding document-level route competition', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const main = fs
    .readFileSync(path.resolve(process.cwd(), 'src/main.tsx'), 'utf8')
    .replace(/\r\n?/g, '\n');

  const appEntry = '<script type="module" src="/src/main.tsx"></script>';
  const appImport = "import('./App')";
  const routeImport = "import('@/pages/ai-chart')";

  expect(html.match(/<script\s+type="module"\s+src="\/src\/main\.tsx"><\/script>/g)).toHaveLength(1);
  expect(html).toContain(appEntry);
  expect(html).not.toMatch(/pages\/ai-chart/);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
  expect(main.match(/import\('\.\/App'\)/g)).toHaveLength(1);
  expect(main.match(/import\('@\/pages\/ai-chart'\)/g)).toHaveLength(1);
  expect(main.indexOf(routeImport)).toBeLessThan(main.indexOf(appImport));
  expect(main).not.toMatch(/setTimeout\([^)]*(?:App|ai-chart)/s);
});
