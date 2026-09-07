import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const indexHtmlPath = fileURLToPath(new URL('../index.html', import.meta.url));

test('production React entry cannot outrun the parsed root container', () => {
  const html = readFileSync(indexHtmlPath, 'utf8');
  const rootOffset = html.indexOf('id="root"');
  const entryOffset = html.indexOf("import('/src/main.tsx')");
  const moduleScript = html.match(/<script\b[^>]*\btype=["']module["'][^>]*>/i)?.[0] ?? null;

  expect(rootOffset, 'index.html must own the canonical React root').toBeGreaterThanOrEqual(0);
  expect(entryOffset, 'index.html must import the canonical /src/main.tsx module entry').toBeGreaterThanOrEqual(0);
  expect(moduleScript, 'index.html must retain a native module entry').not.toBeNull();
  expect(moduleScript, 'the app entry must keep native module defer semantics').not.toMatch(/\sasync(?:\s|=|>)/i);
  expect(entryOffset, 'source HTML must start the app only after #root is parsed').toBeGreaterThan(rootOffset);
});
