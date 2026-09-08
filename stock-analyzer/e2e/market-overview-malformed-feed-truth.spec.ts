import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { requireBriefing, requireSectorPopularData } from '../src/lib/market-overview-response';

const emptySectors = {
  market: 'KR' as const,
  sortBasis: '거래대금 기준',
  sectors: [],
};

const briefing = {
  asOf: '2026-09-08T16:00:00.000Z',
  mood: 'neutral' as const,
  headline: '근거 확인 중',
  lines: [],
  strongSectors: [],
  weakSectors: [],
  positiveNews: [],
  negativeNews: [],
  disclosureRisks: [],
  gainers: [],
  losers: [],
  picks: [],
};

test('genuine empty sector success remains valid', () => {
  expect(requireSectorPopularData(emptySectors, 'KR')).toEqual(emptySectors);
});

test('malformed sector HTTP 200 cannot become safe-looking empty sector state', () => {
  expect(() => requireSectorPopularData({ market: 'KR', sortBasis: '거래대금 기준' }, 'KR')).toThrow('INVALID_SECTOR_POPULAR_RESPONSE');
  expect(() => requireSectorPopularData({ ...emptySectors, market: 'US' }, 'KR')).toThrow('INVALID_SECTOR_POPULAR_RESPONSE');
});

test('malformed briefing HTTP 200 fails closed before headline/lines rendering', () => {
  expect(requireBriefing(briefing)).toEqual(briefing);
  expect(() => requireBriefing({ ...briefing, lines: undefined })).toThrow('INVALID_BRIEFING_RESPONSE');
  expect(() => requireBriefing({ ...briefing, asOf: 'not-a-time' })).toThrow('INVALID_BRIEFING_RESPONSE');
});

test('market overview validates sector and briefing feeds before empty/content rendering', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/market-overview.tsx'), 'utf8');
  expect(page).toContain('requireSectorPopularData(await api.sectorPopular(market), market)');
  expect(page).toContain('requireBriefing(await api.briefing())');
  expect(page).toContain('sectors.isError');
  expect(page).toContain('topSectors.length === 0');
  expect(page).toContain('briefing.isError');
});
