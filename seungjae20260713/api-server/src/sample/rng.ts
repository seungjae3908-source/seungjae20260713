// Deterministic seeded PRNG so every stock gets its own stable, realistic
// sample data (same ticker -> same numbers on every request).
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Fixed wall-clock anchor (2026-07-08) so sample payloads are fully request- and
// time-invariant: dates/timestamps in responses never drift between requests.
export const ANCHOR_MS = Date.UTC(2026, 6, 8);
export function anchorDate(): Date {
  return new Date(ANCHOR_MS);
}

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seeded(...parts: (string | number)[]): Rng {
  return mulberry32(hashString(parts.join(':')));
}

export function rangeInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function rangeFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// Deterministic 0-100 "quality" score for a ticker; small/speculative names
// (short numeric-free tickers, biotech, quantum) skew lower / riskier.
export function qualityScore(ticker: string): number {
  const r = seeded(ticker, 'quality');
  return Math.round(r() * 100);
}
