// Grid and DCA research on cached public candles, always with the tail loss.
//
// Grid bounds for each quarter are set from the PREVIOUS quarter's range only
// (no look-ahead); DCA uses fixed, predeclared parameters. Periods: the 2025
// validation year (pre-holdout) and the forward window from 2026-08-10. The
// 2026 sealed holdout window is not used. Research only, no orders.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FORWARD_PAPER_START_MS } from './extended-exit-backtest-v1.mjs';
import { simulateDcaV1, simulateGridV1 } from './research-analytics-v1.mjs';

export const GRID_DCA_RESEARCH_CONTRACT_V1 = 'grid-dca-research/v1';
const DAY = 86_400_000;
const QUARTER = 91 * DAY;

export const GRID_DCA_POLICY_V1 = Object.freeze({
  symbols: Object.freeze(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL']),
  intervalMs: 24 * 3_600_000,
  grid: Object.freeze({ levels: 12, capital: 1_000_000, feeRate: 0.0005, rangePadding: 0.05 }),
  dca: Object.freeze({ baseOrder: 100_000, safetyOrder: 100_000, maxSafetyOrders: 6, deviation: 0.03, takeProfit: 0.02, feeRate: 0.0005 }),
});

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/** Quarterly grid with bounds from the previous quarter, plus one DCA run. */
export function gridDcaForPeriodV1(candles, { start, end, policy = GRID_DCA_POLICY_V1 }) {
  const inPeriod = candles.filter((row) => row.timestamp >= start && row.timestamp < end);
  if (inPeriod.length < 200) return { status: 'INSUFFICIENT_DATA', candles: inPeriod.length };
  const grids = [];
  for (let qStart = start; qStart < end; qStart += QUARTER) {
    const qEnd = Math.min(end, qStart + QUARTER);
    const prior = candles.filter((row) => row.timestamp >= qStart - QUARTER && row.timestamp < qStart);
    const quarter = candles.filter((row) => row.timestamp >= qStart && row.timestamp < qEnd);
    if (prior.length < 100 || quarter.length < 100) continue;
    const low = Math.min(...prior.map((row) => row.low)); const high = Math.max(...prior.map((row) => row.high));
    const lower = low * (1 - policy.grid.rangePadding); const upper = high * (1 + policy.grid.rangePadding);
    grids.push({ from: new Date(qStart).toISOString().slice(0, 10), ...simulateGridV1(quarter, { ...policy.grid, lower, upper }) });
  }
  const dca = simulateDcaV1(inPeriod, policy.dca);
  const buyHold = inPeriod.at(-1).close / inPeriod[0].open - 1;
  return {
    status: 'OK', candles: inPeriod.length,
    grid: { quarters: grids,
      worstQuarterReturn: grids.length ? Math.min(...grids.map((row) => row.finalReturn)) : null,
      worstDrawdown: grids.length ? Math.max(...grids.map((row) => row.maxDrawdown)) : null },
    dca, buyAndHoldReturn: Number(buyHold.toFixed(6)),
  };
}

export async function runGridDcaResearchV1({ stateRoot, now = () => new Date().toISOString(), policy = GRID_DCA_POLICY_V1 } = {}) {
  const observedAt = now();
  const nowMs = Date.parse(observedAt);
  const outputPath = join(stateRoot, 'latest', 'grid-dca-research-v1.json');
  const prior = await readJson(outputPath);
  if (prior?.observedAt && nowMs - Date.parse(prior.observedAt) < policy.intervalMs) return { status: 'NOT_DUE', observedAt: prior.observedAt };
  const results = [];
  for (const symbol of policy.symbols) {
    const research = await readJson(join(stateRoot, 'combination-research', 'datasets', 'UPBIT_1H', `${symbol}.json`));
    const forward = await readJson(join(stateRoot, 'exploratory-paper', 'candles', 'UPBIT_1H', `${symbol}.json`));
    const history = (research?.candles ?? []).filter((row) => row.timestamp < Date.UTC(2026, 0, 1));
    results.push({
      symbol,
      validation2025: history.length ? gridDcaForPeriodV1(history, { start: Date.UTC(2025, 0, 1), end: Date.UTC(2026, 0, 1), policy }) : { status: 'NO_DATA' },
      forward: forward?.candles?.length
        ? gridDcaForPeriodV1(forward.candles.filter((row) => row.timestamp >= FORWARD_PAPER_START_MS - QUARTER), { start: FORWARD_PAPER_START_MS, end: nowMs, policy })
        : { status: 'NO_DATA' },
    });
  }
  const summary = Object.freeze({ contract: GRID_DCA_RESEARCH_CONTRACT_V1, observedAt, policy, results,
    note: 'GRID_AND_DCA_LOOK_SMOOTH_UNTIL_A_TREND_BREAKS_THE_RANGE_TAIL_LOSS_IS_REPORTED', executionAuthority: 'NONE' });
  await atomicJson(outputPath, summary);
  return summary;
}
