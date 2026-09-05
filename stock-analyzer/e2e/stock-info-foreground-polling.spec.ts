import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('stock and coin special feeds stop interval polling while the app is backgrounded', () => {
  const stockInfo = source('src/pages/stock-info.tsx');

  expect(stockInfo).not.toContain('refetchIntervalInBackground: true');
  expect(stockInfo.match(/refetchIntervalInBackground: false/g) ?? []).toHaveLength(2);
});

test('special-feed transports are owned by the React Query abort signal', () => {
  const stockInfo = source('src/pages/stock-info.tsx');

  expect(stockInfo.match(/queryFn: async \(\{ signal \}\)/g) ?? []).toHaveLength(2);
  expect(stockInfo.match(/\{ cache: 'no-store', signal \}/g) ?? []).toHaveLength(2);
  expect(stockInfo).toContain("queryKey: ['stock-info-special-feed', market]");
  expect(stockInfo).toContain("queryKey: ['coin-info-special-feed', coinMarket]");
});
