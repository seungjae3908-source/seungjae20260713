import { expect, test } from '@playwright/test';
import { analyzeAutoDrawing, detectAutoPatterns, detectWaveCandidates, zigZagSwings, type SwingPoint } from '../src/lib/chart-auto-drawing';
import type { NormalizedChartCandle } from '../src/lib/chart-candle-normalizer';
const base = 1_800_000_000;
const rows = (prices: number[]): NormalizedChartCandle[] => prices.map((price, i) => ({ time: base + i * 60, sourceTime: new Date((base + i * 60) * 1000).toISOString(), open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 100, isClosed: true, closeStateSource: 'provider' }));
const swings = (prices: number[], first: 'low' | 'high' = 'low'): SwingPoint[] => prices.map((price, i) => ({ time: base + i * 60, price, index: i, confirmed: true, confirmedAt: base + i * 60, kind: i % 2 === 0 ? first : first === 'low' ? 'high' : 'low' }));

test('confirmed ZigZag anchors do not repaint when future bars arrive; open bar stays provisional', () => {
  const data = rows([100, 100.5, 101, 103, 105, 104, 102, 100, 99, 100, 102, 104, 106, 105, 103, 101, 99]);
  for (let i = 5; i < data.length; i += 1) {
    const confirmed = zigZagSwings(data.slice(0, i), 1).filter(p => p.confirmed);
    const extended = zigZagSwings(data, 1).filter(p => p.confirmed);
    expect(extended.slice(0, confirmed.length)).toEqual(confirmed);
  }
  const open = [...data.slice(0, 5), { ...data[5], isClosed: false, close: 99, low: 98 }];
  expect(zigZagSwings(open).filter(p => p.confirmed)).toEqual(zigZagSwings(open.slice(0, -1)).filter(p => p.confirmed));
});
test('double bottom records closed breakout and sticky invalidation, not intrabar wick', () => {
  const points = swings([90, 100, 90.5]);
  const data = rows([90, 100, 90.5, 99, 101, 89, 102, 103]);
  const live = data.slice(0, 5); live[4] = { ...live[4], isClosed: false };
  expect(detectAutoPatterns(live, points).find(p => p.name === '이중바닥')?.status).toBe('candidate');
  expect(detectAutoPatterns(data.slice(0, 5), points).find(p => p.name === '이중바닥')?.status).toBe('confirmed');
  const invalid = detectAutoPatterns(data, points).find(p => p.name === '이중바닥');
  expect(invalid?.status).toBe('invalidated'); expect(invalid?.eventAt).toBe(data[5].time);
});
test('triangle, wedge, channel, flag and head-and-shoulders are detected from actual anchors', () => {
  const examples: Array<[string, number[], 'high' | 'low']> = [
    ['삼각수렴', [110, 90, 108, 92, 106, 94], 'high'],
    ['상승 쐐기', [110, 90, 112, 97, 114, 104], 'high'],
    ['상승 채널', [110, 100, 115, 105, 120, 110], 'high'],
    ['헤드앤숄더', [105, 95, 115, 96, 106], 'high'],
  ];
  for (const [name, prices, first] of examples) {
    const data = rows([...prices, prices.at(-1)!, prices.at(-1)!]);
    expect(detectAutoPatterns(data, swings(prices, first)).some(p => p.name === name)).toBe(true);
  }
  const prices = [70, 100, 110, 102, 108, 100, 106, 98];
  const data = rows([...prices, 100, 99]);
  const points = swings(prices.slice(2), 'high').map(p => ({ ...p, time: p.time + 120, confirmedAt: p.confirmedAt + 120, index: p.index + 2 }));
  expect(detectAutoPatterns(data, points).some(p => p.name === '상승 깃발')).toBe(true);
});
test('Elliott rules reject overlap, wave-2 overrun and shortest wave-3; ABC uses real points only', () => {
  const valid = [100, 110, 105, 125, 115, 130, 118, 125, 110];
  const wave = detectWaveCandidates(swings(valid))[0];
  expect(wave.points.map(p => p.label)).toEqual(['0', '1', '2', '3', '4', '5', 'A', 'B', 'C']);
  for (const invalid of [[100, 110, 99, 125, 115, 130], [100, 110, 105, 125, 109, 130], [100, 110, 105, 112, 111, 125]]) expect(detectWaveCandidates(swings(invalid))).toEqual([]);
  const incomplete = detectWaveCandidates(swings(valid.slice(0, 8)))[0];
  expect(incomplete.points).toHaveLength(6);
});
test('invalid or unordered candles never create a drawing', () => {
  const data = rows([100, 110, 105]);
  expect(analyzeAutoDrawing([data[1], data[0]]).patterns).toEqual([]);
  expect(analyzeAutoDrawing([{ ...data[0], low: 0 }, ...data.slice(1)]).asOf).toBeNull();
});
