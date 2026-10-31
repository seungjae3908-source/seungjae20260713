// block19-elite.test.mjs
// BLOCK 19 Step 5 — Elite Trader 분석기 유닛 테스트 (네트워크 0건)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  analyzeEliteTrader,
  assertNoOrderAuthority,
  ELITE_ANALYZER_VERSION,
} from '../src/elite-trader-analyzer.mjs';

function trade(over) {
  return {
    id: 'x',
    side: 'long',
    entryMs: 1_700_000_000_000,
    exitMs:  1_700_000_060_000,
    pnl: 10,
    ...over,
  };
}

test('E1: 정상 4건 → 모든 metric available', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 't1', pnl: 10 }),
      trade({ id: 't2', pnl: -5 }),
      trade({ id: 't3', pnl: 20, side: 'short' }),
      trade({ id: 't4', pnl: -3 }),
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.advisoryOnly, true);
  assert.equal(r.sampleSize, 4);
  assert.equal(r.metrics.totalReturnUsdt.available, true);
  assert.equal(r.metrics.totalReturnUsdt.value, 22);
  assert.equal(r.metrics.winRate.value, 50);
  assert.equal(r.metrics.consecutiveLosses.value, 1);
  assert.equal(r.metrics.longShortRatio.value.long, 3);
  assert.equal(r.metrics.longShortRatio.value.short, 1);
});

test('E2: 빈 배열 → sampleSize=0, 모두 unavailable', () => {
  const r = analyzeEliteTrader({ trades: [] });
  assert.equal(r.ok, true);
  assert.equal(r.sampleSize, 0);
  for (const k of Object.keys(r.metrics)) {
    assert.equal(r.metrics[k].available, false, `${k} 는 unavailable`);
  }
});

test('E3: 비객체 입력 → ok:false, INVALID_INPUT', () => {
  const r = analyzeEliteTrader(null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'INVALID_INPUT');
  assert.equal(r.advisoryOnly, true);
});

test('E4: 필드 누락(pnl) → trade skip + warning', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', pnl: 10 }),
      { id: 'b', side: 'long', entryMs: 1, exitMs: 2 }, // pnl 누락
      trade({ id: 'c', pnl: 5 }),
    ],
  });
  assert.equal(r.sampleSize, 2);
  assert.ok(r.warnings.some((w) => w.startsWith('TRADE_SKIP_INVALID_PNL')));
});

test('E5: 시간 역전 감지 → warning + 재정렬', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', entryMs: 100, exitMs: 50, pnl: 1 }),   // 역전
      trade({ id: 'b', entryMs: 200, exitMs: 250, pnl: 2 }),
    ],
  });
  assert.ok(r.warnings.includes('TIME_INVERSION_DETECTED'));
});

test('E6: 중복 tradeId → dedupe + warning', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'dup', pnl: 10 }),
      trade({ id: 'dup', pnl: 10 }),  // 중복
      trade({ id: 'uniq', pnl: 5 }),
    ],
  });
  assert.equal(r.sampleSize, 2);
  assert.ok(r.warnings.some((w) => w.startsWith('TRADE_DUPLICATE_ID')));
});

test('E7: NaN pnl → skip', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', pnl: NaN }),
      trade({ id: 'b', pnl: 10 }),
    ],
  });
  assert.equal(r.sampleSize, 1);
  assert.ok(r.warnings.some((w) => w.startsWith('TRADE_SKIP_INVALID_PNL')));
});

test('E8: advisoryOnly 항상 true (모든 경로)', () => {
  const cases = [
    null,
    {},
    { trades: [] },
    { trades: [trade()] },
    { bad: 1 },
  ];
  for (const c of cases) {
    assert.equal(analyzeEliteTrader(c).advisoryOnly, true);
  }
});

test('E9: 주문 권한 필드 절대 부재 (모든 경로)', () => {
  const cases = [
    null,
    { trades: [] },
    { trades: [trade()] },
  ];
  for (const c of cases) {
    const r = analyzeEliteTrader(c);
    const check = assertNoOrderAuthority(r);
    assert.equal(check.ok, true, `위반: ${check.violations.join(',')}`);
  }
});

test('E10: 데이터 기간 계산', () => {
  const dayMs = 24 * 3600_000;
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', entryMs: 0, exitMs: dayMs, pnl: 1 }),
      trade({ id: 'b', entryMs: dayMs, exitMs: 2 * dayMs, pnl: 2 }),
    ],
  });
  assert.ok(r.dataPeriod);
  assert.equal(r.dataPeriod.startMs, 0);
  assert.equal(r.dataPeriod.endMs, 2 * dayMs);
  assert.equal(r.dataPeriod.spanDays, 2);
  assert.equal(r.metrics.tradeFrequency.value, 1); // 2 trades / 2 days
});

test('E11: 승률 계산 정확성', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', pnl: 1 }),
      trade({ id: 'b', pnl: -1 }),
      trade({ id: 'c', pnl: 1 }),
      trade({ id: 'd', pnl: -1 }),
      trade({ id: 'e', pnl: 1 }),
    ],
  });
  // 3승 2패 = 60%
  assert.equal(r.metrics.winRate.value, 60);
});

test('E12: 최대 연속 손실 계산', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', pnl: -1 }),
      trade({ id: 'b', pnl: -1 }),
      trade({ id: 'c', pnl: -1 }),
      trade({ id: 'd', pnl: 1 }),
      trade({ id: 'e', pnl: -1 }),
    ],
  });
  assert.equal(r.metrics.consecutiveLosses.value, 3);
});

test('E13: 롱숏 비율 계산', () => {
  const r = analyzeEliteTrader({
    trades: [
      trade({ id: 'a', side: 'long', pnl: 1 }),
      trade({ id: 'b', side: 'long', pnl: 1 }),
      trade({ id: 'c', side: 'long', pnl: 1 }),
      trade({ id: 'd', side: 'short', pnl: 1 }),
    ],
  });
  assert.equal(r.metrics.longShortRatio.value.long, 3);
  assert.equal(r.metrics.longShortRatio.value.short, 1);
  assert.equal(r.metrics.longShortRatio.value.ratio, 3);
});

test('E14: 정적 보증 — fs/fetch/axios import 없음', () => {
  // 상단 import fs 재사용 (require 는 ESM 에 없음)
  const p = '/opt/smart-grid-dev/packages/smart-grid-engine/src/elite-trader-analyzer.mjs';
  const src = fs.readFileSync(p, 'utf8');
  assert.equal(src.includes('from \'node:fs\''), false, 'fs import 금지');
  assert.equal(src.includes('require(\'fs\')'), false);
  assert.equal(/\bfetch\s*\(/.test(src), false, 'fetch 사용 금지');
  assert.equal(/import.*axios/.test(src), false, 'axios import 금지');
  assert.equal(/import.*bitget-private/.test(src), false, 'bitget-private import 금지');
});

test('E15: version 필드 상수 존재', () => {
  assert.equal(typeof ELITE_ANALYZER_VERSION, 'string');
  const r = analyzeEliteTrader({ trades: [] });
  assert.equal(r.version, ELITE_ANALYZER_VERSION);
});
