// Selection-bias audit for the trend-pilot variant choice. The variants were compared on the same
// data and one was picked, so its raw numbers overstate skill. The Deflated Sharpe Ratio asks: given
// that many variants were tried, is the best one's per-trade Sharpe still distinguishable from the
// best of that many unskilled tries? Pure and read-only; it changes no rule and grants no authority.
import { deflatedSharpeV1 } from './strategy-zoo-v1.mjs';

export const TREND_PILOT_SELECTION_AUDIT_CONTRACT_V1 = 'trend-pilot-selection-audit/v1';
export const TREND_PILOT_DSR_THRESHOLD = 0.9;
export const TREND_PILOT_MIN_TRADES_FOR_AUDIT = 30;

function stats(returns) {
  const r = returns.filter(Number.isFinite);
  const n = r.length;
  if (n < 3) return null;
  const mean = r.reduce((a, v) => a + v, 0) / n;
  const variance = r.reduce((a, v) => a + ((v - mean) ** 2), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  const m3 = r.reduce((a, v) => a + ((v - mean) ** 3), 0) / n;
  const m4 = r.reduce((a, v) => a + ((v - mean) ** 4), 0) / n;
  return { n, mean, sd, srPerTrade: mean / sd, skew: m3 / (sd ** 3), kurt: m4 / (sd ** 4) };
}

/**
 * @param {Array<{variantId:string, returns:number[]}>} variants per-trade net returns on notional (time-ordered, validation-clean data only)
 * @param {{extraTrials?:number}} options additional untracked trials (e.g. exit/risk settings tried earlier); only ever raises the bar
 */
export function trendPilotSelectionAuditV1(variants, { extraTrials = 0 } = {}) {
  const rows = (Array.isArray(variants) ? variants : []).map((v) => ({ variantId: String(v?.variantId ?? ''), ...(stats(Array.isArray(v?.returns) ? v.returns : []) ?? { n: 0 }) }));
  const measured = rows.filter((r) => r.srPerTrade !== undefined);
  const trials = Math.max(1, rows.length + Math.max(0, Math.trunc(Number.isFinite(extraTrials) ? extraTrials : 0)));
  if (measured.length < 2) {
    return Object.freeze({ contract: TREND_PILOT_SELECTION_AUDIT_CONTRACT_V1, status: 'INSUFFICIENT_VARIANTS', trials, rows: [], best: null, executionAuthority: 'NONE' });
  }
  const mean = measured.reduce((a, r) => a + r.srPerTrade, 0) / measured.length;
  const srVariance = measured.reduce((a, r) => a + ((r.srPerTrade - mean) ** 2), 0) / (measured.length - 1);
  const out = measured.map((r) => {
    const dsr = r.n >= TREND_PILOT_MIN_TRADES_FOR_AUDIT
      ? deflatedSharpeV1({ srPerBar: r.srPerTrade, days: r.n, skew: r.skew, kurt: r.kurt }, { trials, srVariance })
      : null;
    return Object.freeze({ variantId: r.variantId, trades: r.n, srPerTrade: r.srPerTrade, deflatedSharpe: dsr });
  });
  const ranked = [...out].sort((a, b) => b.srPerTrade - a.srPerTrade);
  const best = ranked[0];
  const status = best.deflatedSharpe === null ? 'TOO_FEW_TRADES'
    : best.deflatedSharpe >= TREND_PILOT_DSR_THRESHOLD ? 'SELECTION_SUPPORTED' : 'SELECTION_NOT_DISTINGUISHABLE_FROM_LUCK';
  return Object.freeze({
    contract: TREND_PILOT_SELECTION_AUDIT_CONTRACT_V1, status, trials, srVariance, rows: Object.freeze(out), best, threshold: TREND_PILOT_DSR_THRESHOLD, executionAuthority: 'NONE',
  });
}
