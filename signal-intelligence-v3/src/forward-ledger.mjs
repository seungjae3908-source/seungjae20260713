// Forward paper ledger for Signal Intelligence V3.
//
// Every CANDIDATE signal that survives the barrier is recorded as a virtual
// position, then followed with later public candles until its stop, its first
// target or its time limit is reached. Nothing here places an order, reads an
// account or uses a credential: it only turns "the signal said buy here" into
// an honest, cost-adjusted track record that a human can judge.
//
// Fill rules are deliberately pessimistic:
//  * entry at the price seen when the signal was recorded, never a better one;
//  * if stop and target are both touched inside one candle, the stop counts;
//  * a gap through the stop exits at the gap open, not at the stop;
//  * round-trip costs (fees, slippage, tax / FX where they apply) are charged.

export const FORWARD_LEDGER_VERSION = 1;
export const MAX_OPEN_POSITIONS = 200;
export const MAX_OPEN_PER_MARKET = 60;
export const MAX_CLOSED_KEPT = 5_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMEFRAME_MS = Object.freeze({ '15m': 15 * MINUTE, '60m': HOUR, '4H': 4 * HOUR, '1D': DAY });
// How long a virtual position may stay open, in bars of its own timeframe.
export const MAX_HOLD_BARS = Object.freeze({ '15m': 48, '60m': 48, '4H': 30, '1D': 15 });

// Round-trip cost per market as a fraction of notional. Mirrors the research
// lanes: fees + slippage + spread on both sides, KR sell tax (0.20% in 2026),
// US retail commission and KRW/USD spread assumptions.
export const ROUND_TRIP_COST = Object.freeze({
  KR_STOCK: 0.00015 * 2 + 0.002 + 0.001 * 2 + 0.0005,
  US_STOCK: (0.0001 + 0.001) * 2 + (0.0005 + 0.001) * 2 + 0.0001,
  CRYPTO_SPOT: 0.0005 * 2 + 0.0005 * 2 + 0.0002,
  CRYPTO_FUTURES: 0.0006 * 2 + 0.0005 * 2 + 0.0002,
});
// Perpetual funding is unknown per position, so both sides are charged a flat
// 0.01% per 8 hours held. Conservative: a short is not credited when it receives.
export const FUTURES_FUNDING_PER_8H = 0.0001;

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

export function directionSign(direction) {
  const value = String(direction ?? '').toUpperCase();
  if (value === 'BUY' || value === 'LONG') return 1;
  if (value === 'SHORT') return -1;
  return 0;
}

export function emptyLedger(nowMs = 0) {
  return { schemaVersion: FORWARD_LEDGER_VERSION, positions: {}, closed: [], skipped: {}, cooldowns: {}, updatedAt: new Date(nowMs).toISOString() };
}

export function normalizeLedger(value, nowMs = 0) {
  if (!value || value.schemaVersion !== FORWARD_LEDGER_VERSION || typeof value.positions !== 'object') return emptyLedger(nowMs);
  return {
    schemaVersion: FORWARD_LEDGER_VERSION,
    positions: { ...value.positions },
    closed: Array.isArray(value.closed) ? [...value.closed] : [],
    skipped: { ...(value.skipped ?? {}) },
    cooldowns: { ...(value.cooldowns ?? {}) },
    updatedAt: value.updatedAt ?? new Date(nowMs).toISOString(),
  };
}

/**
 * Decides whether a signal's plan can be recorded and at what price. Returns
 * { ok:true, entry, stop, target, riskFraction } or { ok:false, reason }.
 */
export function planEntry({ direction, plan }) {
  const sign = directionSign(direction);
  if (sign === 0) return { ok: false, reason: 'DIRECTION_NOT_TRACKED' };
  const price = positive(plan?.price);
  const stop = positive(plan?.stopLoss);
  const target = positive(plan?.targets?.[0]);
  const from = positive(plan?.entryZone?.from);
  const to = positive(plan?.entryZone?.to);
  if (!price || !stop || !target || !from || !to) return { ok: false, reason: 'PLAN_INCOMPLETE' };
  // Stop and target must be on the correct side of the price.
  if (sign * (price - stop) <= 0) return { ok: false, reason: 'PRICE_AT_OR_BEYOND_STOP' };
  if (sign * (target - price) <= 0) return { ok: false, reason: 'PRICE_AT_OR_BEYOND_TARGET' };
  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  // For a long, "worse than the zone" is above it; for a short, below it.
  const worseThanZone = sign === 1 ? price > high : price < low;
  if (worseThanZone && reward / risk < 1) return { ok: false, reason: 'OUTSIDE_ZONE_LOW_REWARD_RISK' };
  const riskFraction = risk / price;
  if (!(riskFraction > 0 && riskFraction <= 0.25)) return { ok: false, reason: 'STOP_DISTANCE_IMPLAUSIBLE' };
  return { ok: true, entry: price, stop, target, riskFraction, worseThanZone };
}

function rowsOf(snapshot) {
  const lists = snapshot?.lists ?? {};
  return Object.values(lists).flatMap((rows) => (Array.isArray(rows) ? rows : []));
}

function holdMs(timeframe) {
  const frame = TIMEFRAME_MS[timeframe] ?? DAY;
  return frame * (MAX_HOLD_BARS[timeframe] ?? 15);
}

/** Opens virtual positions for new CANDIDATE rows. Pure: returns what happened. */
export function openFromSnapshot({ ledger, snapshot, nowMs }) {
  const next = normalizeLedger(ledger, nowMs);
  const opened = [];
  const skipped = [];
  const perMarket = {};
  for (const position of Object.values(next.positions)) perMarket[position.market] = (perMarket[position.market] ?? 0) + 1;
  for (const row of rowsOf(snapshot)) {
    if (row?.state !== 'CANDIDATE' || typeof row.id !== 'string') continue;
    if (next.positions[row.id]) continue;
    if (Number(next.cooldowns[row.id]) > nowMs) continue;
    const plan = row.provenance?.signalPlan;
    const verdict = planEntry({ direction: row.direction, plan });
    if (!verdict.ok) {
      next.skipped[row.id] = { reason: verdict.reason, at: new Date(nowMs).toISOString() };
      skipped.push({ id: row.id, reason: verdict.reason });
      continue;
    }
    if (Object.keys(next.positions).length >= MAX_OPEN_POSITIONS || (perMarket[row.market] ?? 0) >= MAX_OPEN_PER_MARKET) {
      skipped.push({ id: row.id, reason: 'LEDGER_CAPACITY' });
      continue;
    }
    const research = row.provenance?.researchEvidence ?? null;
    const position = {
      id: row.id,
      market: row.market,
      symbol: row.symbol,
      direction: String(row.direction).toUpperCase(),
      strategy: row.strategy,
      timeframe: row.timeframe,
      // Which rule produced the signal: a holdout-passed research rule, or the canonical handoff.
      source: research?.ruleId ? `RESEARCH:${research.ruleId}` : 'CANONICAL_HANDOFF',
      openedAtMs: nowMs,
      openedAt: new Date(nowMs).toISOString(),
      entry: verdict.entry,
      stop: verdict.stop,
      target: verdict.target,
      riskFraction: verdict.riskFraction,
      worseThanZone: verdict.worseThanZone,
      expiresAtMs: nowMs + holdMs(row.timeframe),
      lastPrice: verdict.entry,
      lastMarkedAtMs: nowMs,
      executionAuthority: 'NONE',
    };
    next.positions[row.id] = position;
    perMarket[row.market] = (perMarket[row.market] ?? 0) + 1;
    opened.push(position);
    delete next.skipped[row.id];
  }
  next.updatedAt = new Date(nowMs).toISOString();
  return { ledger: next, opened, skipped };
}

function costFor(position, heldMs) {
  const base = ROUND_TRIP_COST[position.market] ?? 0.004;
  const funding = position.market === 'CRYPTO_FUTURES' ? FUTURES_FUNDING_PER_8H * (heldMs / (8 * HOUR)) : 0;
  return base + funding;
}

/**
 * Walks later candles over one open position. `candles` are
 * { time, open, high, low, close } with `time` = bar open (ms), oldest first.
 * Returns { closed:false, lastPrice } or { closed:true, exit, exitTimeMs, reason }.
 */
export function walkPosition(position, candles, nowMs) {
  const sign = directionSign(position.direction);
  const frame = TIMEFRAME_MS[position.timeframe] ?? DAY;
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((c) => [c?.time, c?.open, c?.high, c?.low, c?.close].every((v) => Number.isFinite(Number(v))))
    .sort((a, b) => a.time - b.time);
  let lastPrice = position.lastPrice;
  for (const candle of rows) {
    const open = Number(candle.open); const high = Number(candle.high); const low = Number(candle.low); const close = Number(candle.close);
    const barEnd = candle.time + frame;
    if (barEnd <= position.openedAtMs) continue;
    const startsAfterEntry = candle.time >= position.openedAtMs;
    if (!startsAfterEntry) {
      // The candle that was already running at entry: only its latest price is
      // trustworthy, its earlier highs and lows happened before the entry.
      lastPrice = close;
      if (sign * (close - position.stop) <= 0) return { closed: true, exit: close, exitTimeMs: Math.min(nowMs, barEnd), reason: 'STOP' };
      if (sign * (close - position.target) >= 0) return { closed: true, exit: position.target, exitTimeMs: Math.min(nowMs, barEnd), reason: 'TARGET' };
      continue;
    }
    const adverse = sign === 1 ? low : high;
    const favourable = sign === 1 ? high : low;
    if (sign * (open - position.stop) <= 0) return { closed: true, exit: open, exitTimeMs: candle.time, reason: 'STOP_GAP' };
    if (sign * (adverse - position.stop) <= 0) return { closed: true, exit: position.stop, exitTimeMs: Math.min(nowMs, barEnd), reason: 'STOP' };
    if (sign * (favourable - position.target) >= 0) return { closed: true, exit: position.target, exitTimeMs: Math.min(nowMs, barEnd), reason: 'TARGET' };
    lastPrice = close;
    if (barEnd >= position.expiresAtMs && barEnd <= nowMs) return { closed: true, exit: close, exitTimeMs: barEnd, reason: 'TIME' };
  }
  if (nowMs >= position.expiresAtMs && rows.length > 0) {
    return { closed: true, exit: lastPrice, exitTimeMs: nowMs, reason: 'TIME' };
  }
  return { closed: false, lastPrice };
}

export function settle(position, result) {
  const sign = directionSign(position.direction);
  const gross = sign * ((result.exit - position.entry) / position.entry);
  const held = Math.max(0, result.exitTimeMs - position.openedAtMs);
  const cost = costFor(position, held);
  const net = gross - cost;
  return {
    id: position.id,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategy: position.strategy,
    timeframe: position.timeframe,
    source: position.source,
    openedAt: position.openedAt,
    closedAt: new Date(result.exitTimeMs).toISOString(),
    entry: position.entry,
    exit: result.exit,
    reason: result.reason,
    grossReturn: gross,
    cost,
    netReturn: net,
    // Result in units of the risk taken at the stop (after costs).
    rMultiple: position.riskFraction > 0 ? net / position.riskFraction : 0,
    heldHours: held / HOUR,
  };
}

/**
 * Updates every open position. `fetchCandles(position)` returns candles or
 * throws; a failure leaves that position open until the next cycle.
 */
export async function updateOpenPositions({ ledger, nowMs, fetchCandles, concurrency = 4, deadlineMs = 90_000, clock = () => Date.now() }) {
  const next = normalizeLedger(ledger, nowMs);
  const started = clock();
  const ids = Object.keys(next.positions);
  const closedNow = [];
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor]; cursor += 1;
      if (clock() - started > deadlineMs) { errors.push({ id, reason: 'DEADLINE' }); continue; }
      const position = next.positions[id];
      try {
        const candles = await fetchCandles(position);
        const result = walkPosition(position, candles, nowMs);
        if (result.closed) {
          closedNow.push(settle(position, result));
        } else {
          next.positions[id] = { ...position, lastPrice: result.lastPrice, lastMarkedAtMs: nowMs };
        }
      } catch (error) {
        errors.push({ id, reason: String(error?.message ?? error).split(':')[0].slice(0, 80) });
        // Never leave a position open forever because its data vanished.
        if (nowMs > position.expiresAtMs + 2 * (TIMEFRAME_MS[position.timeframe] ?? DAY)) {
          closedNow.push(settle(position, { exit: position.lastPrice, exitTimeMs: nowMs, reason: 'DATA_LOST' }));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length || 1)) }, worker));
  for (const row of closedNow) {
    delete next.positions[row.id];
    // Do not re-open the same signal identity until a full hold period has passed.
    next.cooldowns[row.id] = nowMs + holdMs(row.timeframe);
  }
  for (const [id, until] of Object.entries(next.cooldowns)) if (Number(until) <= nowMs) delete next.cooldowns[id];
  next.closed = [...next.closed, ...closedNow].slice(-MAX_CLOSED_KEPT);
  next.updatedAt = new Date(nowMs).toISOString();
  return { ledger: next, closedNow, errors };
}

// ---------- scorecard ----------

function mean(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + ((v - m) ** 2), 0) / (values.length - 1));
}

export const PROMOTION_CRITERIA = Object.freeze({
  minimumTrades: 30,
  // Lower bound of the 95% interval of the mean net return must be above zero.
  confidenceZ: 1.96,
  minimumDistinctSymbols: 3,
  minimumPositiveSymbolShare: 0.6,
});

export function summarizeTrades(trades) {
  const n = trades.length;
  const net = trades.map((t) => t.netReturn);
  const m = mean(net);
  const sd = stdev(net);
  const half = n > 1 ? PROMOTION_CRITERIA.confidenceZ * sd / Math.sqrt(n) : Infinity;
  const gains = net.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const losses = -net.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  const bySymbol = new Map();
  for (const t of trades) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t.netReturn]);
  const positiveSymbols = [...bySymbol.values()].filter((rows) => mean(rows) > 0).length;
  const lower = Number.isFinite(half) ? m - half : null;
  const symbolShare = bySymbol.size ? positiveSymbols / bySymbol.size : 0;
  const checks = {
    enoughTrades: n >= PROMOTION_CRITERIA.minimumTrades,
    confidenceAboveZero: lower != null && lower > 0,
    enoughSymbols: bySymbol.size >= PROMOTION_CRITERIA.minimumDistinctSymbols,
    symbolsPositive: symbolShare >= PROMOTION_CRITERIA.minimumPositiveSymbolShare,
  };
  return {
    trades: n,
    wins: net.filter((v) => v > 0).length,
    winRate: n ? net.filter((v) => v > 0).length / n : 0,
    meanNetReturn: m,
    meanR: mean(trades.map((t) => t.rMultiple)),
    confidenceLow: lower,
    confidenceHigh: Number.isFinite(half) ? m + half : null,
    profitFactor: losses > 0 ? gains / losses : (gains > 0 ? null : 0),
    distinctSymbols: bySymbol.size,
    positiveSymbolShare: symbolShare,
    stops: trades.filter((t) => t.reason === 'STOP' || t.reason === 'STOP_GAP').length,
    targets: trades.filter((t) => t.reason === 'TARGET').length,
    timeouts: trades.filter((t) => t.reason === 'TIME' || t.reason === 'DATA_LOST').length,
    checks,
    promotionReady: Object.values(checks).every(Boolean),
  };
}

export function buildScorecard(ledger, nowMs) {
  const closed = Array.isArray(ledger?.closed) ? ledger.closed : [];
  const open = Object.values(ledger?.positions ?? {});
  const group = (keyOf) => {
    const map = new Map();
    for (const trade of closed) map.set(keyOf(trade), [...(map.get(keyOf(trade)) ?? []), trade]);
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, summarizeTrades(rows)]));
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    criteria: PROMOTION_CRITERIA,
    openPositions: open.length,
    openByMarket: open.reduce((acc, p) => ({ ...acc, [p.market]: (acc[p.market] ?? 0) + 1 }), {}),
    overall: summarizeTrades(closed),
    byMarket: group((t) => `${t.market}|${t.direction}`),
    bySource: group((t) => `${t.market}|${t.direction}|${t.source}`),
    executionAuthority: 'NONE',
  };
}

const MARKET_KO = Object.freeze({ KR_STOCK: '국내주식', US_STOCK: '해외주식', CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물' });
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);

export function formatScorecardKo(card) {
  const lines = [`📒 신호 모의매매 성적표 (${card.generatedAt.slice(0, 16).replace('T', ' ')} UTC)`,
    `진행 중 ${card.openPositions}건 · 종료 ${card.overall.trades}건 · 실주문 없음(가상 기록)`];
  if (card.overall.trades === 0) { lines.push('아직 종료된 가상 거래가 없습니다. 손절·목표·시간 도달 시 기록됩니다.'); return lines.join('\n'); }
  const rows = Object.entries(card.bySource).sort((a, b) => b[1].trades - a[1].trades).slice(0, 8);
  for (const [key, s] of rows) {
    const [market, direction, source] = key.split('|');
    const label = `${MARKET_KO[market] ?? market} ${direction === 'SHORT' ? '숏' : direction === 'LONG' ? '롱' : '매수'}`;
    const verdict = s.promotionReady ? '✅ 실주문 후보 조건 충족' : (!s.checks.enoughTrades ? `⏳ 표본 부족(${s.trades}/${card.criteria.minimumTrades})` : '❌ 조건 미충족');
    lines.push(`• ${label} [${source.replace('RESEARCH:', '규칙 ')}] ${s.trades}건 · 승률 ${(s.winRate * 100).toFixed(0)}% · 비용 반영 평균 ${pct(s.meanNetReturn)} · 95% 하한 ${pct(s.confidenceLow)} · ${verdict}`);
  }
  lines.push(`기준: ${card.criteria.minimumTrades}건 이상 · 95% 하한 > 0 · 서로 다른 ${card.criteria.minimumDistinctSymbols}종목 이상에서 ${Math.round(card.criteria.minimumPositiveSymbolShare * 100)}% 이상 플러스`);
  return lines.join('\n');
}
