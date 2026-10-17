import type { NormalizedChartCandle } from './chart-candle-normalizer';

export type SwingPoint = { time: number; price: number; index: number; kind: 'high' | 'low'; confirmed: boolean; confirmedAt: number };
export type DrawingSegment = { points: Array<{ time: number; price: number }>; role: 'pattern' | 'wave' | 'forming'; label?: string };
export type AutoPattern = {
  id: string; name: string; direction: 'up' | 'down' | 'both'; status: 'candidate' | 'confirmed' | 'invalidated';
  detectedAt: number; eventAt: number; confirmation: number; invalidation: number;
  target: [number, number]; segments: DrawingSegment[];
};
export type WaveCandidate = { id: string; name: string; points: Array<SwingPoint & { label: string }>; segments: DrawingSegment[] };
export type AutoDrawing = { patterns: AutoPattern[]; waves: WaveCandidate[]; swings: SwingPoint[]; asOf: number | null };

function validCandle(row: NormalizedChartCandle): boolean {
  return [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite) && row.time > 0 && row.low > 0
    && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close);
}

function atrAt(rows: readonly NormalizedChartCandle[], index: number): number {
  let sum = 0;
  const start = Math.max(0, index - 13);
  for (let i = start; i <= index; i += 1) {
    const previous = rows[Math.max(0, i - 1)].close;
    sum += Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - previous), Math.abs(rows[i].low - previous));
  }
  return sum / (index - start + 1);
}

/** Confirmations use only closed, already observed bars. The final leg may repaint. */
export function zigZagSwings(rows: readonly NormalizedChartCandle[], sensitivity = 2): SwingPoint[] {
  if (rows.length < 3 || !rows.every(validCandle)) return [];
  const points: SwingPoint[] = [];
  let direction = 0;
  let highIndex = 0;
  let lowIndex = 0;
  const point = (index: number, kind: SwingPoint['kind'], confirmed: boolean, confirmedAt: number): SwingPoint => ({
    index, time: rows[index].time, price: kind === 'high' ? rows[index].high : rows[index].low, kind, confirmed, confirmedAt,
  });
  for (let i = 1; i < rows.length; i += 1) {
    // An incomplete last bar can make temporary intrabar highs/lows.
    // Never allow its extremes to become a subsequently confirmed swing.
    if (!rows[i].isClosed) continue;
    const threshold = Math.max(atrAt(rows, i) * sensitivity, rows[i].close * 0.003);
    const newHigh = rows[i].high > rows[highIndex].high;
    const newLow = rows[i].low < rows[lowIndex].low;
    if (direction >= 0 && newHigh) highIndex = i;
    if (direction <= 0 && newLow) lowIndex = i;
    if (direction === 0) {
      if (lowIndex < i && rows[i].close - rows[lowIndex].low >= threshold) {
        points.push(point(lowIndex, 'low', true, rows[i].time)); direction = 1; highIndex = i;
      } else if (highIndex < i && rows[highIndex].high - rows[i].close >= threshold) {
        points.push(point(highIndex, 'high', true, rows[i].time)); direction = -1; lowIndex = i;
      }
    } else if (direction > 0 && !newHigh && highIndex < i && rows[highIndex].high - rows[i].close >= threshold) {
      points.push(point(highIndex, 'high', true, rows[i].time)); direction = -1; lowIndex = i;
    } else if (direction < 0 && !newLow && lowIndex < i && rows[i].close - rows[lowIndex].low >= threshold) {
      points.push(point(lowIndex, 'low', true, rows[i].time)); direction = 1; highIndex = i;
    }
  }
  if (direction !== 0) points.push(point(direction > 0 ? highIndex : lowIndex, direction > 0 ? 'high' : 'low', false, rows.at(-1)!.time));
  return points;
}

function line(points: SwingPoint[]) {
  const origin = points[0].index;
  const meanX = points.reduce((sum, p) => sum + p.index - origin, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.price, 0) / points.length;
  const denominator = points.reduce((sum, p) => sum + (p.index - origin - meanX) ** 2, 0);
  const slope = denominator ? points.reduce((sum, p) => sum + (p.index - origin - meanX) * (p.price - meanY), 0) / denominator : 0;
  const at = (index: number) => meanY + slope * (index - origin - meanX);
  const residual = Math.max(...points.map(p => Math.abs(p.price - at(p.index))));
  return { slope, at, residual };
}

function lifecycle(rows: readonly NormalizedChartCandle[], from: number, direction: AutoPattern['direction'], upper: (i: number) => number, lower: (i: number) => number, height: number, invalidation: number) {
  let status: AutoPattern['status'] = 'candidate';
  let eventAt = rows[from].time;
  let chosen = direction;
  let confirmation = direction === 'down' ? lower(from) : upper(from);
  for (let i = from; i < rows.length; i += 1) {
    if (!rows[i].isClosed || upper(i) <= lower(i)) continue;
    if (status === 'candidate') {
      if (direction !== 'down' && rows[i].close > upper(i)) { status = 'confirmed'; chosen = 'up'; confirmation = upper(i); if (direction === 'both') invalidation = lower(i); eventAt = rows[i].time; }
      else if (direction !== 'up' && rows[i].close < lower(i)) { status = 'confirmed'; chosen = 'down'; confirmation = lower(i); if (direction === 'both') invalidation = upper(i); eventAt = rows[i].time; }
      else if ((direction === 'up' && rows[i].close < invalidation) || (direction === 'down' && rows[i].close > invalidation)) { status = 'invalidated'; eventAt = rows[i].time; break; }
    } else if ((chosen === 'up' && rows[i].close < invalidation) || (chosen === 'down' && rows[i].close > invalidation)) {
      status = 'invalidated'; eventAt = rows[i].time; break;
    }
  }
  const target = confirmation + (chosen === 'down' ? -height : height);
  return { status, eventAt, confirmation, invalidation, direction: chosen, target: [Math.max(0, target - height * 0.1), target + height * 0.1] as [number, number] };
}

export function detectAutoPatterns(rows: readonly NormalizedChartCandle[], swings: readonly SwingPoint[]): AutoPattern[] {
  const points = swings.filter(p => p.confirmed);
  const results: AutoPattern[] = [];
  if (rows.length < 3) return results;
  const add = (name: string, anchors: SwingPoint[], direction: AutoPattern['direction'], upper: (i: number) => number, lower: (i: number) => number, height: number, invalidation: number, segments: DrawingSegment[]) => {
    const from = rows.findIndex(r => r.time === anchors.at(-1)!.confirmedAt);
    if (from < 0 || height <= 0 || invalidation <= 0 || rows.length - from > 120) return;
    const state = lifecycle(rows, from, direction, upper, lower, height, invalidation);
    results.push({ id: `${name}:${anchors.map(p => p.time).join(':')}`, name, detectedAt: rows[from].time, segments, ...state });
  };
  // Scan a bounded recent window; terminal states follow historical closes,
  // not only the latest close (a broken pattern cannot silently become valid again).
  for (let end = Math.max(3, points.length - 14); end <= points.length; end += 1) {
    const three = points.slice(end - 3, end);
    if (three.length === 3 && three[0].kind === three[2].kind) {
      const [a, b, c] = three;
      const tolerance = Math.max(a.price * 0.003, Math.min(atrAt(rows, c.index), Math.abs(a.price - b.price) * 0.2));
      if (Math.abs(a.price - c.price) <= tolerance && Math.abs(a.price - b.price) > tolerance * 2) {
        const bottom = a.kind === 'low';
        const invalidation = bottom ? Math.min(a.price, c.price) : Math.max(a.price, c.price);
        add(bottom ? '이중바닥' : '이중천장', three, bottom ? 'up' : 'down', () => bottom ? b.price : invalidation, () => bottom ? invalidation : b.price, Math.abs(b.price - (a.price + c.price) / 2), invalidation, [{ points: three, role: 'pattern' }]);
      }
    }
    const five = points.slice(end - 5, end);
    if (five.length === 5) {
      const [a, b, head, d, e] = five;
      const inverted = a.kind === 'low';
      const sign = inverted ? -1 : 1;
      const shoulder = (a.price + e.price) / 2;
      const height = (head.price - (b.price + d.price) / 2) * sign;
      if (height > 0 && (head.price - shoulder) * sign > height * 0.2 && Math.abs(a.price - e.price) < height * 0.25) {
        const neck = line([b, d]);
        const invalidation = head.price;
        add(inverted ? '역헤드앤숄더' : '헤드앤숄더', five, inverted ? 'up' : 'down', inverted ? neck.at : () => invalidation, inverted ? () => invalidation : neck.at, height, invalidation, [{ points: five, role: 'pattern' }, { points: [b, d], role: 'pattern', label: '목선' }]);
      }
    }
    const six = points.slice(end - 6, end);
    const highs = six.filter(p => p.kind === 'high');
    const lows = six.filter(p => p.kind === 'low');
    if (highs.length !== 3 || lows.length !== 3) continue;
    const top = line(highs); const bottom = line(lows);
    const start = six[0].index; const finish = six.at(-1)!.index;
    const width = top.at(start) - bottom.at(start); const endWidth = top.at(finish) - bottom.at(finish);
    if (width <= 0 || endWidth <= 0 || top.residual > width * 0.18 || bottom.residual > width * 0.18) continue;
    const movement = width * 0.08 / Math.max(1, finish - start);
    const parallel = Math.abs(top.slope - bottom.slope) < width * 0.2 / Math.max(1, finish - start);
    const converging = endWidth < width * 0.8;
    let name = ''; let direction: AutoPattern['direction'] = 'both';
    if (parallel && Math.abs(top.slope) > movement) name = top.slope > 0 ? '상승 채널' : '하락 채널';
    else if (converging && top.slope > movement && bottom.slope > movement) { name = '상승 쐐기'; direction = 'down'; }
    else if (converging && top.slope < -movement && bottom.slope < -movement) { name = '하락 쐐기'; direction = 'up'; }
    else if (converging && top.slope < movement && bottom.slope > -movement) name = '삼각수렴';
    if (!name) continue;
    const before = rows[Math.max(0, start - (finish - start))].close;
    const pole = rows[start].close - before;
    if (parallel && Math.abs(pole) > width * 3 && pole * top.slope < 0) { name = pole > 0 ? '상승 깃발' : '하락 깃발'; direction = pole > 0 ? 'up' : 'down'; }
    const lastIndex = Math.min(rows.length - 1, finish + Math.max(1, finish - start));
    const upperEnd = top.at(lastIndex); const lowerEnd = bottom.at(lastIndex);
    // Stop converging lines before their apex rather than draw crossed rails.
    const drawEnd = upperEnd > lowerEnd ? lastIndex : finish;
    const invalidation = direction === 'down' ? top.at(finish) : bottom.at(finish);
    add(name, six, direction, top.at, bottom.at, width, invalidation, [
      { points: [{ time: rows[start].time, price: top.at(start) }, { time: rows[drawEnd].time, price: top.at(drawEnd) }], role: 'pattern' },
      { points: [{ time: rows[start].time, price: bottom.at(start) }, { time: rows[drawEnd].time, price: bottom.at(drawEnd) }], role: 'pattern' },
    ]);
  }
  return results.sort((a, b) => b.detectedAt - a.detectedAt).filter((row, i, all) => all.findIndex(x => x.name === row.name) === i).slice(0, 3);
}

export function detectWaveCandidates(swings: readonly SwingPoint[]): WaveCandidate[] {
  const confirmed = swings.filter(p => p.confirmed);
  const candidates: WaveCandidate[] = [];
  for (let start = Math.max(0, confirmed.length - 12); start + 6 <= confirmed.length; start += 1) {
    const impulse = confirmed.slice(start, start + 6);
    if (impulse.some((point, i) => i > 0 && (point.kind === impulse[i - 1].kind || point.time <= impulse[i - 1].time))) continue;
    const sign = impulse[0].kind === 'low' ? 1 : -1;
    const p = impulse.map(row => row.price * sign);
    const one = p[1] - p[0]; const three = p[3] - p[2]; const five = p[5] - p[4];
    if (one <= 0 || three <= 0 || five <= 0 || p[2] <= p[0] || p[3] <= p[1] || p[4] <= p[1] || p[5] <= p[3] || three < Math.min(one, five)) continue;
    const points = impulse.map((point, i) => ({ ...point, label: String(i) }));
    const correction = confirmed.slice(start + 6, start + 9);
    if (correction.length === 3 && correction[0].price * sign < p[5] && correction[1].price * sign < p[5] && correction[1].price * sign > correction[0].price * sign && correction[2].price * sign < correction[0].price * sign) {
      points.push(...correction.map((point, i) => ({ ...point, label: ['A', 'B', 'C'][i] })));
    }
    candidates.push({ id: `wave:${impulse.map(x => x.time).join(':')}`, name: sign > 0 ? '상승 1–5파 후보' : '하락 1–5파 후보', points, segments: [{ points, role: 'wave' }] });
  }
  return candidates.slice(-2).reverse();
}

export function analyzeAutoDrawing(input: readonly NormalizedChartCandle[]): AutoDrawing {
  if (!input.every(validCandle) || input.some((row, i) => i > 0 && row.time <= input[i - 1].time)) return { patterns: [], waves: [], swings: [], asOf: null };
  // Pattern confirmations and labels must use completed source candles only.
  // Forming candles remain available to the price chart but not to this engine.
  const rows = input.filter(row => row.isClosed).slice(-800);
  const swings = zigZagSwings(rows);
  return { patterns: detectAutoPatterns(rows, swings), waves: detectWaveCandidates(swings), swings, asOf: rows.at(-1)?.time ?? null };
}
