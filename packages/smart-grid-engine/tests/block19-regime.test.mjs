// block19-regime.test.mjs
// BLOCK 19 Step 1 — 시장 국면 분류기 테스트 (테스트 1~5)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegime,
  allowsNewEntry,
  REGIME,
  REGIME_DEFAULTS,
} from '../src/market-regime-classifier.mjs';

const NOW = 1_700_000_000_000;

function makeCandles(n = 50) {
  return Array.from({ length: n }, (_, i) => ({
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 1000 + i * 10,
  }));
}

function baseInput(overrides = {}) {
  return {
    nowMs: NOW,
    lastUpdateMs: NOW - 1_000,
    candles: makeCandles(),
    atr: 0.5,
    adx: 15,
    rsi: 50,
    macdHistogram: 0,
    bbWidth: 0.02,
    vwap: 100,
    currentPrice: 100,
    ...overrides,
  };
}

// ── 테스트 1: 상승장 감지 ─────────────────────────
test('T1: STRONG_UPTREND 감지', () => {
  const r = classifyRegime(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  }));
  assert.equal(r.regime, REGIME.STRONG_UPTREND);
  assert.equal(r.failClosed, false);
  assert.equal(r.allowNewEntry, true);
  assert.ok(r.confidence >= 0.7, `confidence=${r.confidence} should be >= 0.7`);
  assert.ok(r.reasons.length >= 3, `reasons=${r.reasons.length}`);
});

test('T1b: 강한 상승 추세 (ADX >= 40) confidence=0.9', () => {
  const r = classifyRegime(baseInput({
    adx: 45, rsi: 65, macdHistogram: 0.8, vwap: 97, currentPrice: 100,
  }));
  assert.equal(r.regime, REGIME.STRONG_UPTREND);
  assert.equal(r.confidence, 0.9);
});

// ── 테스트 2: 하락장 감지 ─────────────────────────
test('T2: STRONG_DOWNTREND 감지', () => {
  const r = classifyRegime(baseInput({
    adx: 35, rsi: 35, macdHistogram: -0.5, vwap: 102, currentPrice: 100,
  }));
  assert.equal(r.regime, REGIME.STRONG_DOWNTREND);
  assert.equal(r.failClosed, false);
  assert.equal(r.allowNewEntry, true);
  assert.ok(r.confidence >= 0.7);
  assert.ok(r.reasons.length >= 3);
});

// ── 테스트 3: 횡보장 감지 ─────────────────────────
test('T3: SIDEWAYS 감지', () => {
  const r = classifyRegime(baseInput({
    adx: 15, rsi: 50, macdHistogram: 0.01, vwap: 100, currentPrice: 100,
  }));
  assert.equal(r.regime, REGIME.SIDEWAYS);
  assert.equal(r.failClosed, false);
  assert.equal(r.allowNewEntry, true);
  assert.ok(r.reasons.length >= 1);
});

// ── 테스트 4: 급변동 → 신규 진입 차단 ─────────────
test('T4: HIGH_VOLATILITY (bbWidth 기준) — 신규 진입 차단', () => {
  const r = classifyRegime(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
    bbWidth: 0.08,        // 8% > 6%
    atr: 0.5,             // atrPct = 0.5% (낮음)
  }));
  assert.equal(r.regime, REGIME.HIGH_VOLATILITY);
  assert.equal(r.failClosed, false);
  assert.equal(r.allowNewEntry, false, 'HIGH_VOL 은 신규 진입 차단해야 함');
  assert.ok(r.reasons.some(s => s.includes('bbWidth')));
});

test('T4b: HIGH_VOLATILITY (atrPct 기준) — 신규 진입 차단', () => {
  const r = classifyRegime(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
    bbWidth: 0.02,
    atr: 5,               // atrPct = 5% > 4%
  }));
  assert.equal(r.regime, REGIME.HIGH_VOLATILITY);
  assert.equal(r.allowNewEntry, false);
  assert.ok(r.reasons.some(s => s.includes('atrPct')));
});

test('T4c: HIGH_VOL 은 UPTREND 신호보다 우선한다', () => {
  const r = classifyRegime(baseInput({
    adx: 50, rsi: 70, macdHistogram: 1.0, vwap: 95, currentPrice: 100,
    bbWidth: 0.10, atr: 5,  // 둘 다 고변동
  }));
  assert.equal(r.regime, REGIME.HIGH_VOLATILITY, '고변동이 추세보다 우선');
  assert.equal(r.allowNewEntry, false);
});

// ── 테스트 5: FAIL_CLOSED ─────────────────────────
test('T5a: FAIL_CLOSED — 데이터 오래됨', () => {
  const r = classifyRegime(baseInput({
    lastUpdateMs: NOW - 5 * 60_000,
  }));
  assert.equal(r.regime, REGIME.FAIL_CLOSED);
  assert.equal(r.failClosed, true);
  assert.equal(r.allowNewEntry, false);
  assert.ok(r.reasons.includes('STALE_DATA'));
});

test('T5b: FAIL_CLOSED — 캔들 부족', () => {
  const r = classifyRegime(baseInput({ candles: makeCandles(5) }));
  assert.equal(r.regime, REGIME.FAIL_CLOSED);
  assert.equal(r.allowNewEntry, false);
  assert.ok(r.reasons.includes('INSUFFICIENT_CANDLES'));
});

test('T5c: FAIL_CLOSED — 필수 지표 누락', () => {
  for (const missing of ['atr', 'adx', 'rsi', 'macdHistogram', 'bbWidth', 'vwap', 'currentPrice']) {
    const r = classifyRegime(baseInput({ [missing]: undefined }));
    assert.equal(r.regime, REGIME.FAIL_CLOSED, `missing=${missing}`);
    assert.equal(r.failClosed, true);
    assert.ok(
      r.reasons[0].includes(missing),
      `reason=${r.reasons[0]} should include ${missing}`,
    );
  }
});

test('T5d: FAIL_CLOSED — NaN 지표', () => {
  const r = classifyRegime(baseInput({ rsi: NaN }));
  assert.equal(r.regime, REGIME.FAIL_CLOSED);
  assert.equal(r.allowNewEntry, false);
});

test('T5e: FAIL_CLOSED — 의미 오류 (RSI>100)', () => {
  const r = classifyRegime(baseInput({ rsi: 150 }));
  assert.equal(r.regime, REGIME.FAIL_CLOSED);
  assert.ok(r.reasons.includes('INVALID_RSI'));
});

test('T5f: FAIL_CLOSED — lastUpdateMs 누락', () => {
  const r = classifyRegime(baseInput({ lastUpdateMs: undefined }));
  assert.equal(r.regime, REGIME.FAIL_CLOSED);
  assert.equal(r.allowNewEntry, false);
});

// ── 보조: allowsNewEntry 간편 API ─────────────────
test('allowsNewEntry: 정상 상승장이면 true', () => {
  assert.equal(allowsNewEntry(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  })), true);
});

test('allowsNewEntry: FAIL_CLOSED면 false', () => {
  assert.equal(allowsNewEntry(baseInput({
    lastUpdateMs: NOW - 5 * 60_000,
  })), false);
});

test('allowsNewEntry: HIGH_VOL이면 false', () => {
  assert.equal(allowsNewEntry(baseInput({
    bbWidth: 0.10, atr: 5, adx: 50, rsi: 70, macdHistogram: 1, vwap: 95,
  })), false);
});

// ── 보조: 커스텀 임계값 override ──────────────────
test('opts: bbWidthHigh 임계값 override', () => {
  const input = baseInput({
    bbWidth: 0.05,   // 기본(0.06)이면 통과
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
    atr: 0.5,
  });
  const normal = classifyRegime(input);
  assert.equal(normal.regime, REGIME.STRONG_UPTREND, '기본 0.06 임계값 통과');

  const strict = classifyRegime(input, { bbWidthHigh: 0.03 });
  assert.equal(strict.regime, REGIME.HIGH_VOLATILITY, 'strict 0.03 임계값 초과');
});

// ── 보조: DEFAULTS frozen ─────────────────────────
test('REGIME_DEFAULTS frozen', () => {
  assert.equal(Object.isFrozen(REGIME_DEFAULTS), true);
  assert.throws(() => {
    'use strict';
    REGIME_DEFAULTS.bbWidthHigh = 999;
  });
});
