import { resolveSelectedResearchWindowV1 } from '../../../market-prediction-lab/src/research-selected-window-v1.js';

// The browser and manual research route share one selection contract. Paths,
// provider credentials, historical manifests and execution permissions are
// deliberately absent; they cannot be supplied by an HTTP caller.
export const ORIGINAL_MINUTE_MARKETS_V1 = Object.freeze(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
export const ORIGINAL_MINUTE_TIMEFRAMES_V1 = Object.freeze(['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']);
export const ORIGINAL_MINUTE_PRESETS_V1 = Object.freeze(['1d', '1w', '1m', '3m', '6m', '1y', '3y', '5y', '10y']);
export const ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 = Object.freeze({
  modelOnly: true, providerGETCount: 0, financialMutationCount: 0,
  profitabilityProven: false, OOSPassCount: 0, trueMarketWideRecall: null,
  fullMarketOpportunityDenominatorVerified: false, actualMarketWideOpportunityCount: null,
  actualFillCount: null, netProfitPct: null, paperAdmissionAllowed: false,
  executionAuthority: 'NONE', orderSubmitted: false, realOrders: false,
  liveTrading: false, autoTrading: false, automaticPaperExecution: false,
  historicalAsOfScannerSignalVerified: false, independentOOSAndFullCostProven: false,
});
const DAY = 86_400_000;
const INPUT_KEYS = ['market', 'symbol', 'startDate', 'endDate', 'timeframe', 'direction', 'strategy',
  'initialCapitalKRW', 'leverage', 'riskFraction', 'costModel', 'fxRateKRWPerQuote'];
const COST_KEYS = ['entryFeeRate', 'exitFeeRate', 'spreadRate', 'slippageRate', 'taxRate', 'latencyRate', 'fundingRatePerSession'];
const STRATEGY_KEYS = ['kind', 'fast', 'slow', 'stopPercent', 'targetPercent'];
const fail = code => { throw new TypeError(code); };
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o)
  && [Object.prototype, null].includes(Object.getPrototypeOf(o));
function keys(o, allowed, reason) {
  if (!plain(o) || Reflect.ownKeys(o).some(k => typeof k !== 'string' || !allowed.includes(k))) fail(reason);
}
function number(value, minimum, maximum, code, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || (integer && !Number.isSafeInteger(value))) fail(code);
  return value;
}
export function isOriginalMinuteBacktestSymbolV1(market, symbol) {
  if (typeof symbol !== 'string' || symbol !== symbol.normalize('NFC')) return false;
  if (market === 'CRYPTO_SPOT') return /^KRW-[A-Z0-9]{1,32}$/u.test(symbol);
  // Exact native identifiers: no ASCII transliteration, spaces or URL syntax.
  if (market === 'CRYPTO_FUTURES') return /^[A-Z0-9\p{Script=Han}]{1,36}USDT$/u.test(symbol);
  return ['KR_STOCK', 'US_STOCK'].includes(market) && /^[A-Z0-9][A-Z0-9._:-]{0,39}$/u.test(symbol);
}

export function normalizeOriginalMinuteBacktestRequestV1(raw, { nowMs = Date.now() } = {}) {
  keys(raw, INPUT_KEYS, 'ORIGINAL_MINUTE_REQUEST_FIELDS_INVALID');
  if (!ORIGINAL_MINUTE_MARKETS_V1.includes(raw.market)) fail('ORIGINAL_MINUTE_MARKET_INVALID');
  const market = raw.market;
  if (!isOriginalMinuteBacktestSymbolV1(market, raw.symbol)) fail('ORIGINAL_MINUTE_SYMBOL_INVALID');
  let period;
  try { period = resolveSelectedResearchWindowV1({ startDate: raw.startDate, endDate: raw.endDate }); }
  catch { fail('ORIGINAL_MINUTE_DATE_WINDOW_INVALID'); }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || period.endInclusiveMs > nowMs) fail('ORIGINAL_MINUTE_FUTURE_DATE_INVALID');
  const timeframe = raw.timeframe ?? '5m';
  if (!ORIGINAL_MINUTE_TIMEFRAMES_V1.includes(timeframe)) fail('ORIGINAL_MINUTE_TIMEFRAME_INVALID');
  if (['KR_STOCK', 'US_STOCK'].includes(market) && timeframe === '1d') fail('ORIGINAL_MINUTE_STOCK_DAILY_SOURCE_REQUIRED');
  const direction = raw.direction ?? 'LONG';
  if (!['LONG', 'SHORT'].includes(direction) || (market !== 'CRYPTO_FUTURES' && direction !== 'LONG')) fail('ORIGINAL_MINUTE_DIRECTION_INVALID');
  const leverage = number(raw.leverage ?? 1, 1, market === 'CRYPTO_FUTURES' ? 7 : 1, 'ORIGINAL_MINUTE_LEVERAGE_INVALID', true);
  const strategyInput = raw.strategy ?? {};
  keys(strategyInput, STRATEGY_KEYS, 'ORIGINAL_MINUTE_STRATEGY_FIELDS_INVALID');
  if (strategyInput.kind !== undefined && strategyInput.kind !== 'EMA_TREND') fail('ORIGINAL_MINUTE_STRATEGY_KIND_INVALID');
  const fast = number(strategyInput.fast ?? 4, 2, 100, 'ORIGINAL_MINUTE_EMA_FAST_INVALID', true);
  const slow = number(strategyInput.slow ?? 12, fast + 1, 250, 'ORIGINAL_MINUTE_EMA_SLOW_INVALID', true);
  const strategy = Object.freeze({ kind: 'EMA_TREND', fast, slow,
    stopPercent: number(strategyInput.stopPercent ?? 1, 0.000001, 20, 'ORIGINAL_MINUTE_STOP_INVALID'),
    targetPercent: number(strategyInput.targetPercent ?? 2, 0.000001, 100, 'ORIGINAL_MINUTE_TARGET_INVALID'),
  });
  const costInput = raw.costModel ?? {};
  keys(costInput, COST_KEYS, 'ORIGINAL_MINUTE_COST_FIELDS_INVALID');
  const costs = {};
  for (const name of COST_KEYS) {
    // Zero is a declared model assumption, never evidence that real costs were zero.
    costs[name] = number(costInput[name] ?? 0, 0, 0.199999999, 'ORIGINAL_MINUTE_COST_RATE_INVALID');
  }
  if (market !== 'CRYPTO_FUTURES' && costs.fundingRatePerSession !== 0) fail('ORIGINAL_MINUTE_CASH_FUNDING_INVALID');
  const krw = ['KR_STOCK', 'CRYPTO_SPOT'].includes(market);
  const fx = raw.fxRateKRWPerQuote ?? (krw ? 1 : undefined);
  if (krw && fx !== 1) fail('ORIGINAL_MINUTE_KRW_FX_MUST_BE_ONE');
  number(fx, 0.000001, 10_000, 'ORIGINAL_MINUTE_FX_ASSUMPTION_REQUIRED');
  return Object.freeze({ market, symbol: raw.symbol, startDate: period.startDate, endDate: period.endDate,
    timeframe, direction, strategy, leverage,
    initialCapitalKRW: number(raw.initialCapitalKRW ?? 1_000_000, 1, 1_000_000_000_000, 'ORIGINAL_MINUTE_CAPITAL_INVALID'),
    riskFraction: number(raw.riskFraction ?? 0.01, 0.00000001, 0.1, 'ORIGINAL_MINUTE_RISK_FRACTION_INVALID'),
    costModel: Object.freeze(costs), fxRateKRWPerQuote: fx,
  });
}

/** Calendar presets include endDate. The result never clips the selected range to available data. */
export function resolveOriginalMinuteBacktestPresetV1(preset, endDate) {
  if (!ORIGINAL_MINUTE_PRESETS_V1.includes(preset)) fail('ORIGINAL_MINUTE_PRESET_INVALID');
  let period;
  try { period = resolveSelectedResearchWindowV1({ startDate: endDate, endDate }); }
  catch { fail('ORIGINAL_MINUTE_DATE_WINDOW_INVALID'); }
  const endExclusive = period.endExclusiveMs;
  let startMs;
  if (preset === '1d' || preset === '1w') startMs = endExclusive - (preset === '1d' ? 1 : 7) * DAY;
  else {
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60, '10y': 120 }[preset];
    const d = new Date(endExclusive);
    const originalDay = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, lastDay));
    startMs = d.getTime();
  }
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  try { resolveSelectedResearchWindowV1({ startDate, endDate }); }
  catch { fail('ORIGINAL_MINUTE_DATE_WINDOW_INVALID'); }
  return Object.freeze({ startDate, endDate });
}
