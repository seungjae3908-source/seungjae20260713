const DEFAULT_POLICY = Object.freeze({
  version: 'MIS_V1',
  maxDataAgeMs: 15_000,
  scannerMaxAdjustment: 20,
  structuralHardBlock: 95,
  autoMinForwardSamples: 300,
  autoMinProfitFactor: 1.20,
  autoMinExpectedNetEdgeBps: 1,
  autoMaxDrawdownPct: 20,
  autoMinRegimeCount: 2,
});

const MARKET_SET = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRatio(numerator, denominator, fallback = 0) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : fallback;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeLevel(level) {
  if (Array.isArray(level)) return { price: finite(level[0]), size: finite(level[1]) };
  if (level && typeof level === 'object') {
    return {
      price: finite(level.price ?? level[0]),
      size: finite(level.size ?? level.qty ?? level.quantity ?? level[1]),
    };
  }
  return { price: null, size: null };
}

function normalizeBook(book) {
  const clean = (rows, descending) => (Array.isArray(rows) ? rows : [])
    .map(normalizeLevel)
    .filter((row) => row.price > 0 && row.size >= 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price)
    .slice(0, 50);
  return {
    bids: clean(book?.bids, true),
    asks: clean(book?.asks, false),
    ts: finite(book?.ts ?? book?.timestamp),
  };
}

function normalizeTrades(trades) {
  return (Array.isArray(trades) ? trades : [])
    .map((trade) => ({
      side: String(trade?.side ?? trade?.ask_bid ?? '').toLowerCase() === 'buy'
        || String(trade?.ask_bid ?? '').toUpperCase() === 'BID'
        ? 'buy'
        : 'sell',
      price: finite(trade?.price ?? trade?.trade_price),
      size: finite(trade?.size ?? trade?.qty ?? trade?.volume ?? trade?.trade_volume),
      ts: finite(trade?.ts ?? trade?.timestamp ?? trade?.trade_timestamp),
    }))
    .filter((trade) => trade.price > 0 && trade.size > 0)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function bookFeatures(book, previousBook) {
  const current = normalizeBook(book);
  const previous = normalizeBook(previousBook);
  const bidQty = current.bids.slice(0, 10).reduce((sum, row) => sum + row.size, 0);
  const askQty = current.asks.slice(0, 10).reduce((sum, row) => sum + row.size, 0);
  const bookImbalance = safeRatio(bidQty - askQty, bidQty + askQty, 0);
  const bestBid = current.bids[0];
  const bestAsk = current.asks[0];
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null;
  const spreadBps = mid && bestBid && bestAsk ? ((bestAsk.price - bestBid.price) / mid) * 10_000 : null;
  const microprice = bestBid && bestAsk && bestBid.size + bestAsk.size > 0
    ? (bestAsk.price * bestBid.size + bestBid.price * bestAsk.size) / (bestBid.size + bestAsk.size)
    : null;
  const micropriceBiasBps = mid && microprice ? ((microprice - mid) / mid) * 10_000 : 0;

  let ofi = 0;
  if (bestBid && bestAsk && previous.bids[0] && previous.asks[0]) {
    const prevBid = previous.bids[0];
    const prevAsk = previous.asks[0];
    const bidPressure = bestBid.price > prevBid.price
      ? bestBid.size
      : bestBid.price < prevBid.price
        ? -prevBid.size
        : bestBid.size - prevBid.size;
    const askPressure = bestAsk.price < prevAsk.price
      ? bestAsk.size
      : bestAsk.price > prevAsk.price
        ? -prevAsk.size
        : bestAsk.size - prevAsk.size;
    const denom = Math.max(1e-12, bestBid.size + bestAsk.size + prevBid.size + prevAsk.size);
    ofi = clamp((bidPressure - askPressure) / denom * 2, -1, 1);
  }

  return { current, previous, bidQty, askQty, bookImbalance, bestBid, bestAsk, mid, spreadBps, micropriceBiasBps, ofi };
}

function tradeFeatures(trades) {
  const rows = normalizeTrades(trades);
  let buyNotional = 0;
  let sellNotional = 0;
  for (const row of rows) {
    const notional = row.price * row.size;
    if (row.side === 'buy') buyNotional += notional;
    else sellNotional += notional;
  }
  const totalNotional = buyNotional + sellNotional;
  const cvdNormalized = safeRatio(buyNotional - sellNotional, totalNotional, 0);
  const first = rows[0];
  const last = rows.at(-1);
  const priceReturnBps = first && last ? ((last.price - first.price) / first.price) * 10_000 : 0;
  const bullishAbsorptionScore = cvdNormalized < -0.10 && priceReturnBps >= -5
    ? clamp((-cvdNormalized) * 100 * clamp((priceReturnBps + 5) / 5, 0.25, 1), 0, 100)
    : 0;
  const bearishAbsorptionScore = cvdNormalized > 0.10 && priceReturnBps <= 5
    ? clamp(cvdNormalized * 100 * clamp((5 - priceReturnBps) / 5, 0.25, 1), 0, 100)
    : 0;
  return { rows, buyNotional, sellNotional, totalNotional, cvdNormalized, priceReturnBps, bullishAbsorptionScore, bearishAbsorptionScore };
}

function wallWithdrawalFeatures(currentBook, previousBook, trades) {
  const previousLevels = [
    ...previousBook.bids.slice(0, 20).map((row) => ({ ...row, side: 'bid' })),
    ...previousBook.asks.slice(0, 20).map((row) => ({ ...row, side: 'ask' })),
  ];
  const notionals = previousLevels.map((row) => row.price * row.size);
  const med = median(notionals);
  const wall = previousLevels
    .map((row) => ({ ...row, notional: row.price * row.size }))
    .filter((row) => med > 0 && row.notional >= med * 3)
    .sort((a, b) => b.notional - a.notional)[0];
  if (!wall) return { score: 0, side: null, cancellationRatio: 0, executedRatio: 0 };
  const currentSide = wall.side === 'bid' ? currentBook.bids : currentBook.asks;
  const same = currentSide.find((row) => Math.abs(row.price - wall.price) <= Math.max(1e-12, wall.price * 1e-10));
  const remaining = same?.size ?? 0;
  const cancellationRatio = clamp(1 - safeRatio(remaining, wall.size, 0), 0, 1);
  const tolerance = wall.price * 0.00005;
  const executed = trades
    .filter((trade) => Math.abs(trade.price - wall.price) <= tolerance)
    .reduce((sum, trade) => sum + trade.price * trade.size, 0);
  const executedRatio = clamp(safeRatio(executed, wall.notional, 0), 0, 1);
  const score = cancellationRatio >= 0.60 && executedRatio < 0.25
    ? clamp(cancellationRatio * (1 - executedRatio) * 100, 0, 100)
    : 0;
  return { score, side: wall.side, cancellationRatio, executedRatio, wallPrice: wall.price, wallNotional: wall.notional };
}

function derivativesFeatures(input) {
  const d = input ?? {};
  const oi = finite(d.openInterest);
  const prevOi = finite(d.previousOpenInterest);
  const oiDeltaPct = oi != null && prevOi > 0 ? ((oi - prevOi) / prevOi) * 100 : null;
  const fundingRate = finite(d.fundingRate, 0);
  const longShortRatio = finite(d.longShortRatio, 1);
  const longLiquidation = Math.max(0, finite(d.longLiquidationNotional, 0));
  const shortLiquidation = Math.max(0, finite(d.shortLiquidationNotional, 0));
  const liquidationBias = safeRatio(shortLiquidation - longLiquidation, shortLiquidation + longLiquidation, 0);
  const fundingBias = clamp(-fundingRate * 20_000, -1, 1);
  const crowdingBias = longShortRatio > 0
    ? clamp(-Math.log(longShortRatio) / Math.log(2), -1, 1)
    : 0;
  const oiConviction = oiDeltaPct == null ? 0 : clamp(Math.abs(oiDeltaPct) / 5, 0, 1);
  return { oi, prevOi, oiDeltaPct, fundingRate, longShortRatio, longLiquidation, shortLiquidation, liquidationBias, fundingBias, crowdingBias, oiConviction };
}

function microcapFeatures(input) {
  const m = input ?? {};
  const cash = Math.max(0, finite(m.cash, 0));
  const quarterlyCashBurn = Math.max(0, finite(m.quarterlyCashBurn, 0));
  const runwayQuarters = quarterlyCashBurn > 0 ? cash / quarterlyCashBurn : null;
  const marketCap = Math.max(0, finite(m.marketCap, 0));
  const shelfCapacity = Math.max(0, finite(m.shelfCapacity, 0));
  const shelfToMarketCap = marketCap > 0 ? shelfCapacity / marketCap : 0;
  const sharesOutstanding = Math.max(0, finite(m.sharesOutstanding, 0));
  const previousSharesOutstanding = Math.max(0, finite(m.previousSharesOutstanding, 0));
  const shareGrowthPct = previousSharesOutstanding > 0
    ? ((sharesOutstanding - previousSharesOutstanding) / previousSharesOutstanding) * 100
    : 0;
  const warrantShares = Math.max(0, finite(m.warrantShares, 0));
  const warrantOverhang = sharesOutstanding > 0 ? warrantShares / sharesOutstanding : 0;
  const reverseSplitCount12m = Math.max(0, finite(m.reverseSplitCount12m, 0));
  const shortInterestPctFloat = Math.max(0, finite(m.shortInterestPctFloat, 0));
  const daysToCover = Math.max(0, finite(m.daysToCover, 0));
  const atmActive = m.atmActive === true;
  const convertibleRisk = clamp(finite(m.convertibleRiskScore, 0), 0, 100);

  let dilutionRisk = 0;
  if (atmActive) dilutionRisk += 25;
  dilutionRisk += clamp(shelfToMarketCap * 30, 0, 25);
  dilutionRisk += clamp(warrantOverhang * 60, 0, 20);
  dilutionRisk += clamp(Math.max(0, shareGrowthPct) * 0.6, 0, 20);
  if (runwayQuarters != null) {
    if (runwayQuarters < 1) dilutionRisk += 25;
    else if (runwayQuarters < 2) dilutionRisk += 18;
    else if (runwayQuarters < 4) dilutionRisk += 8;
  }
  dilutionRisk += clamp(reverseSplitCount12m * 5, 0, 10);
  dilutionRisk += convertibleRisk * 0.15;
  dilutionRisk = clamp(dilutionRisk, 0, 100);

  const shortPressureScore = clamp(shortInterestPctFloat * 1.5 + daysToCover * 4, 0, 70);
  return {
    runwayQuarters,
    shelfToMarketCap,
    shareGrowthPct,
    warrantOverhang,
    reverseSplitCount12m,
    shortInterestPctFloat,
    daysToCover,
    atmActive,
    convertibleRisk,
    dilutionRisk,
    shortPressureScore,
  };
}

function resolvePolicy(policy) {
  if (!policy) return { ...DEFAULT_POLICY };
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new Error('POLICY_VERSION_REQUIRED');
  const merged = { ...DEFAULT_POLICY, ...policy };
  for (const key of Object.keys(DEFAULT_POLICY).filter((key) => key !== 'version')) {
    if (!Number.isFinite(Number(merged[key]))) throw new Error(`INVALID_POLICY_FIELD:${key}`);
    merged[key] = Number(merged[key]);
  }
  return merged;
}

function grade(score) {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'WATCH';
  return 'NO_EDGE';
}

export function evaluateMarketIntelligence(input = {}) {
  const market = String(input.market ?? '').toUpperCase();
  if (!MARKET_SET.has(market)) throw new Error(`UNSUPPORTED_MARKET:${market}`);
  const policy = resolvePolicy(input.policy);
  const now = finite(input.now, Date.now());
  const asOf = finite(input.asOf ?? input.orderBook?.ts ?? input.orderBook?.timestamp, now);
  const ageMs = Math.max(0, now - asOf);
  const stale = ageMs > policy.maxDataAgeMs;

  const book = bookFeatures(input.orderBook, input.previous?.orderBook);
  const trades = tradeFeatures(input.trades);
  const wall = wallWithdrawalFeatures(book.current, book.previous, trades.rows);
  const derivatives = market === 'CRYPTO_FUTURES' ? derivativesFeatures({
    ...(input.derivatives ?? {}),
    previousOpenInterest: input.derivatives?.previousOpenInterest ?? input.previous?.derivatives?.openInterest,
  }) : null;
  const microcap = market === 'US_STOCK' ? microcapFeatures(input.microcap) : null;

  let directional = 0;
  directional += book.bookImbalance * 24;
  directional += clamp(book.micropriceBiasBps / 5, -1, 1) * 8;
  directional += book.ofi * 18;
  directional += trades.cvdNormalized * 18;
  directional += (trades.bullishAbsorptionScore - trades.bearishAbsorptionScore) * 0.18;
  if (wall.score > 0) directional += (wall.side === 'ask' ? 1 : -1) * wall.score * 0.18;
  if (derivatives) {
    const flowDirection = Math.sign(directional || trades.cvdNormalized || book.bookImbalance);
    directional += derivatives.liquidationBias * 10;
    directional += derivatives.fundingBias * 8;
    directional += derivatives.crowdingBias * 7;
    if (derivatives.oiConviction > 0 && flowDirection !== 0) directional += flowDirection * derivatives.oiConviction * 5;
  }
  directional = clamp(directional, -50, 50);

  const intelligenceScore = clamp(50 + directional, 0, 100);
  const bullishScore = clamp(50 + directional, 0, 100);
  const bearishScore = clamp(50 - directional, 0, 100);
  const scannerAdjustmentRaw = clamp(directional / 2.5, -policy.scannerMaxAdjustment, policy.scannerMaxAdjustment);
  const structuralPenalty = microcap ? clamp((microcap.dilutionRisk - 50) / 5, 0, policy.scannerMaxAdjustment) : 0;
  const scannerAdjustment = clamp(scannerAdjustmentRaw - structuralPenalty, -policy.scannerMaxAdjustment, policy.scannerMaxAdjustment);
  const squeezeScore = microcap
    ? clamp(microcap.shortPressureScore * 0.65 + (100 - microcap.dilutionRisk) * 0.20 + Math.max(0, scannerAdjustmentRaw) * 0.75, 0, 100)
    : null;

  const hardBlockReason = stale
    ? 'STALE_INTELLIGENCE_DATA'
    : microcap && microcap.dilutionRisk >= policy.structuralHardBlock
      ? 'EXTREME_DILUTION_RISK'
      : book.spreadBps != null && finite(input.maxSpreadBps) != null && book.spreadBps > Number(input.maxSpreadBps)
        ? 'SPREAD_LIMIT_EXCEEDED'
        : null;

  const validation = input.validation ?? {};
  const forwardSamples = Math.max(0, finite(validation.forwardSamples, 0));
  const profitFactor = finite(validation.profitFactor);
  const expectedNetEdgeBps = finite(validation.expectedNetEdgeBps);
  const maxDrawdownPct = Math.abs(finite(validation.maxDrawdownPct, Number.POSITIVE_INFINITY));
  const regimeCount = Math.max(0, finite(validation.regimeCount, 0));
  const evidenceReady = forwardSamples >= policy.autoMinForwardSamples
    && profitFactor != null && profitFactor >= policy.autoMinProfitFactor
    && expectedNetEdgeBps != null && expectedNetEdgeBps >= policy.autoMinExpectedNetEdgeBps
    && maxDrawdownPct <= policy.autoMaxDrawdownPct
    && regimeCount >= policy.autoMinRegimeCount;

  const autoMode = hardBlockReason
    ? 'BLOCKED_RISK'
    : evidenceReady
      ? 'ELIGIBLE_FOR_PARENT_GATE'
      : 'PAPER_ONLY';

  const warnings = [];
  if (stale) warnings.push('STALE_DATA');
  if (!book.current.bids.length || !book.current.asks.length) warnings.push('ORDER_BOOK_NOT_AVAILABLE');
  if (!trades.rows.length) warnings.push('TRADE_FLOW_NOT_AVAILABLE');
  if (market === 'CRYPTO_FUTURES' && derivatives?.oiDeltaPct == null) warnings.push('OI_DELTA_NOT_AVAILABLE');
  if (market === 'US_STOCK' && input.microcap == null) warnings.push('MICROCAP_STRUCTURAL_DATA_NOT_AVAILABLE');
  if (!evidenceReady) warnings.push('AUTO_TRADING_FORWARD_EVIDENCE_INSUFFICIENT');

  return {
    contract: 'market-intelligence-sidecar/v1',
    market,
    symbol: String(input.symbol ?? '').toUpperCase() || null,
    asOf,
    ageMs,
    policy,
    safety: {
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      orderSubmissionAllowed: false,
    },
    microstructure: {
      bookImbalance: book.bookImbalance,
      spreadBps: book.spreadBps,
      micropriceBiasBps: book.micropriceBiasBps,
      ofi: book.ofi,
      cvdNormalized: trades.cvdNormalized,
      priceReturnBps: trades.priceReturnBps,
      bullishAbsorptionScore: trades.bullishAbsorptionScore,
      bearishAbsorptionScore: trades.bearishAbsorptionScore,
      liquidityWithdrawal: wall,
    },
    derivatives,
    structural: microcap ? { ...microcap, shortSqueezeScore: squeezeScore } : null,
    scanner: {
      mode: 'SOFT_INTELLIGENCE_LAYER',
      adjustment: scannerAdjustment,
      intelligenceScore,
      bullishScore,
      bearishScore,
      grade: grade(Math.max(bullishScore, bearishScore)),
      hardBlockReason,
    },
    autoTrading: {
      mode: autoMode,
      parentGateRequired: true,
      orderAllowed: false,
      evidenceReady,
      hardBlockReason,
      evidence: { forwardSamples, profitFactor, expectedNetEdgeBps, maxDrawdownPct, regimeCount },
    },
    warnings,
  };
}

export { DEFAULT_POLICY };
