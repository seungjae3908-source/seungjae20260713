import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSectorPopularData } from './market-overview-response';

const NOW = Date.parse('2026-09-09T08:00:00.000Z');

const row = {
  rank: 1,
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  price: 72000,
  changePercent: 1.25,
  tradingValue: 1_000_000,
  volume: 12_000,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    market: 'KR',
    sortBasis: '거래대금 기준',
    sectors: [
      { key: 'semiconductor', label: '반도체', rows: [row] },
      { key: 'auto', label: '자동차', rows: [] },
    ],
    updatedAt: '2026-09-09T07:59:30.000Z',
    ...overrides,
  };
}

test('sector popular preserves partial empty sectors when live evidence exists', () => {
  const parsed = requireSectorPopularData(payload(), 'KR', NOW);
  assert.equal(parsed.sectors[0].rows[0].ticker, '005930');
  assert.equal(parsed.sectors[1].rows.length, 0);
});

test('sector popular rejects safe-looking HTTP 200 with no ranking evidence', () => {
  assert.throws(
    () => requireSectorPopularData(payload({
      sectors: [
        { key: 'semiconductor', label: '반도체', rows: [] },
        { key: 'auto', label: '자동차', rows: [] },
      ],
    }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
  assert.throws(
    () => requireSectorPopularData(payload({ sectors: [] }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
});

test('sector popular rejects missing, stale, and future updatedAt evidence', () => {
  assert.throws(
    () => requireSectorPopularData(payload({ updatedAt: undefined }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
  assert.throws(
    () => requireSectorPopularData(payload({ updatedAt: '2026-09-09T07:57:00.000Z' }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
  assert.throws(
    () => requireSectorPopularData(payload({ updatedAt: '2026-09-09T08:00:06.000Z' }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
});

test('sector popular rejects row identity and evidence drift', () => {
  assert.throws(
    () => requireSectorPopularData(payload({
      sectors: [{ key: 'semiconductor', label: '반도체', rows: [{ ...row, market: 'US' }] }],
    }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
  assert.throws(
    () => requireSectorPopularData(payload({
      sectors: [{ key: 'semiconductor', label: '반도체', rows: [{ ...row, price: 0 }] }],
    }), 'KR', NOW),
    /INVALID_SECTOR_POPULAR_RESPONSE/,
  );
});
