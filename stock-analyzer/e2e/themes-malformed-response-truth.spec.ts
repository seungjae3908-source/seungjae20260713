import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { requireThemesData } from '../src/lib/theme-response';

const validEmpty = {
  market: 'KR' as const,
  themes: [],
};

const validTheme = {
  market: 'KR' as const,
  themes: [
    {
      key: 'semiconductor',
      label: '반도체',
      count: 1,
      stocks: [
        {
          ticker: '005930',
          name: '삼성전자',
          market: 'KR' as const,
          currency: 'KRW' as const,
          price: 85000,
          changePercent: 1.25,
        },
      ],
    },
  ],
};

test('genuine empty theme envelope remains a valid empty success state', () => {
  expect(requireThemesData(validEmpty, 'KR')).toEqual(validEmpty);
});

test('malformed HTTP 200 theme payload fails closed instead of becoming empty success', () => {
  expect(() => requireThemesData({ market: 'KR' }, 'KR')).toThrow('INVALID_THEMES_RESPONSE');
  expect(() => requireThemesData({ market: 'US', themes: [] }, 'KR')).toThrow('INVALID_THEMES_RESPONSE');
});

test('missing or cross-market investment facts fail closed before classification rendering', () => {
  expect(() =>
    requireThemesData(
      {
        ...validTheme,
        themes: [
          {
            ...validTheme.themes[0],
            stocks: [{ ...validTheme.themes[0].stocks[0], changePercent: undefined }],
          },
        ],
      },
      'KR',
    ),
  ).toThrow('INVALID_THEMES_RESPONSE');

  expect(() =>
    requireThemesData(
      {
        ...validTheme,
        themes: [
          {
            ...validTheme.themes[0],
            stocks: [{ ...validTheme.themes[0].stocks[0], market: 'US', currency: 'USD' }],
          },
        ],
      },
      'KR',
    ),
  ).toThrow('INVALID_THEMES_RESPONSE');
});

test('themes page validates transport payload before legitimate empty-state rendering', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/themes.tsx'), 'utf8');
  expect(page).toContain('requireThemesData(await api.themes(market), market)');
  expect(page).toContain('themesQuery.isError');
  expect(page).toContain('themesQuery.data && themes.length === 0');
  expect(page).not.toContain('(stock.changePercent ?? 0) >= 0');
});
