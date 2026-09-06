import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(
  new URL('../src/components/brokerage-account-connections.tsx', import.meta.url),
  'utf8',
);

test('read-only account provider requests are aborted when the consumer unmounts', () => {
  expect(source).toContain('const controllerRef = useRef<AbortController | null>(null);');
  expect(source).toContain("jsonRequest<CanonicalAccountSnapshot>(`/api/accounts/read-only/${provider}`, { signal: controller.signal })");

  const cleanupMatch = source.match(
    /return \(\) => \{([\s\S]*?)document\.removeEventListener\('visibilitychange', onVisibility\);/,
  );
  expect(cleanupMatch, 'account connection cleanup block must exist').not.toBeNull();

  const cleanup = cleanupMatch?.[1] ?? '';
  const abortIndex = cleanup.indexOf('controllerRef.current?.abort();');
  const clearIndex = cleanup.indexOf('controllerRef.current = null;');

  expect(abortIndex).toBeGreaterThanOrEqual(0);
  expect(clearIndex).toBeGreaterThan(abortIndex);
  expect(cleanup).toContain('requestSequence.current += 1;');
});
