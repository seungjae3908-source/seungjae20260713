import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkTrendPilotPromotion, checkTrendPilotPromotionRecord, signTrendPilotPromotion, TREND_PILOT_PROMOTION_SCHEMA,
  type TrendPilotPromotionRecord,
} from './trend-pilot-v1-promotion.service';

const KEY = 'p'.repeat(40);
const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const ID = 'TREND_PILOT_BTC_ETH_4H_V1';

function record(over: Partial<TrendPilotPromotionRecord> = {}): TrendPilotPromotionRecord {
  const { signature: _ignored, ...base } = {
    schemaVersion: TREND_PILOT_PROMOTION_SCHEMA, strategyId: ID, source: 'PAPER', afterCosts: true,
    closedTrades: 30, distinctSymbols: 3, winRate: 0.6, meanReturnPercent: 0.5, lowerBound95Percent: 0.01,
    issuedAtMs: NOW - 3_600_000, expiresAtMs: NOW + 86_400_000, signature: '', ...over,
  } as TrendPilotPromotionRecord;
  return signTrendPilotPromotion(base, KEY);
}
const env = (extra: Record<string, string> = {}) => ({ TREND_PILOT_PROMOTION_KEY: KEY, TREND_PILOT_PROMOTION_RECORD_PATH: '/x/records.json', ...extra }) as NodeJS.ProcessEnv;
const files = (rows: unknown[]) => () => JSON.stringify({ records: rows });

test('exact owner thresholds pass (30 trades, 3 symbols, 60% wins, lower bound > 0)', () => {
  assert.deepEqual(checkTrendPilotPromotionRecord(record(), ID, NOW, KEY), { ok: true });
});

test('each threshold fails closed one by one', () => {
  for (const [over, code] of [
    [{ closedTrades: 29 }, 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET'],
    [{ distinctSymbols: 2 }, 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET'],
    [{ winRate: 0.59 }, 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET'],
    [{ lowerBound95Percent: 0 }, 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET'],
    [{ lowerBound95Percent: -0.2 }, 'TREND_PILOT_PROMOTION_CRITERIA_NOT_MET'],
    [{ expiresAtMs: NOW - 1 }, 'TREND_PILOT_PROMOTION_EXPIRED'],
    [{ issuedAtMs: NOW - 31 * 86_400_000, expiresAtMs: NOW + 86_400_000 }, 'TREND_PILOT_PROMOTION_EXPIRED'],
    [{ issuedAtMs: NOW + 3_600_000 }, 'TREND_PILOT_PROMOTION_INVALID'],
    [{ winRate: Number.NaN }, 'TREND_PILOT_PROMOTION_INVALID'],
  ] as Array<[Partial<TrendPilotPromotionRecord>, string]>) {
    assert.deepEqual(checkTrendPilotPromotionRecord(record(over), ID, NOW, KEY), { ok: false, code }, JSON.stringify(over));
  }
});

test('tampered, wrongly signed, wrong strategy or non-paper records are invalid', () => {
  const good = record();
  assert.equal(checkTrendPilotPromotionRecord({ ...good, closedTrades: 99 }, ID, NOW, KEY).ok, false);
  assert.equal(checkTrendPilotPromotionRecord(good, ID, NOW, 'q'.repeat(40)).ok, false);
  assert.equal(checkTrendPilotPromotionRecord(good, 'OTHER', NOW, KEY).ok, false);
  assert.equal(checkTrendPilotPromotionRecord({ ...good, source: 'BACKTEST' }, ID, NOW, KEY).ok, false);
  assert.equal(checkTrendPilotPromotionRecord({ ...good, afterCosts: false }, ID, NOW, KEY).ok, false);
  assert.equal(checkTrendPilotPromotionRecord(null, ID, NOW, KEY).ok, false);
  assert.equal(checkTrendPilotPromotionRecord([good], ID, NOW, KEY).ok, false);
});

test('file gate: missing key, path, file, strategy record or malformed json all deny', () => {
  const good = record();
  assert.deepEqual(checkTrendPilotPromotion(ID, NOW, env(), files([good])), { ok: true });
  assert.equal(checkTrendPilotPromotion(ID, NOW, { TREND_PILOT_PROMOTION_RECORD_PATH: '/x' } as NodeJS.ProcessEnv, files([good])).ok, false);
  assert.equal(checkTrendPilotPromotion(ID, NOW, { TREND_PILOT_PROMOTION_KEY: KEY } as NodeJS.ProcessEnv, files([good])).ok, false);
  assert.equal(checkTrendPilotPromotion(ID, NOW, env({ TREND_PILOT_PROMOTION_KEY: 'short' }), files([good])).ok, false);
  assert.deepEqual(checkTrendPilotPromotion('MISSING', NOW, env(), files([good])), { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' });
  assert.deepEqual(checkTrendPilotPromotion(ID, NOW, env(), () => { throw new Error('ENOENT'); }), { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' });
  assert.deepEqual(checkTrendPilotPromotion(ID, NOW, env(), () => 'not json'), { ok: false, code: 'TREND_PILOT_PROMOTION_REQUIRED' });
  assert.deepEqual(checkTrendPilotPromotion(ID, NOW, env(), () => JSON.stringify({ nope: 1 })), { ok: false, code: 'TREND_PILOT_PROMOTION_INVALID' });
});

test('signing refuses a short key', () => {
  assert.throws(() => signTrendPilotPromotion({ ...record(), signature: undefined } as never, 'short'), /TREND_PILOT_PROMOTION_KEY_REQUIRED/);
});
