// Strategy zoo v1 — public trading strategies, one honest backtest (research only).
//
// Owner request 2026-10-18: test what traders, papers, books, blogs, Korean
// communities and exchange bots publish, on all four app markets, and say which
// ones are usable. Every rule here uses its PUBLISHED parameters (no tuning on
// this data) and only daily OHLCV (+ funding for perpetuals).
//
// Execution model (same for every rule, conservative):
//   * a signal uses the bar's close and earlier bars only;
//   * it is executed at the NEXT open; the gap from close to next open is held
//     by the previous position;
//   * every unit of turnover pays the market's one-side cost (fee + tax +
//     slippage); perpetual positions pay/receive the recorded funding;
//   * spot and stocks are long-only (a short signal means cash); futures may
//     be short and are capped at 1x notional per symbol sleeve;
//   * a market portfolio splits capital equally over the symbols that have a
//     bar that day (timing rules) or holds the top-K of a ranking (rotation).
// Evaluation: full span, first 60% (discovery) and last 40% (validation),
// equal-weight buy-and-hold of the same universe as the benchmark, and the
// Deflated Sharpe Ratio over every strategy tried in that market (Bailey &
// López de Prado 2014) so that trying ~40 rules is not mistaken for skill.
// Known bias: universes are today's large caps / listed coins (survivorship),
// which flatters buy-and-hold and rotation more than timing rules.

export const STRATEGY_ZOO_CONTRACT_V1 = 'strategy-zoo/v1';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

export const STRATEGY_ZOO_MARKETS_V1 = Object.freeze({
  KR_STOCK: Object.freeze({ label: '국내주식', barsPerYear: 252, costPerSide: 0.00205, shortAllowed: false, index: '069500' }),
  US_STOCK: Object.freeze({ label: '미국주식', barsPerYear: 252, costPerSide: 0.0012, shortAllowed: false, index: 'SPY' }),
  CRYPTO_SPOT: Object.freeze({ label: '코인현물(업비트)', barsPerYear: 365, costPerSide: 0.0012, shortAllowed: false, index: 'KRW-BTC' }),
  CRYPTO_FUTURES: Object.freeze({ label: '코인선물(비트겟)', barsPerYear: 365, costPerSide: 0.0011, shortAllowed: true, index: 'BTCUSDT' }),
  US_TAA: Object.freeze({ label: '미국 ETF 자산배분', barsPerYear: 252, costPerSide: 0.0008, shortAllowed: false, index: 'SPY' }),
});

// ------------------------------------------------------------------ indicators (pure)

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < values.length; i += 1) {
    e = e === null ? values[i] : (values[i] * k) + (e * (1 - k));
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(close, n) {
  const out = new Array(close.length).fill(null);
  let gain = 0; let loss = 0;
  for (let i = 1; i < close.length; i += 1) {
    const d = close[i] - close[i - 1];
    const g = Math.max(0, d); const l = Math.max(0, -d);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - (100 / (1 + (gain / loss))); }
    } else {
      gain = ((gain * (n - 1)) + g) / n;
      loss = ((loss * (n - 1)) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - (100 / (1 + (gain / loss)));
    }
  }
  return out;
}

export function trueRange(bars) {
  return bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}

/** Wilder ATR. */
export function atr(bars, n) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  let a = null;
  for (let i = 0; i < bars.length; i += 1) {
    if (i < n - 1) continue;
    if (a === null) { let s = 0; for (let j = i - n + 1; j <= i; j += 1) s += tr[j]; a = s / n; }
    else a = ((a * (n - 1)) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export function rollingMax(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) { let m = -Infinity; for (let j = i - n + 1; j <= i; j += 1) if (values[j] > m) m = values[j]; out[i] = m; }
  return out;
}

export function rollingMin(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) { let m = Infinity; for (let j = i - n + 1; j <= i; j += 1) if (values[j] < m) m = values[j]; out[i] = m; }
  return out;
}

export function rollingStd(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) {
    let s = 0; let q = 0;
    for (let j = i - n + 1; j <= i; j += 1) { s += values[j]; q += values[j] * values[j]; }
    const mean = s / n;
    out[i] = Math.sqrt(Math.max(0, (q / n) - (mean * mean)));
  }
  return out;
}

function logReturns(close) {
  return close.map((c, i) => (i === 0 || !(close[i - 1] > 0) ? 0 : Math.log(c / close[i - 1])));
}

/** Supertrend direction (+1 up / −1 down), ATR(n) × m bands (Olivier Seban). */
export function supertrendDirection(bars, n = 10, m = 3) {
  const a = atr(bars, n);
  const dir = new Array(bars.length).fill(null);
  let upper = null; let lower = null; let d = 1;
  for (let i = 0; i < bars.length; i += 1) {
    if (a[i] === null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + (m * a[i]); const bl = mid - (m * a[i]);
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    upper = upper === null || bu < upper || prevClose > upper ? bu : upper;
    lower = lower === null || bl > lower || prevClose < lower ? bl : lower;
    if (d === 1 && bars[i].close < lower) d = -1;
    else if (d === -1 && bars[i].close > upper) d = 1;
    dir[i] = d;
  }
  return dir;
}

/** Wilder ADX(n). */
export function adx(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let trS = 0; let pS = 0; let mS = 0; let adxV = null; const dxs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high; const dn = bars[i - 1].low - bars[i].low;
    const pdm = up > dn && up > 0 ? up : 0; const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= n) { trS += tr; pS += pdm; mS += mdm; if (i < n) continue; }
    else { trS = trS - (trS / n) + tr; pS = pS - (pS / n) + pdm; mS = mS - (mS / n) + mdm; }
    const pdi = trS > 0 ? (100 * pS) / trS : 0; const mdi = trS > 0 ? (100 * mS) / trS : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (adxV === null) { dxs.push(dx); if (dxs.length === n) adxV = dxs.reduce((x, y) => x + y, 0) / n; }
    else adxV = ((adxV * (n - 1)) + dx) / n;
    out[i] = adxV;
  }
  return out;
}

/** Zarattini-Pagani-Barbon (2025) Donchian ensemble position for one lookback (0/1). */
function donchianTrail(close, L) {
  const hi = rollingMax(close, L); const lo = rollingMin(close, L);
  const pos = new Array(close.length).fill(0); let inPos = false; let stop = null;
  for (let i = L; i < close.length; i += 1) {
    if (!inPos && close[i] > hi[i - 1]) { inPos = true; stop = (hi[i] + lo[i]) / 2; }
    else if (inPos) { stop = Math.max(stop, (hi[i] + lo[i]) / 2); if (close[i] < stop) { inPos = false; stop = null; } }
    pos[i] = inPos ? 1 : 0;
  }
  return pos;
}


function wma(values, n) {
  const out = new Array(values.length).fill(null); const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i += 1) { let s = 0; for (let k = 0; k < n; k += 1) { if (values[i - k] === null) { s = null; break; } s += values[i - k] * (n - k); } out[i] = s === null ? null : s / denom; }
  return out;
}

/** Hull MA: WMA(2·WMA(n/2) − WMA(n), √n). */
export function hullMa(close, n) {
  const a = wma(close, Math.floor(n / 2)); const b = wma(close, n);
  const diff = close.map((_, i) => (a[i] !== null && b[i] !== null ? (2 * a[i]) - b[i] : null));
  const first = diff.findIndex((v) => v !== null); const m = Math.floor(Math.sqrt(n));
  const out = new Array(close.length).fill(null); if (first < 0) return out;
  const tail = wma(diff.slice(first), m); for (let i = 0; i < tail.length; i += 1) out[first + i] = tail[i];
  return out;
}

/** Parabolic SAR direction (+1/−1), AF 0.02 step 0.02 max 0.2 (Wilder 1978). */
export function parabolicSarDirection(bars, step = 0.02, maxAf = 0.2) {
  const dir = new Array(bars.length).fill(0); if (bars.length < 3) return dir;
  let up = bars[1].close >= bars[0].close; let sar = up ? bars[0].low : bars[0].high; let ep = up ? bars[1].high : bars[1].low; let af = step;
  for (let i = 2; i < bars.length; i += 1) {
    sar += af * (ep - sar);
    if (up) { sar = Math.min(sar, bars[i - 1].low, bars[i - 2].low); if (bars[i].low < sar) { up = false; sar = ep; ep = bars[i].low; af = step; } else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(maxAf, af + step); } }
    else { sar = Math.max(sar, bars[i - 1].high, bars[i - 2].high); if (bars[i].high > sar) { up = true; sar = ep; ep = bars[i].high; af = step; } else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(maxAf, af + step); } }
    dir[i] = up ? 1 : -1;
  }
  return dir;
}

/** +DI / −DI (Wilder, n). */
function directionalIndex(bars, n = 14) {
  const pdi = new Array(bars.length).fill(null); const mdi = new Array(bars.length).fill(null);
  let trS = 0; let pS = 0; let mS = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high; const dn = bars[i - 1].low - bars[i].low;
    const p2 = up > dn && up > 0 ? up : 0; const m2 = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= n) { trS += tr; pS += p2; mS += m2; if (i < n) continue; } else { trS = trS - (trS / n) + tr; pS = pS - (pS / n) + p2; mS = mS - (mS / n) + m2; }
    pdi[i] = trS > 0 ? (100 * pS) / trS : 0; mdi[i] = trS > 0 ? (100 * mS) / trS : 0;
  }
  return { pdi, mdi };
}

// ------------------------------------------------------------------ per-symbol timing rules
// Each returns target exposure T[i] in [-1, 1] decided at close i (null = flat).
// "state" rules hold until their exit condition fires.

function holdUntil(n, enter, exit) {
  const out = new Array(n).fill(0);
  let pos = 0;
  for (let i = 0; i < n; i += 1) {
    if (pos === 0 && enter(i)) pos = 1;
    else if (pos === 1 && exit(i)) pos = 0;
    out[i] = pos;
  }
  return out;
}

function holdUntilLongShort(n, longEnter, longExit, shortEnter, shortExit) {
  const out = new Array(n).fill(0);
  let pos = 0;
  for (let i = 0; i < n; i += 1) {
    if (pos === 1 && longExit(i)) pos = 0;
    if (pos === -1 && shortExit(i)) pos = 0;
    if (pos === 0) { if (longEnter(i)) pos = 1; else if (shortEnter(i)) pos = -1; }
    out[i] = pos;
  }
  return out;
}

const t = (v) => v !== null && v !== undefined && Number.isFinite(v);

export const TIMING_RULES_V1 = Object.freeze([
  { id: 'BUY_HOLD', family: '기준', name: '그냥 보유', source: 'benchmark', make: ({ n }) => new Array(n).fill(1) },
  { id: 'SMA200', family: '추세', name: '200일선 위에서만 보유', source: 'Faber 2007 (10-month SMA); Zakamulin 2017',
    make: ({ close, n }) => { const s = sma(close, 200); return close.map((c, i) => (t(s[i]) ? (c > s[i] ? 1 : -1) : 0)); } },
  { id: 'GOLDEN_CROSS', family: '추세', name: '50/200일선 골든크로스', source: 'practitioner classic',
    make: ({ close }) => { const f = sma(close, 50); const s = sma(close, 200); return close.map((_, i) => (t(s[i]) ? (f[i] > s[i] ? 1 : -1) : 0)); } },
  { id: 'TSMOM_12M', family: '추세', name: '12개월 시계열 모멘텀', source: 'Moskowitz, Ooi & Pedersen 2012',
    make: ({ close, year }) => close.map((c, i) => (i >= year ? (c > close[i - year] ? 1 : -1) : 0)) },
  { id: 'TSMOM_1M', family: '추세', name: '1개월 시계열 모멘텀', source: 'Moskowitz et al. 2012; crypto: Liu & Tsyvinski 2021',
    make: ({ close, month }) => close.map((c, i) => (i >= month ? (c > close[i - month] ? 1 : -1) : 0)) },
  { id: 'TURTLE_20_10', family: '돌파', name: '터틀 1 (20일 고점 돌파, 10일 저점 청산)', source: 'Faith, Way of the Turtle (2007)',
    make: ({ bars, close, n }) => { const hi = rollingMax(bars.map((b) => b.high), 20); const lo = rollingMin(bars.map((b) => b.low), 10);
      const hiS = rollingMin(bars.map((b) => b.low), 20); const loS = rollingMax(bars.map((b) => b.high), 10);
      return holdUntilLongShort(n, (i) => i > 0 && t(hi[i - 1]) && close[i] > hi[i - 1], (i) => i > 0 && t(lo[i - 1]) && close[i] < lo[i - 1],
        (i) => i > 0 && t(hiS[i - 1]) && close[i] < hiS[i - 1], (i) => i > 0 && t(loS[i - 1]) && close[i] > loS[i - 1]); } },
  { id: 'TURTLE_55_20', family: '돌파', name: '터틀 2 (55일 돌파, 20일 청산)', source: 'Faith (2007)',
    make: ({ bars, close, n }) => { const hi = rollingMax(bars.map((b) => b.high), 55); const lo = rollingMin(bars.map((b) => b.low), 20);
      const hiS = rollingMin(bars.map((b) => b.low), 55); const loS = rollingMax(bars.map((b) => b.high), 20);
      return holdUntilLongShort(n, (i) => i > 0 && t(hi[i - 1]) && close[i] > hi[i - 1], (i) => i > 0 && t(lo[i - 1]) && close[i] < lo[i - 1],
        (i) => i > 0 && t(hiS[i - 1]) && close[i] < hiS[i - 1], (i) => i > 0 && t(loS[i - 1]) && close[i] > loS[i - 1]); } },
  { id: 'CONNORS_RSI2', family: '역추세', name: '코너스 RSI(2) (200일선 위 눌림 매수)', source: 'Connors & Alvarez, Short Term Trading Strategies That Work (2008)',
    make: ({ close, n }) => { const r = rsi(close, 2); const s200 = sma(close, 200); const s5 = sma(close, 5);
      return holdUntil(n, (i) => t(s200[i]) && t(r[i]) && close[i] > s200[i] && r[i] < 10, (i) => t(s5[i]) && close[i] > s5[i]); } },
  { id: 'IBS_LOW', family: '역추세', name: 'IBS < 0.2 다음날 매도', source: 'Pagonidis 2014 (IBS); Quantpedia',
    make: ({ bars }) => bars.map((b) => (b.high > b.low && (b.close - b.low) / (b.high - b.low) < 0.2 ? 1 : 0)) },
  { id: 'BB_REVERT', family: '역추세', name: '볼린저 하단 매수, 중심선 매도', source: 'Bollinger on Bollinger Bands (2001); 국내 커뮤니티 단골',
    make: ({ close, n }) => { const m = sma(close, 20); const sd = rollingStd(close, 20);
      return holdUntil(n, (i) => t(m[i]) && close[i] < m[i] - (2 * sd[i]), (i) => t(m[i]) && close[i] > m[i]); } },
  { id: 'BB_BREAKOUT', family: '돌파', name: '볼린저 상단 돌파 추종', source: 'Bollinger (2001) band walk',
    make: ({ close, n }) => { const m = sma(close, 20); const sd = rollingStd(close, 20);
      return holdUntil(n, (i) => t(m[i]) && close[i] > m[i] + (2 * sd[i]), (i) => t(m[i]) && close[i] < m[i]); } },
  { id: 'RSI_30_70', family: '역추세', name: 'RSI 30 매수 / 70 매도', source: 'Wilder 1978; 코인 갤러리 단골',
    make: ({ close, n }) => { const r = rsi(close, 14); return holdUntil(n, (i) => t(r[i]) && r[i] < 30, (i) => t(r[i]) && r[i] > 70); } },
  { id: 'MACD_CROSS', family: '추세', name: 'MACD 시그널 교차', source: 'Appel (1979)',
    make: ({ close }) => { const m12 = ema(close, 12); const m26 = ema(close, 26); const macd = close.map((_, i) => (t(m26[i]) ? m12[i] - m26[i] : null));
      const sig = ema(macd.map((v) => v ?? 0), 9); return macd.map((v, i) => (t(v) && i >= 34 ? (v > sig[i] ? 1 : -1) : 0)); } },
  { id: 'SUPERTREND', family: '추세', name: '슈퍼트렌드(10, 3)', source: 'Seban; TradingView 인기 지표',
    make: ({ bars }) => supertrendDirection(bars, 10, 3).map((d) => d ?? 0) },
  { id: 'MA_ALIGNED', family: '추세', name: '이평선 정배열 (5>20>60>120)', source: '국내 커뮤니티/키움 조건검색 단골',
    make: ({ close }) => { const a = sma(close, 5); const b = sma(close, 20); const c = sma(close, 60); const d = sma(close, 120);
      return close.map((_, i) => (t(d[i]) && a[i] > b[i] && b[i] > c[i] && c[i] > d[i] ? 1 : 0)); } },
  { id: 'WEINSTEIN_STAGE2', family: '추세', name: '와인스타인 2단계 (30주선 위·상승)', source: 'Weinstein, Secrets for Profiting in Bull and Bear Markets (1988)',
    make: ({ close }) => { const s = sma(close, 150); return close.map((c, i) => (i >= 170 && t(s[i]) && t(s[i - 20]) && c > s[i] && s[i] > s[i - 20] ? 1 : 0)); } },
  { id: 'MINERVINI_TEMPLATE', family: '추세', name: '미너비니 트렌드 템플릿', source: 'Minervini, Trade Like a Stock Market Wizard (2013)',
    make: ({ close, n }) => { const s50 = sma(close, 50); const s150 = sma(close, 150); const s200 = sma(close, 200);
      const hi = rollingMax(close, 252); const lo = rollingMin(close, 252);
      const ok = (i) => i >= 272 && t(s200[i - 20]) && close[i] > s50[i] && s50[i] > s150[i] && s150[i] > s200[i] && s200[i] > s200[i - 20]
        && close[i] >= 0.75 * hi[i] && close[i] >= 1.3 * lo[i];
      return holdUntil(n, ok, (i) => t(s50[i]) && close[i] < s50[i]); } },
  { id: 'NEW_HIGH_VOLUME', family: '돌파', name: '거래량 2배 + 20일 신고가', source: '국내 급등주 단골 조건',
    make: ({ bars, close, n }) => { const vol = bars.map((b) => b.volume ?? 0); const av = sma(vol, 20); const hi = rollingMax(close, 20); const s10 = sma(close, 10);
      let held = 0;
      return holdUntil(n, (i) => { const ok = i > 0 && t(av[i - 1]) && av[i - 1] > 0 && vol[i] > 2 * av[i - 1] && close[i] >= hi[i]; if (ok) held = 0; return ok; },
        (i) => { held += 1; return (t(s10[i]) && close[i] < s10[i]) || held >= 10; }); } },
  { id: 'ICHIMOKU', family: '추세', name: '일목균형표 (구름 위 + 전환>기준)', source: 'Hosoda (1969)',
    make: ({ bars, close }) => { const hh = (k) => rollingMax(bars.map((b) => b.high), k); const ll = (k) => rollingMin(bars.map((b) => b.low), k);
      const h9 = hh(9); const l9 = ll(9); const h26 = hh(26); const l26 = ll(26); const h52 = hh(52); const l52 = ll(52);
      return close.map((c, i) => { const j = i - 26; if (j < 52) return 0;
        const tenkan = (h9[i] + l9[i]) / 2; const kijun = (h26[i] + l26[i]) / 2;
        const spanA = ((h9[j] + l9[j]) / 2 + (h26[j] + l26[j]) / 2) / 2; const spanB = (h52[j] + l52[j]) / 2;
        const top = Math.max(spanA, spanB); const bottom = Math.min(spanA, spanB);
        if (c > top && tenkan > kijun) return 1; if (c < bottom && tenkan < kijun) return -1; return 0; }); } },
  { id: 'VOL_TARGET', family: '위험관리', name: '변동성 타기팅 보유 (Moreira-Muir)', source: 'Moreira & Muir 2017',
    make: ({ close, year, crypto }) => { const r = logReturns(close); const sd = rollingStd(r, 20); const target = (crypto ? 0.5 : 0.15) / Math.sqrt(year);
      return sd.map((v) => (t(v) && v > 0 ? Math.min(1, target / v) : 0)); } },
  { id: 'MA_RATIO_10', family: '추세', name: '10일선 위에서만 보유 (짧은 이평 비율)', source: 'Detzel et al. 2021; Wei et al. 2024 (crypto MA ratio survived SPA)',
    make: ({ close }) => { const s = sma(close, 10); return close.map((c, i) => (t(s[i]) ? (c > s[i] ? 1 : -1) : 0)); } },
  { id: 'DONCHIAN20_SMA200', family: '돌파', name: '20일 신고가 돌파 + 200일선 필터 (10일 저점 청산)', source: 'Hudson & Urquhart 2021; Quantpedia BTC MAX revisit',
    make: ({ bars, close, n }) => { const hi = rollingMax(bars.map((b) => b.high), 20); const lo = rollingMin(bars.map((b) => b.low), 10); const s200 = sma(close, 200);
      return holdUntil(n, (i) => i > 0 && t(hi[i - 1]) && t(s200[i]) && close[i] > hi[i - 1] && close[i] > s200[i], (i) => i > 0 && t(lo[i - 1]) && close[i] < lo[i - 1]); } },
  { id: 'DONCHIAN_ENSEMBLE', family: '추세', name: '돈치안 앙상블 9개 기간 + 변동성 25% 목표', source: 'Zarattini, Pagani & Barbon 2025, Catching Crypto Trends',
    make: ({ close, year }) => { const Ls = [5, 10, 20, 30, 60, 90, 150, 250, 360]; const parts = Ls.map((L) => donchianTrail(close, L));
      const sd = rollingStd(logReturns(close), 30); const target = 0.25 / Math.sqrt(year);
      return close.map((_, i) => { const avg = parts.reduce((a, p) => a + p[i], 0) / Ls.length; const scale = t(sd[i]) && sd[i] > 0 ? Math.min(1, target / sd[i]) : 0; return avg * scale; }); } },
  { id: 'RSI70_MOMENTUM', family: '추세', name: 'RSI 70 돌파 추종 (50 아래 청산)', source: 'Coinpaprika BTC indicator study 2026 (RSI>70 = continuation)',
    make: ({ close, n }) => { const r = rsi(close, 14); return holdUntil(n, (i) => t(r[i]) && r[i] > 70, (i) => t(r[i]) && r[i] < 50); } },
  { id: 'DOUBLE_7S', family: '역추세', name: '코너스 더블 7 (200일선 위 7일 최저 매수)', source: 'Connors & Alvarez 2009; StrategyQuant SPY 1993-2026',
    make: ({ close, n }) => { const s200 = sma(close, 200); const lo7 = rollingMin(close, 7); const hi7 = rollingMax(close, 7);
      return holdUntil(n, (i) => t(s200[i]) && close[i] > s200[i] && close[i] <= lo7[i], (i) => t(hi7[i]) && close[i] >= hi7[i]); } },
  { id: 'CONNORS_PCTB', family: '역추세', name: '코너스 %b (3일 연속 0.2 미만 매수, 0.8 초과 매도)', source: 'Connors & Alvarez, High Probability ETF Trading (2009)',
    make: ({ close, n }) => { const m = sma(close, 20); const sd = rollingStd(close, 20); const s200 = sma(close, 200);
      const pb = close.map((c, i) => (t(m[i]) && sd[i] > 0 ? (c - (m[i] - 2 * sd[i])) / (4 * sd[i]) : null));
      return holdUntil(n, (i) => i >= 2 && t(s200[i]) && close[i] > s200[i] && [0, 1, 2].every((k) => t(pb[i - k]) && pb[i - k] < 0.2), (i) => t(pb[i]) && pb[i] > 0.8); } },
  { id: 'BB_SQUEEZE', family: '돌파', name: '볼린저 스퀴즈 후 상단 돌파', source: 'Bollinger (2001); LazyBear Squeeze 계열',
    make: ({ close, n }) => { const m = sma(close, 20); const sd = rollingStd(close, 20); const bbw = close.map((_, i) => (t(m[i]) && m[i] > 0 ? (4 * sd[i]) / m[i] : null));
      const minW = rollingMin(bbw.map((v) => v ?? Infinity), 125); let armed = 0;
      return holdUntil(n, (i) => { if (t(bbw[i]) && bbw[i] <= minW[i]) armed = 20; else armed = Math.max(0, armed - 1); return armed > 0 && t(m[i]) && close[i] > m[i] + 2 * sd[i]; },
        (i) => t(m[i]) && close[i] < m[i]); } },
  { id: 'KELTNER_BREAKOUT', family: '돌파', name: '켈트너 채널 상단 돌파 (EMA20 ± 2ATR)', source: 'Keltner (1960) / Raschke variant',
    make: ({ bars, close, n }) => { const e = ema(close, 20); const a = atr(bars, 10);
      return holdUntil(n, (i) => t(e[i]) && t(a[i]) && close[i] > e[i] + 2 * a[i], (i) => t(e[i]) && close[i] < e[i]); } },
  { id: 'NR7_BREAKOUT', family: '돌파', name: 'NR7 다음날 고가 돌파 (10일 보유)', source: 'Crabel, Day Trading with Short Term Price Patterns (1990); OxfordStrat',
    make: ({ bars, n }) => { const rng = bars.map((b) => b.high - b.low); const minR = rollingMin(rng, 7); let held = 0;
      return holdUntil(n, (i) => { const ok = i > 0 && t(minR[i - 1]) && rng[i - 1] <= minR[i - 1] && bars[i].close > bars[i - 1].high; if (ok) held = 0; return ok; }, () => { held += 1; return held >= 10; }); } },
  { id: 'HOLY_GRAIL', family: '추세', name: '라쉬키 홀리 그레일 (ADX>30 + EMA20 눌림)', source: 'Raschke & Connors, Street Smarts (1995)',
    make: ({ bars, close, n }) => { const e = ema(close, 20); const a = adx(bars, 14); const hi20 = rollingMax(bars.map((b) => b.high), 20); let held = 0;
      return holdUntil(n, (i) => { const ok = i > 0 && t(a[i]) && t(e[i]) && a[i] > 30 && a[i] >= a[i - 1] && bars[i].low <= e[i] && close[i] > e[i]; if (ok) held = 0; return ok; },
        (i) => { held += 1; return (i > 0 && t(hi20[i - 1]) && bars[i].high >= hi20[i - 1]) || (t(e[i]) && close[i] < e[i] * 0.97) || held >= 20; }); } },
  { id: 'VOLATILITY_SYSTEM', family: '추세', name: 'ATR 2배 종가 변화 반전 시스템', source: 'freqtrade-strategies futures/VolatilitySystem.py (Wilder volatility system)',
    make: ({ bars, close, n }) => { const a = atr(bars, 14); const out = new Array(n).fill(0); let pos = 0;
      for (let i = 1; i < n; i += 1) { if (t(a[i - 1])) { const d = close[i] - close[i - 1]; if (d > 2 * a[i - 1]) pos = 1; else if (-d > 2 * a[i - 1]) pos = -1; } out[i] = pos; } return out; } },
  { id: 'ADX_MOMENTUM', family: '추세', name: 'ADX 모멘텀 (ADX>25, +DI>−DI, MOM>0)', source: 'freqtrade-strategies berlinguyinca/ADXMomentum.py',
    make: ({ bars, close, n }) => { const a = adx(bars, 14); const { pdi, mdi } = directionalIndex(bars, 25);
      return holdUntil(n, (i) => i >= 14 && t(a[i]) && t(pdi[i]) && a[i] > 25 && close[i] - close[i - 14] > 0 && pdi[i] > 25 && pdi[i] > mdi[i],
        (i) => i >= 14 && t(a[i]) && t(mdi[i]) && a[i] > 25 && close[i] - close[i - 14] < 0 && mdi[i] > 25 && mdi[i] > pdi[i]); } },
  { id: 'EMA8_21_WEEKLY50', family: '추세', name: 'EMA 8/21 교차 + 주봉 50선 필터', source: 'freqtrade-strategies ReinforcedAverageStrategy.py',
    make: ({ close, n }) => { const f = ema(close, 8); const sl = ema(close, 21); const w = sma(close, 250);
      return holdUntil(n, (i) => i > 0 && t(sl[i - 1]) && t(w[i]) && f[i - 1] <= sl[i - 1] && f[i] > sl[i] && close[i] > w[i], (i) => i > 0 && t(sl[i]) && sl[i] > f[i]); } },
  { id: 'EMA20_OBV', family: '추세', name: 'EMA20 돌파 + OBV 확인 (롱숏)', source: 'freqtrade-strategies futures/TrendFollowingStrategy.py',
    make: ({ bars, close, n }) => { const e = ema(close, 20); const obv = new Array(n).fill(0);
      for (let i = 1; i < n; i += 1) obv[i] = obv[i - 1] + (close[i] > close[i - 1] ? 1 : close[i] < close[i - 1] ? -1 : 0) * (bars[i].volume ?? 0);
      const out = new Array(n).fill(0); let pos = 0;
      for (let i = 1; i < n; i += 1) { if (t(e[i]) && t(e[i - 1])) { if (close[i] > e[i] && close[i - 1] <= e[i - 1] && obv[i] > obv[i - 1]) pos = 1; else if (close[i] < e[i] && close[i - 1] >= e[i - 1] && obv[i] < obv[i - 1]) pos = -1; } out[i] = pos; }
      return out; } },
  { id: 'PARABOLIC_SAR', family: '추세', name: '파라볼릭 SAR 반전', source: 'Wilder 1978; je-suis-tm/quant-trading',
    make: ({ bars }) => parabolicSarDirection(bars) },
  { id: 'AWESOME_OSCILLATOR', family: '추세', name: '어썸 오실레이터 0선 교차', source: 'Bill Williams; je-suis-tm/quant-trading',
    make: ({ bars }) => { const hl2 = bars.map((b) => (b.high + b.low) / 2); const a5 = sma(hl2, 5); const a34 = sma(hl2, 34);
      return bars.map((_, i) => (t(a34[i]) ? (a5[i] - a34[i] > 0 ? 1 : -1) : 0)); } },
  { id: 'SSL_CHANNEL', family: '추세', name: 'SSL 채널 (10)', source: 'ErwinBeckers TradingView; GitHub ports',
    make: ({ bars, close }) => { const h = sma(bars.map((b) => b.high), 10); const l = sma(bars.map((b) => b.low), 10); let hlv = 0;
      return close.map((c, i) => { if (!t(h[i])) return 0; if (c > h[i]) hlv = 1; else if (c < l[i]) hlv = -1; return hlv; }); } },
  { id: 'CHANDELIER_EXIT', family: '추세', name: '샹들리에 엑시트 (22, 3ATR) 반전', source: 'Chuck LeBeau; everget TradingView',
    make: ({ bars, close, n }) => { const a = atr(bars, 22); const hh = rollingMax(close, 22); const ll = rollingMin(close, 22);
      const out = new Array(n).fill(0); let longStop = null; let shortStop = null; let dir = 1;
      for (let i = 1; i < n; i += 1) { if (!t(a[i])) continue;
        const ls = hh[i] - 3 * a[i]; const ss = ll[i] + 3 * a[i];
        longStop = longStop === null || close[i - 1] <= longStop ? ls : Math.max(ls, longStop);
        shortStop = shortStop === null || close[i - 1] >= shortStop ? ss : Math.min(ss, shortStop);
        if (dir === -1 && close[i] > shortStop) dir = 1; else if (dir === 1 && close[i] < longStop) dir = -1;
        out[i] = dir; }
      return out; } },
  { id: 'HULL_55', family: '추세', name: '헐 이동평균 55 방향', source: 'Alan Hull; Hull Suite TradingView',
    make: ({ close }) => { const h = hullMa(close, 55); return close.map((_, i) => (i >= 2 && t(h[i]) && t(h[i - 2]) ? (h[i] > h[i - 2] ? 1 : -1) : 0)); } },
  { id: 'SQUEEZE_MOMENTUM', family: '돌파', name: '스퀴즈 모멘텀 (LazyBear)', source: 'LazyBear TradingView; pandas-ta squeeze',
    make: ({ bars, close, n }) => { const m = sma(close, 20); const sd = rollingStd(close, 20); const tr = trueRange(bars); const kc = sma(tr, 20);
      const hh = rollingMax(bars.map((b) => b.high), 20); const ll = rollingMin(bars.map((b) => b.low), 20);
      const base = close.map((c, i) => (t(m[i]) && t(hh[i]) ? c - ((((hh[i] + ll[i]) / 2) + m[i]) / 2) : null));
      const mom = new Array(n).fill(null);
      for (let i = 39; i < n; i += 1) { let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let ok = true;
        for (let k = 0; k < 20; k += 1) { const y = base[i - 19 + k]; if (y === null) { ok = false; break; } sx += k; sy += y; sxx += k * k; sxy += k * y; }
        if (!ok) continue; const slope = ((20 * sxy) - (sx * sy)) / ((20 * sxx) - (sx * sx)); const icpt = (sy - (slope * sx)) / 20; mom[i] = icpt + (slope * 19); }
      const sqzOn = close.map((_, i) => t(m[i]) && t(kc[i]) && (m[i] + 2 * sd[i]) < (m[i] + 1.5 * kc[i]) && (m[i] - 2 * sd[i]) > (m[i] - 1.5 * kc[i]));
      return holdUntil(n, (i) => i > 0 && sqzOn[i - 1] && !sqzOn[i] && t(mom[i]) && t(mom[i - 1]) && mom[i] > 0 && mom[i] > mom[i - 1],
        (i) => i > 1 && t(mom[i]) && (mom[i] < 0 || (mom[i] < mom[i - 1] && mom[i - 1] < mom[i - 2]))); } },
  { id: 'MA_SCORE_3_20', family: '추세', name: '이평 점수 (3·5·10·20일선 위 개수 비중)', source: '강환국 변동성 돌파 책 코드; sharebook-kr',
    make: ({ close }) => { const ms = [3, 5, 10, 20].map((L) => sma(close, L)); return close.map((c, i) => (t(ms[3][i]) ? ms.filter((m) => c > m[i]).length / 4 : 0)); } },
  { id: 'BTC_MAX_10D', family: '돌파', name: '10일 신고가 종가 다음 1일 보유 (MAX)', source: 'Padysák & Vojtko 2022 (Bitcoin MAX); Quantpedia',
    make: ({ close }) => { const hi = rollingMax(close, 10); return close.map((c, i) => (t(hi[i]) && c >= hi[i] ? 1 : 0)); } },
  { id: 'RSRS', family: '추세', name: 'RSRS 저항지지 상대강도 (18일 회귀, 600일 표준화)', source: '광대증권(光大证券) 2017; JoinQuant 최다 복제',
    make: ({ bars, n }) => { const beta = new Array(n).fill(null); const r2 = new Array(n).fill(null);
      for (let i = 17; i < n; i += 1) { let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
        for (let k = i - 17; k <= i; k += 1) { const x = bars[k].low; const y = bars[k].high; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
        const den = (18 * sxx) - (sx * sx); if (den <= 0) continue; beta[i] = ((18 * sxy) - (sx * sy)) / den; const r2d = den * ((18 * syy) - (sy * sy)); r2[i] = r2d > 0 ? (((18 * sxy) - (sx * sy)) ** 2) / r2d : 0; }
      const out = new Array(n).fill(0); let pos = 0;
      for (let i = 617; i < n; i += 1) { let m = 0; let q = 0; let c = 0; for (let k = i - 599; k <= i; k += 1) if (beta[k] !== null) { m += beta[k]; q += beta[k] * beta[k]; c += 1; }
        if (c < 300 || beta[i] === null) { out[i] = pos; continue; } const mean = m / c; const sd = Math.sqrt(Math.max(1e-12, (q / c) - (mean * mean))); const z = ((beta[i] - mean) / sd) * r2[i];
        if (z > 0.7) pos = 1; else if (z < -0.7) pos = 0; out[i] = pos; }
      return out; } },
  { id: 'WAVETREND', family: '역추세', name: '웨이브트렌드 과매도 교차 (LazyBear)', source: 'LazyBear TradingView',
    make: ({ bars, n }) => { const ap = bars.map((b) => (b.high + b.low + b.close) / 3); const esa = ema(ap, 10); const d = ema(ap.map((v, i) => (t(esa[i]) ? Math.abs(v - esa[i]) : 0)), 10);
      const ci = ap.map((v, i) => (t(esa[i]) && t(d[i]) && d[i] > 0 ? (v - esa[i]) / (0.015 * d[i]) : 0)); const wt1 = ema(ci, 21); const wt2 = sma(wt1.map((v) => v ?? 0), 4);
      return holdUntil(n, (i) => i > 40 && t(wt1[i]) && t(wt2[i]) && wt1[i - 1] <= wt2[i - 1] && wt1[i] > wt2[i] && wt1[i] < -53,
        (i) => i > 40 && t(wt1[i]) && t(wt2[i]) && wt1[i - 1] >= wt2[i - 1] && wt1[i] < wt2[i] && wt1[i] > 53); } },
  { id: 'UT_BOT', family: '추세', name: 'UT Bot (ATR10 × 1 트레일링 반전)', source: 'QuantNomad/HPotter TradingView',
    make: ({ bars, close, n }) => { const a = atr(bars, 10); const out = new Array(n).fill(0); let stop = null; let dir = 0;
      for (let i = 1; i < n; i += 1) { if (!t(a[i])) continue; const loss = a[i];
        if (stop === null) stop = close[i] - loss;
        else if (close[i] > stop && close[i - 1] > stop) stop = Math.max(stop, close[i] - loss);
        else if (close[i] < stop && close[i - 1] < stop) stop = Math.min(stop, close[i] + loss);
        else stop = close[i] > stop ? close[i] - loss : close[i] + loss;
        dir = close[i] > stop ? 1 : -1; out[i] = dir; }
      return out; } },
  { id: 'MA25_DEVIATION', family: '역추세', name: '25일선 이격도 −8% 매수 (일본 乖離率)', source: 'Monex 移動平均乖離率; 일본 시스트레',
    make: ({ close, n }) => { const m = sma(close, 25); let held = 0;
      return holdUntil(n, (i) => { const ok = t(m[i]) && close[i] / m[i] - 1 <= -0.08; if (ok) held = 0; return ok; }, (i) => { held += 1; return (t(m[i]) && close[i] >= m[i]) || held >= 20; }); } },
  { id: 'PSYCHO_LINE', family: '역추세', name: '심리선 12일 25% 이하 매수 / 75% 이상 매도', source: '일본 サイコロジカルライン',
    make: ({ close, n }) => { const up = close.map((c, i) => (i > 0 && c > close[i - 1] ? 1 : 0)); const pl = sma(up, 12);
      return holdUntil(n, (i) => t(pl[i]) && pl[i] <= 0.25, (i) => t(pl[i]) && pl[i] >= 0.75); } },
  { id: 'KDJ', family: '역추세', name: 'KDJ(9,3,3) 20 아래 골든크로스 매수', source: '중국 커뮤니티 단골 (스토캐스틱 변형)',
    make: ({ bars, close, n }) => { const hh = rollingMax(bars.map((b) => b.high), 9); const ll = rollingMin(bars.map((b) => b.low), 9); let k = 50; let d = 50; const K = new Array(n).fill(null); const D = new Array(n).fill(null);
      for (let i = 0; i < n; i += 1) { if (!t(hh[i])) continue; const rsv = hh[i] > ll[i] ? ((close[i] - ll[i]) / (hh[i] - ll[i])) * 100 : 50; k = (2 / 3) * k + (1 / 3) * rsv; d = (2 / 3) * d + (1 / 3) * k; K[i] = k; D[i] = d; }
      return holdUntil(n, (i) => i > 0 && t(K[i - 1]) && K[i - 1] <= D[i - 1] && K[i] > D[i] && K[i] < 20, (i) => t(K[i]) && ((3 * K[i]) - (2 * D[i]) > 100 || (i > 0 && K[i - 1] >= D[i - 1] && K[i] < D[i]))); } },
  { id: 'TURN_OF_MONTH', family: '달력', name: '월말·월초 효과 (말일~3거래일)', source: 'Ariel 1987; Lakonishok & Smidt 1988',
    make: ({ bars }) => bars.map((b, i) => { const d = new Date(b.timestamp); const next = bars[i + 1];
      const lastOfMonth = next ? new Date(next.timestamp).getUTCMonth() !== d.getUTCMonth() : false;
      let k = 0; for (let j = i; j >= 0 && new Date(bars[j].timestamp).getUTCMonth() === d.getUTCMonth(); j -= 1) k += 1;
      return lastOfMonth || k <= 2 ? 1 : 0; }) },
  ...LEGEND_TRADER_RULES(),
]);

// ------------------------------------------------------------------ volume-filter experiment
// Owner request 2026-10-18: does a volume filter improve net return / drawdown of
// the near-miss breakout rules? Two filters, fixed BEFORE looking at results, no
// parameter search: RVOL15 = entry only when the entry bar's volume is >= 1.5x the
// mean of the previous 20 bars; CONFIRM1 = entry only after the signal persisted a
// second bar (one-bar delay; exits are never delayed). Every variant is added to
// the trial count, so the multiple-testing deflation pays for the extra tries.
export const VOLUME_FILTER_BASE_IDS_V1 = Object.freeze(['BB_BREAKOUT', 'KELTNER_BREAKOUT', 'DONCHIAN20_SMA200', 'RSI70_MOMENTUM']);
export const VOLUME_FILTER_RVOL_MULTIPLE_V1 = 1.5;
export const VOLUME_FILTER_RVOL_WINDOW_V1 = 20;

/** Pure: blocks an entry (0 -> +-1 or a flip) unless `allow(i, side)`; the block lasts until the raw signal returns to 0 or flips. */
export function gateEntriesV1(signal, allow) {
  const out = new Array(signal.length).fill(0);
  let prev = 0; let blocked = false;
  for (let i = 0; i < signal.length; i += 1) {
    const s = Number.isFinite(signal[i]) ? Math.sign(signal[i]) : 0;
    if (s === 0) { blocked = false; } else if (s !== prev) { blocked = !allow(i, s); }
    out[i] = s !== 0 && !blocked ? signal[i] : 0;
    prev = s;
  }
  return out;
}

/** Pure: true when volume[i] >= multiple x mean(volume[i-window..i-1]); false on missing or zero volume. */
export function relativeVolumeOkV1(volume, i, { multiple = VOLUME_FILTER_RVOL_MULTIPLE_V1, window = VOLUME_FILTER_RVOL_WINDOW_V1 } = {}) {
  if (!(i >= window)) return false;
  let sum = 0;
  for (let j = i - window; j < i; j += 1) { const v = volume[j]; if (!Number.isFinite(v) || v < 0) return false; sum += v; }
  const mean = sum / window;
  return mean > 0 && Number.isFinite(volume[i]) && volume[i] >= multiple * mean;
}

/** Pure: keep a position only from the second consecutive bar of the same raw signal. */
export function confirmOneBarV1(signal) {
  return signal.map((v, i) => (i > 0 && v !== 0 && Math.sign(v) === Math.sign(signal[i - 1] ?? 0) ? v : 0));
}

function buildVolumeFilteredRules() {
  const byId = new Map(TIMING_RULES_V1.map((rule) => [rule.id, rule]));
  const out = [];
  for (const baseId of VOLUME_FILTER_BASE_IDS_V1) {
    const base = byId.get(baseId);
    if (!base) continue;
    out.push({ id: `${baseId}__RVOL15`, family: '거래량필터', baseId, filter: 'RVOL15', name: `${base.name} + 상대거래량 ≥1.5배(20봉 평균) 진입`, source: `${base.source}; 거래량 필터 실험`,
      make: (ctx) => { const volume = ctx.bars.map((b) => b.volume ?? 0); return gateEntriesV1(base.make(ctx), (i) => relativeVolumeOkV1(volume, i)); } });
    out.push({ id: `${baseId}__CONFIRM1`, family: '거래량필터', baseId, filter: 'CONFIRM1', name: `${base.name} + 돌파 다음 봉 확인 진입`, source: `${base.source}; 돌파 확인 실험`,
      make: (ctx) => confirmOneBarV1(base.make(ctx)) });
  }
  return Object.freeze(out);
}
export const VOLUME_FILTERED_RULES_V1 = buildVolumeFilteredRules();

// Rules written down from famous traders / YouTubers' public descriptions.
// Discretionary parts (news, earnings, tape reading) cannot be coded; what is
// coded is the mechanical skeleton each of them teaches. Adaptations are named.
function LEGEND_TRADER_RULES() {
  const adr = (bars, L = 20) => sma(bars.map((b) => (b.low > 0 ? (b.high / b.low) - 1 : 0)), L);
  return [
    { id: 'DANTE_224_BREAKOUT', family: '전설', name: '단테 224일선 돌파 (4개월+ 아래 있다가 상향 돌파, 224선 −5% 이탈 청산)', source: '주식단테 유튜브 (224일선 돌파 매매)',
      make: ({ close, n, month }) => { const s = sma(close, 224); const below = close.map((c, i) => (t(s[i]) && c < s[i] ? 1 : 0)); const look = 4 * month; const cnt = sma(below, look);
        return holdUntil(n, (i) => i > 0 && t(s[i]) && t(cnt[i - 1]) && cnt[i - 1] >= 0.9 && close[i] > s[i] && t(s[i - 20]) && s[i] >= s[i - 20] * 0.97,
          (i) => t(s[i]) && close[i] < s[i] * 0.95); } },
    { id: 'DANTE_224_PULLBACK', family: '전설', name: '단테 224일선 눌림 (정배열 + 224선 ±8% 접근 매수, −8% 이탈 손절, +35% 이격 익절)', source: '주식단테 유튜브 (224일선 사정거리 ±8~10%)',
      make: ({ close, n }) => { const s = sma(close, 224); const m = sma(close, 112);
        return holdUntil(n, (i) => i >= 20 && t(s[i - 20]) && t(m[i]) && s[i] > s[i - 20] && m[i] > s[i] && close[i] >= s[i] * 0.98 && close[i] <= s[i] * 1.08,
          (i) => t(s[i]) && (close[i] < s[i] * 0.92 || close[i] > s[i] * 1.35)); } },
    { id: 'DANTE_112_BOTTOM', family: '전설', name: '단테 112일선 바닥 (역배열 종목 112선 돌파 매수, 224선 도달 매도)', source: '주식단테 유튜브 (역배열 112일선 저점 매매)',
      make: ({ close, n }) => { const s = sma(close, 224); const m = sma(close, 112);
        return holdUntil(n, (i) => i > 0 && t(s[i]) && t(m[i - 1]) && m[i] < s[i] && close[i - 1] <= m[i - 1] && close[i] > m[i],
          (i) => t(s[i]) && (close[i] >= s[i] || close[i] < m[i] * 0.95)); } },
    { id: 'QULLAMAGGIE_BREAKOUT', family: '전설', name: '쿨라매기 돌파 (급등주 1·3·6개월 +25/50/150% + 변동폭 큼 + 깃발 돌파, 진입일 저가 손절, 10일선 청산)', source: 'Kristjan Kullamägi (Qullamaggie) streams/blog; ADR 5%(코인)·3%(주식) 적응',
      make: ({ bars, close, n, month, crypto }) => { const a = adr(bars); const s10 = sma(close, 10); const s50 = sma(close, 50); const hi = rollingMax(bars.map((b) => b.high), 10); const lo = rollingMin(bars.map((b) => b.low), 10);
        const adrMin = crypto ? 0.05 : 0.03; let stop = null; let held = 0;
        return holdUntil(n, (i) => { if (i < 6 * month + 11 || !t(a[i]) || !t(hi[i - 1]) || !t(s50[i])) return false; const j = i - 10;
          const mom = close[j] / close[j - month] - 1 >= 0.25 || close[j] / close[j - 3 * month] - 1 >= 0.5 || close[j] / close[j - 6 * month] - 1 >= 1.5;
          const tight = (hi[i - 1] - lo[i - 1]) / close[i - 1] <= 4 * a[i];
          const ok = a[i] >= adrMin && mom && tight && close[i] > s50[i] && close[i] > hi[i - 1] && (close[i] / close[i - 1] - 1) <= 2 * a[i];
          if (ok) { stop = bars[i].low; held = 0; } return ok; },
        (i) => { held += 1; return close[i] < stop || (held >= 3 && t(s10[i]) && close[i] < s10[i]); }); } },
    { id: 'MINERVINI_VCP', family: '전설', name: '미너비니 VCP (트렌드 템플릿 + 변동폭·거래량 수축 후 돌파, −8% 손절, 50일선 청산)', source: 'Minervini, Trade Like a Stock Market Wizard (2013); USIC 2021 334.8%',
      make: ({ bars, close, n }) => { const s50 = sma(close, 50); const s150 = sma(close, 150); const s200 = sma(close, 200); const h252 = rollingMax(close, 252); const l252 = rollingMin(close, 252);
        const highs = bars.map((b) => b.high); const lows = bars.map((b) => b.low); const vol = bars.map((b) => b.volume ?? 0); const v10 = sma(vol, 10); const v50 = sma(vol, 50);
        const hi10 = rollingMax(highs, 10); const lo10 = rollingMin(lows, 10); const hi30 = rollingMax(highs, 30); const lo30 = rollingMin(lows, 30); let stop = null;
        return holdUntil(n, (i) => { if (i < 273 || !t(s200[i - 20]) || !t(hi30[i - 1])) return false;
          const template = close[i] > s50[i] && s50[i] > s150[i] && s150[i] > s200[i] && s200[i] > s200[i - 20] && close[i] >= 0.75 * h252[i] && close[i] >= 1.3 * l252[i];
          const recent = (hi10[i - 1] - lo10[i - 1]) / close[i - 1]; const wide = (hi30[i - 1] - lo30[i - 1]) / close[i - 1];
          const dryUp = !(v50[i - 1] > 0) || v10[i - 1] < v50[i - 1];
          const ok = template && recent <= 0.5 * wide && recent <= 0.15 && dryUp && close[i] > hi10[i - 1];
          if (ok) stop = close[i] * 0.92; return ok; },
        (i) => close[i] < stop || (t(s50[i]) && close[i] < s50[i])); } },
    { id: 'DARVAS_BOX', family: '전설', name: '다바스 박스 (52주 고점권 박스 상단 돌파, 박스 하단 트레일링 손절)', source: 'Nicolas Darvas, How I Made $2,000,000 in the Stock Market (1960)',
      make: ({ bars, close, n }) => { const highs = bars.map((b) => b.high); const lows = bars.map((b) => b.low); const h252 = rollingMax(highs, 252); const out = new Array(n).fill(0);
        let top = null; let bottom = null; let topAge = 0; let pos = 0; let stop = null;
        for (let i = 1; i < n; i += 1) {
          if (pos === 1) { if (close[i] < stop) pos = 0; }
          else if (top !== null && bottom !== null && topAge >= 3 && t(h252[i - 1]) && top >= 0.9 * h252[i - 1] && close[i] > top) { pos = 1; stop = bottom; }
          if (top === null || highs[i] > top) { top = highs[i]; topAge = 0; bottom = null; } else { topAge += 1; bottom = bottom === null ? lows[i] : Math.min(bottom, lows[i]); }
          if (pos === 1 && topAge >= 3 && bottom !== null) stop = Math.max(stop, bottom);
          out[i] = pos;
        }
        return out; } },
    { id: 'BRANDT_PATTERN', family: '전설', name: '브란트 8주 수렴 패턴 돌파 (돌파일 저가 손절, 패턴 높이 목표)', source: 'Peter Brandt, Diary of a Professional Commodity Trader (2011) — Last Day Rule',
      make: ({ bars, close, n }) => { const highs = bars.map((b) => b.high); const lows = bars.map((b) => b.low); const h40 = rollingMax(highs, 40); const l40 = rollingMin(lows, 40);
        const h20 = rollingMax(highs, 20); const l20 = rollingMin(lows, 20); let stop = null; let target = null; let held = 0;
        return holdUntil(n, (i) => { if (i < 61 || !t(h40[i - 1]) || !t(h20[i - 21])) return false; const height = h40[i - 1] - l40[i - 1];
          const early = h20[i - 21] - l20[i - 21]; const late = h20[i - 1] - l20[i - 1];
          const ok = height / close[i - 1] <= 0.35 && late <= 0.8 * early && close[i] > h40[i - 1];
          if (ok) { stop = bars[i].low; target = close[i] + height; held = 0; } return ok; },
        (i) => { held += 1; return close[i] < stop || close[i] >= target || held >= 40; }); } },
    { id: 'COWEN_LOG_RISK', family: '전설', name: '코웬식 로그회귀 리스크 (과거만 쓴 회귀 잔차 백분위: 낮으면 많이, 높으면 0)', source: 'Benjamin Cowen, Into the Cryptoverse (log regression bands / risk metric) — 재현판',
      make: ({ bars, close, n, crypto }) => { const GENESIS = Date.UTC(2009, 0, 3); const out = new Array(n).fill(0); const resid = [];
        let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let c = 0;
        for (let i = 0; i < n; i += 1) {
          const x = Math.log(crypto ? Math.max(1, (bars[i].timestamp - GENESIS) / DAY) : i + 250); const y = Math.log(close[i]);
          sx += x; sy += y; sxx += x * x; sxy += x * y; c += 1;
          if (c < 365) continue; const den = (c * sxx) - (sx * sx); if (den <= 0) continue;
          const b = ((c * sxy) - (sx * sy)) / den; const a0 = (sy - (b * sx)) / c; const r = y - (a0 + (b * x)); resid.push(r);
          let below = 0; for (const v of resid) if (v <= r) below += 1; const risk = below / resid.length;
          out[i] = risk < 0.3 ? 1 : risk < 0.5 ? 0.75 : risk < 0.7 ? 0.5 : risk < 0.85 ? 0.25 : 0;
        }
        return out; } },
    { id: 'QULLAMAGGIE_PARABOLIC_SHORT', family: '전설', name: '쿨라매기 포물선 숏 (5일 +30%·3연속 양봉 뒤 첫 전일저가 이탈 숏, 고점 손절, 10일선 커버)', source: 'Kristjan Kullamägi parabolic short; stonkscapital systemization', nativeShort: true,
      make: ({ bars, close, n }) => { const s10 = sma(close, 10); const out = new Array(n).fill(0); let armed = 0; let peak = null; let pos = 0; let stop = null; let held = 0;
        for (let i = 5; i < n; i += 1) {
          if (pos === -1) { held += 1; if (close[i] > stop || (t(s10[i]) && close[i] <= s10[i]) || held >= 10) pos = 0; }
          const run = close[i] / close[i - 5] - 1 >= 0.3 && close[i] > close[i - 1] && close[i - 1] > close[i - 2] && close[i - 2] > close[i - 3];
          if (run) { armed = 3; peak = Math.max(peak ?? 0, bars[i].high); } else if (armed > 0) {
            if (pos === 0 && close[i] < bars[i - 1].low) { pos = -1; stop = Math.max(peak, bars[i].high); held = 0; armed = 0; peak = null; } else { armed -= 1; peak = Math.max(peak ?? 0, bars[i].high); if (!armed) peak = null; }
          }
          out[i] = pos;
        }
        return out; } },
  ];
}

// Rules that need their own intraday return model (daily OHLC only).
export const SPECIAL_RULES_V1 = Object.freeze([
  { id: 'VOL_BREAKOUT_K05', family: '돌파', name: '래리 윌리엄스 변동성 돌파 (k=0.5, 다음날 시가 청산)', source: 'Williams, Long-Term Secrets to Short-Term Trading (1999); 국내 업비트 자동매매 단골' },
  { id: 'VOL_BREAKOUT_K05_MA5', family: '돌파', name: '변동성 돌파 + 5일선 필터 (강환국판)', source: '강환국, 거인의 포트폴리오 / 유튜브' },
  { id: 'OVERNIGHT', family: '달력', name: '종가 매수·다음날 시가 매도 (오버나이트)', source: 'Cliff, Cooper & Gulen 2008; Kelly & Clark 2011' },
  { id: 'WEEKEND_CRYPTO', family: '달력', name: '코인 주말만 보유 (금 종가→월 시가)', source: 'Caporale & Plastun 2019 (day-of-week in crypto)' },
  { id: 'VOL_BREAKOUT_NOISE', family: '돌파', name: '변동성 돌파 노이즈 k + 이평 점수 + 변동성 비중 (강환국)', source: '강환국, 가상화폐 투자 마스터플랜 (2021)' },
  { id: 'DUAL_THRUST', family: '돌파', name: '듀얼 스러스트 (N=4, K=0.5, 롱숏 반전)', source: 'Michael Chalek; jesse-ai DUAL_THRUST; je-suis-tm' },
  { id: 'DCA_MARTINGALE', family: '봇', name: 'DCA 물타기 봇 (안전주문 5개 ×2배, +1.5% 익절, 손절 없음)', source: '3Commas/거래소 DCA 봇 기본형' },
  { id: 'FUNDING_CARRY', family: '캐리', name: '펀딩비 반대 방향 선물만 보유 (헤지 없음, 비교용)', source: 'directional variant (not the paper strategy)' },
  { id: 'FUNDING_CARRY_HEDGED', family: '캐리', name: '펀딩비 차익 (현물 매수 + 선물 매도, 가격위험 헤지)', source: 'He, Manela, Ross & von Wachter 2024 (arXiv 2212.06888); BIS WP 1087' },
]);

// ------------------------------------------------------------------ rotation (cross-sectional) rules
export const ROTATION_RULES_V1 = Object.freeze([
  { id: 'XS_MOM_12_1', name: '횡단면 모멘텀 12-1개월 상위 30% (월간)', source: 'Jegadeesh & Titman 1993', rebalance: 'month',
    score: ({ close, i, year, month }) => (i >= year ? close[i - month] / close[i - year] - 1 : null) },
  { id: 'XS_MOM_3M', name: '3개월 수익률 상위 30% (월간)', source: 'Jegadeesh & Titman 1993 (J=3)', rebalance: 'month',
    score: ({ close, i, month }) => (i >= 3 * month ? close[i] / close[i - (3 * month)] - 1 : null) },
  { id: 'DUAL_MOM_12M', name: '듀얼 모멘텀 (12개월 상위 + 절대 모멘텀)', source: 'Antonacci, Dual Momentum Investing (2014)', rebalance: 'month', absolute: true,
    score: ({ close, i, year }) => (i >= year ? close[i] / close[i - year] - 1 : null) },
  { id: 'HIGH_52W', name: '52주 신고가 근접 상위 30% (월간)', source: 'George & Hwang 2004', rebalance: 'month',
    score: ({ close, i, year }) => { if (i < year) return null; let m = 0; for (let j = i - year + 1; j <= i; j += 1) m = Math.max(m, close[j]); return close[i] / m; } },
  { id: 'LOW_VOL', name: '저변동성 하위 30% (월간)', source: 'Ang et al. 2006; Baker, Bradley & Wurgler 2011', rebalance: 'month',
    score: ({ close, i }) => { if (i < 61) return null; let s = 0; let q = 0; for (let j = i - 59; j <= i; j += 1) { const r = Math.log(close[j] / close[j - 1]); s += r; q += r * r; } return -Math.sqrt(Math.max(0, (q / 60) - ((s / 60) ** 2))); } },
  { id: 'ST_REVERSAL_1W', name: '단기 반전 (지난주 하락 상위, 주간)', source: 'Lehmann 1990; Jegadeesh 1990', rebalance: 'week',
    score: ({ close, i, week }) => (i >= week ? -(close[i] / close[i - week] - 1) : null) },
  { id: 'LOW_MAX', name: '로또주 회피 (최근 1개월 최대 일간상승 낮은 순, 월간)', source: 'Bali, Cakici & Whitelaw 2011', rebalance: 'month',
    score: ({ close, i, month }) => { if (i < month + 1) return null; let m = -Infinity; for (let j = i - month + 1; j <= i; j += 1) m = Math.max(m, close[j] / close[j - 1] - 1); return -m; } },
  { id: 'CLENOW_MOMENTUM', name: '클레노우 회귀 모멘텀 + 지수 필터 (주간)', source: 'Clenow, Stocks on the Move (2015)', rebalance: 'week', indexFilter: true,
    score: ({ close, i }) => { if (i < 100) return null; const n = 90; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
      for (let k = 0; k < n; k += 1) { const y = Math.log(close[i - n + 1 + k]); sx += k; sy += y; sxx += k * k; sxy += k * y; syy += y * y; }
      const slope = ((n * sxy) - (sx * sy)) / ((n * sxx) - (sx * sx)); const r2num = ((n * sxy) - (sx * sy)) ** 2; const r2den = ((n * sxx) - (sx * sx)) * ((n * syy) - (sy * sy));
      const r2 = r2den > 0 ? r2num / r2den : 0; let s100 = 0; for (let k = i - 99; k <= i; k += 1) s100 += close[k];
      if (close[i] < s100 / 100) return null; return ((Math.exp(slope * 252) - 1) * r2); } },
  { id: 'XS_MOM_12_7', name: '12-7개월 모멘텀 상위 30% (월간, 한국형)', source: 'Novy-Marx 2012; Sim & Kim 2021 (Korea)', rebalance: 'month',
    score: ({ close, i, year, month }) => (i >= year ? close[i - (7 * month)] / close[i - year] - 1 : null) },
  { id: 'ST_REVERSAL_1M', name: '1개월 반전 (지난달 하락 상위, 월간)', source: 'Jegadeesh 1990; Sim & Kim 2021 (Korea alpha 1.3%/월)', rebalance: 'month',
    score: ({ close, i, month }) => (i >= month ? -(close[i] / close[i - month] - 1) : null) },
  { id: 'HIGH_VOLUME_PREMIUM', name: '거래량 급증 프리미엄 (주간 거래량/50일 평균 상위)', source: 'Gervais, Kaniel & Mingelgrin 2001', rebalance: 'week',
    score: ({ volume, i, week }) => { if (!volume || i < 55) return null; let w = 0; for (let k = i - week + 1; k <= i; k += 1) w += volume[k]; let a = 0; for (let k = i - 54; k <= i - week; k += 1) a += volume[k]; a /= (55 - week); return a > 0 ? (w / week) / a : null; } },
  { id: 'MOM_1M_WEEKLY_FILTER', name: '1개월 모멘텀 상위 + 지수 200일선 필터 (주간)', source: 'Liu-Tsyvinski-Wu 2022 + regime filter (practitioner)', rebalance: 'week', indexFilter: true,
    score: ({ close, i, month }) => (i >= month ? close[i] / close[i - month] - 1 : null) },
  { id: 'XS_IBS_DAILY', name: '횡단면 IBS 하위 매수 (매일, 1일 보유)', source: 'QuantConnect GlobalEquityMeanReversionIBSAlpha', rebalance: 'day',
    score: ({ bars, i }) => { const x = bars?.[i]; return x && x.high > x.low ? -((x.close - x.low) / (x.high - x.low)) : null; } },
  { id: 'MOM_1M_WEEKLY', name: '1개월 모멘텀 상위 (주간, 코인 로테이션)', source: 'Liu, Tsyvinski & Wu 2022 (crypto momentum)', rebalance: 'week',
    score: ({ close, i, month }) => (i >= month ? close[i] / close[i - month] - 1 : null) },
]);

// ------------------------------------------------------------------ simulation

/** Aligns datasets of one market on a shared daily calendar. */
export function buildPanel(datasets) {
  const dates = new Set();
  const series = datasets.map((d) => {
    const bars = (d.candles ?? []).filter((c) => c.timestamp < HOLDOUT_START && [c.open, c.high, c.low, c.close].every((v) => v > 0))
      .sort((a, b) => a.timestamp - b.timestamp);
    const day = (ms) => Math.floor(ms / DAY) * DAY;
    const byDay = new Map(); for (const b of bars) byDay.set(day(b.timestamp), b);
    const uniq = [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
    for (const b of uniq) dates.add(day(b.timestamp));
    return { symbol: d.symbol, bars: uniq, funding: d.fundingRates ?? [], dayIndex: new Map(uniq.map((b, i) => [day(b.timestamp), i])) };
  });
  return { calendar: [...dates].sort((a, b) => a - b), series };
}

/** Per-day funding sum (rate units) for a perpetual, by UTC day. */
function fundingByDay(funding) {
  const m = new Map();
  for (const r of funding) { const k = Math.floor(r.timestamp / DAY) * DAY; m.set(k, (m.get(k) ?? 0) + Number(r.rate || 0)); }
  return m;
}

/**
 * Pure: daily portfolio return series from per-symbol target exposures.
 * targets[s][i] decided at close of bar i of symbol s. Day j return per symbol:
 * T[j-2] × gap(C[j-1]→O[j]) + T[j-1] × intraday(O[j]→C[j]) − cost × |T[j-1] − T[j-2]| − funding.
 */
export function simulateTimingPortfolio(panel, targetsBySymbol, market, { weightOf = null } = {}) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const fundingMaps = panel.series.map((s) => fundingByDay(s.funding));
  const out = []; let turnover = 0; let exposure = 0;
  for (const day of panel.calendar) {
    let sum = 0; let active = 0; let expDay = 0; let turnDay = 0;
    for (let s = 0; s < panel.series.length; s += 1) {
      const ser = panel.series[s]; const j = ser.dayIndex.get(day);
      if (j === undefined || j < 2) { if (j !== undefined) active += 1; continue; }
      active += 1;
      const T = targetsBySymbol[s];
      const clamp = (v) => { const x = Number.isFinite(v) ? v : 0; return spec.shortAllowed ? Math.max(-1, Math.min(1, x)) : Math.max(0, Math.min(1, x)); };
      const prev = clamp(T[j - 2]); const cur = clamp(T[j - 1]);
      const b = ser.bars[j]; const pc = ser.bars[j - 1].close;
      let r = (prev * (b.open / pc - 1)) + (cur * (b.close / b.open - 1)) - (spec.costPerSide * Math.abs(cur - prev));
      if (market === 'CRYPTO_FUTURES') r -= cur * (fundingMaps[s].get(day) ?? 0);
      sum += r; expDay += Math.abs(cur); turnDay += Math.abs(cur - prev);
    }
    const w = active > 0 ? 1 / active : 0;
    out.push({ day, ret: sum * w });
    exposure += expDay * w; turnover += turnDay * w;
  }
  return { returns: out, avgExposure: out.length ? exposure / out.length : 0, turnoverPerYear: out.length ? (turnover / out.length) * spec.barsPerYear : 0 };
}

/** Pure: special intraday rules on daily OHLC → per-symbol daily returns, then equal weight. */
export function simulateSpecialPortfolio(panel, ruleId, market) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const fundingMaps = panel.series.map((s) => fundingByDay(s.funding));
  const dtPos = {};
  const hedgedPos = {};
  const perSymbol = panel.series.map((ser, s) => {
    const bars = ser.bars; const close = bars.map((b) => b.close); const s5 = sma(close, 5);
    const r = new Array(bars.length).fill(0); const exp = new Array(bars.length).fill(0); const turn = new Array(bars.length).fill(0);
    for (let j = 1; j < bars.length; j += 1) {
      const b = bars[j]; const p = bars[j - 1];
      if (ruleId === 'VOL_BREAKOUT_K05' || ruleId === 'VOL_BREAKOUT_K05_MA5') {
        // buy when price reaches open + 0.5 × yesterday's range; sell at next open
        const entry = b.open + (0.5 * (p.high - p.low));
        const filterOk = ruleId === 'VOL_BREAKOUT_K05' || (s5[j - 1] !== null && b.open > s5[j - 1]);
        if (filterOk && b.high >= entry && j + 1 < bars.length && entry > 0) {
          const exit = bars[j + 1].open;
          r[j] = (exit / entry - 1) - (2 * spec.costPerSide); exp[j] = 1; turn[j] = 2;
          if (market === 'CRYPTO_FUTURES') r[j] -= fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0;
        }
      } else if (ruleId === 'VOL_BREAKOUT_NOISE') {
        // k = mean noise of 20 days; weight = MA score (3/5/10/20) × min(1, 2% / (range/close)); sell next open
        if (j < 21 || j + 1 >= bars.length) continue;
        let noise = 0; for (let k = j - 20; k < j; k += 1) { const x = bars[k]; noise += x.high > x.low ? 1 - (Math.abs(x.open - x.close) / (x.high - x.low)) : 1; }
        const kk = noise / 20; const entry = b.open + (kk * (p.high - p.low));
        let score = 0; for (const L of [3, 5, 10, 20]) { let m = 0; for (let k = j - L; k < j; k += 1) m += bars[k].close; if (b.open > m / L) score += 0.25; }
        const rangePct = (p.high - p.low) / p.close; const w = score * Math.min(1, rangePct > 0 ? 0.02 / rangePct : 0);
        if (w > 0 && b.high >= entry && entry > 0) {
          r[j] = w * ((bars[j + 1].open / entry - 1) - (2 * spec.costPerSide)); exp[j] = w; turn[j] = 2 * w;
          if (market === 'CRYPTO_FUTURES') r[j] -= w * (fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0);
        }
      } else if (ruleId === 'DUAL_THRUST') {
        // stop-and-reverse on today's open ± 0.5 × range of the last 4 bars; fill at the trigger (or the open on a gap)
        if (j < 5) continue;
        let hh = -Infinity; let ll = Infinity; let hc = -Infinity; let lc = Infinity;
        for (let k = j - 4; k < j; k += 1) { hh = Math.max(hh, bars[k].high); ll = Math.min(ll, bars[k].low); hc = Math.max(hc, bars[k].close); lc = Math.min(lc, bars[k].close); }
        const rng = Math.max(hh - lc, hc - ll); const upT = b.open + 0.5 * rng; const dnT = b.open - 0.5 * rng;
        const prevPos = dtPos[s] ?? 0; let pos = prevPos; let pnl = prevPos * (b.open / p.close - 1); let fills = 0; let fromPrice = b.open;
        const hitUp = b.high >= upT; const hitDn = b.low <= dnT;
        // both touched: assume the adverse one first (conservative)
        const order = hitUp && hitDn ? (prevPos >= 0 ? ['dn', 'up'] : ['up', 'dn']) : hitUp ? ['up'] : hitDn ? ['dn'] : [];
        for (const side of order) {
          const target = side === 'up' ? 1 : -1; if (!spec.shortAllowed && target === -1 && pos === 0) continue;
          const px = side === 'up' ? Math.max(upT, b.open) : Math.min(dnT, b.open);
          pnl += pos * (px / fromPrice - 1); const newPos = spec.shortAllowed ? target : (target === 1 ? 1 : 0);
          fills += Math.abs(newPos - pos); pos = newPos; fromPrice = px;
        }
        pnl += pos * (b.close / fromPrice - 1) - (spec.costPerSide * fills);
        if (market === 'CRYPTO_FUTURES') pnl -= pos * (fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0);
        r[j] = pnl; exp[j] = Math.abs(pos); turn[j] = fills; dtPos[s] = pos;
      } else if (ruleId === 'OVERNIGHT') {
        if (market === 'KR_STOCK' || market === 'US_STOCK') { r[j] = (b.open / p.close - 1) - (2 * spec.costPerSide); exp[j] = 1; turn[j] = 2; }
      } else if (ruleId === 'WEEKEND_CRYPTO') {
        // held from Friday close to Monday open (UTC) on crypto
        if (market === 'CRYPTO_SPOT' || market === 'CRYPTO_FUTURES') {
          const dow = new Date(b.timestamp).getUTCDay();
          if (dow === 6 || dow === 0) { r[j] = b.close / p.close - 1; exp[j] = 1; }
          if (dow === 1) { r[j] = (b.open / p.close - 1) - (2 * spec.costPerSide); exp[j] = 1; turn[j] = 2; }
          if (market === 'CRYPTO_FUTURES' && exp[j]) r[j] -= fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0;
        }
      } else if (ruleId === 'FUNDING_CARRY_HEDGED') {
        if (market === 'CRYPTO_FUTURES') {
          // Enter (at the next open) when the last 3 days averaged ≥ 3 bp/day of funding,
          // leave when the average turns negative. Capital = spot notional + 50% perp
          // margin (2x isolated short) → funding yield ÷ 1.5. Four legs pay costs each way.
          let f = 0; let k = 0;
          for (let d = 1; d <= 3; d += 1) { const v = fundingMaps[s].get(Math.floor(bars[j - d]?.timestamp / DAY) * DAY); if (Number.isFinite(v)) { f += v; k += 1; } }
          const avg = k ? f / k : 0; const prev = hedgedPos[s] ?? 0;
          const pos = prev ? (avg < 0 ? 0 : 1) : (avg >= 0.0003 ? 1 : 0);
          const today = fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0;
          r[j] = (pos * today / 1.5) - (pos !== prev ? (4 * spec.costPerSide) / 1.5 : 0);
          exp[j] = pos; turn[j] = pos !== prev ? 4 / 1.5 : 0; hedgedPos[s] = pos;
        }
      } else if (ruleId === 'FUNDING_CARRY') {
        if (market === 'CRYPTO_FUTURES') {
          // position decided at close j−1 from the last 3 days of funding: short when
          // longs pay (> 1 bp/day avg), long when shorts pay (< −1 bp/day)
          let f = 0; let k = 0;
          for (let d = 1; d <= 3; d += 1) { const v = fundingMaps[s].get(Math.floor(bars[j - d]?.timestamp / DAY) * DAY); if (Number.isFinite(v)) { f += v; k += 1; } }
          const avg = k ? f / k : 0;
          const pos = avg > 0.0001 ? -1 : avg < -0.0001 ? 1 : 0;
          if (pos !== 0) {
            const today = fundingMaps[s].get(Math.floor(b.timestamp / DAY) * DAY) ?? 0;
            r[j] = (pos * (b.close / p.close - 1)) - (pos * today) - (spec.costPerSide * 0.2); exp[j] = 1; turn[j] = 0.2;
          }
        }
      }
    }
    if (ruleId === 'DCA_MARTINGALE') {
      // sleeve = 1; orders 1,2,4,8,16,32 /63 at entry, −2%, −4%, −6%, −8%, −10%; take profit +1.5% over the average
      const sizes = [1, 2, 4, 8, 16, 32].map((x) => x / 63); const levels = [0, 0.02, 0.04, 0.06, 0.08, 0.10];
      let qty = 0; let cost = 0; let filled = 0; let entry = null; let cash = 1; let prevValue = 1;
      for (let j = 1; j < bars.length; j += 1) {
        const b = bars[j];
        // Conservative intrabar order: on a day that opens a cycle or fills a safety
        // order, the low is assumed to come AFTER the high, so no take-profit that day.
        let boughtToday = false;
        const tpBefore = qty > 0 ? (cost / qty) * 1.015 : null;
        if (qty === 0) { entry = b.open; const q = sizes[0] / entry; qty = q; cost = sizes[0]; cash -= sizes[0] * (1 + spec.costPerSide); filled = 1; turn[j] += sizes[0]; boughtToday = true; }
        while (filled < sizes.length && b.low <= entry * (1 - levels[filled])) {
          const price = Math.min(b.open, entry * (1 - levels[filled])); qty += sizes[filled] / price; cost += sizes[filled]; cash -= sizes[filled] * (1 + spec.costPerSide); turn[j] += sizes[filled]; filled += 1; boughtToday = true;
        }
        if (!boughtToday && tpBefore !== null && b.high >= tpBefore) {
          const px = Math.max(tpBefore, b.open); cash += qty * px * (1 - spec.costPerSide); turn[j] += qty * px; qty = 0; cost = 0; filled = 0;
        }
        const value = cash + (qty * b.close);
        r[j] = prevValue > 0 ? value / prevValue - 1 : 0; exp[j] = prevValue > 0 ? (qty * b.close) / prevValue : 0; prevValue = value;
        if (value <= 0.0001) break;
      }
    }
    return { r, exp, turn };
  });
  const out = []; let exposure = 0; let turnover = 0;
  for (const day of panel.calendar) {
    let sum = 0; let active = 0; let e = 0; let tu = 0;
    panel.series.forEach((ser, s) => { const j = ser.dayIndex.get(day); if (j === undefined) return; active += 1; sum += perSymbol[s].r[j]; e += perSymbol[s].exp[j]; tu += perSymbol[s].turn[j]; });
    const w = active ? 1 / active : 0;
    out.push({ day, ret: sum * w }); exposure += e * w; turnover += tu * w;
  }
  return { returns: out, avgExposure: out.length ? exposure / out.length : 0, turnoverPerYear: out.length ? (turnover / out.length) * spec.barsPerYear : 0 };
}

/** Pure: cross-sectional top-K rotation, executed at the next open, equal weight. */
export function simulateRotationPortfolio(panel, rule, market, { topFraction = 0.3, minK = 2, longShort = false, shortOnly = false } = {}) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const year = spec.barsPerYear; const month = Math.round(year / 12); const week = market.startsWith('CRYPTO') ? 7 : 5;
  const closes = panel.series.map((s) => s.bars.map((b) => b.close));
  const volumes = panel.series.map((s) => s.bars.map((b) => Number(b.volume) || 0));
  const allBars = panel.series.map((s) => s.bars);
  const rotFunding = panel.series.map((s) => fundingByDay(s.funding));
  const indexSeries = panel.series.findIndex((s) => s.symbol === spec.index);
  let weights = new Map(); // symbol index → weight (decided at previous rebalance close)
  let pending = null; // weights decided at today's close, executed next open
  const out = []; let turnover = 0; let exposure = 0; let lastKey = null;
  for (let d = 0; d < panel.calendar.length; d += 1) {
    const day = panel.calendar[d];
    const date = new Date(day);
    // 1. today's P&L: overnight gap on yesterday's weights, intraday on the weights in force from the open
    const next = pending ?? weights;
    let r = 0; let tu = 0;
    const all = new Set([...weights.keys(), ...next.keys()]);
    for (const s of all) {
      const ser = panel.series[s]; const j = ser.dayIndex.get(day);
      const wPrev = weights.get(s) ?? 0; const wNow = next.get(s) ?? 0;
      tu += Math.abs(wNow - wPrev);
      if (j === undefined || j < 1) continue;
      const b = ser.bars[j]; const pc = ser.bars[j - 1].close;
      r += (wPrev * (b.open / pc - 1)) + (wNow * (b.close / b.open - 1));
    }
    r -= spec.costPerSide * tu;
    weights = next; pending = null;
    if (market === 'CRYPTO_FUTURES') {
      for (const [s2, w2] of weights) if (w2 !== 0) r -= w2 * (rotFunding[s2].get(Math.floor(day / DAY) * DAY) ?? 0);
    }
    out.push({ day, ret: r }); turnover += tu; exposure += [...weights.values()].reduce((a, v) => a + Math.abs(v), 0);
    // 2. rebalance decision at today's close
    const periodKey = (ms) => (rule.rebalance === 'month' ? `${new Date(ms).getUTCFullYear()}-${new Date(ms).getUTCMonth()}`
      : rule.rebalance === 'day' ? String(ms) : `${Math.floor((ms / DAY + 3) / 7)}`); // weeks start Monday
    const key = periodKey(day);
    const nextDay = panel.calendar[d + 1];
    const nextKey = nextDay === undefined ? null : periodKey(nextDay);
    if (nextKey === key || nextKey === null) { lastKey = key; continue; }
    // last bar of the period → decide
    let indexOk = true;
    if (rule.indexFilter && indexSeries >= 0) {
      const ser = panel.series[indexSeries]; const j = ser.dayIndex.get(day);
      if (j !== undefined && j >= 200) { let s200 = 0; for (let k = j - 199; k <= j; k += 1) s200 += ser.bars[k].close; indexOk = ser.bars[j].close > s200 / 200; }
    }
    const scored = [];
    panel.series.forEach((ser, s) => {
      const j = ser.dayIndex.get(day); if (j === undefined) return;
      const v = rule.score({ close: closes[s], volume: volumes[s], bars: allBars[s], i: j, year, month, week });
      if (Number.isFinite(v)) scored.push({ s, v, ret12: j >= year ? closes[s][j] / closes[s][j - year] - 1 : null });
    });
    const w = new Map();
    if (indexOk && scored.length >= Math.max(4, minK)) {
      scored.sort((a, b) => b.v - a.v);
      const k = Math.max(minK, Math.round(scored.length * topFraction));
      const picks = scored.slice(0, k).filter((x) => !rule.absolute || (x.ret12 !== null && x.ret12 > 0));
      const losers = scored.slice(-k).filter((x) => !rule.absolute || (x.ret12 !== null && x.ret12 < 0));
      if (shortOnly) { for (const p of losers) w.set(p.s, -1 / k); }
      else if (longShort) { for (const p of picks) w.set(p.s, 0.5 / k); for (const p of losers) w.set(p.s, (w.get(p.s) ?? 0) - (0.5 / k)); }
      else for (const p of picks) w.set(p.s, 1 / k); // unfilled slots stay in cash
    }
    pending = w; lastKey = key;
  }
  void lastKey;
  return { returns: out, avgExposure: out.length ? exposure / out.length : 0, turnoverPerYear: out.length ? (turnover / out.length) * spec.barsPerYear : 0 };
}


// ------------------------------------------------------------------ tactical asset allocation (US ETFs, monthly)
// Momentum helpers on month-end closes: r(k) = close / close k months ago − 1.
function retMonths(close, i, months, month) { const j = i - (months * month); return j >= 0 && close[j] > 0 ? close[i] / close[j] - 1 : null; }
function score13612w(close, i, month) {
  const r1 = retMonths(close, i, 1, month); const r3 = retMonths(close, i, 3, month); const r6 = retMonths(close, i, 6, month); const r12 = retMonths(close, i, 12, month);
  return [r1, r3, r6, r12].every((v) => v !== null) ? (12 * r1) + (4 * r3) + (2 * r6) + r12 : null;
}

export const ALLOCATION_MODELS_V1 = Object.freeze([
  { id: 'SIXTY_FORTY', name: '주식 60 / 채권 40 (월간 리밸런싱, 비교용)', source: 'benchmark',
    weights: () => ({ SPY: 0.6, AGG: 0.4 }) },
  { id: 'GEM', name: '듀얼 모멘텀 GEM (SPY·EFA vs AGG)', source: 'Antonacci 2014',
    weights: ({ r }) => { const spy = r('SPY', 12); const efa = r('EFA', 12); const bil = r('BIL', 12) ?? 0; if (spy === null || efa === null) return null;
      return spy > bil ? (spy >= efa ? { SPY: 1 } : { EFA: 1 }) : { AGG: 1 }; } },
  { id: 'VAA_G4', name: 'VAA 공격형 4 (Keller-Keuning)', source: 'Keller & Keuning 2017, SSRN 3002624',
    weights: ({ sc }) => { const off = ['SPY', 'EFA', 'EEM', 'AGG']; const def = ['LQD', 'IEF', 'SHY'];
      const o = off.map((x) => [x, sc(x)]); const d = def.map((x) => [x, sc(x)]); if ([...o, ...d].some(([, v]) => v === null)) return null;
      const pool = o.every(([, v]) => v > 0) ? o : d; pool.sort((a, b) => b[1] - a[1]); return { [pool[0][0]]: 1 }; } },
  { id: 'DAA_G12', name: 'DAA 방어적 자산배분 G12 (카나리아 VWO·BND)', source: 'Keller & Keuning 2018, SSRN 3212862',
    weights: ({ sc }) => { const risky = ['SPY', 'IWM', 'QQQ', 'VGK', 'EWJ', 'VWO', 'VNQ', 'DBC', 'GLD', 'TLT', 'HYG', 'LQD']; const cash = ['SHY', 'IEF', 'LQD'];
      const can = ['VWO', 'BND'].map((x) => sc(x)); if (can.some((v) => v === null)) return null; const bad = can.filter((v) => v <= 0).length;
      const rs = risky.map((x) => [x, sc(x)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const cs = cash.map((x) => [x, sc(x)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]);
      if (!cs.length || rs.length < 6) return null; const riskyShare = bad === 0 ? 1 : bad === 1 ? 0.5 : 0; const w = {};
      for (const [x] of rs) w[x] = (w[x] ?? 0) + (riskyShare / rs.length); w[cs[0][0]] = (w[cs[0][0]] ?? 0) + (1 - riskyShare); return w; } },
  { id: 'HAA', name: 'HAA 하이브리드 (TIP 카나리아, 상위 4)', source: 'Keller 2023, SSRN 4346906',
    weights: ({ u }) => { const tip = u('TIP'); const off = ['SPY', 'IWM', 'VEA', 'VWO', 'VNQ', 'DBC', 'IEF', 'TLT']; const bilU = u('BIL'); const iefU = u('IEF');
      if (tip === null || bilU === null || iefU === null) return null; const safe = bilU >= iefU ? 'BIL' : 'IEF';
      if (tip <= 0) return { [safe]: 1 }; const rs = off.map((x) => [x, u(x)]); if (rs.some(([, v]) => v === null)) return null;
      rs.sort((a, b) => b[1] - a[1]); const w = {}; for (const [x, v] of rs.slice(0, 4)) { const k = v > 0 ? x : safe; w[k] = (w[k] ?? 0) + 0.25; } return w; } },
  { id: 'BAA_BALANCED', name: 'BAA 균형형 (카나리아 4, 상위 6)', source: 'Keller 2022, SSRN 4166845',
    weights: ({ sc, sma12 }) => { const can = ['SPY', 'VWO', 'VEA', 'BND'].map((x) => sc(x)); if (can.some((v) => v === null)) return null;
      const off = ['SPY', 'QQQ', 'IWM', 'VGK', 'EWJ', 'VWO', 'VNQ', 'DBC', 'GLD', 'TLT', 'HYG', 'LQD']; const def = ['TIP', 'DBC', 'BIL', 'IEF', 'TLT', 'LQD', 'BND'];
      const pick = (xs, k) => xs.map((x) => [x, sma12(x)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]).slice(0, k);
      const w = {}; if (can.every((v) => v > 0)) { const p = pick(off, 6); if (p.length < 6) return null; for (const [x] of p) w[x] = 1 / 6; return w; }
      const bil = sma12('BIL') ?? 0; const p = pick(def, 3); if (p.length < 3) return null; for (const [x, v] of p) { const k = v >= bil ? x : 'BIL'; w[k] = (w[k] ?? 0) + 1 / 3; } return w; } },
  { id: 'BAA_AGGRESSIVE', name: 'BAA 공격형 (상위 1)', source: 'Keller 2022, SSRN 4166845',
    weights: ({ sc, sma12 }) => { const can = ['SPY', 'VWO', 'VEA', 'BND'].map((x) => sc(x)); if (can.some((v) => v === null)) return null;
      const off = ['QQQ', 'EFA', 'EEM', 'AGG']; const def = ['TIP', 'DBC', 'BIL', 'IEF', 'TLT', 'LQD', 'BND'];
      const pick = (xs, k) => xs.map((x) => [x, sma12(x)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]).slice(0, k);
      if (can.every((v) => v > 0)) { const p = pick(off, 1); return p.length ? { [p[0][0]]: 1 } : null; }
      const bil = sma12('BIL') ?? 0; const p = pick(def, 3); if (p.length < 3) return null; const w = {}; for (const [x, v] of p) { const k = v >= bil ? x : 'BIL'; w[k] = (w[k] ?? 0) + 1 / 3; } return w; } },
  { id: 'PAA', name: 'PAA 보호형 (a=2, 상위 6, 채권 IEF)', source: 'Keller & Keuning 2016, SSRN 2759734',
    weights: ({ sma12 }) => { const xs = ['SPY', 'QQQ', 'IWM', 'VGK', 'EWJ', 'EEM', 'VNQ', 'DBC', 'GLD', 'HYG', 'LQD', 'TLT']; const v = xs.map((x) => [x, sma12(x)]);
      if (v.some(([, y]) => y === null)) return null; const N = 12; const nPos = v.filter(([, y]) => y > 0).length; const bf = Math.min(1, (N - nPos) / (N - 6));
      const top = v.filter(([, y]) => y > 0).sort((a, b) => b[1] - a[1]).slice(0, 6); const w = { IEF: bf }; for (const [x] of top) w[x] = (w[x] ?? 0) + ((1 - bf) / Math.max(1, top.length)); if (!top.length) w.IEF = 1; return w; } },
  { id: 'COMPOSITE_DM', name: '복합 듀얼모멘텀 4모듈', source: 'Antonacci, Composite Dual Momentum',
    weights: ({ r }) => { const mods = [['SPY', 'EFA'], ['HYG', 'LQD'], ['VNQ', 'REM'], ['GLD', 'TLT']]; const bil = r('BIL', 12) ?? 0; const w = {};
      for (const [a2, b2] of mods) { const ra = r(a2, 12); const rb = r(b2, 12); if (ra === null || rb === null) return null; const best = ra >= rb ? [a2, ra] : [b2, rb]; const k = best[1] > bil ? best[0] : 'BIL'; w[k] = (w[k] ?? 0) + 0.25; }
      return w; } },
  { id: 'ADM', name: '가속 듀얼모멘텀 (SPY·SCZ vs TLT)', source: 'EngineeredPortfolio, Accelerating Dual Momentum',
    weights: ({ r }) => { const sc2 = (x) => { const a1 = r(x, 1); const a3 = r(x, 3); const a6 = r(x, 6); return [a1, a3, a6].every((y) => y !== null) ? a1 + a3 + a6 : null; };
      const a = sc2('SPY'); const b = sc2('SCZ'); if (a === null || b === null) return null; const best = a >= b ? ['SPY', a] : ['SCZ', b]; return best[1] > 0 ? { [best[0]]: 1 } : { TLT: 1 }; } },
  { id: 'IVY5', name: 'Ivy 5 (10개월선 위만 20%씩)', source: 'Faber & Richardson, The Ivy Portfolio (2009)',
    weights: ({ above }) => { const xs = ['VTI', 'VEU', 'VNQ', 'AGG', 'DBC']; if (xs.some((x) => above(x) === null)) return null; const w = {}; for (const x of xs) w[above(x) ? x : 'BIL'] = (w[above(x) ? x : 'BIL'] ?? 0) + 0.2; return w; } },
  { id: 'ETF_SLOPE_R2', name: 'ETF 회귀기울기×R² 1위 (중국 JoinQuant 미국판)', source: 'JoinQuant 커뮤니티 ETF 轮动',
    weights: ({ slopeR2 }) => { const xs = ['GLD', 'QQQ', 'IWM', 'SPY', 'TLT'].map((x) => [x, slopeR2(x)]); if (xs.some(([, v]) => v === null)) return null;
      xs.sort((a, b) => b[1] - a[1]); return xs[0][1] > 0 ? { [xs[0][0]]: 1 } : { BIL: 1 }; } },
  { id: 'LETF_SMA200', name: '나스닥 200일선 위면 TQQQ, 아래면 채권 (r/LETFs)', source: 'Reddit r/LETFs 200SMA strategy',
    weights: ({ aboveK }) => { const v = aboveK('QQQ', 1); if (v === null) return null; return v > 1 ? { TQQQ: 1 } : { IEF: 1 }; } },
  { id: 'GTAA5', name: 'GTAA 5 (10개월선 위 자산만 20%씩)', source: 'Faber 2007, A Quantitative Approach to TAA',
    weights: ({ above }) => { const xs = ['SPY', 'EFA', 'IEF', 'VNQ', 'DBC']; if (xs.some((x) => above(x) === null)) return null; const w = {}; for (const x of xs) if (above(x)) w[x] = 0.2; return w; } },
]);

/** Pure: monthly allocation (decided at the month's last close, executed next open). */
export function simulateAllocationPortfolio(panel, model, market) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const month = Math.round(spec.barsPerYear / 12);
  const idx = new Map(panel.series.map((s, k) => [s.symbol, k]));
  let weights = new Map(); let pending = null; const out = []; let turnover = 0; let exposure = 0; let decided = false;
  for (let d = 0; d < panel.calendar.length; d += 1) {
    const day = panel.calendar[d];
    const next = pending ?? weights; let r = 0; let tu = 0;
    for (const s of new Set([...weights.keys(), ...next.keys()])) {
      const ser = panel.series[s]; const j = ser.dayIndex.get(day); const wPrev = weights.get(s) ?? 0; const wNow = next.get(s) ?? 0;
      tu += Math.abs(wNow - wPrev); if (j === undefined || j < 1) continue;
      const b = ser.bars[j]; const pc = ser.bars[j - 1].close; r += (wPrev * (b.open / pc - 1)) + (wNow * (b.close / b.open - 1));
    }
    r -= spec.costPerSide * tu; weights = next; pending = null;
    if (decided) { out.push({ day, ret: r }); turnover += tu; exposure += [...weights.values()].reduce((a, v) => a + v, 0); }
    const nextDay = panel.calendar[d + 1];
    if (nextDay === undefined || new Date(nextDay).getUTCMonth() === new Date(day).getUTCMonth()) continue;
    const at = (x) => { const k = idx.get(x); if (k === undefined) return null; const ser = panel.series[k]; const j = ser.dayIndex.get(day); return j === undefined ? null : { close: ser.bars.map((b) => b.close), j }; };
    const ctx = {
      r: (x, m) => { const a = at(x); return a ? retMonths(a.close, a.j, m, month) : null; },
      sc: (x) => { const a = at(x); return a ? score13612w(a.close, a.j, month) : null; },
      u: (x) => { const a = at(x); if (!a) return null; const v = [1, 3, 6, 12].map((m) => retMonths(a.close, a.j, m, month)); return v.every((y) => y !== null) ? v.reduce((p, q) => p + q, 0) / 4 : null; },
      sma12: (x) => { const a = at(x); if (!a || a.j < 12 * month) return null; let sum = 0; for (let k = 0; k <= 12; k += 1) sum += a.close[a.j - (k * month)]; return a.close[a.j] / (sum / 13) - 1; },
      slopeR2: (x, n = 25) => { const a = at(x); if (!a || a.j < n) return null; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
        for (let k = 0; k < n; k += 1) { const y = Math.log(a.close[a.j - n + 1 + k]); sx += k; sy += y; sxx += k * k; sxy += k * y; syy += y * y; }
        const den = (n * sxx) - (sx * sx); const slope = ((n * sxy) - (sx * sy)) / den; const r2d = den * ((n * syy) - (sy * sy)); const r2 = r2d > 0 ? (((n * sxy) - (sx * sy)) ** 2) / r2d : 0;
        return ((Math.exp(slope) ** 250) - 1) * r2; },
      aboveK: (x, k) => { const a = at(x); if (!a || a.j < 200) return null; let s2 = 0; for (let q = a.j - 199; q <= a.j; q += 1) s2 += a.close[q]; return a.close[a.j] / (s2 / 200) / k; },
      above: (x) => { const a = at(x); if (!a || a.j < 210) return null; let s2 = 0; for (let k = a.j - 209; k <= a.j; k += 1) s2 += a.close[k]; return a.close[a.j] > s2 / 210; },
    };
    const w = model.weights(ctx);
    if (!w) continue;
    decided = true;
    const m = new Map(); for (const [x, v] of Object.entries(w)) { const k = idx.get(x); if (k !== undefined && v > 0) m.set(k, v); }
    pending = m;
  }
  return { returns: out, avgExposure: out.length ? exposure / out.length : 0, turnoverPerYear: out.length ? (turnover / out.length) * spec.barsPerYear : 0 };
}

// ------------------------------------------------------------------ statistics

function normalCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; const z = Math.abs(x) / Math.SQRT2; const tt = 1 / (1 + (0.3275911 * z));
  const y = 1 - ((((((1.061405429 * tt) - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-z * z);
  return 0.5 * (1 + (s * y));
}

function normalInv(p) {
  // Acklam's rational approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Pure: performance of a daily return series. */
export function performanceV1(returns, barsPerYear) {
  const r = returns.map((x) => x.ret).filter(Number.isFinite);
  const n = r.length;
  if (n < 20) return { days: n, cagr: null, vol: null, sharpe: null, maxDrawdown: null, calmar: null, totalReturn: null, skew: null, kurt: null, srPerBar: null };
  let eq = 1; let peak = 1; let mdd = 0;
  for (const x of r) { eq *= 1 + x; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - (eq / peak)); }
  const mean = r.reduce((a, v) => a + v, 0) / n;
  const varr = r.reduce((a, v) => a + ((v - mean) ** 2), 0) / (n - 1);
  const sd = Math.sqrt(varr);
  const m3 = r.reduce((a, v) => a + ((v - mean) ** 3), 0) / n; const m4 = r.reduce((a, v) => a + ((v - mean) ** 4), 0) / n;
  const years = n / barsPerYear;
  const cagr = eq > 0 ? (eq ** (1 / years)) - 1 : -1;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : null;
  return {
    days: n, totalReturn: eq - 1, cagr, vol: sd * Math.sqrt(barsPerYear), sharpe, maxDrawdown: mdd,
    calmar: mdd > 0 ? cagr / mdd : null, srPerBar: sd > 0 ? mean / sd : null,
    skew: sd > 0 ? m3 / (sd ** 3) : 0, kurt: sd > 0 ? m4 / (sd ** 4) : 3,
  };
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014): probability that the
 * true Sharpe exceeds the expected maximum Sharpe of `trials` unskilled tries.
 */
export function deflatedSharpeV1({ srPerBar, days, skew, kurt }, { trials, srVariance }) {
  if (!Number.isFinite(srPerBar) || days < 30 || trials < 1) return null;
  const gamma = 0.5772156649;
  const sd = Math.sqrt(Math.max(srVariance, 1e-12));
  const sr0 = trials > 1 ? sd * (((1 - gamma) * normalInv(1 - (1 / trials))) + (gamma * normalInv(1 - (1 / (trials * Math.E))))) : 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - (skew * srPerBar) + (((kurt - 1) / 4) * srPerBar * srPerBar)));
  return normalCdf(((srPerBar - sr0) * Math.sqrt(days - 1)) / denom);
}

function correlation(x, y) {
  // every series ends on the market's last day: align on the common tail
  const n = Math.min(x.length, y.length); if (n < 30) return null;
  x = x.slice(x.length - n); y = y.slice(y.length - n);
  let sx = 0; let sy = 0; for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; }
  const mx = sx / n; const my = sy / n; let cov = 0; let vx = 0; let vy = 0;
  for (let i = 0; i < n; i += 1) { const dx = x[i] - mx; const dy = y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
}

function splitReturns(returns, fraction = 0.6) {
  if (!returns.length) return { discovery: [], validation: [], splitDay: null };
  const first = returns[0].day; const last = returns.at(-1).day;
  const splitDay = first + ((last - first) * fraction);
  return { discovery: returns.filter((x) => x.day < splitDay), validation: returns.filter((x) => x.day >= splitDay), splitDay };
}

/** Pre-registered verdict (fixed before running). */
export function verdictV1(row, benchmark) {
  const v = row.validation; const dsc = row.discovery;
  if (!v || v.sharpe === null || dsc.sharpe === null) return 'NO_DATA';
  const bv = benchmark?.validation;
  const beatsBenchmark = bv && bv.sharpe !== null && v.sharpe >= bv.sharpe;
  const saferWithReturn = bv && bv.maxDrawdown > 0 && v.maxDrawdown <= 0.6 * bv.maxDrawdown && v.cagr >= 0.5 * Math.max(0, bv.cagr);
  if (v.sharpe >= 0.5 && v.cagr > 0 && dsc.sharpe > 0 && (row.deflatedSharpe ?? 0) >= 0.9 && (beatsBenchmark || saferWithReturn)) return 'USABLE';
  if (v.sharpe >= 0.3 && dsc.sharpe > 0 && v.cagr > 0) return 'WATCH';
  return 'REJECT';
}

// ------------------------------------------------------------------ run

/** Mirror chart (1/price, high↔low): a long rule on it is the symmetric short rule. */
export function invertBars(bars) {
  return bars.map((b) => ({ timestamp: b.timestamp, open: 1 / b.open, high: 1 / b.low, low: 1 / b.high, close: 1 / b.close, volume: b.volume }));
}

/** Futures variants of one timing rule: LONG (long side only), SHORT (mirror-chart long = short), LS (both). */
function futuresTargets(panel, rule, market, side) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const year = spec.barsPerYear; const month = Math.round(year / 12);
  return panel.series.map((ser) => {
    const run = (bars) => rule.make({ bars, close: bars.map((b) => b.close), n: bars.length, year, month, crypto: true });
    const longSide = side === 'SHORT' ? null : run(ser.bars).map((v) => Math.max(0, Number(v) || 0));
    const shortSide = side === 'LONG' ? null : run(invertBars(ser.bars)).map((v) => Math.max(0, Number(v) || 0));
    return ser.bars.map((_, i) => Math.max(-1, Math.min(1, (longSide ? longSide[i] : 0) - (shortSide ? shortSide[i] : 0))));
  });
}

function timingTargets(panel, rule, market) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  const year = spec.barsPerYear; const month = Math.round(year / 12);
  return panel.series.map((ser) => {
    const bars = ser.bars; const close = bars.map((b) => b.close);
    return rule.make({ bars, close, n: bars.length, year, month, crypto: market.startsWith('CRYPTO') });
  });
}

export function evaluateStrategyZooMarketV1({ market, datasets }) {
  const spec = STRATEGY_ZOO_MARKETS_V1[market];
  if (!spec) throw new Error(`STRATEGY_ZOO_MARKET_UNKNOWN:${market}`);
  const panel = buildPanel(datasets);
  const rows = [];
  const allocationOnly = market === 'US_TAA';
  const add = (meta, sim) => {
    const full = performanceV1(sim.returns, spec.barsPerYear);
    const split = splitReturns(sim.returns);
    rows.push({ ...meta, daily: sim.returns.map((x) => x.ret), full, discovery: performanceV1(split.discovery, spec.barsPerYear), validation: performanceV1(split.validation, spec.barsPerYear),
      splitDate: split.splitDay ? new Date(split.splitDay).toISOString().slice(0, 10) : null,
      avgExposure: sim.avgExposure, turnoverPerYear: sim.turnoverPerYear });
  };
  if (allocationOnly) {
    const spy = panel.series.findIndex((x) => x.symbol === 'SPY');
    if (spy >= 0) add({ id: 'BUY_HOLD', family: '기준', name: 'SPY 그냥 보유', source: 'benchmark', kind: 'timing' },
      simulateTimingPortfolio({ ...panel, series: [panel.series[spy]] }, [new Array(panel.series[spy].bars.length).fill(1)], market));
    for (const model of ALLOCATION_MODELS_V1) add({ id: model.id, family: '자산배분', name: model.name, source: model.source, kind: 'allocation' }, simulateAllocationPortfolio(panel, model, market));
  }
  const SIDE_KO = { LONG: '롱만', SHORT: '숏만', LS: '롱숏' };
  for (const rule of allocationOnly ? [] : [...TIMING_RULES_V1, ...VOLUME_FILTERED_RULES_V1]) {
    if (rule.nativeShort) {
      // a rule that only exists as a short: futures only, run as written
      if (market === 'CRYPTO_FUTURES') add({ id: rule.id, family: rule.family, name: `${rule.name} [숏만]`, source: rule.source, kind: 'timing', side: 'SHORT' }, simulateTimingPortfolio(panel, timingTargets(panel, rule, market), market));
    } else if (market === 'CRYPTO_FUTURES') {
      for (const side of ['LONG', 'SHORT', 'LS']) {
        if (rule.id === 'BUY_HOLD' && side === 'LS') continue;
        const id = rule.id === 'BUY_HOLD' && side === 'LONG' ? 'BUY_HOLD' : `${rule.id}__${side}`;
        add({ id, family: rule.family, name: rule.id === 'BUY_HOLD' && side === 'LONG' ? rule.name : `${rule.name} [${SIDE_KO[side]}]`, source: rule.source, kind: 'timing', side },
          simulateTimingPortfolio(panel, futuresTargets(panel, rule, market, side), market));
      }
    } else add({ id: rule.id, family: rule.family, name: rule.name, source: rule.source, kind: 'timing' }, simulateTimingPortfolio(panel, timingTargets(panel, rule, market), market));
  }
  for (const rule of allocationOnly ? [] : SPECIAL_RULES_V1) {
    if (rule.id === 'OVERNIGHT' && market.startsWith('CRYPTO')) continue;
    if (rule.id === 'WEEKEND_CRYPTO' && !market.startsWith('CRYPTO')) continue;
    if (rule.id.startsWith('FUNDING_CARRY') && market !== 'CRYPTO_FUTURES') continue;
    if (rule.id.startsWith('FUNDING_CARRY') && !panel.series.some((s) => s.funding.length > 100)) continue;
    add({ id: rule.id, family: rule.family, name: rule.name, source: rule.source, kind: 'special' }, simulateSpecialPortfolio(panel, rule.id, market));
  }
  if (!allocationOnly && panel.series.length >= 8) {
    for (const rule of ROTATION_RULES_V1) {
      add({ id: rule.id, family: '로테이션', name: market === 'CRYPTO_FUTURES' ? `${rule.name} [롱만]` : rule.name, source: rule.source, kind: 'rotation', side: 'LONG' }, simulateRotationPortfolio(panel, rule, market));
      if (market === 'CRYPTO_FUTURES') {
        add({ id: `${rule.id}__LS`, family: '로테이션', name: `${rule.name} [상위 롱 + 하위 숏, 시장중립]`, source: rule.source, kind: 'rotation', side: 'LS' }, simulateRotationPortfolio(panel, rule, market, { longShort: true }));
        add({ id: `${rule.id}__SHORT`, family: '로테이션', name: `${rule.name} [하위 숏만]`, source: rule.source, kind: 'rotation', side: 'SHORT' }, simulateRotationPortfolio(panel, rule, market, { shortOnly: true }));
      }
    }
  }
  // multiple-testing deflation over everything tried in this market
  // Robust spread of trial Sharpes (1.4826 × MAD): a few cost-destroyed rules
  // (daily round trips) must not inflate the bar every other rule is held to.
  const srs = rows.map((r) => r.full.srPerBar).filter(Number.isFinite).sort((x, y) => x - y);
  const median = (xs) => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[(xs.length / 2) - 1] + xs[xs.length / 2]) / 2) : 0);
  const med = median(srs);
  const mad = median(srs.map((v) => Math.abs(v - med)).sort((x, y) => x - y));
  const srVariance = (1.4826 * mad) ** 2;
  // Effective number of independent trials (Bailey & López de Prado): many rules
  // here are near-duplicates (e.g. several trend filters), so N_eff = ρ̄ + (1 − ρ̄)·N
  // with ρ̄ the mean absolute pairwise correlation of the strategies' daily returns.
  const series = rows.map((r) => r.daily);
  let sumCorr = 0; let pairs = 0;
  for (let a = 0; a < series.length; a += 1) for (let b = a + 1; b < series.length; b += 1) {
    // |ρ|: a mirrored short of a rule is as redundant as a copy of it
    const c = correlation(series[a], series[b]); if (Number.isFinite(c)) { sumCorr += Math.abs(c); pairs += 1; }
  }
  const rhoBar = pairs ? Math.max(0, Math.min(1, sumCorr / pairs)) : 0;
  const effectiveTrials = Math.max(1, rhoBar + ((1 - rhoBar) * rows.length));
  for (const r of rows) {
    r.deflatedSharpeAllTrials = deflatedSharpeV1(r.full, { trials: rows.length, srVariance });
    r.deflatedSharpe = deflatedSharpeV1(r.full, { trials: effectiveTrials, srVariance });
    delete r.daily;
  }
  const benchmark = rows.find((r) => r.id === 'BUY_HOLD');
  for (const r of rows) r.verdict = r.id === 'BUY_HOLD' || r.id === 'SIXTY_FORTY' ? 'BENCHMARK' : verdictV1(r, benchmark);
  for (const r of rows) if (r.verdict === 'USABLE' && r.full.maxDrawdown > 0.5) r.verdict = 'USABLE_HIGH_DRAWDOWN';
  const span = panel.calendar.length ? { from: new Date(panel.calendar[0]).toISOString().slice(0, 10), to: new Date(panel.calendar.at(-1)).toISOString().slice(0, 10) } : null;
  return { market, label: spec.label, symbols: panel.series.map((s) => s.symbol), span, trials: rows.length, effectiveTrials, meanCorrelation: rhoBar, rows };
}

// ------------------------------------------------------------------ report

const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-');
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const VERDICT_KO = { USABLE: '✅ 쓸만함', USABLE_HIGH_DRAWDOWN: '⚠️ 쓸만하나 낙폭 50%+', WATCH: '🟡 관찰', REJECT: '❌ 탈락', BENCHMARK: '기준', NO_DATA: '데이터 부족' };

export function formatStrategyZooReportKoV1(markets) {
  const lines = ['공개 전략 동물원 · 같은 조건 백테스트 (다음날 시가 체결, 수수료·세금·슬리피지·펀딩 반영, 2025년까지)', ''];
  for (const m of markets) {
    if (!m.rows?.length) { lines.push(`■ ${m.label}: 데이터 없음`, ''); continue; }
    const bh = m.rows.find((r) => r.id === 'BUY_HOLD');
    lines.push(`■ ${m.label} · ${m.symbols.length}종목 · ${m.span?.from}~${m.span?.to} · 시험한 전략 ${m.trials}개 (서로 닮은 정도 ${num(m.meanCorrelation)} → 실효 ${num(m.effectiveTrials, 1)}개로 보정)`);
    lines.push(`  기준(그냥 보유): 연 ${pct(bh.full.cagr)} · 샤프 ${num(bh.full.sharpe)} · 최대낙폭 ${pct(-bh.full.maxDrawdown)} · 검증구간 연 ${pct(bh.validation.cagr)} 샤프 ${num(bh.validation.sharpe)}`);
    const sorted = m.rows.filter((r) => r.id !== 'BUY_HOLD').sort((a, b) => (b.validation.sharpe ?? -9) - (a.validation.sharpe ?? -9));
    for (const r of sorted) {
      lines.push(`  ${VERDICT_KO[r.verdict] ?? r.verdict} ${r.name}: 전체 연 ${pct(r.full.cagr)} 샤프 ${num(r.full.sharpe)} 낙폭 ${pct(-r.full.maxDrawdown)} | 앞 샤프 ${num(r.discovery.sharpe)} · 검증 연 ${pct(r.validation.cagr)} 샤프 ${num(r.validation.sharpe)} 낙폭 ${pct(-r.validation.maxDrawdown)} | 보유비중 ${pct(r.avgExposure)} · 회전 ${num(r.turnoverPerYear, 0)}회/년 · 우연 아닐 확률 ${pct(r.deflatedSharpe)} (전체 ${m.trials}회 기준 ${pct(r.deflatedSharpeAllTrials)})`);
    }
    lines.push('');
  }
  lines.push(...formatVolumeFilterComparisonKoV1(markets));
  lines.push('판정 기준: 검증구간 샤프 ≥ 0.5, 수익 플러스, 앞 구간도 플러스, 다중검정 보정(실효 시행 수) 후 우연 아닐 확률 ≥ 90%, 그리고 그냥 보유보다 샤프가 높거나 낙폭이 40% 이상 작으면서 수익 절반 이상. 1차 실행 후 보정 시행 수를 "전체"에서 "실효(상관 반영)"로 바꿨고, 전체 기준 값도 함께 표시합니다.');
  lines.push('한계: 종목은 현재 대형주·상장 코인(생존 편향) — 특히 물타기(DCA)·평균회귀·로테이션은 망한 종목이 빠져 실제보다 좋게 나옵니다. 주식 해외 환전비 미반영, 과거 성적일 뿐 미래 보장 아님. 주문 권한 없음.');
  return lines.join('\n');
}

/** Pure: filtered rule vs the same rule without the filter, same data and costs. A filter that does not help is marked for removal. */
export function compareVolumeFilterV1(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const rule of VOLUME_FILTERED_RULES_V1) {
    for (const suffix of ['', '__LONG', '__SHORT', '__LS']) {
      const filtered = byId.get(`${rule.id}${suffix}`); const base = byId.get(`${rule.baseId}${suffix}`);
      if (!filtered || !base) continue;
      const f = filtered.full; const b = base.full; const fv = filtered.validation; const bv = base.validation;
      if (![f?.cagr, b?.cagr, fv?.sharpe, bv?.sharpe].every(Number.isFinite)) { out.push({ id: filtered.id, baseId: base.id, filter: rule.filter, verdict: 'NO_DATA' }); continue; }
      const cagrDelta = f.cagr - b.cagr; const mddDelta = b.maxDrawdown - f.maxDrawdown; const sharpeDelta = fv.sharpe - bv.sharpe;
      // Kept only if net return is not worse, drawdown is not deeper, validation Sharpe improves, and the validation CAGR stays positive.
      const keep = cagrDelta >= 0 && mddDelta >= 0 && sharpeDelta > 0 && fv.cagr > 0;
      out.push({ id: filtered.id, baseId: base.id, filter: rule.filter, name: filtered.name, cagrDelta, mddDelta, validationSharpeDelta: sharpeDelta, validationCagr: fv.cagr,
        deflatedSharpe: filtered.deflatedSharpe ?? null, verdict: keep ? 'KEEP' : 'REMOVE' });
    }
  }
  return out;
}

export function formatVolumeFilterComparisonKoV1(markets) {
  const lines = [];
  for (const m of markets) {
    if (!m.rows?.length) continue;
    const comparisons = compareVolumeFilterV1(m.rows);
    if (!comparisons.length) continue;
    lines.push(`■ 거래량 필터 비교 · ${m.label} (같은 데이터·같은 비용, 필터 없는 같은 전략 대비)`);
    for (const c of comparisons) {
      if (c.verdict === 'NO_DATA') { lines.push(`  데이터 부족 ${c.id}`); continue; }
      lines.push(`  ${c.verdict === 'KEEP' ? '✅ 유지' : '❌ 제거'} ${c.name}: 연수익 ${pct(c.cagrDelta)}p · 낙폭 ${pct(c.mddDelta)}p 개선 · 검증 샤프 ${c.validationSharpeDelta >= 0 ? '+' : ''}${num(c.validationSharpeDelta)} · 검증 연 ${pct(c.validationCagr)} · 보정 ${num(c.deflatedSharpe)}`);
    }
    lines.push('');
  }
  return lines;
}
