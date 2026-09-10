import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('scanner mobile detail sheet overrides translucent card alpha with raw theme colors', () => {
  const css = source('src/index.css');
  const settings = source('src/lib/settings.tsx');
  const scanner = source('src/pages/signal-scanner.tsx');

  expect(settings).toContain("root.style.setProperty('--card-alpha', '0.72')");
  expect(scanner).toContain('data-testid="scanner-mobile-sheet"');

  const start = css.lastIndexOf("[data-testid='scanner-mobile-sheet'] {");
  expect(start).toBeGreaterThan(-1);
  const rule = css.slice(start, css.indexOf('}', start) + 1);

  expect(rule).toContain('background-color: hsl(var(--card));');
  expect(rule).toContain('border-color: hsl(var(--card-border));');
  expect(rule).toContain('color: hsl(var(--card-foreground));');
  expect(rule).not.toContain('--card-alpha');
});
