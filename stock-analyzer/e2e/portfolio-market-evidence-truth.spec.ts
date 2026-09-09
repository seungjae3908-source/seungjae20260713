import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const portfolioPath = fileURLToPath(new URL('../src/pages/portfolio.tsx', import.meta.url));
const overlayPath = fileURLToPath(new URL('../src/lib/portfolio-overlay.ts', import.meta.url));
const truthPath = fileURLToPath(new URL('../src/lib/portfolio-market-truth.ts', import.meta.url));

test('missing portfolio quote evidence fails closed before average-price fallback can render', async () => {
  const [portfolio, overlay, truth] = await Promise.all([
    readFile(portfolioPath, 'utf8'),
    readFile(overlayPath, 'utf8'),
    readFile(truthPath, 'utf8'),
  ]);

  // The existing unsafe projection is deliberately detected until PortfolioPage can
  // remove it directly; the overlay seam must fail before the load is committed.
  expect(portfolio).toContain('row.currentPrice ??');
  expect(portfolio).toContain('row.average_price;');
  expect(portfolio).toContain('syncPortfolioChartOverlays(enrichedRows);');
  expect(portfolio).toContain('setRows([]);');

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
