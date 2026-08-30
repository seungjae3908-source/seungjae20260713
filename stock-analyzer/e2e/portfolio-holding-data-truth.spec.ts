import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePortfolioHoldingRows } from '../src/lib/portfolio-holding-truth';

const VALID_ROW = {
  id: 'holding-1',
  ticker: '005930',
  market: 'KR',
  currency: 'KRW',
  quantity: 10,
  average_price: 78000,
} as const;

test('portfolio holding truth accepts explicit finite positive numeric facts', () => {
  expect(validatePortfolioHoldingRows([VALID_ROW])).toEqual({ ok: true });
  expect(validatePortfolioHoldingRows([{
    ...VALID_ROW,
    id: 'holding-us',
    ticker: 'AAPL',
    market: 'US',
    currency: 'USD',
    quantity: '2.5',
    average_price: '240.10',
  }])).toEqual({ ok: true });
});

test('portfolio holding truth never converts missing or invalid quantity to zero', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 'not-a-number' }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 0 }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
});

test('portfolio holding truth rejects missing or impossible average price', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: null }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: -1 }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
});

test('portfolio holding truth rejects guessed market or currency identity', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_MARKET',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: 'US', currency: 'KRW' }])).toEqual({
    ok: false,
    code: 'INVALID_CURRENCY',
    rowIndex: 0,
  });
});

test('Supabase boundary validates only canonical full-row portfolio reads', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("method !== 'GET'");
  expect(source).toContain("'/rest/v1/portfolio_holdings'");
  expect(source).toContain("parsed.searchParams.get('select') === '*'");
  expect(source).toContain('validatePortfolioHoldingRows(payload)');
  expect(source).toContain('PORTFOLIO_HOLDING_DATA_INVALID');
  expect(source).toContain('status: 422');
});

test('partial portfolio selects remain outside the full-row truth guard', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("if (parsed?.pathname.replace(/\\/+$/u, '') !== '/rest/v1/portfolio_holdings') return false;");
  expect(source).toContain("return parsed.searchParams.get('select') === '*';");
  expect(source).not.toContain("return parsed?.pathname.replace(/\\/+$/u, '') === '/rest/v1/portfolio_holdings';");
});

test('portfolio holdings UI never presents load failure as zero-valued portfolio facts', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/portfolio.tsx'), 'utf8');
  expect(source).toContain('holdingLoadFailed');
  expect(source).toContain('setHoldingLoadFailed(true)');
  expect(source).toContain('data-testid="portfolio-holdings-summary"');
  expect(source).toContain('!loading &&');
  expect(source).toContain('!holdingLoadFailed &&');
  expect(source).toContain('disabled={loading || holdingLoadFailed}');
});
