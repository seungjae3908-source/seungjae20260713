import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedChartCandle } from './chart-candle-normalizer';
import { detectConfirmedPivots, type ConfirmedChartPivot } from './chart-structure-engine';
import {
  buildChartWaveTrendOverlay,
  buildTrendChannel,
  buildTrendline,
  buildWaveSwings,
  classifyWaveStructure,
  lineValueAt,
  segmentLinePoints,
  waveLinePoints,
} from './chart-wave-trend';

function candles(values: number[], options: { lastClosed?: boolean } = {}): NormalizedChartCandle[] {
  return values.map((close, index) => ({
    time: 1_700_000_000 + index * 300,
    sourceTime: String(1_700_000_000 + index * 300),
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000 + index * 10,
    isClosed: index === values.length - 1 ? options.lastClosed ?? true : true,
    closeStateSource: 'provider' as const,
  }));
}

function pivot(kind: 'high' | 'low', candleIndex: number, price: number): ConfirmedChartPivot {
  return {
    id: `${kind}:${candleIndex}`,
    kind,
    candleIndex,
    time: 1_700_000_000 + candleIndex * 300,
    price,
    confirmedAtTime: 1_700_000_000 + (candleIndex + 2) * 300,
    classification: 'UNCLASSIFIED',
  };
}

// 저점·고점이 함께 높아지는 상승 파동: 저 100 → 고 110 → 저 104 → 고 116 → 저 109 → 고 121
const RISING = [
  103, 101, 100, 102, 105, 108, 110, 108, 106, 104, 107, 111, 114, 116, 114, 111, 109, 112, 116, 119, 121, 119, 117, 118,
];
// 고점·저점이 함께 낮아지는 하락 파동
const FALLING = RISING.map((value) => 230 - value);

test('wave swings alternate highs and lows and collapse same-kind runs to the extreme', () => {
  const swings = buildWaveSwings([
    pivot('low', 2, 100),
    pivot('high', 5, 110),
    pivot('high', 7, 112),
    pivot('high', 9, 111),
    pivot('low', 12, 104),
    pivot('low', 14, 103),
    pivot('high', 17, 118),
  ]);
  assert.deepEqual(swings.map((swing) => `${swing.kind}:${swing.candleIndex}`), ['low:2', 'high:7', 'low:14', 'high:17']);
  assert.deepEqual(swings.map((swing) => swing.classification), ['START', 'START', 'HL', 'HH']);
  assert.equal(swings[2].label, 'HL 저점↑');
  assert.equal(swings[3].label, 'HH 고점↑');
  assert.equal(swings[3].direction, 'up');
});

test('an outside bar that is both a high and a low pivot never produces duplicate line times', () => {
  const swings = buildWaveSwings([pivot('low', 2, 100), pivot('high', 5, 110), pivot('low', 5, 99), pivot('low', 8, 98)]);
  const points = waveLinePoints(classifyWaveStructure(swings));
  for (let index = 1; index < points.length; index += 1) assert.ok(points[index].time > points[index - 1].time);
  assert.deepEqual(swings.map((swing) => `${swing.kind}:${swing.candleIndex}`), ['low:2', 'high:5', 'low:8']);
});

test('wave structure labels: rising, falling, mixed and insufficient', () => {
  const up = classifyWaveStructure(buildWaveSwings([pivot('low', 1, 100), pivot('high', 3, 110), pivot('low', 5, 104), pivot('high', 7, 116)]));
  assert.equal(up.trend, 'bullish');
  assert.equal(up.label, '상승 구조');
  const down = classifyWaveStructure(buildWaveSwings([pivot('high', 1, 120), pivot('low', 3, 110), pivot('high', 5, 116), pivot('low', 7, 104)]));
  assert.equal(down.trend, 'bearish');
  assert.equal(down.label, '하락 구조');
  assert.equal(down.swings.at(-2)?.label, 'LH 고점↓');
  assert.equal(down.swings.at(-1)?.label, 'LL 저점↓');
  const mixed = classifyWaveStructure(buildWaveSwings([pivot('low', 1, 100), pivot('high', 3, 110), pivot('low', 5, 98), pivot('high', 7, 116)]));
  assert.equal(mixed.trend, 'mixed');
  assert.equal(mixed.label, '혼조');
  assert.equal(classifyWaveStructure(buildWaveSwings([pivot('low', 1, 100), pivot('high', 3, 110)])).label, '판단 보류');
});

test('wave is built only from confirmed pivots and does not change while the last bar is open', () => {
  const closed = candles(RISING);
  const open = candles([...RISING, 130], { lastClosed: false });
  const closedWave = buildChartWaveTrendOverlay(closed, detectConfirmedPivots(closed)).wave;
  const openWave = buildChartWaveTrendOverlay(open, detectConfirmedPivots(open)).wave;
  assert.deepEqual(openWave.swings.map((swing) => swing.id), closedWave.swings.map((swing) => swing.id));
  for (const swing of closedWave.swings) assert.ok(swing.candleIndex <= closed.length - 3);
});

test('rising data yields a bullish wave, an intact rising support trendline and a rising channel', () => {
  const rows = candles(RISING);
  const overlay = buildChartWaveTrendOverlay(rows, detectConfirmedPivots(rows));
  assert.equal(overlay.wave.label, '상승 구조');
  assert.ok(overlay.support);
  assert.equal(overlay.support.slope, 'rising');
  assert.equal(overlay.support.broken, false);
  assert.equal(overlay.support.label, '상승 추세선');
  assert.equal(overlay.support.end.time, rows.at(-1)!.time);
  assert.ok(overlay.support.end.value > overlay.support.start.value);
  assert.ok(overlay.channel);
  assert.equal(overlay.channel.base, 'support');
  assert.equal(overlay.channel.slope, 'rising');
  assert.ok(overlay.channel.width > 0);
  // 채널 상단은 기준선과 평행
  const upperSlope = overlay.channel.upper.end.value - overlay.channel.upper.start.value;
  const lowerSlope = overlay.channel.lower.end.value - overlay.channel.lower.start.value;
  assert.ok(Math.abs(upperSlope - lowerSlope) < 1e-9);
});

test('falling data yields a bearish wave and a falling resistance trendline as channel base', () => {
  const rows = candles(FALLING);
  const overlay = buildChartWaveTrendOverlay(rows, detectConfirmedPivots(rows));
  assert.equal(overlay.wave.label, '하락 구조');
  assert.ok(overlay.resistance);
  assert.equal(overlay.resistance.slope, 'falling');
  assert.equal(overlay.resistance.label, '하락 추세선');
  assert.equal(overlay.channel?.base, 'resistance');
  assert.ok(overlay.channel!.lower.start.value < overlay.channel!.upper.start.value);
});

test('a closed candle beyond the support line marks the trendline broken; an open candle does not', () => {
  const crash = [...RISING, 100];
  const brokenRows = candles(crash);
  const broken = buildTrendline(brokenRows, buildWaveSwings(detectConfirmedPivots(brokenRows)), 'support');
  assert.ok(broken);
  assert.equal(broken.broken, true);
  assert.equal(broken.breakTime, brokenRows.at(-1)!.time);
  assert.match(broken.label, /이탈$/);

  const openRows = candles(crash, { lastClosed: false });
  const pending = buildTrendline(openRows, buildWaveSwings(detectConfirmedPivots(openRows)), 'support');
  assert.equal(pending?.broken, false);
});

test('support trendline prefers the latest rising low pair over a newer falling pair', () => {
  const rows = candles(new Array(30).fill(110));
  const swings = buildWaveSwings([
    pivot('low', 2, 100),
    pivot('high', 5, 115),
    pivot('low', 8, 104),
    pivot('high', 11, 118),
    pivot('low', 14, 102),
  ]);
  const line = buildTrendline(rows, swings, 'support');
  assert.ok(line);
  assert.deepEqual(line.anchors.map((swing) => swing.candleIndex), [2, 8]);
  assert.equal(line.slope, 'rising');
});

test('trendline geometry is linear in candle index and channel needs positive width', () => {
  const a = { candleIndex: 0, time: 0, value: 10 };
  const b = { candleIndex: 4, time: 4, value: 18 };
  assert.equal(lineValueAt(a, b, 2), 14);
  assert.equal(lineValueAt(a, b, 6), 22);
  assert.deepEqual(segmentLinePoints({ start: b, end: a }), []);
  assert.equal(buildTrendChannel(candles([1, 2, 3]), null), null);
  assert.equal(buildTrendline(candles([1, 2]), [], 'support'), null);
});
