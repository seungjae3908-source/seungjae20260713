import { deflateSync } from 'node:zlib';
import type { Candle } from '../sample/types';

export type TelegramEvidenceChartInput = {
  candles: readonly Candle[];
  dataAsOf: string;
  entryZone?: { from: number; to: number } | null;
  stopLoss?: number | null;
  targets?: readonly number[];
  maxAgeMs?: number;
  nowMs?: number;
};

export type TelegramEvidenceChartResult =
  | {
      status: 'READY';
      png: Uint8Array;
      candleCount: number;
      dataAsOf: string;
      priceMin: number;
      priceMax: number;
    }
  | {
      status: 'UNAVAILABLE';
      reason:
        | 'INSUFFICIENT_CHART_EVIDENCE'
        | 'INVALID_CHART_EVIDENCE'
        | 'STALE_CHART_EVIDENCE'
        | 'FUTURE_CHART_EVIDENCE';
    };

const WIDTH = 960;
const HEIGHT = 540;
const LEFT = 44;
const RIGHT = 24;
const TOP = 28;
const BOTTOM = 52;
const MIN_CANDLES = 10;
const DEFAULT_MAX_AGE_MS = 36 * 60 * 60_000;

const BACKGROUND = [13, 17, 23, 255] as const;
const GRID = [47, 55, 66, 255] as const;
const UP = [36, 184, 108, 255] as const;
const DOWN = [239, 68, 68, 255] as const;
const ENTRY = [59, 130, 246, 74] as const;
const STOP = [244, 63, 94, 255] as const;
const TARGET = [250, 204, 21, 255] as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const checksumSource = Buffer.concat([typeBytes, body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(checksumSource), 0);
  return Buffer.concat([length, typeBytes, body, checksum]);
}

function setPixel(
  image: Uint8Array,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const index = (y * WIDTH + x) * 4;
  const alpha = rgba[3] / 255;
  const inverse = 1 - alpha;
  image[index] = Math.round(rgba[0] * alpha + image[index] * inverse);
  image[index + 1] = Math.round(rgba[1] * alpha + image[index + 1] * inverse);
  image[index + 2] = Math.round(rgba[2] * alpha + image[index + 2] * inverse);
  image[index + 3] = 255;
}

function fillRect(
  image: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(WIDTH, Math.ceil(x + width));
  const bottom = Math.min(HEIGHT, Math.ceil(y + height));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) setPixel(image, px, py, rgba);
  }
}

function line(
  image: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: readonly [number, number, number, number],
): void {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const sx = ax < bx ? 1 : -1;
  const dy = -Math.abs(by - ay);
  const sy = ay < by ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    setPixel(image, ax, ay, rgba);
    if (ax === bx && ay === by) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      ax += sx;
    }
    if (doubled <= dx) {
      error += dx;
      ay += sy;
    }
  }
}

function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validCandle(candle: Candle): boolean {
  return [candle.open, candle.high, candle.low, candle.close, candle.volume].every(numeric)
    && candle.open > 0
    && candle.high > 0
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
}

function timestamp(value: string | number): number | null {
  if (typeof value === 'number') {
    const normalized = value > 100_000_000_000 ? value : value * 1000;
    return Number.isFinite(normalized) ? normalized : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function encodePng(image: Uint8Array): Uint8Array {
  const stride = WIDTH * 4;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    Buffer.from(image.buffer, image.byteOffset + y * stride, stride).copy(raw, row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function renderTelegramEvidenceChart(input: TelegramEvidenceChartInput): TelegramEvidenceChartResult {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60_000, input.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
  const asOfMs = Date.parse(input.dataAsOf);
  if (!Number.isFinite(asOfMs)) return { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' };
  if (asOfMs > nowMs + 60_000) return { status: 'UNAVAILABLE', reason: 'FUTURE_CHART_EVIDENCE' };
  if (nowMs - asOfMs > maxAgeMs) return { status: 'UNAVAILABLE', reason: 'STALE_CHART_EVIDENCE' };

  const candles = input.candles.slice(-60);
  if (candles.length < MIN_CANDLES) return { status: 'UNAVAILABLE', reason: 'INSUFFICIENT_CHART_EVIDENCE' };
  if (!candles.every(validCandle)) return { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' };
  const times = candles.map((candle) => timestamp(candle.time));
  if (times.some((value) => value == null)) return { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' };
  for (let index = 1; index < times.length; index += 1) {
    if ((times[index] as number) <= (times[index - 1] as number)) {
      return { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' };
    }
  }

  const levelValues = [
    input.entryZone?.from,
    input.entryZone?.to,
    input.stopLoss,
    ...(input.targets ?? []),
  ].filter((value): value is number => numeric(value) && value > 0);
  const lows = candles.map((candle) => candle.low);
  const highs = candles.map((candle) => candle.high);
  let priceMin = Math.min(...lows, ...levelValues);
  let priceMax = Math.max(...highs, ...levelValues);
  if (!(priceMax > priceMin)) return { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' };
  const padding = (priceMax - priceMin) * 0.06;
  priceMin = Math.max(0, priceMin - padding);
  priceMax += padding;

  const image = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let index = 0; index < image.length; index += 4) {
    image[index] = BACKGROUND[0];
    image[index + 1] = BACKGROUND[1];
    image[index + 2] = BACKGROUND[2];
    image[index + 3] = 255;
  }

  const chartWidth = WIDTH - LEFT - RIGHT;
  const chartHeight = HEIGHT - TOP - BOTTOM;
  const yFor = (price: number) => TOP + ((priceMax - price) / (priceMax - priceMin)) * chartHeight;

  for (let index = 0; index <= 5; index += 1) {
    const y = TOP + (chartHeight * index) / 5;
    line(image, LEFT, y, WIDTH - RIGHT, y, GRID);
  }

  if (input.entryZone && numeric(input.entryZone.from) && numeric(input.entryZone.to)) {
    const high = Math.max(input.entryZone.from, input.entryZone.to);
    const low = Math.min(input.entryZone.from, input.entryZone.to);
    const top = yFor(high);
    const bottom = yFor(low);
    fillRect(image, LEFT, top, chartWidth, Math.max(2, bottom - top), ENTRY);
  }
  if (numeric(input.stopLoss) && input.stopLoss > 0) {
    const y = yFor(input.stopLoss);
    line(image, LEFT, y, WIDTH - RIGHT, y, STOP);
    line(image, LEFT, y + 1, WIDTH - RIGHT, y + 1, STOP);
  }
  for (const target of (input.targets ?? []).filter((value) => numeric(value) && value > 0).slice(0, 3)) {
    const y = yFor(target);
    line(image, LEFT, y, WIDTH - RIGHT, y, TARGET);
  }

  const step = chartWidth / candles.length;
  const bodyWidth = Math.max(2, Math.min(12, step * 0.58));
  candles.forEach((candle, index) => {
    const x = LEFT + step * index + step / 2;
    const color = candle.close >= candle.open ? UP : DOWN;
    line(image, x, yFor(candle.high), x, yFor(candle.low), color);
    const openY = yFor(candle.open);
    const closeY = yFor(candle.close);
    const top = Math.min(openY, closeY);
    const height = Math.max(2, Math.abs(closeY - openY));
    fillRect(image, x - bodyWidth / 2, top, bodyWidth, height, color);
  });

  return {
    status: 'READY',
    png: encodePng(image),
    candleCount: candles.length,
    dataAsOf: input.dataAsOf,
    priceMin,
    priceMax,
  };
}
