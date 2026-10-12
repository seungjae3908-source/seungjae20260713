import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChartLiveEvents, mergeChartLiveEvents, type ChartLiveSnapshot } from './chart-live-feed';
import { buildChartAnalysis } from './chart-analysis';
import type { AutoPattern, WaveCandidate } from './chart-auto-drawing';

const now = 1_791_752_000_000;
const barTime = Math.floor(now / 1000) - 600;
const analysis = buildChartAnalysis({
  symbol: 'AAPL', market: 'US', timeframe: '5m', latestTime: barTime, currentPrice: 105,
  previousClose: 100, trend: '상승', rsi: 60, macd: 1, volumeRatio: 1.4,
  support: 95, resistance: 110, signal: 'WATCH', confidence: 60,
  title: '상승 후보', summary: '완료봉 관측', patterns: [], source: 'TEST_ONLY', isClosedCandle: true,
});
const snapshot = (patch: Partial<ChartLiveSnapshot> = {}): ChartLiveSnapshot => ({
  identity: 'US:AAPL:5m', market: 'US', analysis,
  drawing: { patterns: [], waves: [], swings: [], asOf: barTime },
  price: 105, closedTime: barTime, volumeRatio: 1.4, source: 'TEST_ONLY', status: '정상',
  dataState: 'ok', transport: 'REST 주기 조회', asOf: now - 1000, ...patch,
});

test('initial observation records data and current judgement, never invents a new bar', () => {
  const events = buildChartLiveEvents(null, snapshot(), now);
  assert.deepEqual(events.map(event => event.kind), ['data', 'analysis']);
  assert.ok(events[1].detail.length);
  assert.deepEqual(events[1].confirmation, analysis.confirmationConditions.slice(0, 2));
  assert.ok(events.every(event => event.identity === 'US:AAPL:5m'));
});
test('unchanged snapshots do not repeat commentary', () => {
  assert.deepEqual(buildChartLiveEvents(snapshot(), snapshot(), now), []);
});

test('loading to first valid data establishes a baseline, not a new bar or volume crossing', () => {
  const pending = snapshot({ analysis: null, closedTime: null, volumeRatio: null, asOf: null, dataState: 'insufficient', source: '연결 대기' });
  assert.deepEqual(buildChartLiveEvents(pending, snapshot({ volumeRatio: 2 }), now).map(event => event.kind), ['data', 'analysis']);
});
test('a status or bias transition records reasons and invalidation, not a trade command', () => {
  const next = snapshot({ analysis: { ...analysis, status: 'invalidated', bias: 'bearish', transitionReason: '지지 이탈' } });
  const events = buildChartLiveEvents(snapshot(), next, now);
  assert.equal(events.length, 1);
  assert.match(events[0].title, /무효화/);
  assert.match(events[0].detail, /지지 이탈/);
  assert.deepEqual(events[0].invalidation, analysis.invalidationConditions.slice(0, 2));
});
test('wrong-symbol or timeframe analysis cannot enter the feed', () => {
  for (const patch of [{ symbol: 'TSLA' }, { timeframe: '1D' }, { market: 'KR' }]) {
    assert.equal(buildChartLiveEvents(null, snapshot({ analysis: { ...analysis, ...patch } }), now).filter(event => event.kind === 'analysis').length, 0);
  }
});
test('unavailable and stale snapshots record the stop even without a source timestamp', () => {
  for (const dataState of ['unavailable', 'stale', 'insufficient'] as const) {
    const events = buildChartLiveEvents(snapshot(), snapshot({ dataState, status: '연결 오류', asOf: null, closedTime: barTime + 300 }), now);
    assert.deepEqual(events.map(event => event.kind), ['data']);
    assert.match(events[0].detail, /새 판단 중단/);
    assert.equal(events[0].at, now);
  }
});
test('recovery records the current judgement even if it matches the old cached opinion', () => {
  const prior = snapshot({ dataState: 'unavailable', status: '연결 오류' });
  assert.deepEqual(buildChartLiveEvents(prior, snapshot(), now).map(event => event.kind), ['data', 'analysis']);
});
test('missing, nonfinite or future price timestamps cannot issue opinions', () => {
  for (const asOf of [null, NaN, Infinity, now + 1]) {
    assert.deepEqual(buildChartLiveEvents(null, snapshot({ asOf }), now).map(event => event.kind), ['data']);
  }
});

test('a future source timestamp stops commentary and its correction explicitly restores judgment', () => {
  const invalid = snapshot({ asOf: now + 600_000 });
  const stop = buildChartLiveEvents(snapshot(), invalid, now);
  assert.deepEqual(stop.map(event => event.kind), ['data']);
  assert.match(stop[0].title, /가격 기준 시각 미확인/);
  assert.match(stop[0].detail, /새 판단 중단/);
  assert.deepEqual(buildChartLiveEvents(invalid, snapshot(), now).map(event => event.kind), ['data', 'analysis']);
});
test('closed-bar events require forward progress; historical backfill is not a new bar', () => {
  const previous = snapshot();
  assert.equal(buildChartLiveEvents(previous, snapshot({ closedTime: barTime + 300 }), now)[0].kind, 'bar');
  assert.deepEqual(buildChartLiveEvents(previous, snapshot({ closedTime: barTime - 300 }), now), []);
  assert.deepEqual(buildChartLiveEvents(previous, snapshot({ closedTime: now / 1000 + 300 }), now), []);
});
test('volume commentary occurs at a threshold crossing, not every price update', () => {
  assert.match(buildChartLiveEvents(snapshot(), snapshot({ volumeRatio: 2 }), now)[0].title, /거래량 증가/);
  assert.deepEqual(buildChartLiveEvents(snapshot({ volumeRatio: 2 }), snapshot({ volumeRatio: 3 }), now), []);
});
test('pattern state transitions are retained and future pattern events are rejected', () => {
  const pattern: AutoPattern = { id: 'double', name: '이중바닥', direction: 'up', status: 'candidate',
    detectedAt: barTime, eventAt: barTime, confirmation: 110, invalidation: 95, target: [120, 125], segments: [] };
  const previous = snapshot({ drawing: { patterns: [pattern], waves: [], swings: [], asOf: barTime } });
  const next = snapshot({ drawing: { ...previous.drawing, patterns: [{ ...pattern, status: 'confirmed', eventAt: barTime + 300 }] } });
  assert.match(buildChartLiveEvents(previous, next, now)[0].title, /돌파 확인/);
  assert.equal(buildChartLiveEvents(null, snapshot({ drawing: { ...next.drawing, patterns: [{ ...pattern, eventAt: now / 1000 + 1 }] } }), now).filter(event => event.kind === 'pattern').length, 0);
});
test('ABC extension is recorded even when the impulse wave id stays the same', () => {
  const point = (label: string, offset: number) => ({ label, time: barTime + offset, confirmedAt: barTime + offset, price: 100, index: offset, kind: 'low' as const, confirmed: true });
  const wave: WaveCandidate = { id: 'wave:1', name: '상승 1–5파 후보', points: [point('5', 0)], segments: [] };
  const previous = snapshot({ drawing: { patterns: [], waves: [wave], swings: [], asOf: barTime } });
  const next = snapshot({ drawing: { ...previous.drawing, waves: [{ ...wave, points: [...wave.points, point('A', 30), point('B', 60), point('C', 90)] }] } });
  const events = buildChartLiveEvents(previous, next, now);
  assert.equal(events.length, 1);
  assert.match(events[0].title, /A–B–C/);
});
test('history is deduplicated, identity-bound, newest-first and capped at 100', () => {
  const template = buildChartLiveEvents(null, snapshot(), now)[0];
  const rows = Array.from({ length: 120 }, (_, index) => ({ ...template, id: String(index), at: now - index }));
  const result = mergeChartLiveEvents(rows, [rows[0], { ...rows[0], id: 'other', identity: 'KR:005930:5m' }], template.identity);
  assert.equal(result.length, 100);
  assert.equal(result[0].id, '0');
  assert.equal(result[99].id, '99');
});
test('changing identities starts a fresh observation without prior market history', () => {
  const next = snapshot({ identity: 'US:TSLA:5m', analysis: { ...analysis, symbol: 'TSLA' } });
  const events = buildChartLiveEvents(snapshot(), next, now);
  assert.ok(events.every(event => event.identity === 'US:TSLA:5m'));
  assert.ok(events.some(event => event.kind === 'analysis'));
});

test('recovery does not report disconnected candles or threshold changes as newly observed live events', () => {
  const disconnected = snapshot({
    dataState: 'stale', status: '오래된 데이터', asOf: now - 86_400_000,
    closedTime: barTime, volumeRatio: 1.2,
  });
  const recovered = snapshot({ closedTime: barTime + 300, volumeRatio: 2.3 });
  const events = buildChartLiveEvents(disconnected, recovered, now);
  assert.deepEqual(events.map((event) => event.kind), ['data', 'analysis']);
  assert.ok(!events.some((event) => /새 완료봉|거래량 증가/.test(event.title)));
});

test('provider / transport switch resets the live bar baseline without removing the new source status', () => {
  const original = snapshot({ closedTime: barTime, volumeRatio: 1.2 });
  const newProvider = snapshot({
    source: 'UPSTREAM_PUBLIC_WS:PUBLIC_WS_VERIFIED', transport: '공개 WS 검증',
    closedTime: barTime + 300, volumeRatio: 2.3,
  });
  const changed = buildChartLiveEvents(original, newProvider, now);
  assert.deepEqual(changed.map((event) => event.kind), ['data']);
  assert.match(changed[0].detail, /PUBLIC_WS_VERIFIED/);

  // Once the same verified provider is continuously observed, genuine new
  // closed-bar and volume-transition events are allowed again.
  const continuous = buildChartLiveEvents(newProvider, snapshot({
    source: newProvider.source, transport: newProvider.transport,
    closedTime: barTime + 600, volumeRatio: 1.0,
  }), now);
  assert.deepEqual(continuous.map((event) => event.kind), ['bar']);
  const rising = buildChartLiveEvents(snapshot({
    source: newProvider.source, transport: newProvider.transport,
    closedTime: barTime + 600, volumeRatio: 1.0,
  }), snapshot({
    source: newProvider.source, transport: newProvider.transport,
    closedTime: barTime + 900, volumeRatio: 2.0,
  }), now);
  assert.deepEqual(rising.map((event) => event.kind), ['bar', 'bar']);
});
