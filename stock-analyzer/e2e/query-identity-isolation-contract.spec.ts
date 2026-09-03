import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const hookPath = fileURLToPath(new URL('../src/hooks/use-stock-data.ts', import.meta.url));

async function hookSource() {
  return readFile(hookPath, 'utf8');
}

test.describe('query identity isolation contract', () => {
  test('does not carry previous query data into a different market or symbol identity', async () => {
    const source = await hookSource();

    expect(source).not.toContain('keepPreviousData');
    expect(source).not.toContain('placeholderData:');
  });

  test('identity-sensitive query keys retain their market, symbol, or timeframe dimensions', async () => {
    const source = await hookSource();

    for (const contract of [
      "queryKey: ['search', q]",
      "queryKey: ['movers', market ?? 'default']",
      "queryKey: ['alert-feed', market]",
      "queryKey: ['quotes', tickers.join(',')]",
      "queryKey: ['chart', ticker, tf]",
      "queryKey: ['financials', ticker]",
      "queryKey: ['risk', ticker]",
      "queryKey: ['disclosures', ticker]",
      "queryKey: ['signals', ticker]",
      "queryKey: ['news', ticker]",
      "queryKey: ['analysis', ticker]",
    ]) {
      expect(source).toContain(contract);
    }
  });
});
