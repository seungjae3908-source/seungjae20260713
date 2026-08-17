const BASE_URL = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const LEVERAGE_GRID = Object.freeze([1, 2, 3, 5, 10, 15, 20]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

async function fetchJson(path, params, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('BITGET_PUBLIC_TIMEOUT')), 5_000);
  try {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'signal-intelligence-v3/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_PUBLIC_HTTP_${response.status}`);
    const body = await response.json();
    if (!body || body.code !== '00000') throw new Error('BITGET_PUBLIC_PROVIDER_ERROR');
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (!symbol.endsWith('USDT')) throw new TypeError('BITGET_SYMBOL_INVALID');
  return symbol;
}

function parseTier(data, symbol) {
  if (!Array.isArray(data) || data.length < 1) throw new Error('BITGET_POSITION_TIER_MISSING');
  const first = [...data]
    .map((row) => ({
      symbol: String(row?.symbol ?? symbol).toUpperCase(),
      level: finite(row?.level ?? row?.tier),
      startUnit: finite(row?.startUnit ?? row?.minTierValue),
      endUnit: positive(row?.endUnit ?? row?.maxTierValue),
      maxLeverage: positive(row?.leverage),
      mmr: positive(row?.keepMarginRate ?? row?.mmr),
    }))
    .filter((row) => row.level === 1 || row.startUnit === 0)
    .sort((a, b) => (a.startUnit ?? 0) - (b.startUnit ?? 0))[0];
  if (!first || first.startUnit !== 0 || first.endUnit == null || first.maxLeverage == null || first.mmr == null) {
    throw new Error('BITGET_FIRST_POSITION_TIER_INVALID');
  }
  return first;
}

function parseContract(data, symbol) {
  if (!Array.isArray(data)) throw new Error('BITGET_CONTRACT_DATA_INVALID');
  const row = data.find((item) => String(item?.symbol ?? '').toUpperCase() === symbol);
  if (!row || String(row.symbolStatus ?? '') !== 'normal') throw new Error('BITGET_CONTRACT_NOT_TRADABLE');
  const takerFeeRate = finite(row.takerFeeRate);
  const minLeverage = positive(row.minLever);
  const maxLeverage = positive(row.maxLever);
  if (takerFeeRate == null || takerFeeRate < 0 || minLeverage == null || maxLeverage == null) throw new Error('BITGET_CONTRACT_RISK_FIELDS_INVALID');
  return { takerFeeRate, minLeverage, maxLeverage };
}

function parseClosedCandles(data, nowMs) {
  if (!Array.isArray(data)) throw new Error('BITGET_CANDLES_INVALID');
  const rows = data.flatMap((raw) => {
    if (!Array.isArray(raw) || raw.length < 5) return [];
    const timestamp = positive(raw[0]);
    const open = positive(raw[1]);
    const high = positive(raw[2]);
    const low = positive(raw[3]);
    const close = positive(raw[4]);
    if ([timestamp, open, high, low, close].some((value) => value == null)) return [];
    if (timestamp + 60 * 60_000 > nowMs || low > Math.min(open, close) || high < Math.max(open, close)) return [];
    return [{ timestamp, open, high, low, close }];
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length < 72) throw new Error('BITGET_MAE_HISTORY_INSUFFICIENT');
  return rows;
}

export function historicalAdverseEvidence(candles, direction, horizonBars = 12) {
  const normalizedDirection = String(direction).toUpperCase();
  if (!['LONG', 'SHORT'].includes(normalizedDirection)) throw new TypeError('FUTURES_DIRECTION_INVALID');
  if (!Number.isInteger(horizonBars) || horizonBars < 1) throw new TypeError('HORIZON_INVALID');
  const mae = [];
  const terminal = [];
  for (let index = 0; index + horizonBars < candles.length; index += 1) {
    const entry = candles[index].close;
    const future = candles.slice(index + 1, index + horizonBars + 1);
    if (normalizedDirection === 'LONG') {
      const worstLow = Math.min(...future.map((row) => row.low));
      mae.push(Math.max(0, (entry - worstLow) / entry * 100));
      terminal.push(Math.max(0, (entry - future.at(-1).close) / entry * 100));
    } else {
      const worstHigh = Math.max(...future.map((row) => row.high));
      mae.push(Math.max(0, (worstHigh - entry) / entry * 100));
      terminal.push(Math.max(0, (future.at(-1).close - entry) / entry * 100));
    }
  }
  const maeQ95Pct = quantile(mae, 0.95);
  const downsideIntervalPct = quantile(terminal, 0.95);
  if (maeQ95Pct == null || downsideIntervalPct == null || mae.length < 50) throw new Error('ADVERSE_SAMPLE_INSUFFICIENT');
  return Object.freeze({
    horizonBars,
    sampleSize: mae.length,
    maeQ95Pct,
    downsideIntervalPct,
    method: 'CLOSED_1H_FORWARD_WINDOW_EMPIRICAL_Q95',
  });
}

export function isolatedFirstTierLiquidationPrice({ entryPrice, leverage, mmr, takerFeeRate, direction }) {
  const entry = positive(entryPrice);
  const lev = positive(leverage);
  const maintenance = positive(mmr);
  const taker = finite(takerFeeRate);
  const side = String(direction).toUpperCase() === 'LONG' ? 1 : String(direction).toUpperCase() === 'SHORT' ? -1 : 0;
  if (entry == null || lev == null || maintenance == null || taker == null || taker < 0 || side === 0) throw new TypeError('LIQUIDATION_INPUT_INVALID');
  const denominator = maintenance + taker - side;
  if (denominator === 0) throw new Error('LIQUIDATION_DENOMINATOR_ZERO');
  const liquidation = entry * (1 / lev - side) / denominator;
  return Number.isFinite(liquidation) && liquidation > 0 ? liquidation : null;
}

function liquidationDistancePct(entryPrice, liquidationPrice) {
  if (liquidationPrice == null) return null;
  return Math.abs(entryPrice - liquidationPrice) / entryPrice * 100;
}

function volatilityClass(candles) {
  const changes = [];
  for (let index = 1; index < candles.length; index += 1) {
    changes.push(Math.abs(candles[index].close / candles[index - 1].close - 1) * 100);
  }
  const q75 = quantile(changes.slice(-72), 0.75);
  if (q75 == null) return 'EXTREME';
  if (q75 < 0.6) return 'LOW';
  if (q75 < 1.5) return 'NORMAL';
  if (q75 < 3) return 'HIGH';
  return 'EXTREME';
}

function liquidityClass(spreadPct) {
  if (spreadPct <= 0.08) return 'HIGH';
  if (spreadPct <= 0.25) return 'NORMAL';
  return 'LOW';
}

export async function buildBitgetIndicativeLeverageEvidence(input, fetchImpl = fetch) {
  const symbol = normalizeSymbol(input?.symbol);
  const direction = String(input?.direction ?? '').toUpperCase();
  if (!['LONG', 'SHORT'].includes(direction)) throw new TypeError('FUTURES_DIRECTION_INVALID');
  const entryPrice = positive(input?.entryPrice);
  const stopDistancePct = positive(input?.stopDistancePct);
  const spreadPct = finite(input?.spreadPct);
  const slippagePct = finite(input?.slippagePct);
  if (entryPrice == null || stopDistancePct == null || spreadPct == null || spreadPct < 0 || slippagePct == null || slippagePct < 0) {
    throw new TypeError('LEVERAGE_MARKET_EVIDENCE_INCOMPLETE');
  }
  const nowMs = Number.isFinite(input?.nowMs) ? input.nowMs : Date.now();

  const [tierData, contractData, candleData] = await Promise.all([
    fetchJson('/api/v2/mix/market/query-position-lever', { symbol, productType: PRODUCT_TYPE }, fetchImpl),
    fetchJson('/api/v2/mix/market/contracts', { symbol, productType: PRODUCT_TYPE }, fetchImpl),
    fetchJson('/api/v2/mix/market/candles', { symbol, productType: PRODUCT_TYPE, granularity: '1H', limit: '240' }, fetchImpl),
  ]);
  const tier = parseTier(tierData, symbol);
  const contract = parseContract(contractData, symbol);
  const candles = parseClosedCandles(candleData, nowMs);
  const adverse = historicalAdverseEvidence(candles, direction, Number.isInteger(input?.horizonBars) ? input.horizonBars : 12);
  const exchangeMaximum = Math.min(tier.maxLeverage, contract.maxLeverage);
  const candidateLeverages = LEVERAGE_GRID.filter((leverage) => leverage >= contract.minLeverage && leverage <= exchangeMaximum);
  if (!candidateLeverages.length) throw new Error('NO_CONSERVATIVE_LEVERAGE_GRID');

  const tiers = candidateLeverages.flatMap((leverage) => {
    const lp = isolatedFirstTierLiquidationPrice({ entryPrice, leverage, mmr: tier.mmr, takerFeeRate: contract.takerFeeRate, direction });
    const distance = liquidationDistancePct(entryPrice, lp);
    return distance == null ? [] : [{
      leverage,
      liquidationDistancePct: distance,
      maintenanceMarginRatePct: tier.mmr * 100,
      verified: true,
    }];
  });
  if (!tiers.length) throw new Error('NO_VALID_LIQUIDATION_DISTANCE');

  return Object.freeze({
    stopDistancePct,
    maeQ95Pct: adverse.maeQ95Pct,
    downsideIntervalPct: adverse.downsideIntervalPct,
    spreadPct,
    slippagePct,
    uncertainty: adverse.sampleSize >= 150 ? 'LOW' : 'MEDIUM',
    volatility: volatilityClass(candles),
    liquidity: liquidityClass(spreadPct),
    tiers: Object.freeze(tiers),
    evidence: Object.freeze({
      provider: 'bitget-public',
      model: 'ISOLATED_NEW_POSITION_FIRST_TIER_INDICATIVE',
      positionTier: 1,
      firstTierMaxNotional: tier.endUnit,
      firstTierMaxLeverage: tier.maxLeverage,
      mmr: tier.mmr,
      takerFeeRate: contract.takerFeeRate,
      adverse,
      publicOnly: true,
      privateAccountStateUsed: false,
      executionAuthority: 'NONE',
    }),
  });
}
