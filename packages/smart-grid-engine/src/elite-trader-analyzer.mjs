// elite-trader-analyzer.mjs
// BLOCK 19 Step 5 — Elite Trader 공개 데이터 순수 분석기
//
// 원칙:
//   - 네트워크/파일 접근 절대 없음 (fs/fetch/axios import 없음)
//   - 순수 함수만 export — 입력 데이터만 처리
//   - 데이터가 없으면 null / available:false (임의 추정 금지)
//   - 주문 권한 필드 절대 포함 금지 (canTrade/shouldEnter/orderAllowed 등)
//   - advisoryOnly: true 항상 강제
//   - 형식 오류 / 시간 역전 / 중복 / NaN 감지 → warnings 에 기록

export const ELITE_ANALYZER_VERSION = '1.0.0';

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function emptyMetric(reason) {
  return { value: null, available: false, reason };
}

function okMetric(value) {
  return { value, available: true, reason: null };
}

function detectTrade(raw) {
  // 지원 입력 형식 1: { id, side, entryMs, exitMs, pnl, ... }
  // 지원 입력 형식 2: { id, type/side, openedAt, closedAt, pnl/realizedPnl, ... }
  const id = raw?.id ?? raw?.tradeId ?? null;
  const side = (raw?.side ?? raw?.type ?? '').toString().toLowerCase();
  const entryMs = raw?.entryMs ?? raw?.openedAt ?? raw?.openTime ?? null;
  const exitMs = raw?.exitMs ?? raw?.closedAt ?? raw?.closeTime ?? null;
  const pnl = raw?.pnl ?? raw?.realizedPnl ?? raw?.netPnl ?? null;
  return { id, side, entryMs, exitMs, pnl };
}

function normalizeTrades(rawData) {
  const warnings = [];
  let list = [];
  if (Array.isArray(rawData?.trades)) list = rawData.trades;
  else if (Array.isArray(rawData?.closedPositions)) list = rawData.closedPositions;
  else if (Array.isArray(rawData?.positions)) {
    list = rawData.positions.filter((p) => {
      const s = (p?.status ?? '').toString().toLowerCase();
      return s === 'closed' || p?.closedAt != null || p?.exitPrice != null;
    });
  } else if (Array.isArray(rawData)) list = rawData;
  else return { trades: [], warnings: ['INPUT_NOT_RECOGNIZED'] };

  const seenIds = new Set();
  const cleaned = [];
  for (const raw of list) {
    const t = detectTrade(raw);
    if (!isFiniteNumber(t.pnl)) {
      warnings.push(`TRADE_SKIP_INVALID_PNL:${t.id ?? 'unknown'}`);
      continue;
    }
    if (t.id != null && seenIds.has(t.id)) {
      warnings.push(`TRADE_DUPLICATE_ID:${t.id}`);
      continue;
    }
    if (t.id != null) seenIds.add(t.id);
    cleaned.push(t);
  }

  // 시간 역전 감지 및 정렬
  let timeInversion = false;
  for (const t of cleaned) {
    if (isFiniteNumber(t.entryMs) && isFiniteNumber(t.exitMs) && t.exitMs < t.entryMs) {
      timeInversion = true;
      break;
    }
  }
  if (timeInversion) {
    warnings.push('TIME_INVERSION_DETECTED');
    // 정렬 가능한 것만 정렬 (역전은 warning + 재정렬 시도)
    cleaned.sort((a, b) => (a.entryMs ?? 0) - (b.entryMs ?? 0));
  }

  return { trades: cleaned, warnings };
}

function computeMetrics(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const totalReturnUsdt = trades.reduce((s, t) => s + t.pnl, 0);

  const winRate = n > 0 ? (wins.length / n) * 100 : null;

  // 롱/숏 비율
  const longs = trades.filter((t) => t.side === 'long' || t.side === 'buy');
  const shorts = trades.filter((t) => t.side === 'short' || t.side === 'sell');
  const longShortRatio = (longs.length + shorts.length) > 0
    ? { long: longs.length, short: shorts.length, ratio: shorts.length > 0 ? longs.length / shorts.length : null }
    : null;

  // 최대 연속 손실
  let maxConsec = 0;
  let cur = 0;
  for (const t of trades) {
    if (t.pnl < 0) { cur += 1; maxConsec = Math.max(maxConsec, cur); }
    else cur = 0;
  }

  // 데이터 기간
  const entryTimes = trades.map((t) => t.entryMs).filter(isFiniteNumber);
  const exitTimes = trades.map((t) => t.exitMs).filter(isFiniteNumber);
  const allTimes = [...entryTimes, ...exitTimes];
  const dataPeriod = allTimes.length > 0
    ? {
        startMs: Math.min(...allTimes),
        endMs: Math.max(...allTimes),
        spanDays: (Math.max(...allTimes) - Math.min(...allTimes)) / (24 * 3600_000),
      }
    : null;

  // 거래 빈도 (trades/day)
  const tradeFrequency = dataPeriod && dataPeriod.spanDays > 0
    ? n / dataPeriod.spanDays
    : null;

  // 평균 보유 시간
  const holds = trades
    .filter((t) => isFiniteNumber(t.entryMs) && isFiniteNumber(t.exitMs) && t.exitMs >= t.entryMs)
    .map((t) => t.exitMs - t.entryMs);
  const averageHoldMs = holds.length > 0
    ? holds.reduce((s, v) => s + v, 0) / holds.length
    : null;

  // 최대 낙폭 (누적 PnL 기준 % — 시작 자본 명시 없으면 USDT 기준)
  let cumulative = 0;
  let peak = 0;
  let maxDdUsdt = 0;
  for (const t of trades) {
    cumulative += t.pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDdUsdt) maxDdUsdt = dd;
  }
  const maxDrawdownUsdt = trades.length > 0 ? maxDdUsdt : null;

  return {
    totalReturnUsdt,
    winRate,
    longShortRatio,
    consecutiveLosses: maxConsec,
    dataPeriod,
    tradeFrequency,
    averageHoldMs,
    maxDrawdownUsdt,
    grossWin,
    grossLoss,
    sampleSize: n,
  };
}

/**
 * Elite Trader 공개 데이터 분석 (순수 함수).
 *
 * 반환 객체에는 주문 실행 관련 필드가 절대 포함되지 않는다:
 *   canTrade / shouldEnter / orderAllowed / canEnter / placeOrder / liveAuthority
 *
 * advisoryOnly: true 항상.
 */
export function analyzeEliteTrader(rawData, opts = {}) {
  const warnings = [];
  let advisoryOnly = true; // 강제

  if (rawData == null || typeof rawData !== 'object') {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      advisoryOnly,
      sampleSize: null,
      dataPeriod: null,
      metrics: {
        totalReturnUsdt: emptyMetric('INVALID_INPUT'),
        maxDrawdownPct: emptyMetric('INVALID_INPUT'),
        winRate: emptyMetric('INVALID_INPUT'),
        longShortRatio: emptyMetric('INVALID_INPUT'),
        consecutiveLosses: emptyMetric('INVALID_INPUT'),
        tradeFrequency: emptyMetric('INVALID_INPUT'),
        averageHoldMs: emptyMetric('INVALID_INPUT'),
      },
      warnings,
      version: ELITE_ANALYZER_VERSION,
    };
  }

  const { trades, warnings: parseWarnings } = normalizeTrades(rawData);
  warnings.push(...parseWarnings);

  if (trades.length === 0) {
    return {
      ok: true,
      advisoryOnly,
      sampleSize: 0,
      dataPeriod: null,
      metrics: {
        totalReturnUsdt: emptyMetric('NO_TRADES'),
        maxDrawdownPct: emptyMetric('NO_TRADES'),
        winRate: emptyMetric('NO_TRADES'),
        longShortRatio: emptyMetric('NO_TRADES'),
        consecutiveLosses: emptyMetric('NO_TRADES'),
        tradeFrequency: emptyMetric('NO_TRADES'),
        averageHoldMs: emptyMetric('NO_TRADES'),
      },
      warnings,
      version: ELITE_ANALYZER_VERSION,
    };
  }

  const m = computeMetrics(trades);

  const metrics = {
    totalReturnUsdt: okMetric(m.totalReturnUsdt),
    maxDrawdownPct: m.maxDrawdownUsdt != null
      ? { value: m.maxDrawdownUsdt, available: true, reason: null, unit: 'USDT' }
      : emptyMetric('NO_CAPITAL_BASE'),
    winRate: m.winRate != null ? okMetric(m.winRate) : emptyMetric('NO_TRADES'),
    longShortRatio: m.longShortRatio
      ? { value: m.longShortRatio, available: true, reason: null }
      : emptyMetric('NO_SIDE_DATA'),
    consecutiveLosses: okMetric(m.consecutiveLosses),
    tradeFrequency: m.tradeFrequency != null
      ? { value: m.tradeFrequency, available: true, reason: null, unit: 'trades/day' }
      : emptyMetric('NO_PERIOD'),
    averageHoldMs: m.averageHoldMs != null
      ? okMetric(m.averageHoldMs)
      : emptyMetric('NO_HOLD_DATA'),
  };

  return {
    ok: true,
    advisoryOnly,
    sampleSize: m.sampleSize,
    dataPeriod: m.dataPeriod,
    metrics,
    warnings,
    version: ELITE_ANALYZER_VERSION,
  };
}

/**
 * 절대 금지 필드가 결과에 없는지 확인 (테스트 및 게이트에서 사용).
 */
export function assertNoOrderAuthority(result) {
  const forbidden = [
    'canTrade', 'shouldEnter', 'orderAllowed', 'canEnter', 'placeOrder',
    'liveAuthority', 'liveTradingEnabled', 'autoTradingEnabled',
    'allowNewEntry', 'executionAuthority',
  ];
  const violations = [];
  for (const k of forbidden) {
    if (result && Object.prototype.hasOwnProperty.call(result, k)) {
      violations.push(k);
    }
  }
  return { ok: violations.length === 0, violations };
}
