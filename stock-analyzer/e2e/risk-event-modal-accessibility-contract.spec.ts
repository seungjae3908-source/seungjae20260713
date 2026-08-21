import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

test('risk event detail keeps a fail-safe keyboard modal contract', () => {
  const source = fs.readFileSync(
    path.join(analyzerDirectory(), 'src/components/tabs/risk-tab.tsx'),
    'utf8',
  );

  expect(source).toContain('aria-modal="true"');
  expect(source).toContain('aria-labelledby="risk-event-dialog-title"');
  expect(source).toContain("keyboardEvent.key === 'Escape'");
  expect(source).toContain("keyboardEvent.key !== 'Tab'");
  expect(source).toContain('closeButtonRef.current?.focus()');
  expect(source).toContain('if (opener?.isConnected) opener.focus()');
  expect(source).toContain("document.body.style.overflow = 'hidden'");
  expect(source).toContain('min-h-11 min-w-11');
});
