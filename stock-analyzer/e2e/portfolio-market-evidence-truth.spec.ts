import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parsePortfolioQuoteSnapshot } from '../src/lib/portfolio-market-truth';

const portfolioPath = fileURLToPath(new URL('../src/pages/portfolio.tsx', import.meta.url));
const overlayPath = fileURLToPath(new URL('../src/lib/portfolio-overlay.ts', import.meta.url));
const truthPath = fileURLToPath(new URL('../src/lib/portfolio-market-truth.ts', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/market.ts', import.meta.url));
const now = Date.parse('2026-09-10T00:00:00.000Z');

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    quotes: [{ ticker: '005930', price: 72_000, changePercent: 1.2 }],
    requested: 1,
    available: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

test('portfolio quote runtime contract rejects malformed stale future and count-drift HTTP 200', () => {
  expect(parsePortfolioQuoteSnapshot(envelope(), ['005930'], now).complete).toBe(true);
  expect(() => parsePortfolioQuoteSnapshot({}, ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(envelope({ requested: 2 }), ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(envelope({ available: 0 }), ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ updatedAt: '2026-09-09T23:57:59.000Z' }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ updatedAt: '2026-09-10T00:00:06.000Z' }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
});

test('portfolio quote truth is enforced at authenticated transport before average-price fallback can render', async () => {
  const [portfolio, overlay, truth, authFetch, backend] = await Promise.all([
    readFile(portfolioPath, 'utf8'),
    readFile(overlayPath, 'utf8'),
    readFile(truthPath, 'utf8'),
    readFile(authFetchPath, 'utf8'),
    readFile(backendPath, 'utf8'),
  ]);

  // The legacy projection is still present, so both transport and overlay seams
  // must fail closed before missing or malformed market evidence can reach it.
  expect(portfolio).toContain('row.currentPrice ??');
  expect(portfolio).toContain('row.average_price;');
  expect(portfolio).toContain('syncPortfolioChartOverlays(enrichedRows);');
  expect(portfolio).toContain('setRows([]);');

  expect(authFetch).toContain("import { parsePortfolioQuoteSnapshot } from '@/lib/portfolio-market-truth';");
  expect(authFetch).toContain("path === '/api/quotes' && method === 'GET'");
  expect(authFetch).toContain('portfolioRequestedTickers(input)');
  expect(authFetch).toContain("throw new Error('INVALID_PORTFOLIO_QUOTE_RESPONSE')");
  expect(backend).toContain("router.get('/quotes'");
  expect(backend).toContain('requested: tickers.length');
  expect(backend).toContain('updatedAt: new Date().toISOString()');

  expect(overlay).toContain("import { assertPortfolioMarketEvidence } from './portfolio-market-truth';");
  expect(overlay).toContain('assertPortfolioMarketEvidence(');
  expect(truth).toContain("PORTFOLIO_MARKET_EVIDENCE_MISSING");
  expect(truth).toContain('!isFiniteNumber(row.currentPrice) || row.currentPrice <= 0');

  const setRows = portfolio.indexOf('setRows(enrichedRows);');
  const sync = portfolio.indexOf('syncPortfolioChartOverlays(enrichedRows);');
  const outerFailClosed = portfolio.indexOf('setRows([]);', sync);
  expect(setRows).toBeGreaterThanOrEqual(0);
  expect(sync).toBeGreaterThan(setRows);
  expect(outerFailClosed).toBeGreaterThan(sync);
});
