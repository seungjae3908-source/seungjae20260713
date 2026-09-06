import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const indexHtmlPath = fileURLToPath(new URL('../index.html', import.meta.url));

function mainEntryTag(html: string): string | null {
  return html.match(/<script\b[^>]*\bsrc=["']\/src\/main\.tsx["'][^>]*><\/script>/i)?.[0] ?? null;
}

test('production React entry cannot outrun the parsed root container', () => {
  const html = readFileSync(indexHtmlPath, 'utf8');
  const rootOffset = html.indexOf('id="root"');
  const entryTag = mainEntryTag(html);

  expect(rootOffset, 'index.html must own the canonical React root').toBeGreaterThanOrEqual(0);
  expect(entryTag, 'index.html must include the canonical /src/main.tsx module entry').not.toBeNull();
  expect(entryTag, 'the app entry must keep native module defer semantics; async can execute before #root after Vite moves the production entry into <head>').not.toMatch(/\sasync(?:\s|=|>)/i);
  expect(html.indexOf(entryTag!), 'source HTML must also place the app entry after #root').toBeGreaterThan(rootOffset);
});
