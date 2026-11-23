// Intraday scalp / pump-catching zoo (research only, no orders).
// Question: can rules that try to grab +several % to +tens of % within minutes
// to a day beat (a) zero after costs and (b) random entries with the same exits?
//
// Execution model (conservative):
//   - signal on bar i close → enter at bar i+1 open, cost per side included
//   - exits checked bar by bar; if stop and target are both touched in one bar,
//     the stop is assumed first; gaps through a level fill at the bar open
//   - trailing stops tighten only from the PREVIOUS bar's extreme (no intrabar lookahead)
//   - one position per symbol per rule; funding ignored (holds ≤ 1–5 days, ~0.01%/8h)
import { ema, rollingMax, rollingMin, rollingStd, rsi, sma } from './strategy-zoo-v1.mjs';

export const INTRADAY_CONTRACT_V1 = 'intraday-scalp-zoo/v1';
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const INTRADAY_VENUES_V1 = Object.freeze({
  // taker 0.06% + slippage 0.02% per side on liquid perps
  BITGET_5M: Object.freeze({ label: '코인선물 5분봉', costPerSide: 0.0008, shortAllowed: true, barMs: 5 * 60_000 }),
  BITGET_1H: Object.freeze({ label: '코인선물 1시간봉', costPerSide: 0.0008, shortAllowed: true, barMs: HOUR }),
  // Upbit fee 0.05% + 0.10% slippage on KRW alts during pumps
  UPBIT_1H: Object.freeze({ label: '업비트 현물 1시간봉 (알트 급등)', costPerSide: 0.0015, shortAllowed: false, barMs: HOUR }),
});

// ------------------------------------------------------------------ context

const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);

export function buildIntradayContext(bars) {
  const n = bars.length;
  const close = bars.map((b) => b.close); const high = bars.map((b) => b.high); const low = bars.map((b) => b.low); const vol = bars.map((b) => b.volume ?? 0);
  const cache = new Map();
  const memo = (key, f) => { if (!cache.has(key)) cache.set(key, f()); return cache.get(key); };
  // UTC day bookkeeping, previous-day high/low, daily VWAP (resets 00:00 UTC)
  const dayIdx = new Array(n); const pdh = new Array(n).fill(null); const pdl = new Array(n).fill(null); const vwap = new Array(n).fill(null);
  let curDay = null; let dh = -Infinity; let dl = Infinity; let prevH = null; let prevL = null; let pv = 0; let vv = 0;
  for (let i = 0; i < n; i += 1) {
    const d = Math.floor(bars[i].timestamp / DAY);
    if (d !== curDay) { if (curDay !== null) { prevH = dh; prevL = dl; } curDay = d; dh = -Infinity; dl = Infinity; pv = 0; vv = 0; }
    dayIdx[i] = d; pdh[i] = prevH; pdl[i] = prevL;
    dh = Math.max(dh, high[i]); dl = Math.min(dl, low[i]);
    const typical = (high[i] + low[i] + close[i]) / 3; pv += typical * vol[i]; vv += vol[i]; vwap[i] = vv > 0 ? pv / vv : close[i];
  }
  return {
    bars, n, close, high, low, vol, dayIdx, pdh, pdl, vwap,
    ema: (L) => memo(`ema${L}`, () => ema(close, L)),
    sma: (L) => memo(`sma${L}`, () => sma(close, L)),
    avgVol: (L) => memo(`av${L}`, () => sma(vol, L)),
    maxHigh: (L) => memo(`mh${L}`, () => rollingMax(high, L)),
    minLow: (L) => memo(`ml${L}`, () => rollingMin(low, L)),
    rsi: (L) => memo(`rsi${L}`, () => rsi(close, L)),
    bbWidth: (L) => memo(`bbw${L}`, () => { const m = sma(close, L); const sd = rollingStd(close, L); return close.map((_, i) => (fin(m[i]) && m[i] > 0 ? (4 * sd[i]) / m[i] : null)); }),
    bbUpper: (L) => memo(`bbu${L}`, () => { const m = sma(close, L); const sd = rollingStd(close, L); return close.map((_, i) => (fin(m[i]) ? m[i] + (2 * sd[i]) : null)); }),
    minOf: (key, arr, L) => memo(`min:${key}:${L}`, () => rollingMin(arr.map((v) => (fin(v) ? v : Infinity)), L)),
    state: new Map(),
  };
}

const ret = (c, i, k) => (i >= k && c.close[i - k] > 0 ? c.close[i] / c.close[i - k] - 1 : null);
const volX = (c, i, L) => { const a = c.avgVol(L); return i > 0 && fin(a[i - 1]) && a[i - 1] > 0 ? c.vol[i] / a[i - 1] : null; };
const minuteOfDay = (c, i) => Math.floor((c.bars[i].timestamp % DAY) / 60_000);

/** Opening-range breakout for a session starting at `startMin` (UTC minutes), range of `rangeBars` bars. */
function orb(c, i, { key, startMin, rangeBars, barMin, lastMin, side }) {
  const st = c.state.get(key) ?? {}; c.state.set(key, st);
  const m = minuteOfDay(c, i); const d = c.dayIdx[i];
  if (st.day !== d) { st.day = d; st.hi = null; st.lo = null; st.count = 0; st.done = false; }
  if (m >= startMin && m < startMin + (rangeBars * barMin)) {
    st.hi = Math.max(st.hi ?? -Infinity, c.high[i]); st.lo = Math.min(st.lo ?? Infinity, c.low[i]); st.count += 1; return null;
  }
  if (st.done || st.count < rangeBars || m >= lastMin || m < startMin) return null;
  const width = st.hi - st.lo; if (!(width > 0)) return null;
  const exitInBars = Math.max(1, Math.floor((lastMin - m) / barMin));
  if (side === 'LONG' && c.close[i] > st.hi) { st.done = true; return { stopPrice: st.lo, targetR: 2, maxBars: exitInBars }; }
  if (side === 'SHORT' && c.close[i] < st.lo) { st.done = true; return { stopPrice: st.hi, targetR: 2, maxBars: exitInBars }; }
  return null;
}

// ------------------------------------------------------------------ rules

export const INTRADAY_RULES_V1 = Object.freeze([
  // ---------------- 5-minute perpetuals (2023–2025)
  { id: 'F5_VOL_SPIKE_BREAKOUT', venue: 'BITGET_5M', side: 'LONG', name: '5분 거래량 10배 폭발 + 하루 신고가 돌파 롱 (손절 2%, 익절 6%, 12시간)', source: '급등 포착 텔레그램/유튜브 단골 (거래량 폭발 돌파)',
    baseline: Object.freeze({ stopPct: 0.02, targetPct: 0.06, maxBars: 144 }),
    signal: (c, i) => { const vx = volX(c, i, 288); const mh = c.maxHigh(288);
      return vx >= 10 && c.close[i] / c.bars[i].open - 1 >= 0.015 && fin(mh[i - 1]) && c.close[i] > mh[i - 1] ? { stopPct: 0.02, targetPct: 0.06, maxBars: 144 } : null; } },
  { id: 'F5_VOL_SPIKE_TRAIL', venue: 'BITGET_5M', side: 'LONG', name: '5분 거래량 폭발 돌파 롱 (손절 2%, 3% 트레일링, 24시간)', source: '같은 진입, 수익 끝까지 따라가기',
    baseline: Object.freeze({ stopPct: 0.02, trailPct: 0.03, maxBars: 288 }),
    signal: (c, i) => { const vx = volX(c, i, 288); const mh = c.maxHigh(288);
      return vx >= 10 && c.close[i] / c.bars[i].open - 1 >= 0.015 && fin(mh[i - 1]) && c.close[i] > mh[i - 1] ? { stopPct: 0.02, trailPct: 0.03, maxBars: 288 } : null; } },
  { id: 'F5_PUMP_FADE_SHORT', venue: 'BITGET_5M', side: 'SHORT', name: '4시간 +10% 급등 후 첫 음봉 이탈 숏 (급등 고점 손절, 익절 6%)', source: '펌프 꼭대기 숏 (Kullamägi parabolic short 단타판)',
    signal: (c, i) => { const r = ret(c, i, 48); const mh = c.maxHigh(48);
      return r >= 0.10 && c.close[i] < c.bars[i].open && c.close[i] < c.low[i - 1] ? { stopPrice: mh[i] * 1.002, targetPct: 0.06, maxBars: 144 } : null; } },
  { id: 'F5_DUMP_BOUNCE', venue: 'BITGET_5M', side: 'LONG', name: '1시간 −5% 투매 + 거래량 5배 반등 롱 (손절 3%, 익절 4%, 6시간)', source: '청산 캐스케이드 반등 (liquidation flush bounce)',
    baseline: Object.freeze({ stopPct: 0.03, targetPct: 0.04, maxBars: 72 }),
    signal: (c, i) => { const r = ret(c, i, 12); return r <= -0.05 && volX(c, i, 288) >= 5 ? { stopPct: 0.03, targetPct: 0.04, maxBars: 72 } : null; } },
  { id: 'F5_VWAP_RECLAIM', venue: 'BITGET_5M', side: 'LONG', name: 'VWAP 재돌파 + 거래량 2배 + 1시간 200EMA 위 롱 (손절 0.8%, 익절 1.6%)', source: '데이트레이딩 VWAP 기법 (Brian Shannon 등)',
    baseline: Object.freeze({ stopPct: 0.008, targetPct: 0.016, maxBars: 48 }),
    signal: (c, i) => { const e = c.ema(2400); return i > 0 && fin(e[i]) && c.close[i - 1] < c.vwap[i - 1] && c.close[i] > c.vwap[i] && c.close[i] > e[i] && volX(c, i, 288) >= 2 ? { stopPct: 0.008, targetPct: 0.016, maxBars: 48 } : null; } },
  { id: 'F5_EMA9_21_LONG', venue: 'BITGET_5M', side: 'LONG', name: '5분 EMA9/21 골든크로스 + 1시간 추세 위 롱 (손절 1%, 익절 2%) — 단타 유튜버식', source: '선물 단타 유튜브 단골 (EMA 크로스 + 상위 추세)',
    baseline: Object.freeze({ stopPct: 0.01, targetPct: 0.02, maxBars: 72 }),
    signal: (c, i) => { const f = c.ema(9); const s = c.ema(21); const e = c.ema(2400); return i > 0 && fin(e[i]) && f[i - 1] <= s[i - 1] && f[i] > s[i] && c.close[i] > e[i] ? { stopPct: 0.01, targetPct: 0.02, maxBars: 72 } : null; } },
  { id: 'F5_EMA9_21_SHORT', venue: 'BITGET_5M', side: 'SHORT', name: '5분 EMA9/21 데드크로스 + 1시간 추세 아래 숏 (손절 1%, 익절 2%)', source: '선물 단타 유튜브 단골',
    baseline: Object.freeze({ stopPct: 0.01, targetPct: 0.02, maxBars: 72 }),
    signal: (c, i) => { const f = c.ema(9); const s = c.ema(21); const e = c.ema(2400); return i > 0 && fin(e[i]) && f[i - 1] >= s[i - 1] && f[i] < s[i] && c.close[i] < e[i] ? { stopPct: 0.01, targetPct: 0.02, maxBars: 72 } : null; } },
  { id: 'F5_RSI2_SCALP', venue: 'BITGET_5M', side: 'LONG', name: '5분 RSI(2)<5 눌림 + 상위 추세 롱 (손절 1.5%, 익절 1%)', source: 'Connors RSI2 단타판',
    baseline: Object.freeze({ stopPct: 0.015, targetPct: 0.01, maxBars: 24 }),
    signal: (c, i) => { const r = c.rsi(2); const e = c.ema(2400); return fin(r[i]) && fin(e[i]) && r[i] < 5 && c.close[i] > e[i] ? { stopPct: 0.015, targetPct: 0.01, maxBars: 24 } : null; } },
  { id: 'F5_ICT_SWEEP_PDL', venue: 'BITGET_5M', side: 'LONG', name: 'ICT 유동성 사냥: 전일 저가 깨고 다시 회복 롱 (사냥 저점 손절, 전일 고가 목표)', source: 'ICT / SMC (liquidity sweep) 유튜브',
    signal: (c, i) => { const l = c.pdl[i]; const h = c.pdh[i]; return fin(l) && fin(h) && c.low[i] < l && c.close[i] > l && h > c.close[i] * 1.004 ? { stopPrice: c.low[i] * 0.999, targetPrice: h, maxBars: 288 } : null; } },
  { id: 'F5_ICT_SWEEP_PDH', venue: 'BITGET_5M', side: 'SHORT', name: 'ICT 유동성 사냥: 전일 고가 뚫고 다시 하락 숏 (사냥 고점 손절, 전일 저가 목표)', source: 'ICT / SMC (liquidity sweep) 유튜브',
    signal: (c, i) => { const l = c.pdl[i]; const h = c.pdh[i]; return fin(l) && fin(h) && c.high[i] > h && c.close[i] < h && l < c.close[i] * 0.996 ? { stopPrice: c.high[i] * 1.001, targetPrice: l, maxBars: 288 } : null; } },
  { id: 'F5_ORB_NY_LONG', venue: 'BITGET_5M', side: 'LONG', name: '뉴욕장 첫 30분 범위 상단 돌파 롱 (범위 하단 손절, 2R, 당일 청산)', source: 'Opening Range Breakout (Crabel; Zarattini 2023)',
    signal: (c, i) => orb(c, i, { key: 'nyL', startMin: 810, rangeBars: 6, barMin: 5, lastMin: 1435, side: 'LONG' }) },
  { id: 'F5_ORB_NY_SHORT', venue: 'BITGET_5M', side: 'SHORT', name: '뉴욕장 첫 30분 범위 하단 이탈 숏 (2R, 당일 청산)', source: 'Opening Range Breakout',
    signal: (c, i) => orb(c, i, { key: 'nyS', startMin: 810, rangeBars: 6, barMin: 5, lastMin: 1435, side: 'SHORT' }) },
  { id: 'F5_ORB_KST9_LONG', venue: 'BITGET_5M', side: 'LONG', name: '한국 아침 9시 첫 30분 범위 돌파 롱 (2R, 당일 청산)', source: 'Opening Range Breakout — 코인 9시 리셋',
    signal: (c, i) => orb(c, i, { key: 'k9L', startMin: 0, rangeBars: 6, barMin: 5, lastMin: 1435, side: 'LONG' }) },
  { id: 'F5_ORB_KST9_SHORT', venue: 'BITGET_5M', side: 'SHORT', name: '한국 아침 9시 첫 30분 범위 이탈 숏 (2R, 당일 청산)', source: 'Opening Range Breakout — 코인 9시 리셋',
    signal: (c, i) => orb(c, i, { key: 'k9S', startMin: 0, rangeBars: 6, barMin: 5, lastMin: 1435, side: 'SHORT' }) },
  { id: 'F5_SQUEEZE_BREAKOUT', venue: 'BITGET_5M', side: 'LONG', name: '5분 볼린저 하루 최저 수축 후 상단 돌파 롱 (손절 1.5%, 2% 트레일링)', source: 'Bollinger squeeze 단타판',
    baseline: Object.freeze({ stopPct: 0.015, trailPct: 0.02, maxBars: 144 }),
    signal: (c, i) => { const w = c.bbWidth(20); const mw = c.minOf('bbw20', w, 288); const up = c.bbUpper(20); const st = c.state.get('sq') ?? { armed: 0 }; c.state.set('sq', st);
      if (fin(w[i]) && w[i] <= mw[i]) st.armed = 24; else st.armed = Math.max(0, st.armed - 1);
      return st.armed > 0 && fin(up[i]) && c.close[i] > up[i] ? { stopPct: 0.015, trailPct: 0.02, maxBars: 144 } : null; } },
  // ---------------- 1-hour perpetuals (2021–2025)
  { id: 'F1H_PUMP_CONT', venue: 'BITGET_1H', side: 'LONG', name: '1시간 +5% & 거래량 5배 급등 추격 롱 (손절 4%, 익절 12%, 24시간)', source: '급등 추격 (momentum ignition)',
    baseline: Object.freeze({ stopPct: 0.04, targetPct: 0.12, maxBars: 24 }),
    signal: (c, i) => (ret(c, i, 1) >= 0.05 && volX(c, i, 168) >= 5 ? { stopPct: 0.04, targetPct: 0.12, maxBars: 24 } : null) },
  { id: 'F1H_PUMP_CONT_TRAIL', venue: 'BITGET_1H', side: 'LONG', name: '1시간 급등 추격 롱 (손절 4%, 5% 트레일링, 3일)', source: '급등 추격 + 끝까지 따라가기',
    baseline: Object.freeze({ stopPct: 0.04, trailPct: 0.05, maxBars: 72 }),
    signal: (c, i) => (ret(c, i, 1) >= 0.05 && volX(c, i, 168) >= 5 ? { stopPct: 0.04, trailPct: 0.05, maxBars: 72 } : null) },
  { id: 'F1H_DONCHIAN48_LONG', venue: 'BITGET_1H', side: 'LONG', name: '1시간 48봉(2일) 신고가 돌파 + 200EMA 위 롱 (4% 트레일링, 5일)', source: '단기 추세 돌파 (터틀 단타판)',
    baseline: Object.freeze({ stopPct: 0.04, trailPct: 0.04, maxBars: 120 }),
    signal: (c, i) => { const mh = c.maxHigh(48); const e = c.ema(200); return fin(mh[i - 1]) && fin(e[i]) && c.close[i] > mh[i - 1] && c.close[i] > e[i] ? { stopPct: 0.04, trailPct: 0.04, maxBars: 120 } : null; } },
  { id: 'F1H_DONCHIAN48_SHORT', venue: 'BITGET_1H', side: 'SHORT', name: '1시간 48봉 신저가 이탈 + 200EMA 아래 숏 (4% 트레일링, 5일)', source: '단기 추세 돌파 숏',
    baseline: Object.freeze({ stopPct: 0.04, trailPct: 0.04, maxBars: 120 }),
    signal: (c, i) => { const ml = c.minLow(48); const e = c.ema(200); return fin(ml[i - 1]) && fin(e[i]) && c.close[i] < ml[i - 1] && c.close[i] < e[i] ? { stopPct: 0.04, trailPct: 0.04, maxBars: 120 } : null; } },
  { id: 'F1H_PARABOLIC_FADE', venue: 'BITGET_1H', side: 'SHORT', name: '24시간 +25% 포물선 후 첫 저가 이탈 숏 (고점 손절, 익절 12%)', source: 'Kullamägi parabolic short — 코인 1시간판',
    signal: (c, i) => { const r = ret(c, i, 24); const mh = c.maxHigh(24); return r >= 0.25 && c.close[i] < c.low[i - 1] ? { stopPrice: mh[i] * 1.003, targetPct: 0.12, maxBars: 48 } : null; } },
  // ---------------- Upbit KRW spot 1-hour (2022–2025): Korean alt pumps
  { id: 'U1H_PUMP_CONT', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 1시간 +8% & 거래량 8배 급등 추격 (손절 5%, 익절 15%, 24시간)', source: '국내 코인 급등 따라타기 (리딩방·텔레그램 단골)',
    baseline: Object.freeze({ stopPct: 0.05, targetPct: 0.15, maxBars: 24 }),
    signal: (c, i) => (ret(c, i, 1) >= 0.08 && volX(c, i, 168) >= 8 ? { stopPct: 0.05, targetPct: 0.15, maxBars: 24 } : null) },
  { id: 'U1H_PUMP_CONT_TRAIL', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 급등 추격 (손절 5%, 7% 트레일링, 3일)', source: '국내 코인 급등 따라타기',
    baseline: Object.freeze({ stopPct: 0.05, trailPct: 0.07, maxBars: 72 }),
    signal: (c, i) => (ret(c, i, 1) >= 0.08 && volX(c, i, 168) >= 8 ? { stopPct: 0.05, trailPct: 0.07, maxBars: 72 } : null) },
  { id: 'U1H_EARLY_PUMP', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 초기 급등 (1시간 +3%인데 거래량 10배) 선진입 (손절 3%, 익절 10%)', source: '거래량 먼저 터지는 종목 선점',
    baseline: Object.freeze({ stopPct: 0.03, targetPct: 0.10, maxBars: 24 }),
    signal: (c, i) => { const r = ret(c, i, 1); return r >= 0.03 && r < 0.08 && volX(c, i, 168) >= 10 ? { stopPct: 0.03, targetPct: 0.10, maxBars: 24 } : null; } },
  { id: 'U1H_DUMP_BOUNCE', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 4시간 −12% 투매 반등 (손절 5%, 익절 8%)', source: '급락 반등 단타',
    baseline: Object.freeze({ stopPct: 0.05, targetPct: 0.08, maxBars: 24 }),
    signal: (c, i) => (ret(c, i, 4) <= -0.12 && volX(c, i, 168) >= 5 ? { stopPct: 0.05, targetPct: 0.08, maxBars: 24 } : null) },
  { id: 'U1H_KST9_ORB', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 아침 9시 첫 1시간 고점 돌파 (1시간 저점 손절, 2R, 당일)', source: '업비트 9시 리셋 돌파',
    signal: (c, i) => orb(c, i, { key: 'u9', startMin: 0, rangeBars: 1, barMin: 60, lastMin: 1380, side: 'LONG' }) },
  { id: 'U1H_LISTING_RIDE', venue: 'UPBIT_1H', side: 'LONG', name: '업비트 신규 상장 2번째 시간 매수 (손절 20%, 15% 트레일링, 3일)', source: '업비트 상장 펌프 따라타기',
    signal: (c, i) => (c.listedInWindow && i === 1 ? { stopPct: 0.2, trailPct: 0.15, maxBars: 72 } : null) },
]);

// ------------------------------------------------------------------ simulator

/** Simulate one rule on one symbol. Returns closed trades. */
export function simulateIntradayRule(ctx, rule, costPerSide, { signalOverride = null } = {}) {
  const trades = []; const { bars, n } = ctx; const dir = rule.side === 'SHORT' ? -1 : 1;
  const sig = signalOverride ?? rule.signal;
  let i = 1;
  while (i < n - 1) {
    const s = sig(ctx, i);
    if (!s) { i += 1; continue; }
    const e = i + 1; const entry = bars[e].open; if (!(entry > 0)) { i += 1; continue; }
    let stop = fin(s.stopPrice) ? s.stopPrice : entry * (1 - (dir * s.stopPct));
    if (dir * (entry - stop) <= 0) { i += 1; continue; } // stop already on the wrong side of the entry
    const risk = Math.abs(entry - stop);
    const target = fin(s.targetPrice) ? s.targetPrice : fin(s.targetPct) ? entry * (1 + (dir * s.targetPct)) : fin(s.targetR) ? entry + (dir * s.targetR * risk) : null;
    if (target !== null && dir * (target - entry) <= 0) { i += 1; continue; }
    const last = Math.min(n - 1, e + Math.max(1, s.maxBars) - 1);
    let exit = null; let j = e; let reason = 'TIME'; let extreme = dir === 1 ? -Infinity : Infinity;
    for (; j <= last; j += 1) {
      const b = bars[j];
      if (fin(s.trailPct) && j > e) { const trail = dir === 1 ? extreme * (1 - s.trailPct) : extreme * (1 + s.trailPct); stop = dir === 1 ? Math.max(stop, trail) : Math.min(stop, trail); }
      const open = j === e ? entry : b.open;
      if (dir === 1) {
        if (open <= stop) { exit = open; reason = 'STOP'; break; }
        if (b.low <= stop) { exit = stop; reason = 'STOP'; break; }
        if (target !== null && open >= target) { exit = open; reason = 'TARGET'; break; }
        if (target !== null && b.high >= target) { exit = target; reason = 'TARGET'; break; }
        extreme = Math.max(extreme, b.high);
      } else {
        if (open >= stop) { exit = open; reason = 'STOP'; break; }
        if (b.high >= stop) { exit = stop; reason = 'STOP'; break; }
        if (target !== null && open <= target) { exit = open; reason = 'TARGET'; break; }
        if (target !== null && b.low <= target) { exit = target; reason = 'TARGET'; break; }
        extreme = Math.min(extreme, b.low);
      }
    }
    if (exit === null) { j = last; exit = bars[last].close; }
    const gross = dir === 1 ? exit / entry - 1 : 1 - (exit / entry);
    const net = gross - (costPerSide * (1 + (exit / entry)));
    trades.push({ entryT: bars[e].timestamp, exitT: bars[j].timestamp, ret: net, bars: j - e + 1, reason });
    i = j + 1; // re-arm after the exit bar
  }
  return trades;
}

// ------------------------------------------------------------------ statistics

export function tradeStats(trades) {
  const n = trades.length; if (!n) return { n: 0 };
  const rs = trades.map((t) => t.ret); const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + ((b - mean) ** 2), 0) / (n - 1)) : 0;
  const wins = rs.filter((r) => r > 0); const losses = rs.filter((r) => r <= 0);
  const gw = wins.reduce((a, b) => a + b, 0); const gl = -losses.reduce((a, b) => a + b, 0);
  const sorted = [...rs].sort((a, b) => a - b);
  return { n, mean, median: sorted[Math.floor(n / 2)], tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, winRate: wins.length / n,
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    share5: rs.filter((r) => r >= 0.05).length / n, share10: rs.filter((r) => r >= 0.10).length / n, best: sorted[n - 1], worst: sorted[0],
    avgHoldBars: trades.reduce((a, t) => a + t.bars, 0) / n, targetHitRate: trades.filter((t) => t.reason === 'TARGET').length / n };
}

/** Shared-equity curve: every trade uses `fraction` of current equity, applied at its exit time. */
export function equityCurve(trades, { fraction = 0.1, from, to }) {
  const sorted = [...trades].sort((a, b) => a.exitT - b.exitT);
  let eq = 1; let peak = 1; let mdd = 0;
  for (const t of sorted) { eq *= Math.max(0, 1 + (fraction * t.ret)); peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - (eq / peak)); }
  const years = Math.max(1 / 365, (to - from) / (365 * DAY));
  return { finalMultiple: eq, cagr: eq > 0 ? (eq ** (1 / years)) - 1 : -1, maxDrawdown: mdd, tradesPerYear: trades.length / years };
}

export function intradayVerdictV1({ discovery, validation, full }, baseline) {
  if (!full.n || full.n < 100 || !validation.n || validation.n < 30) return 'TOO_FEW_TRADES';
  const beatsBase = !baseline || !baseline.validation?.n || validation.mean > baseline.validation.mean;
  if (discovery.mean > 0 && validation.mean > 0 && validation.profitFactor > 1.15 && validation.tStat >= 2.5 && beatsBase) return 'USABLE';
  if (full.mean > 0 && validation.mean > 0) return 'WATCH';
  return 'REJECT';
}

/**
 * Streaming evaluation: add one symbol at a time (5-minute history is large), then finish.
 * datasets: { symbol, candles, listedInWindow? } on the venue's bar size.
 */
export function createIntradayAccumulatorV1(venue) {
  const spec = INTRADAY_VENUES_V1[venue]; if (!spec) throw new Error(`INTRADAY_VENUE_UNKNOWN:${venue}`);
  const rules = INTRADAY_RULES_V1.filter((r) => r.venue === venue && (spec.shortAllowed || r.side === 'LONG'));
  const byRule = new Map(rules.map((r) => [r.id, []])); const baseByRule = new Map(); const symbols = [];
  return {
    add(ds) {
      symbols.push(ds.symbol);
      const ctx = buildIntradayContext(ds.candles); ctx.listedInWindow = Boolean(ds.listedInWindow);
      for (const rule of rules) {
        ctx.state = new Map();
        byRule.get(rule.id).push(...simulateIntradayRule(ctx, rule, spec.costPerSide).map((t) => ({ ...t, symbol: ds.symbol })));
        // matched random baseline for percentage exits (same stop/target/trail/hold, random entry bars)
        const probe = rule.baseline ?? null;
        if (probe) {
          ctx.state = new Map();
          const salt = [...`${ds.symbol}:${rule.id}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
          if (!baseByRule.has(rule.id)) baseByRule.set(rule.id, []);
          baseByRule.get(rule.id).push(...simulateIntradayRule(ctx, rule, spec.costPerSide, { signalOverride: (c, i) => (randomHit(i, salt, rule.baselineEvery ?? 400) ? probe : null) }));
        }
      }
    },
    finish({ splitTime, span }) {
      const split = (ts) => ({ discovery: tradeStats(ts.filter((t) => t.entryT < splitTime)), validation: tradeStats(ts.filter((t) => t.entryT >= splitTime)), full: tradeStats(ts) });
      const rows = rules.map((rule) => {
        const ts = byRule.get(rule.id); const s = split(ts);
        const base = baseByRule.has(rule.id) ? split(baseByRule.get(rule.id)) : null;
        const bySymbol = {}; for (const t of ts) bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + 1;
        return { id: rule.id, name: rule.name, source: rule.source, side: rule.side, ...s, baseline: base ? { full: base.full, validation: base.validation } : null,
          equity10: equityCurve(ts, { fraction: 0.1, from: span.from, to: span.to }), verdict: intradayVerdictV1(s, base), symbolsTraded: Object.keys(bySymbol).length };
      });
      return { venue, label: spec.label, costPerSide: spec.costPerSide, symbols, span: { from: new Date(span.from).toISOString().slice(0, 10), to: new Date(span.to).toISOString().slice(0, 10) },
        splitDate: new Date(splitTime).toISOString().slice(0, 10), rows };
    },
  };
}

export function evaluateIntradayVenueV1({ venue, datasets, splitTime, span }) {
  const acc = createIntradayAccumulatorV1(venue);
  for (const ds of datasets) acc.add(ds);
  return acc.finish({ splitTime, span });
}

function randomHit(i, salt, every) {
  let h = (Math.imul(i, 2654435761) + salt) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h % every === 0;
}

// ------------------------------------------------------------------ report

const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const VERDICT_KO = { USABLE: '✅ 쓸만함', WATCH: '🟡 관찰', REJECT: '❌ 탈락', TOO_FEW_TRADES: '거래 부족' };

export function formatIntradayReportKoV1(venues) {
  const lines = ['단타 / 급등 포착 전략 백테스트 (연구 전용, 주문 없음)',
    '진입: 신호 봉 종가 → 다음 봉 시가 · 손절·익절이 한 봉에 같이 닿으면 손절 우선 · 비용 포함',
    '판정: 앞(60%)·뒤(40%) 기간 모두 1회 평균 > 0, 뒤 기간 손익비 > 1.15, t ≥ 2.5, 같은 청산 규칙의 무작위 진입보다 좋아야 쓸만함',
    '"10% 비중 복리" = 매 거래 자산의 10%만 넣었을 때의 연수익·최대낙폭 (레버리지 5배면 대략 ×5)', ''];
  for (const v of venues) {
    lines.push(`■ ${v.label} · ${v.symbols.length}종목 · ${v.span.from}~${v.span.to} (검증 시작 ${v.splitDate}) · 편도 비용 ${pct(v.costPerSide, 2)}`);
    for (const r of [...v.rows].sort((a, b) => (b.validation.mean ?? -1) - (a.validation.mean ?? -1))) {
      const b = r.baseline?.validation;
      lines.push(`  ${VERDICT_KO[r.verdict]} ${r.name}`);
      lines.push(`     거래 ${r.full.n ?? 0}회 · 승률 ${pct(r.full.winRate, 0)} · 1회 평균 ${pct(r.full.mean)} (앞 ${pct(r.discovery.mean)} / 뒤 ${pct(r.validation.mean)}, t=${(r.validation.tStat ?? 0).toFixed(1)})`
        + ` · +5% 이상 ${pct(r.full.share5, 0)} · +10% 이상 ${pct(r.full.share10, 0)} · 최고 ${pct(r.full.best, 0)}`
        + `${b?.n ? ` · 무작위 진입 뒤 기간 ${pct(b.mean)}` : ''} · 10% 비중 복리 연 ${pct(r.equity10.cagr, 1)} / 낙폭 ${pct(-r.equity10.maxDrawdown, 1)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
