// Long → short flip, round 2 (research only, no orders). Pre-registered 2026-10-18
// after round 1 (v1) failed out of sample: the 1h short leg lost (PF 0.59) and the
// 1h long-only baseline was flat. Round 2 changes only what round 1 suggested, fixed
// before any round-2 result was seen:
//   - slower bars: 4h and 1d, resampled from the same Bitget 1h candles
//   - a stricter short: 3 confirming bars, a break of the 20-bar low, EMA20 < EMA50
//     AND (funding >= 0.03% when funding is known)
//   - a majors-only universe besides the full one
// Variants (each FLIP is judged against its own LONG_ONLY twin):
//   H4_MAJORS_LONG / H4_MAJORS_FLIP, D1_ALL_LONG / D1_ALL_FLIP
// Verdict per FLIP variant on the validation segment (last 40%), all symbols pooled:
//   short trades >= 30, short ΣR > 0, short PF >= 1.2 (stricter than v1 for testing 2 flips),
//   FLIP ΣR > its LONG_ONLY ΣR, and >= 60% of symbols with shorts gain from the flip.
// Every other rule, cost and split is identical to v1. 2026 data is never read.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  LONG_SHORT_FLIP_HOLDOUT_START,
  LONG_SHORT_FLIP_RULES_V1,
  flipSplitTimeV1,
  regimeAllowsLongV1,
  simulateLongShortFlipV1,
  summarizeFlipTradesV1,
} from './long-short-flip-backtest-v1.mjs';

export const LONG_SHORT_FLIP_CONTRACT_V2 = 'long-short-flip-backtest/v2';
const HOUR = 3_600_000;

export const LONG_SHORT_FLIP_MAJORS_V2 = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT']);

export const LONG_SHORT_FLIP_STRICT_SHORT_V2 = Object.freeze({
  ...LONG_SHORT_FLIP_RULES_V1,
  confirmBars: 3,
  recentLowBars: 20,
  strictShort: true,
});

export const LONG_SHORT_FLIP_VARIANTS_V2 = Object.freeze([
  Object.freeze({ id: 'H4_MAJORS_LONG', barHours: 4, universe: 'majors', flip: false, regime: true }),
  Object.freeze({ id: 'H4_MAJORS_FLIP', barHours: 4, universe: 'majors', flip: true, regime: true, baseline: 'H4_MAJORS_LONG' }),
  Object.freeze({ id: 'D1_ALL_LONG', barHours: 24, universe: 'all', flip: false, regime: true }),
  Object.freeze({ id: 'D1_ALL_FLIP', barHours: 24, universe: 'all', flip: true, regime: true, baseline: 'D1_ALL_LONG' }),
]);

export const LONG_SHORT_FLIP_VERDICT_V2 = Object.freeze({ minShortTrades: 30, minShortProfitFactor: 1.2, minSymbolBreadth: 0.6 });

/** Pure: aggregate 1h candles into N-hour bars aligned to UTC midnight; incomplete bars dropped. */
export function resampleFlipCandlesV2(candles, hours) {
  if (hours === 1) return candles;
  const size = hours * HOUR;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.timestamp / size) * size;
    let rows = groups.get(key);
    if (!rows) { rows = []; groups.set(key, rows); }
    rows.push(c);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .filter(([, rows]) => rows.length === hours)
    .map(([timestamp, rows]) => {
      rows.sort((a, b) => a.timestamp - b.timestamp);
      let high = -Infinity; let low = Infinity; let volume = 0;
      for (const r of rows) { high = Math.max(high, r.high); low = Math.min(low, r.low); volume += r.volume ?? 0; }
      return { timestamp, open: rows[0].open, high, low, close: rows.at(-1).close, volume };
    });
}

export function evaluateLongShortFlipV2({ datasets, benchmarkSymbol = 'BTCUSDT' }) {
  const usable = datasets.filter((d) => Array.isArray(d.candles) && d.candles.length >= 200)
    .map((d) => ({ ...d, candles: d.candles.filter((c) => c.timestamp < LONG_SHORT_FLIP_HOLDOUT_START) }));
  const splitTime = flipSplitTimeV1(usable);
  const perVariant = {};
  const symbolsOf = {};
  for (const variant of LONG_SHORT_FLIP_VARIANTS_V2) {
    const members = variant.universe === 'majors' ? usable.filter((d) => LONG_SHORT_FLIP_MAJORS_V2.includes(d.symbol)) : usable;
    symbolsOf[variant.id] = members.map((d) => d.symbol);
    const bench = usable.find((d) => d.symbol === benchmarkSymbol);
    const benchBars = bench ? resampleFlipCandlesV2(bench.candles, variant.barHours) : [];
    const rules = variant.flip ? LONG_SHORT_FLIP_STRICT_SHORT_V2 : LONG_SHORT_FLIP_RULES_V1;
    // The regime peak window stays 24 hours of wall time on every bar size.
    const regimeAllowed = bench ? regimeAllowsLongV1(benchBars, { ...rules, regimePeakBars: Math.max(1, Math.round(24 / variant.barHours)) }) : null;
    const bySymbol = {};
    for (const d of members) {
      bySymbol[d.symbol] = simulateLongShortFlipV1({
        candles: resampleFlipCandlesV2(d.candles, variant.barHours),
        fundingRates: d.fundingRates ?? [],
        regimeAllowed,
        variant: { id: variant.id, flip: variant.flip, regime: variant.regime },
        rules,
      });
    }
    perVariant[variant.id] = bySymbol;
  }
  const segment = (trades, which) => trades.filter((t) => (which === 'discovery' ? t.entryTime < splitTime : t.entryTime >= splitTime));
  const pooled = (id, which, side = null) => Object.values(perVariant[id]).flatMap((ts) => segment(ts, which))
    .filter((t) => side === null || t.side === side);
  const results = {};
  for (const variant of LONG_SHORT_FLIP_VARIANTS_V2) {
    results[variant.id] = {};
    for (const which of ['discovery', 'validation']) {
      results[variant.id][which] = {
        all: summarizeFlipTradesV1(pooled(variant.id, which)),
        long: summarizeFlipTradesV1(pooled(variant.id, which, 'long')),
        short: summarizeFlipTradesV1(pooled(variant.id, which, 'short')),
      };
    }
  }
  const verdicts = {};
  const rule = LONG_SHORT_FLIP_VERDICT_V2;
  for (const variant of LONG_SHORT_FLIP_VARIANTS_V2.filter((v) => v.flip)) {
    const v = results[variant.id].validation;
    const base = results[variant.baseline].validation;
    const sum = (ts) => ts.reduce((s, t) => s + t.rMultiple, 0);
    const deltas = symbolsOf[variant.id].map((symbol) => {
      const flip = segment(perVariant[variant.id][symbol], 'validation');
      return { symbol, shorts: flip.filter((t) => t.side === 'short').length,
        deltaR: sum(flip) - sum(segment(perVariant[variant.baseline][symbol], 'validation')) };
    });
    const withShorts = deltas.filter((d) => d.shorts > 0);
    const breadth = withShorts.length ? withShorts.filter((d) => d.deltaR > 0).length / withShorts.length : null;
    const checks = {
      enoughShortTrades: v.short.trades >= rule.minShortTrades,
      shortSumPositive: v.short.sumR > 0,
      shortProfitFactor: v.short.profitFactor === Infinity || (Number.isFinite(v.short.profitFactor) && v.short.profitFactor >= rule.minShortProfitFactor),
      beatsLongOnly: v.all.sumR > base.all.sumR,
      symbolBreadth: breadth !== null && breadth >= rule.minSymbolBreadth,
    };
    verdicts[variant.id] = { checks, symbolBreadth: breadth, symbolDeltas: deltas,
      verdict: Object.values(checks).every(Boolean) ? 'SHORT_LEG_ADDS_VALUE' : 'NOT_PROVEN' };
  }
  const longOnlyPositive = Object.fromEntries(LONG_SHORT_FLIP_VARIANTS_V2.filter((v) => !v.flip).map((v) => {
    const r = results[v.id].validation.all;
    return [v.id, r.trades >= 30 && r.sumR > 0 && Number.isFinite(r.profitFactor) && r.profitFactor >= 1.2];
  }));
  const fundingCoverage = usable.length
    ? usable.filter((d) => (d.fundingRates ?? []).length > 0).length / usable.length : 0;
  return {
    contract: LONG_SHORT_FLIP_CONTRACT_V2,
    symbols: usable.map((d) => d.symbol),
    splitTime: splitTime === null ? null : new Date(splitTime).toISOString(),
    fundingCoverage,
    variants: LONG_SHORT_FLIP_VARIANTS_V2,
    results,
    verdicts,
    longOnlyPositive,
    safety: { researchOnly: true, finalHoldoutUsed: false, realOrder: false, executionAuthority: 'NONE' },
  };
}

const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? '-' : v === Infinity ? '∞' : Number(v).toFixed(d));

export function formatLongShortFlipReportKoV2(result) {
  const lines = ['롱 → 숏 전환 2차 시험 (사전 등록 규칙, 연구 전용)'];
  lines.push(`종목 ${result.symbols.length}개 · 4시간/일봉 · 펀딩비 확보 종목 ${pct(result.fundingCoverage)} · 검증 시작 ${result.splitTime?.slice(0, 10) ?? '-'}`);
  for (const which of ['discovery', 'validation']) {
    lines.push('', which === 'discovery' ? '[탐색 구간 (앞 60%)]' : '[검증 구간 (뒤 40%) ← 판정]');
    for (const v of result.variants) {
      const r = result.results[v.id][which];
      lines.push(`  ${v.id.padEnd(15)} 거래 ${String(r.all.trades).padStart(4)} · 승률 ${pct(r.all.winRate)} · ΣR ${num(r.all.sumR)} · PF ${num(r.all.profitFactor)}`
        + ` · 1%위험 수익 ${pct(r.all.returnAtOnePercentRisk)} · 최대낙폭 ${pct(r.all.maxDrawdownAtOnePercentRisk)}`);
      if (v.flip) lines.push(`  ${''.padEnd(15)}  └ 롱 ${r.long.trades}건 ΣR ${num(r.long.sumR)} / 숏 ${r.short.trades}건 ΣR ${num(r.short.sumR)} PF ${num(r.short.profitFactor)}`);
    }
  }
  lines.push('', '[판정]');
  for (const [id, v] of Object.entries(result.verdicts)) {
    const c = v.checks;
    lines.push(`  ${id}: ${v.verdict === 'SHORT_LEG_ADDS_VALUE' ? '숏 전환 효과 확인' : '증명 안 됨'}`
      + ` (숏 30건 ${c.enoughShortTrades ? 'O' : 'X'} · 숏 ΣR>0 ${c.shortSumPositive ? 'O' : 'X'} · 숏 PF≥1.2 ${c.shortProfitFactor ? 'O' : 'X'}`
      + ` · 롱만보다 나음 ${c.beatsLongOnly ? 'O' : 'X'} · 종목 60% ${c.symbolBreadth ? 'O' : 'X'} ${pct(v.symbolBreadth)})`);
  }
  for (const [id, ok] of Object.entries(result.longOnlyPositive)) {
    lines.push(`  ${id}: 롱 단독 ${ok ? '검증 구간 수익 확인 (30건↑, ΣR>0, PF≥1.2)' : '수익 증명 안 됨'}`);
  }
  return lines.join('\n');
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function runLongShortFlipBacktestV2({ stateRoot, now = new Date() }) {
  const dir = join(stateRoot, 'combination-research', 'datasets', 'BITGET_1H');
  const datasets = [];
  for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && !n.endsWith('.failure.json')).sort()) {
    const cached = JSON.parse(await readFile(join(dir, name), 'utf8'));
    datasets.push({ symbol: cached.symbol ?? name.replace(/\.json$/u, ''), candles: cached.candles ?? [],
      fundingRates: (cached.fundingRates ?? []).filter((r) => r.timestamp < LONG_SHORT_FLIP_HOLDOUT_START) });
  }
  const result = { ...evaluateLongShortFlipV2({ datasets }), observedAt: now.toISOString() };
  await atomicJson(join(stateRoot, 'latest', 'long-short-flip-backtest-v2.json'), result);
  return result;
}
