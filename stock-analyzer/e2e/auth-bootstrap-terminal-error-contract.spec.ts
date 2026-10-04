import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('auth bootstrap failure exits loading through the terminal retry ErrorState', () => {
  const app = source('src/App.tsx');
  const dataState = source('src/components/data-state.tsx');

  expect(app).toContain(
    'if (auth.bootstrapError) return <ErrorState message={auth.bootstrapError} onRetry={auth.retryBootstrap} />;',
  );
  expect(app).not.toContain(
    'if (auth.bootstrapError) return <Suspense fallback={<PageFallback />}><AccountPage /></Suspense>;',
  );

  expect(dataState).toContain('data-testid="error-state"');
  expect(dataState).toContain('onClick={onRetry}');
  expect(dataState).toContain('다시 시도');
});
