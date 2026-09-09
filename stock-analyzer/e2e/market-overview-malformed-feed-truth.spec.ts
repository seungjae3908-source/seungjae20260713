import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { requireBriefing, requireSectorPopularData } from '../src/lib/market-overview-response';

const sectorNowMs = Date.parse('2026-09-08T16:02:00.000Z');
const partialSectors = {
  market: 'KR' as const,
  sortBasis: '거래대금 기준',
  updatedAt: new Date(sectorNowMs).toISOString(),
  sectors: [
    { key: 'semiconductor', label: '반도체', rows: [] },
    {
      key: 'electronics',
      label: '전자',
      rows: [
        {
          rank: 1,
          ticker: '005930',
          name: '삼성전자',
          market: 'KR' as const,
          currency: 'KRW' as const,
          price: 70000,
          changePercent: 1.2,
        },
      ],
    },
  ],
};
const allEmptySectors = {
  ...partialSectors,
  sectors: partialSectors.sectors.map((sector) => ({ ...sector, rows: [] })),
};

const briefingAsOf = '2026-09-08T16:00:00.000Z';
const briefingNowMs = Date.parse('2026-09-08T16:02:00.000Z');
const briefing = {
  asOf: briefingAsOf,
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

test('partial empty sector groups remain valid when at least one ranking row is evidenced', () => {
  expect(requireSectorPopularData(partialSectors, 'KR', sectorNowMs)).toEqual(partialSectors);
});

test('malformed sector HTTP 200 cannot become safe-looking empty sector state', () => {
  expect(() => requireSectorPopularData({ market: 'KR', sortBasis: '거래대금 기준' }, 'KR', sectorNowMs)).toThrow('INVALID_SECTOR_POPULAR_RESPONSE');
  expect(() => requireSectorPopularData({ ...partialSectors, market: 'US' }, 'KR', sectorNowMs)).toThrow('INVALID_SECTOR_POPULAR_RESPONSE');
  expect(() => requireSectorPopularData(allEmptySectors, 'KR', sectorNowMs)).toThrow('INVALID_SECTOR_POPULAR_RESPONSE');
});

test('malformed briefing HTTP 200 fails closed before headline/lines rendering', () => {
  expect(requireBriefing(briefing, briefingNowMs)).toEqual(briefing);
  expect(() => requireBriefing({ ...briefing, lines: undefined }, briefingNowMs)).toThrow('INVALID_BRIEFING_RESPONSE');
  expect(() => requireBriefing({ ...briefing, asOf: 'not-a-time' }, briefingNowMs)).toThrow('INVALID_BRIEFING_RESPONSE');
});

test('stale or future briefing HTTP 200 fails closed instead of looking current', () => {
  expect(() =>
    requireBriefing(
      { ...briefing, asOf: new Date(briefingNowMs - 5 * 60 * 1000 - 1).toISOString() },
      briefingNowMs,
    ),
  ).toThrow('INVALID_BRIEFING_RESPONSE');
  expect(() =>
    requireBriefing(
      { ...briefing, asOf: new Date(briefingNowMs + 5 * 1000 + 1).toISOString() },
      briefingNowMs,
    ),
  ).toThrow('INVALID_BRIEFING_RESPONSE');
});

test('market overview validates sector and briefing feeds before empty/content rendering', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/market-overview.tsx'), 'utf8');
  expect(page).toContain('requireSectorPopularData(await api.sectorPopular(market), market)');
  expect(page).toContain('requireBriefing(await api.briefing())');
  expect(page).toContain('sectors.isError');
  expect(page).toContain('topSectors.length === 0');
  expect(page).toContain('briefing.isError');
});
