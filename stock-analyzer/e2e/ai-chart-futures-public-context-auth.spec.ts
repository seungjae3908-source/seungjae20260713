import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('AI Chart Bitget public context uses the authenticated app API transport', () => {
  const panel = source('src/components/futures-public-context-panel.tsx');
  const authFetch = source('src/lib/auth-fetch.ts');

  expect(panel).toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(panel).toContain('const response = await authorizedFetch(`/api/crypto/futures/${encodeURIComponent(normalizedSymbol)}/snapshot`');
  expect(panel).not.toContain('const response = await fetch(`/api/crypto/futures/${encodeURIComponent(normalizedSymbol)}/snapshot`');

  expect(authFetch).toContain("headers.set('Authorization', `Bearer ${token}`)");
  expect(authFetch).toContain('fetch(input, { ...init, headers, signal: controller.signal });');
});

test('futures market status panel does not prefetch protected data without futures capability', () => {
  const panel = source('src/components/futures-market-status-panel.tsx');

  expect(panel).toContain("import { useAuth } from '@/lib/auth';");
  expect(panel).toContain("const canAccessFutures = !auth.loading && auth.isApproved && auth.can('canAccessFutures');");
  expect(panel).toContain('enabled: canAccessFutures,');
  expect(panel).toContain('enabled: canAccessFutures && Boolean(symbol),');
  expect(panel).toContain('if (!canAccessFutures) return;');
  expect(panel).toContain('if (!canAccessFutures) return null;');
});

