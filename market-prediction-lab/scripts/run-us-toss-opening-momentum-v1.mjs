import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const EVAL_START = Date.parse("2026-08-03T00:00:00.000Z");
const EVAL_END = Date.parse("2026-09-26T00:00:00.000Z");
const DAILY_START = Date.parse("2024-06-01T00:00:00.000Z");
const DAILY_END = Date.parse("2026-09-30T00:00:00.000Z");
const ACADEMIC_FORMATION_MONTHS = Object.freeze(["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
const JT_MOMENTUM_DOI = "10.1111/j.1540-6261.1993.tb04702.x";
const GH_52W_HIGH_DOI = "10.1111/j.1540-6261.2004.00695.x";
const PIT_SAMPLE_SIZE = 180;
const PIT_MIN_HISTORY_READY = 120;
const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const PIT_SAMPLE_SEED = "US_PIT_REFERENCE_SAMPLE_V1";
const NORMAL_COST = 0.0015;
const STRESS_COST = NORMAL_COST * 1.5;
const COMMON_CANDIDATES_PER_DAY = 5;
const ACCOUNT = Object.freeze({ riskPerTrade: 0.005, maxWeight: 0.20, maxConcurrent: 3, maxPerSector: 2 });
const PEAD_HORIZONS = Object.freeze([5, 20, 40]);
const PEAD_PRIOR_START = "2025-07-01";
const PEAD_RECENT_START = "2026-07-01";
const PEAD_RECENT_END = "2026-09-20";
const QULLAMAGGIE_BREAKOUT_SOURCE = "https://qullamaggie.com/my-3-timeless-setups-that-have-made-me-tens-of-millions/";
const QULLAMAGGIE_EP_SOURCE = "https://qullamaggie.com/how-to-master-a-setup-episodic-pivots/";
const PEAD_REVIEW_DOI = "10.1016/j.jbef.2020.100446";
const LIVNAT_MENDENHALL_DOI = "10.1111/j.1475-679X.2006.00196";
const ANALYST_SUE_FORMULA_REFERENCE_DOI = "10.1016/j.frl.2020.101742";
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function nyParts(ms) {
  const values = Object.fromEntries(ny.formatToParts(new Date(ms)).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour), minute: Number(values.minute) };
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values) { if (!values.length) return 0; const copy = [...values].sort((a, b) => a - b); const mid = Math.floor(copy.length / 2); return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2; }
function safeNumber(value) { const parsed = Number(String(value ?? "").replace(/[$,% ,]/g, "")); return Number.isFinite(parsed) ? parsed : null; }
function regular(ms) { const p = nyParts(ms); const minute = p.hour * 60 + p.minute; return minute >= 570 && minute < 960; }
function minuteOfDay(ms) { const p = nyParts(ms); return p.hour * 60 + p.minute; }
function sma(candles, index, period) { if (index - period + 1 < 0) return null; let sum = 0; for (let i = index - period + 1; i <= index; i += 1) sum += candles[i].close; return sum / period; }
function atr(candles, index, period = 20) {
  if (index - period + 1 < 1) return null;
  const tr = [];
  for (let i = index - period + 1; i <= index; i += 1) {
    const prev = candles[i - 1].close;
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev)));
  }
  return mean(tr);
}
function avgVolume(candles, index, period = 20) { if (index - period + 1 < 0) return null; return mean(candles.slice(index - period + 1, index + 1).map((row) => row.volume)); }
function minLow(rows) { return rows.length ? Math.min(...rows.map((row) => row.low)) : null; }
function maxHigh(rows) { return rows.length ? Math.max(...rows.map((row) => row.high)) : null; }
function avgRange(rows) { return rows.length ? mean(rows.map((row) => row.high - row.low)) : null; }
function securityEligible(row) {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const name = String(row.name ?? "");
  const industry = String(row.industry ?? "");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return false;
  if (/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name)) return false;
  if (/Blank Checks/i.test(industry) || /Acquisition Corp/i.test(name)) return false;
  if (/[RWU]$/.test(symbol) && symbol.length >= 4) return false;
  return true;
}
async function fetchJson(url, label, { timeoutMs = 15_000, attempts = 3 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 research-reference-recipes/2.0",
          referer: "https://www.nasdaq.com/",
        },
      });
      if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
      await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error(`${label}_FAILED`);
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try { out[index] = { ok: true, value: await fn(items[index], index) }; }
      catch (error) { out[index] = { ok: false, error: String(error?.message ?? error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}
async function fetchUniverse() {
  const payload = await fetchJson("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true", "NASDAQ_UNIVERSE");
  const raw = payload?.data?.rows;
  if (!Array.isArray(raw) || raw.length < 1000) throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  const rows = raw.map((row) => {
    const price = safeNumber(row.lastsale);
    const volume = safeNumber(row.volume);
    const marketCap = safeNumber(row.marketCap);
    return {
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      name: String(row.name ?? ""),
      sector: String(row.sector ?? "UNKNOWN") || "UNKNOWN",
      industry: String(row.industry ?? ""),
      price,
      volume,
      marketCap,
      dollarVolume: price != null && volume != null ? price * volume : null,
    };
  }).filter((row) => securityEligible(row) && row.price >= 2 && row.marketCap > 0 && row.dollarVolume > 0);
  return {
    rawRows: raw.length,
    buckets: {
      LARGE: rows.filter((row) => row.marketCap >= 10_000_000_000 && row.dollarVolume >= 10_000_000).sort((a, b) => b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol)).slice(0, 80),
      MID: rows.filter((row) => row.marketCap >= 2_000_000_000 && row.marketCap < 10_000_000_000 && row.dollarVolume >= 5_000_000).sort((a, b) => b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol)).slice(0, 100),
      SMALL: rows.filter((row) => row.marketCap >= 300_000_000 && row.marketCap < 2_000_000_000 && row.dollarVolume >= 2_000_000).sort((a, b) => b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol)).slice(0, 120),
    },
  };
}
function parseYahooChart(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`YAHOO_CHART_${payload?.chart?.error?.code ?? "EMPTY"}`);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const rows = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index]) * 1000;
    const open = Number(quote.open?.[index]);
    const high = Number(quote.high?.[index]);
    const low = Number(quote.low?.[index]);
    const close = Number(quote.close?.[index]);
    const volume = Number(quote.volume?.[index]);
    if (!Number.isFinite(timestamp) || ![open, high, low, close, volume].every(Number.isFinite)) continue;
    if (Math.min(open, high, low, close) <= 0 || volume < 0 || high < low) continue;
    rows.push({ timestamp, open, high, low, close, volume });
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}
async function yahoo5m(symbol) {
  const encoded = encodeURIComponent(symbol);
  const query = "range=60d&interval=5m&includePrePost=false&events=div%2Csplits";
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`,
  ];
  let last = null;
  for (const url of urls) {
    try {
      const payload = await fetchJson(url, "YAHOO_5M", { attempts: 2 });
      return parseYahooChart(payload).filter((row) => regular(row.timestamp) && row.timestamp >= EVAL_START - 3 * 86_400_000 && row.timestamp < EVAL_END + 3 * 86_400_000);
    } catch (error) { last = error; }
  }
  throw last ?? new Error("YAHOO_5M_FAILED");
}
function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}
function firstDefined(row, keys) { for (const key of keys) if (row?.[key] != null && String(row[key]).trim() !== "") return row[key]; return null; }
async function fetchNasdaqEarnings(symbol) {
  try {
    const payload = await fetchJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`, "NASDAQ_EARNINGS", { attempts: 2 });
    const data = payload?.data ?? {};
    const rows = data?.earningsSurpriseTable?.rows ?? data?.quarterlyEarnings?.rows ?? data?.rows ?? [];
    if (!Array.isArray(rows)) return { status: "UNAVAILABLE", events: [] };
    const events = rows.map((row) => {
      const date = normalizeDate(firstDefined(row, ["dateReported", "reportDate", "reportedDate", "fiscalQtrEnd", "periodEnding"]));
      const actual = safeNumber(firstDefined(row, ["eps", "reportedEPS", "actualEPS", "actual", "reported"]));
      const forecast = safeNumber(firstDefined(row, ["consensusForecast", "forecastEPS", "estimate", "consensus", "estimatedEPS"]));
      let surprisePct = safeNumber(firstDefined(row, ["percentageSurprise", "surprisePercentage", "surprisePct", "%Surprise", "surprise"]));
      if (surprisePct == null && actual != null && forecast != null && forecast !== 0) surprisePct = ((actual - forecast) / Math.abs(forecast)) * 100;
      return { date, actual, forecast, surprisePct };
    }).filter((event) => event.date && event.surprisePct != null);
    return { status: events.length ? "AVAILABLE" : "UNAVAILABLE", events };
  } catch (error) {
    return { status: "UNAVAILABLE", events: [], error: String(error?.message ?? error) };
  }
}
function dailyIndexBefore(candles, date) {
  let index = -1;
  for (let i = 0; i < candles.length; i += 1) {
    if (nyParts(candles[i].timestamp).date < date) index = i;
    else break;
  }
  return index;
}
function dailyIndexOnDate(candles, date) { return candles.findIndex((row) => nyParts(row.timestamp).date === date); }
function leaderSnapshot(row, date) {
  const candles = row.daily;
  const index = dailyIndexBefore(candles, date);
  if (index < 126) return null;
  return {
    row,
    index,
    r21: candles[index].close / candles[index - 21].close - 1,
    r63: candles[index].close / candles[index - 63].close - 1,
    r126: candles[index].close / candles[index - 126].close - 1,
  };
}
function rankLeaders(rows, date) {
  const snapshots = rows.map((row) => leaderSnapshot(row, date)).filter(Boolean);
  if (!snapshots.length) return new Map();
  const topN = Math.max(1, Math.ceil(snapshots.length * 0.02));
  for (const key of ["r21", "r63", "r126"]) {
    [...snapshots].sort((a, b) => b[key] - a[key]).forEach((snapshot, position) => { snapshot[`rank_${key}`] = position + 1; });
  }
  return new Map(snapshots.map((snapshot) => [snapshot.row.symbol, {
    r21: snapshot.r21, r63: snapshot.r63, r126: snapshot.r126,
    rank21: snapshot.rank_r21, rank63: snapshot.rank_r63, rank126: snapshot.rank_r126,
    topN, top2pctAny: Math.min(snapshot.rank_r21, snapshot.rank_r63, snapshot.rank_r126) <= topN,
  }]));
}
function maxPriorMove(candles, index) {
  let best = 0;
  const start = Math.max(0, index - 63);
  for (let from = start; from <= index - 5; from += 1) {
    for (let to = from + 5; to <= Math.min(index, from + 20); to += 1) {
      best = Math.max(best, candles[to].high / candles[from].close - 1);
    }
  }
  return best;
}
function detectConsolidation(candles, index) {
  const ma10 = sma(candles, index, 10);
  const ma20 = sma(candles, index, 20);
  const ma20Prev = sma(candles, index - 5, 20);
  if (![ma10, ma20, ma20Prev].every((value) => value > 0)) return null;
  if (!(candles[index].close >= ma10 && ma10 >= ma20 && ma20 > ma20Prev)) return null;
  for (let window = 10; window <= 42; window += 1) {
    if (index - window + 1 < 0) break;
    const slice = candles.slice(index - window + 1, index + 1);
    const split = Math.floor(slice.length / 2);
    const first = slice.slice(0, split);
    const second = slice.slice(split);
    if (!first.length || !second.length) continue;
    const higherLow = minLow(second) > minLow(first);
    const tightening = avgRange(second) < avgRange(first);
    if (!higherLow || !tightening) continue;
    return {
      sessions: window,
      higherLow,
      tightening,
      breakoutLevel: maxHigh(slice),
      firstHalfAvgRange: avgRange(first),
      secondHalfAvgRange: avgRange(second),
      ma10,
      ma20,
    };
  }
  return null;
}
function buildCommonBreakoutCandidate(row, date, leader) {
  if (!leader?.top2pctAny) return null;
  const candles = row.daily;
  const index = dailyIndexBefore(candles, date);
  if (index < 126) return null;
  const priorMove = maxPriorMove(candles, index);
  if (priorMove < 0.30) return null;
  const consolidation = detectConsolidation(candles, index);
  if (!consolidation) return null;
  const atr20 = atr(candles, index, 20);
  if (!(atr20 > 0)) return null;
  return {
    symbol: row.symbol,
    sector: row.sector,
    bucket: row.bucket,
    date,
    recipeId: "QULLAMAGGIE_COMMON_BREAKOUT_V1",
    leader,
    priorMove,
    consolidation,
    breakoutLevel: consolidation.breakoutLevel,
    atr20,
  };
}
function buildEpGapCandidate(row, date) {
  const candles = row.daily;
  const dayIndex = dailyIndexOnDate(candles, date);
  if (dayIndex <= 126) return null;
  const prev = candles[dayIndex - 1];
  const day = candles[dayIndex];
  const gap = day.open / prev.close - 1;
  if (gap < 0.10) return null;
  const atr20 = atr(candles, dayIndex - 1, 20);
  const adv20 = avgVolume(candles, dayIndex - 1, 20);
  const r63 = prev.close / candles[dayIndex - 64].close - 1;
  const r126 = prev.close / candles[dayIndex - 127].close - 1;
  if (!(atr20 > 0) || !(adv20 > 0)) return null;
  return {
    symbol: row.symbol, sector: row.sector, bucket: row.bucket, date,
    recipeId: "QULLAMAGGIE_EP_V1", gap, atr20, adv20, prior3mReturn: r63, prior6mReturn: r126,
  };
}
function groupDays(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!regular(row.timestamp)) continue;
    const date = nyParts(row.timestamp).date;
    const list = map.get(date) ?? [];
    list.push(row);
    map.set(date, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return map;
}
function completeDates(rows) {
  return [...groupDays(rows).entries()]
    .filter(([date, values]) => Date.parse(`${date}T00:00:00Z`) >= EVAL_START && Date.parse(`${date}T00:00:00Z`) < EVAL_END && values.length >= 70)
    .map(([date]) => date).sort();
}
function entryOn5mOrh(candidate, day, { ep = false } = {}) {
  if (!day?.length) return null;
  const first = day.find((row) => minuteOfDay(row.timestamp) === 570) ?? day[0];
  const firstIndex = day.indexOf(first);
  if (firstIndex < 0 || firstIndex + 1 >= day.length) return null;
  const trigger = ep ? first.high : Math.max(first.high, candidate.breakoutLevel);
  const endMinute = ep ? 660 : 720;
  for (let i = firstIndex + 1; i < day.length - 1; i += 1) {
    if (minuteOfDay(day[i].timestamp) > endMinute) break;
    if (day[i].high < trigger) continue;
    const next = day[i + 1];
    const lowToDate = minLow(day.slice(0, i + 1));
    const risk = next.open - lowToDate;
    const cap = candidate.atr20 * (ep ? 1.5 : 1.0);
    if (!(risk > 0) || risk > cap) return null;
    return {
      index: i + 1,
      entryTime: next.timestamp,
      rawEntry: next.open,
      initialStop: lowToDate,
      stopDistancePct: risk / next.open,
      trigger,
      first5High: first.high,
    };
  }
  return null;
}
function diagnoseEpEntry(candidate, day) {
  if (!day?.length) return { status: "NO_INTRADAY_DAY", entry: null };
  const first = day.find((row) => minuteOfDay(row.timestamp) === 570) ?? day[0];
  const firstIndex = day.indexOf(first);
  if (firstIndex < 0 || firstIndex + 1 >= day.length) return { status: "OPENING_BAR_MISSING", entry: null };
  for (let i = firstIndex + 1; i < day.length - 1; i += 1) {
    if (minuteOfDay(day[i].timestamp) > 660) break;
    if (day[i].high < first.high) continue;
    const next = day[i + 1];
    const lowToDate = minLow(day.slice(0, i + 1));
    const risk = next.open - lowToDate;
    if (!(risk > 0)) return { status: "NON_POSITIVE_RISK", entry: null, risk, atrCap: candidate.atr20 * 1.5 };
    if (risk > candidate.atr20 * 1.5) return { status: "RISK_GT_1_5_ATR", entry: null, risk, atrCap: candidate.atr20 * 1.5 };
    return { status: "ELIGIBLE", entry: { index: i + 1, entryTime: next.timestamp, rawEntry: next.open, initialStop: lowToDate, stopDistancePct: risk / next.open, trigger: first.high, first5High: first.high }, risk, atrCap: candidate.atr20 * 1.5 };
  }
  return { status: "ORH_NOT_REBROKEN_BY_1100", entry: null };
}
function exitReturn(entryFill, exitRaw, cost) { return exitRaw * (1 - cost) / entryFill - 1; }
function simulateCommonBreakout(row, candidate, day, entry, cost) {
  const entryFill = entry.rawEntry * (1 + cost);
  let remaining = 1;
  let realized = 0;
  let partialDone = false;
  let exitNextOpen = false;
  let exitTime = day.at(-1)?.timestamp ?? entry.entryTime;
  let exitReason = "HORIZON_END";
  for (let i = entry.index + 1; i < day.length; i += 1) {
    if (day[i].low <= entry.initialStop) {
      realized += remaining * exitReturn(entryFill, entry.initialStop, cost);
      return { netReturn: realized, exitTime: day[i].timestamp, exitReason: "INITIAL_STOP", partialDone, stopDistancePct: entry.stopDistancePct };
    }
  }
  const candles = row.daily;
  const dayIndex = dailyIndexOnDate(candles, candidate.date);
  if (dayIndex < 0) return null;
  const maxIndex = Math.min(candles.length - 1, dayIndex + 45);
  for (let index = dayIndex + 1; index <= maxIndex; index += 1) {
    const bar = candles[index];
    if (exitNextOpen) {
      realized += remaining * exitReturn(entryFill, bar.open, cost);
      remaining = 0;
      exitTime = bar.timestamp;
      exitReason = "NEXT_OPEN_AFTER_10DMA_CLOSE_BREAK";
      break;
    }
    const activeStop = partialDone ? Math.max(entry.initialStop, entry.rawEntry) : entry.initialStop;
    if (bar.low <= activeStop) {
      realized += remaining * exitReturn(entryFill, activeStop, cost);
      remaining = 0;
      exitTime = bar.timestamp;
      exitReason = partialDone ? "BREAKEVEN_STOP" : "INITIAL_STOP";
      break;
    }
    const heldSessions = index - dayIndex + 1;
    if (!partialDone && heldSessions >= 4) {
      realized += (1 / 3) * exitReturn(entryFill, bar.close, cost);
      remaining -= 1 / 3;
      partialDone = true;
    }
    if (partialDone) {
      const ma10 = sma(candles, index, 10);
      if (ma10 && bar.close < ma10) exitNextOpen = true;
    }
    exitTime = bar.timestamp;
  }
  if (remaining > 0) {
    const lastIndex = Math.min(maxIndex, candles.length - 1);
    const last = candles[lastIndex];
    realized += remaining * exitReturn(entryFill, last.close, cost);
    exitTime = last.timestamp;
    exitReason = "HORIZON_END";
  }
  return { netReturn: realized, exitTime, exitReason, partialDone, stopDistancePct: entry.stopDistancePct };
}
function simulateEp(row, candidate, day, entry, cost) {
  const entryFill = entry.rawEntry * (1 + cost);
  for (let i = entry.index + 1; i < day.length; i += 1) {
    if (day[i].low <= entry.initialStop) {
      return { netReturn: exitReturn(entryFill, entry.initialStop, cost), exitTime: day[i].timestamp, exitReason: "INITIAL_STOP", stopDistancePct: entry.stopDistancePct };
    }
  }
  const candles = row.daily;
  const dayIndex = dailyIndexOnDate(candles, candidate.date);
  if (dayIndex < 0) return null;
  let exitNextOpen = false;
  const maxIndex = Math.min(candles.length - 1, dayIndex + 60);
  for (let index = dayIndex + 1; index <= maxIndex; index += 1) {
    const bar = candles[index];
    if (exitNextOpen) return { netReturn: exitReturn(entryFill, bar.open, cost), exitTime: bar.timestamp, exitReason: "NEXT_OPEN_AFTER_20DMA_CLOSE_BREAK", stopDistancePct: entry.stopDistancePct };
    if (bar.low <= entry.initialStop) return { netReturn: exitReturn(entryFill, entry.initialStop, cost), exitTime: bar.timestamp, exitReason: "INITIAL_STOP", stopDistancePct: entry.stopDistancePct };
    const ma20 = sma(candles, index, 20);
    if (ma20 && ma20 > entry.initialStop && bar.close < ma20) exitNextOpen = true;
  }
  const last = candles[maxIndex];
  return { netReturn: exitReturn(entryFill, last.close, cost), exitTime: last.timestamp, exitReason: "HORIZON_END", stopDistancePct: entry.stopDistancePct };
}
function summarizeTrades(trades) {
  if (!trades.length) return { trades: 0, meanNetReturn: null, medianNetReturn: null, winRate: null, profitFactor: null, compoundSequentialReturn: null, maxSequentialDrawdown: null };
  const returns = trades.map((trade) => trade.netReturn);
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return {
    trades: trades.length,
    meanNetReturn: mean(returns),
    medianNetReturn: median(returns),
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: losses > 0 ? gains / losses : null,
    compoundSequentialReturn: equity - 1,
    maxSequentialDrawdown: maxDrawdown,
  };
}
function portfolioDiagnostic(trades) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));
  const active = [];
  const sectors = new Map();
  let capitalReturn = 0;
  let admitted = 0;
  for (const trade of ordered) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].exitTime <= trade.entryTime) {
        const sector = active[index].sector;
        sectors.set(sector, Math.max(0, (sectors.get(sector) ?? 1) - 1));
        active.splice(index, 1);
      }
    }
    if (active.length >= ACCOUNT.maxConcurrent || (sectors.get(trade.sector) ?? 0) >= ACCOUNT.maxPerSector) continue;
    const weight = Math.min(ACCOUNT.maxWeight, ACCOUNT.riskPerTrade / Math.max(trade.stopDistancePct, 1e-9));
    capitalReturn += weight * trade.netReturn;
    admitted += 1;
    active.push(trade);
    sectors.set(trade.sector, (sectors.get(trade.sector) ?? 0) + 1);
  }
  return { admitted, additiveCapitalReturn: capitalReturn, canonicalPortfolioClaimAllowed: false };
}
function matchEarningsEvent(events, date) {
  const previous = new Date(`${date}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDate = previous.toISOString().slice(0, 10);
  return events.find((event) => (event.date === date || event.date === previousDate) && event.surprisePct > 0) ?? null;
}
function first30mVolume(day) { return day.filter((bar) => minuteOfDay(bar.timestamp) >= 570 && minuteOfDay(bar.timestamp) < 600).reduce((sum, bar) => sum + bar.volume, 0); }
function priceOneMonthBefore(candles, eventDate) {
  const target = Date.parse(`${eventDate}T12:00:00Z`) - 30 * 86_400_000;
  let selected = null;
  for (const bar of candles) {
    if (bar.timestamp > target) break;
    selected = bar;
  }
  return selected?.close ?? null;
}
function peadRows(row, earnings) {
  const output = [];
  if (earnings.status !== "AVAILABLE") return output;
  for (const event of earnings.events) {
    if (event.date < PEAD_PRIOR_START || event.date >= PEAD_RECENT_END) continue;
    if (event.actual == null || event.forecast == null) continue;
    const candles = row.daily;
    const priceMonthPrior = priceOneMonthBefore(candles, event.date);
    if (!(priceMonthPrior > 0)) continue;
    const analystSueProxy = (event.actual - event.forecast) / priceMonthPrior;
    const eventIndex = candles.findIndex((bar) => nyParts(bar.timestamp).date > event.date);
    if (eventIndex < 0) continue;
    for (const horizon of PEAD_HORIZONS) {
      const exitIndex = eventIndex + horizon - 1;
      if (exitIndex >= candles.length) continue;
      const entry = candles[eventIndex].open * (1 + NORMAL_COST);
      const exit = candles[exitIndex].close * (1 - NORMAL_COST);
      output.push({
        symbol: row.symbol, sector: row.sector, bucket: row.bucket,
        eventDate: event.date,
        validationWindow: event.date < PEAD_RECENT_START ? "PRIOR" : "RECENT",
        actualEps: event.actual, consensusEps: event.forecast,
        surprisePct: event.surprisePct, priceMonthPrior, analystSueProxy,
        horizonSessions: horizon, netReturn: exit / entry - 1,
      });
    }
  }
  return output;
}
function summarizePead(rows) {
  const normalize = (values) => summarizeTrades(values.map((row, index) => ({ ...row, entryTime: index, exitTime: index + 1, stopDistancePct: 1 })));
  return Object.fromEntries(PEAD_HORIZONS.map((horizon) => {
    const subset = rows.filter((row) => row.horizonSessions === horizon && Number.isFinite(row.analystSueProxy));
    const ordered = [...subset].sort((a, b) => a.analystSueProxy - b.analystSueProxy);
    const decileN = ordered.length ? Math.max(1, Math.ceil(ordered.length * 0.10)) : 0;
    const bottomDecile = decileN ? ordered.slice(0, decileN) : [];
    const topDecile = decileN ? ordered.slice(-decileN) : [];
    const positive = subset.filter((row) => row.analystSueProxy > 0);
    const topMetrics = normalize(topDecile);
    const bottomMetrics = normalize(bottomDecile);
    return [String(horizon), {
      signalRows: subset.length,
      positiveAnalystSue: normalize(positive),
      analystSueTopDecile: {
        count: topDecile.length,
        threshold: topDecile.length ? topDecile[0].analystSueProxy : null,
        metrics: topMetrics,
      },
      analystSueBottomDecile: {
        count: bottomDecile.length,
        threshold: bottomDecile.length ? bottomDecile.at(-1).analystSueProxy : null,
        metrics: bottomMetrics,
      },
      descriptiveTopMinusBottomMeanReturn: topMetrics.meanNetReturn != null && bottomMetrics.meanNetReturn != null
        ? topMetrics.meanNetReturn - bottomMetrics.meanNetReturn
        : null,
      tradableLongShortClaimAllowed: false,
    }];
  }));
}
function monthEndIndex(candles, month) {
  let index = -1;
  for (let i = 0; i < candles.length; i += 1) {
    const date = nyParts(candles[i].timestamp).date;
    if (date.startsWith(month)) index = i;
    else if (index >= 0 && date > `${month}-31`) break;
  }
  return index;
}
function sixMonthForwardReturn(candles, formationIndex, cost) {
  const entryIndex = formationIndex + 1;
  const exitIndex = formationIndex + 126;
  if (entryIndex >= candles.length || exitIndex >= candles.length) return null;
  const entry = candles[entryIndex].open * (1 + cost);
  const exit = candles[exitIndex].close * (1 - cost);
  return { netReturn: exit / entry - 1, entryDate: nyParts(candles[entryIndex].timestamp).date, exitDate: nyParts(candles[exitIndex].timestamp).date };
}
function decileSummary(records, signalKey) {
  const valid = records.filter((row) => Number.isFinite(row[signalKey]) && Number.isFinite(row.netReturn)).sort((a, b) => a[signalKey] - b[signalKey]);
  if (!valid.length) return { count: 0, decileN: 0, top: null, bottom: null, descriptiveTopMinusBottomMeanReturn: null };
  const decileN = Math.max(1, Math.ceil(valid.length * 0.10));
  const bottom = valid.slice(0, decileN);
  const top = valid.slice(-decileN);
  const metrics = (rows) => {
    const returns = rows.map((row) => row.netReturn).sort((a, b) => b - a);
    const positiveSum = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const byBucket = Object.fromEntries(["LARGE", "MID", "SMALL"].map((bucket) => {
      const bucketRows = rows.filter((row) => row.bucket === bucket);
      return [bucket, {
        count: bucketRows.length,
        meanNetReturn: bucketRows.length ? mean(bucketRows.map((row) => row.netReturn)) : null,
        medianNetReturn: bucketRows.length ? median(bucketRows.map((row) => row.netReturn)) : null,
      }];
    }));
    return {
      count: rows.length,
      meanNetReturn: mean(rows.map((row) => row.netReturn)),
      medianNetReturn: median(rows.map((row) => row.netReturn)),
      winRate: rows.filter((row) => row.netReturn > 0).length / rows.length,
      minSignal: Math.min(...rows.map((row) => row[signalKey])),
      maxSignal: Math.max(...rows.map((row) => row[signalKey])),
      maxNetReturn: returns[0] ?? null,
      top3PositiveReturnShare: positiveSum > 0 ? returns.slice(0, 3).filter((value) => value > 0).reduce((sum, value) => sum + value, 0) / positiveSum : null,
      byBucket,
    };
  };
  const topMetrics = metrics(top);
  const bottomMetrics = metrics(bottom);
  return {
    count: valid.length,
    decileN,
    top: topMetrics,
    bottom: bottomMetrics,
    descriptiveTopMinusBottomMeanReturn: topMetrics.meanNetReturn - bottomMetrics.meanNetReturn,
    tradableLongShortClaimAllowed: false,
  };
}
function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}
function monthEndDate(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}
function pitSampleHash(symbol) {
  return createHash("sha256").update(`${PIT_SAMPLE_SEED}:${symbol}`).digest("hex");
}
function cleanPitTicker(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null;
}
function sha256Text(value) {
  return "sha256:" + createHash("sha256").update(String(value)).digest("hex");
}
async function alphaListingStatus(date = null) {
  const apiKey = String(process.env.ALPHA_VANTAGE_API_KEY ?? "").trim();
  if (!apiKey) {
    return {
      status: "BLOCKED_ALPHA_VANTAGE_KEY_MISSING",
      date,
      rows: [],
      credentialMode: "MISSING",
      error: "ALPHA_VANTAGE_API_KEY_MISSING",
    };
  }
  const url = new URL(ALPHA_VANTAGE_BASE);
  url.searchParams.set("function", "LISTING_STATUS");
  if (date) url.searchParams.set("date", date);
  url.searchParams.set("state", "active");
  url.searchParams.set("apikey", apiKey);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("ALPHA_VANTAGE_LISTING_STATUS_TIMEOUT")), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "text/csv,text/plain,*/*", "user-agent": "reference-recipe-pit-research/1.0" },
      });
      if (!response.ok) throw new Error(`ALPHA_VANTAGE_LISTING_STATUS_HTTP_${response.status}`);
      const text = await response.text();
      if (/thank you for using alpha vantage|rate limit|information|premium/i.test(text) && !/^symbol,/im.test(text)) {
        throw new Error("ALPHA_VANTAGE_LISTING_STATUS_THROTTLED_OR_UNAVAILABLE");
      }
      const lines = text.trim().split(/\r?\n/u).filter(Boolean);
      const header = lines.length ? parseCsvLine(lines[0]).map((value) => value.toLowerCase()) : [];
      if (!header.includes("symbol") || !header.includes("assettype") || !header.includes("status")) {
        throw new Error("ALPHA_VANTAGE_LISTING_STATUS_SCHEMA");
      }
      const index = Object.fromEntries(header.map((name, position) => [name, position]));
      const rows = lines.slice(1).map((line) => {
        const cells = parseCsvLine(line);
        const symbol = cleanPitTicker(cells[index.symbol]);
        return {
          symbol,
          name: String(cells[index.name] ?? "").trim(),
          exchange: String(cells[index.exchange] ?? "").trim().toUpperCase(),
          assetType: String(cells[index.assettype] ?? "").trim().toUpperCase(),
          ipoDate: String(cells[index.ipodate] ?? "").trim() || null,
          delistingDate: String(cells[index.delistingdate] ?? "").trim() || null,
          listingStatus: String(cells[index.status] ?? "").trim().toUpperCase(),
        };
      }).filter((row) =>
        row.symbol
        && row.assetType === "STOCK"
        && ["NASDAQ", "NYSE", "NYSE MKT", "AMEX"].includes(row.exchange)
        && row.listingStatus === "ACTIVE"
      );
      if (rows.length < 500) throw new Error(`ALPHA_VANTAGE_LISTING_STATUS_INSUFFICIENT_${rows.length}`);
      return {
        status: "AVAILABLE",
        date,
        rows,
        credentialMode: "CONFIGURED_SECRET",
        sourceId: `alpha-vantage-listing-status:${date ?? "latest"}`,
        sourceDigest: sha256Text(text),
      };
    } catch (error) {
      lastError = error;
      await sleep(1_500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    status: "BLOCKED_ALPHA_VANTAGE_LISTING_STATUS",
    date,
    rows: [],
    credentialMode: "CONFIGURED_SECRET",
    error: String(lastError?.message ?? lastError),
  };
}
function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&nbsp;/gu, " ")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/\s+/gu, " ")
    .trim();
}
async function wikipediaSp500Snapshot(asOfDate) {
  const revisionUrl = new URL("https://en.wikipedia.org/w/api.php");
  revisionUrl.searchParams.set("action", "query");
  revisionUrl.searchParams.set("format", "json");
  revisionUrl.searchParams.set("prop", "revisions");
  revisionUrl.searchParams.set("titles", "List of S&P 500 companies");
  revisionUrl.searchParams.set("rvprop", "ids|timestamp");
  revisionUrl.searchParams.set("rvstart", `${asOfDate}T23:59:59Z`);
  revisionUrl.searchParams.set("rvdir", "older");
  revisionUrl.searchParams.set("rvlimit", "1");
  revisionUrl.searchParams.set("origin", "*");
  const revisionPayload = await fetchJson(revisionUrl, "WIKIPEDIA_SP500_REVISION", { attempts: 3 });
  const page = Object.values(revisionPayload?.query?.pages ?? {})[0];
  const revision = page?.revisions?.[0];
  const revisionId = Number(revision?.revid);
  if (!Number.isInteger(revisionId) || revisionId <= 0) throw new Error("WIKIPEDIA_SP500_REVISION_MISSING");

  const parseUrl = new URL("https://en.wikipedia.org/w/api.php");
  parseUrl.searchParams.set("action", "parse");
  parseUrl.searchParams.set("format", "json");
  parseUrl.searchParams.set("oldid", String(revisionId));
  parseUrl.searchParams.set("prop", "text");
  parseUrl.searchParams.set("origin", "*");
  const parsed = await fetchJson(parseUrl, "WIKIPEDIA_SP500_PARSE", { attempts: 3 });
  const html = String(parsed?.parse?.text?.["*"] ?? "");
  if (!html) throw new Error("WIKIPEDIA_SP500_HTML_MISSING");
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/giu)].map((match) => match[0]);
  const table = tables.find((candidate) => /GICS Sector/iu.test(candidate) && /(Symbol|Ticker symbol)/iu.test(candidate))
    ?? tables.find((candidate) => /constituents/iu.test(candidate));
  if (!table) throw new Error("WIKIPEDIA_SP500_CONSTITUENTS_TABLE_MISSING");
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => decodeHtml(cell[1]));
    if (!cells.length) continue;
    const symbol = cleanPitTicker(cells[0]);
    if (!symbol) continue;
    rows.push({
      symbol,
      name: cells[1] ?? symbol,
      exchange: "SP500",
      assetType: "STOCK",
      ipoDate: null,
      delistingDate: null,
      listingStatus: "ACTIVE",
    });
  }
  const uniqueRows = [...new Map(rows.map((row) => [row.symbol, row])).values()];
  if (uniqueRows.length < 450) throw new Error(`WIKIPEDIA_SP500_MEMBERSHIP_INSUFFICIENT_${uniqueRows.length}`);
  return {
    status: "AVAILABLE",
    date: asOfDate,
    rows: uniqueRows,
    credentialMode: "PUBLIC_NO_KEY",
    sourceId: `wikipedia-sp500-oldid:${revisionId}`,
    sourceDigest: sha256Text(html),
    revisionId,
    revisionTimestamp: String(revision.timestamp ?? ""),
  };
}
function deterministicPitSample(rows) {
  return [...rows]
    .sort((left, right) => pitSampleHash(left.symbol).localeCompare(pitSampleHash(right.symbol)) || left.symbol.localeCompare(right.symbol))
    .slice(0, PIT_SAMPLE_SIZE);
}
function academicPitRecord(row, month) {
  const candles = row.daily;
  const index = monthEndIndex(candles, month);
  if (index < 252 || candles[index].close < 5) return null;
  const sixMonthEnd = index - 21;
  const sixMonthStart = sixMonthEnd - 126;
  if (sixMonthStart < 0) return null;
  const entryIndex = index + 1;
  if (entryIndex >= candles.length) return null;
  const jt6mSignal = candles[sixMonthEnd].close / candles[sixMonthStart].close - 1;
  const high52 = maxHigh(candles.slice(index - 251, index + 1));
  if (!(high52 > 0)) return null;
  const entry = candles[entryIndex].open * (1 + NORMAL_COST);
  const exitIndex = index + 126;
  const base = {
    symbol: row.symbol,
    bucket: row.bucket ?? "PIT",
    sector: row.sector ?? "PIT_UNKNOWN",
    formationMonth: month,
    formationDate: nyParts(candles[index].timestamp).date,
    entryDate: nyParts(candles[entryIndex].timestamp).date,
    jt6mSignal,
    high52Ratio: candles[index].close / high52,
  };
  if (exitIndex < candles.length) {
    const exit = candles[exitIndex].close * (1 - NORMAL_COST);
    return {
      ...base,
      outcomeStatus: "COMPLETE",
      netReturn: exit / entry - 1,
      lastObservedNetReturn: exit / entry - 1,
      wipeoutStressReturn: exit / entry - 1,
      exitDate: nyParts(candles[exitIndex].timestamp).date,
    };
  }
  const last = candles.at(-1);
  const lastObservedNetReturn = last && last.timestamp > candles[entryIndex].timestamp
    ? last.close * (1 - NORMAL_COST) / entry - 1
    : null;
  return {
    ...base,
    outcomeStatus: "TERMINAL_VALUE_UNPROVEN",
    netReturn: null,
    lastObservedNetReturn,
    wipeoutStressReturn: -1,
    exitDate: null,
  };
}
function pitDecileSummary(records, signalKey) {
  const valid = records.filter((row) => Number.isFinite(row[signalKey])).sort((a, b) => a[signalKey] - b[signalKey]);
  if (!valid.length) {
    return {
      count: 0,
      decileN: 0,
      top: null,
      bottom: null,
      observedOnlyTopMinusBottomMeanReturn: null,
      wipeoutStressTopMinusBottomMeanReturn: null,
      allOutcomesProven: false,
      tradableLongShortClaimAllowed: false,
    };
  }
  const decileN = Math.max(1, Math.ceil(valid.length * 0.10));
  const bottom = valid.slice(0, decileN);
  const top = valid.slice(-decileN);
  const metrics = (rows) => {
    const complete = rows.filter((row) => Number.isFinite(row.netReturn));
    const blocked = rows.filter((row) => !Number.isFinite(row.netReturn));
    const observedMean = complete.length ? mean(complete.map((row) => row.netReturn)) : null;
    const lastObserved = rows.map((row) => Number.isFinite(row.netReturn) ? row.netReturn : row.lastObservedNetReturn).filter(Number.isFinite);
    const wipeout = rows.map((row) => Number.isFinite(row.netReturn) ? row.netReturn : -1);
    return {
      count: rows.length,
      completedOutcomes: complete.length,
      blockedTerminalOutcomes: blocked.length,
      outcomeCoverage: rows.length ? complete.length / rows.length : 0,
      allOutcomesProven: blocked.length === 0,
      meanNetReturn: blocked.length === 0 ? observedMean : null,
      observedOnlyMeanNetReturn: observedMean,
      lastObservedBoundMeanReturn: lastObserved.length === rows.length ? mean(lastObserved) : null,
      wipeoutStressMeanReturn: mean(wipeout),
      minSignal: Math.min(...rows.map((row) => row[signalKey])),
      maxSignal: Math.max(...rows.map((row) => row[signalKey])),
      blockedSymbols: blocked.map((row) => row.symbol),
    };
  };
  const topMetrics = metrics(top);
  const bottomMetrics = metrics(bottom);
  const observedSpread = topMetrics.observedOnlyMeanNetReturn != null && bottomMetrics.observedOnlyMeanNetReturn != null
    ? topMetrics.observedOnlyMeanNetReturn - bottomMetrics.observedOnlyMeanNetReturn
    : null;
  return {
    count: valid.length,
    decileN,
    top: topMetrics,
    bottom: bottomMetrics,
    observedOnlyTopMinusBottomMeanReturn: observedSpread,
    wipeoutStressTopMinusBottomMeanReturn: topMetrics.wipeoutStressMeanReturn - bottomMetrics.wipeoutStressMeanReturn,
    allOutcomesProven: topMetrics.allOutcomesProven && bottomMetrics.allOutcomesProven,
    tradableLongShortClaimAllowed: false,
  };
}
function aggregateFormationMetric(formations, key) {
  const usable = formations.map((formation) => formation[key]).filter((value) => value?.top && value?.bottom);
  const proven = usable.filter((value) => value.allOutcomesProven && value.top.meanNetReturn != null && value.bottom.meanNetReturn != null);
  return {
    formationCount: usable.length,
    allOutcomeProvenFormationCount: proven.length,
    meanTopDecileReturn: proven.length ? mean(proven.map((value) => value.top.meanNetReturn)) : null,
    meanBottomDecileReturn: proven.length ? mean(proven.map((value) => value.bottom.meanNetReturn)) : null,
    meanDescriptiveTopMinusBottomReturn: proven.length ? mean(proven.map((value) => value.top.meanNetReturn - value.bottom.meanNetReturn)) : null,
    meanObservedOnlyTopMinusBottomReturn: usable.length ? mean(usable.map((value) => value.observedOnlyTopMinusBottomMeanReturn).filter(Number.isFinite)) : null,
    meanWipeoutStressTopMinusBottomReturn: usable.length ? mean(usable.map((value) => value.wipeoutStressTopMinusBottomMeanReturn).filter(Number.isFinite)) : null,
    terminalBlockedFormationCount: usable.filter((value) => !value.allOutcomesProven).length,
    canonicalReplicationClaimAllowed: false,
  };
}
async function buildPitMembershipMomentumStress() {
  const apiKeyPresent = Boolean(String(process.env.ALPHA_VANTAGE_API_KEY ?? "").trim());
  const formationMemberships = [];
  let providerMode = apiKeyPresent ? "ALPHA_VANTAGE" : "WIKIPEDIA_SP500";
  let alphaFallbackReason = null;
  let alphaProbe = null;
  if (providerMode === "ALPHA_VANTAGE") {
    alphaProbe = await alphaListingStatus(monthEndDate(ACADEMIC_FORMATION_MONTHS[0]));
    if (alphaProbe.status !== "AVAILABLE") {
      providerMode = "WIKIPEDIA_SP500";
      alphaFallbackReason = alphaProbe.error ?? alphaProbe.status;
    }
  }
  for (let formationIndex = 0; formationIndex < ACADEMIC_FORMATION_MONTHS.length; formationIndex += 1) {
    const month = ACADEMIC_FORMATION_MONTHS[formationIndex];
    const asOfDate = monthEndDate(month);
    const listing = providerMode === "ALPHA_VANTAGE"
      ? (formationIndex === 0 && alphaProbe?.status === "AVAILABLE" ? alphaProbe : await alphaListingStatus(asOfDate))
      : await wikipediaSp500Snapshot(asOfDate);
    if (listing.status !== "AVAILABLE") {
      return {
        status: "BLOCKED_PIT_PUBLIC_MEMBERSHIP_SOURCE",
        provider: providerMode === "ALPHA_VANTAGE" ? "alpha-vantage-listing-status" : "wikipedia-sp500-historical-revision",
        providerConfigured: apiKeyPresent,
        credentialMode: listing.credentialMode ?? (apiKeyPresent ? "CONFIGURED_SECRET" : "PUBLIC_NO_KEY"),
        alphaFallbackReason,
        selectionUsesCurrentMembership: false,
        currentMembershipUsedForSelection: false,
        failedFormationMonth: month,
        error: listing.error ?? null,
        sampleSizePerFormation: PIT_SAMPLE_SIZE,
        canonicalPitDatasetClaimAllowed: false,
        formations: formationMemberships,
        jtMomentumJ6K6Skip1: { aggregate: aggregateFormationMetric([], "jtMomentumJ6K6Skip1") },
        high52WeekK6: { aggregate: aggregateFormationMetric([], "high52WeekK6") },
      };
    }
    const sample = deterministicPitSample(listing.rows);
    formationMemberships.push({
      month,
      asOfDate,
      sourceRows: listing.rows.length,
      sourceId: listing.sourceId,
      sourceDigest: listing.sourceDigest,
      revisionId: listing.revisionId ?? null,
      revisionTimestamp: listing.revisionTimestamp ?? null,
      sample,
    });
    if (providerMode === "ALPHA_VANTAGE" && formationIndex < ACADEMIC_FORMATION_MONTHS.length - 1) await sleep(13_000);
  }

  const latestAsOfDate = "2026-09-29";
  const latestListing = providerMode === "ALPHA_VANTAGE"
    ? await alphaListingStatus(latestAsOfDate)
    : await wikipediaSp500Snapshot(latestAsOfDate);
  const latestActive = latestListing.status === "AVAILABLE" ? new Set(latestListing.rows.map((row) => row.symbol)) : null;
  const unionSymbols = [...new Set(formationMemberships.flatMap((formation) => formation.sample.map((row) => row.symbol)))];
  const histories = await mapLimit(unionSymbols, 8, async (symbol) => ({
    symbol,
    daily: (await collectYahooStockHistory({
      market: "US_STOCK",
      symbol,
      startTime: DAILY_START,
      endTime: DAILY_END,
      timeoutMs: 15_000,
    })).candles,
  }));
  const historyBySymbol = new Map(
    histories
      .filter((result) => result.ok && result.value.daily.length >= 300)
      .map((result) => [result.value.symbol, result.value.daily]),
  );
  const historyFailures = histories.map((result, index) => {
    if (result.ok && result.value?.daily?.length >= 300) return null;
    return {
      symbol: result.ok ? result.value.symbol : unionSymbols[index] ?? null,
      error: result.ok ? `HISTORY_INSUFFICIENT_${result.value?.daily?.length ?? 0}` : result.error,
    };
  }).filter(Boolean);

  const formations = formationMemberships.map((formation) => {
    const readyRows = formation.sample.map((member) => {
      const daily = historyBySymbol.get(member.symbol);
      return daily ? { symbol: member.symbol, bucket: "PIT", sector: "PIT_UNKNOWN", daily } : null;
    }).filter(Boolean);
    const records = readyRows.map((row) => academicPitRecord(row, formation.month)).filter(Boolean);
    const futureRemovedFromLatest = latestActive
      ? formation.sample.filter((member) => !latestActive.has(member.symbol)).map((member) => member.symbol)
      : [];
    return {
      month: formation.month,
      asOfDate: formation.asOfDate,
      sourceRows: formation.sourceRows,
      sourceId: formation.sourceId,
      sourceDigest: formation.sourceDigest,
      revisionId: formation.revisionId,
      revisionTimestamp: formation.revisionTimestamp,
      deterministicSampleSize: formation.sample.length,
      historyReady: readyRows.length,
      evaluableRecords: records.length,
      historyCoverage: formation.sample.length ? readyRows.length / formation.sample.length : 0,
      futureRemovedFromLatestCount: futureRemovedFromLatest.length,
      futureRemovedFromLatestSymbols: futureRemovedFromLatest,
      terminalValueBlockedRecords: records.filter((row) => row.outcomeStatus === "TERMINAL_VALUE_UNPROVEN").length,
      jtMomentumJ6K6Skip1: pitDecileSummary(records, "jt6mSignal"),
      high52WeekK6: pitDecileSummary(records, "high52Ratio"),
    };
  });
  const minimumHistoryReady = formations.length ? Math.min(...formations.map((formation) => formation.historyReady)) : 0;
  const status = minimumHistoryReady >= PIT_MIN_HISTORY_READY
    ? "PIT_HISTORICAL_MEMBERSHIP_STRESS_COMPLETE"
    : "BLOCKED_PIT_HISTORY_COVERAGE";

  return {
    status,
    provider: providerMode === "ALPHA_VANTAGE" ? "alpha-vantage-listing-status" : "wikipedia-sp500-historical-revision",
    providerConfigured: apiKeyPresent,
    credentialMode: providerMode === "ALPHA_VANTAGE" ? "CONFIGURED_SECRET" : "PUBLIC_NO_KEY",
    alphaFallbackReason,
    providerHistoricalMembershipAsOfDate: true,
    providerUniverseScope: providerMode === "ALPHA_VANTAGE" ? "US_ACTIVE_STOCKS" : "S&P_500_CONSTITUENTS",
    selectionUsesCurrentMembership: false,
    currentMembershipUsedForSelection: false,
    currentMembershipUsedForRemovedNameDiagnosticOnly: true,
    deterministicSampleSeed: PIT_SAMPLE_SEED,
    sampleSizePerFormation: PIT_SAMPLE_SIZE,
    minimumHistoryReadyRequired: PIT_MIN_HISTORY_READY,
    minimumHistoryReadyObserved: minimumHistoryReady,
    unionSymbols: unionSymbols.length,
    yahooHistoryReadySymbols: historyBySymbol.size,
    yahooHistoryFailures: historyFailures.slice(0, 30),
    latestMembershipDiagnosticAvailable: Boolean(latestActive),
    latestMembershipSourceId: latestListing.sourceId ?? null,
    latestMembershipSourceDigest: latestListing.sourceDigest ?? null,
    canonicalPitDatasetClaimAllowed: false,
    corporateActionReceiptReady: false,
    delistedTerminalPricePolicyReady: false,
    fullUniverseReplicationClaimAllowed: false,
    terminalValueMissingDoesNotDisappearFromDecile: true,
    formations,
    jtMomentumJ6K6Skip1: {
      recipeId: "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
      aggregate: aggregateFormationMetric(formations, "jtMomentumJ6K6Skip1"),
    },
    high52WeekK6: {
      recipeId: "FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1",
      aggregate: aggregateFormationMetric(formations, "high52WeekK6"),
    },
  };
}

function buildAcademicMomentumBaselines(rows) {
  const formations = [];
  for (const month of ACADEMIC_FORMATION_MONTHS) {
    const records = [];
    for (const row of rows) {
      const candles = row.daily;
      const index = monthEndIndex(candles, month);
      if (index < 252) continue;
      if (candles[index].close < 5) continue;
      const forward = sixMonthForwardReturn(candles, index, NORMAL_COST);
      if (!forward) continue;
      const sixMonthEnd = index - 21;
      const sixMonthStart = sixMonthEnd - 126;
      if (sixMonthStart < 0) continue;
      const jt6mSignal = candles[sixMonthEnd].close / candles[sixMonthStart].close - 1;
      const high52 = maxHigh(candles.slice(index - 251, index + 1));
      if (!(high52 > 0)) continue;
      const high52Ratio = candles[index].close / high52;
      records.push({
        symbol: row.symbol, bucket: row.bucket, sector: row.sector, formationMonth: month,
        jt6mSignal, high52Ratio, ...forward,
      });
    }
    formations.push({
      month,
      records: records.length,
      jtMomentumJ6K6Skip1: decileSummary(records, "jt6mSignal"),
      high52WeekK6: decileSummary(records, "high52Ratio"),
    });
  }
  const aggregate = (key) => {
    const usable = formations.map((formation) => formation[key]).filter((value) => value?.top && value?.bottom);
    return {
      formationCount: usable.length,
      meanTopDecileReturn: usable.length ? mean(usable.map((value) => value.top.meanNetReturn)) : null,
      meanBottomDecileReturn: usable.length ? mean(usable.map((value) => value.bottom.meanNetReturn)) : null,
      meanDescriptiveTopMinusBottomReturn: usable.length ? mean(usable.map((value) => value.descriptiveTopMinusBottomMeanReturn)) : null,
      overlappingPortfolioReturnSeriesImplemented: false,
      canonicalReplicationClaimAllowed: false,
    };
  };
  return {
    formationMonths: ACADEMIC_FORMATION_MONTHS,
    formations,
    jtMomentumJ6K6Skip1: {
      recipeId: "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
      sourceDoi: JT_MOMENTUM_DOI,
      signal: "past 6-month return ending one month before formation",
      formationPriceFloorUsd: 5,
      holding: "subsequent 6 months",
      portfolio: "top/bottom signal deciles within bounded cohort; descriptive return spread only",
      aggregate: aggregate("jtMomentumJ6K6Skip1"),
    },
    high52WeekK6: {
      recipeId: "FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1",
      sourceDoi: GH_52W_HIGH_DOI,
      signal: "formation close / maximum daily high over previous 252 sessions",
      formationPriceFloorUsd: 5,
      holding: "subsequent 6 months",
      portfolio: "top/bottom signal deciles within bounded cohort; descriptive return spread only",
      aggregate: aggregate("high52WeekK6"),
    },
  };
}

async function main() {
  const universe = await fetchUniverse();
  const requested = Object.entries(universe.buckets).flatMap(([bucket, rows]) => rows.map((row) => ({ ...row, bucket })));
  const dailyFetched = await mapLimit(requested, 10, async (row) => ({ ...row, daily: (await collectYahooStockHistory({ market: "US_STOCK", symbol: row.symbol, startTime: DAILY_START, endTime: DAILY_END })).candles }));
  const dailyUniverse = dailyFetched.filter((result) => result.ok && result.value.daily.length >= 160).map((result) => result.value);
  if (dailyUniverse.length < 240) throw new Error(`DAILY_UNIVERSE_INSUFFICIENT_${dailyUniverse.length}`);
  const rowBySymbol = new Map(dailyUniverse.map((row) => [row.symbol, row]));
  const earningsResearchUniverse = [
    ...dailyUniverse.filter((row) => row.bucket === "LARGE").slice(0, 20),
    ...dailyUniverse.filter((row) => row.bucket === "MID").slice(0, 20),
    ...dailyUniverse.filter((row) => row.bucket === "SMALL").slice(0, 40),
  ];

  const spy5m = await yahoo5m("SPY");
  const dates = completeDates(spy5m);
  if (dates.length < 20) throw new Error(`COMPLETE_DATES_INSUFFICIENT_${dates.length}`);

  const commonByDate = new Map();
  const commonSymbols = new Set();
  const epGapCandidates = [];
  for (const date of dates) {
    const leaders = rankLeaders(dailyUniverse, date);
    const common = dailyUniverse.map((row) => buildCommonBreakoutCandidate(row, date, leaders.get(row.symbol))).filter(Boolean)
      .sort((a, b) => Math.min(a.leader.rank21, a.leader.rank63, a.leader.rank126) - Math.min(b.leader.rank21, b.leader.rank63, b.leader.rank126) || b.priorMove - a.priorMove)
      .slice(0, COMMON_CANDIDATES_PER_DAY);
    commonByDate.set(date, common);
    for (const candidate of common) commonSymbols.add(candidate.symbol);
    for (const row of dailyUniverse) {
      const candidate = buildEpGapCandidate(row, date);
      if (candidate) epGapCandidates.push(candidate);
    }
  }

  const earningsRequestSymbols = [...new Set([...earningsResearchUniverse.map((row) => row.symbol), ...epGapCandidates.map((candidate) => candidate.symbol)])];
  const earningsResults = await mapLimit(earningsRequestSymbols, 6, async (symbol) => ({ symbol, earnings: await fetchNasdaqEarnings(symbol) }));
  const earningsBySymbol = new Map(earningsResults.filter((result) => result.ok).map((result) => [result.value.symbol, result.value.earnings]));
  const earningsAvailableSymbols = [...earningsBySymbol.values()].filter((value) => value.status === "AVAILABLE").length;

  const neededIntraday = [...new Set([...commonSymbols, ...epGapCandidates.map((candidate) => candidate.symbol)])];
  const intradayFetched = await mapLimit(neededIntraday, 5, async (symbol) => ({ symbol, rows: await yahoo5m(symbol) }));
  const intradayBySymbol = new Map(intradayFetched.filter((result) => result.ok && result.value.rows.length).map((result) => [result.value.symbol, groupDays(result.value.rows)]));

  const commonNormal = [];
  const commonStress = [];
  for (const [date, candidates] of commonByDate.entries()) {
    for (const candidate of candidates) {
      const row = rowBySymbol.get(candidate.symbol);
      const day = intradayBySymbol.get(candidate.symbol)?.get(date);
      if (!row || !day) continue;
      const entry = entryOn5mOrh(candidate, day, { ep: false });
      if (!entry) continue;
      const normal = simulateCommonBreakout(row, candidate, day, entry, NORMAL_COST);
      const stress = simulateCommonBreakout(row, candidate, day, entry, STRESS_COST);
      if (normal) commonNormal.push({ ...candidate, ...entry, ...normal });
      if (stress) commonStress.push({ ...candidate, ...entry, ...stress });
    }
  }

  const epConfirmed = [];
  const epStress = [];
  const epMechanics = [];
  for (const candidate of epGapCandidates) {
    const row = rowBySymbol.get(candidate.symbol);
    const day = intradayBySymbol.get(candidate.symbol)?.get(candidate.date);
    if (!row || !day) continue;
    const volumeRatio30m = first30mVolume(day) / candidate.adv20;
    if (volumeRatio30m < 1) continue;
    const earnings = earningsBySymbol.get(candidate.symbol) ?? { status: "UNAVAILABLE", events: [] };
    const event = matchEarningsEvent(earnings.events, candidate.date);
    const entryDiagnostic = diagnoseEpEntry(candidate, day);
    epMechanics.push({ ...candidate, volumeRatio30m, catalystConfirmed: Boolean(event), event, entryDiagnostic: { status: entryDiagnostic.status, risk: entryDiagnostic.risk ?? null, atrCap: entryDiagnostic.atrCap ?? null } });
    if (!event) continue;
    const entry = entryDiagnostic.entry;
    if (!entry) continue;
    const normal = simulateEp(row, candidate, day, entry, NORMAL_COST);
    const stress = simulateEp(row, candidate, day, entry, STRESS_COST);
    if (normal) epConfirmed.push({ ...candidate, volumeRatio30m, event, ...entry, ...normal });
    if (stress) epStress.push({ ...candidate, volumeRatio30m, event, ...entry, ...stress });
  }

  const pead = [];
  for (const row of earningsResearchUniverse) pead.push(...peadRows(row, earningsBySymbol.get(row.symbol) ?? { status: "UNAVAILABLE", events: [] }));
  const academicMomentum = buildAcademicMomentumBaselines(dailyUniverse);
  const pitMembershipStress = await buildPitMembershipMomentumStress();

  const report = {
    schemaVersion: 2,
    status: "pass",
    market: "US_STOCK",
    purpose: "reference-first reproduction of published/practitioner strategy recipes before wave/candle/AI overlays",
    recipeContract: {
      noInventedCompositeBeforeBaseline: true,
      noWaveCandleVwapAiOverlayInBaseline: true,
      winnerSelectionFromThisWindow: false,
      commonBreakout: {
        recipeId: "QULLAMAGGIE_COMMON_BREAKOUT_V1",
        source: QULLAMAGGIE_BREAKOUT_SOURCE,
        sourceRules: ["top 1-2% leaders by 1m/3m/6m", "30-100%+ prior move", "2w-2m higher-low tightening consolidation", "opening-range-high entry", "stop at low of day and no wider than ATR/ADR", "sell 1/3 after day 4 then breakeven", "trail remainder on first close below 10DMA"],
        deterministicOperationalizationOnly: true,
        parameterSearch: false,
      },
      episodicPivot: {
        recipeId: "QULLAMAGGIE_EP_V1",
        source: QULLAMAGGIE_EP_SOURCE,
        sourceRules: ["10%+ gap", "large volume with best cases near ADV in first 15-30m", "unexpected earnings/guidance catalyst", "opening-range-high entry", "low-of-day stop <=1.5 ATR", "20DMA close trail"],
        requiresConfirmedCatalyst: true,
        priceVolumeOnlyCannotCountAsEp: true,
        parameterSearch: false,
      },
      pead: {
        recipeId: "PEAD_EARNINGS_SURPRISE_V1",
        reviewSourceDoi: PEAD_REVIEW_DOI,
        analystForecastSourceDoi: LIVNAT_MENDENHALL_DOI,
        analystSueFormulaReferenceDoi: ANALYST_SUE_FORMULA_REFERENCE_DOI,
        implementation: "analyst-SUE proxy=(actual EPS-consensus EPS)/price one month before announcement; rank bounded event cohort into top/bottom deciles; enter first full session strictly after report; measure 5/20/40-session returns",
        canonicalIbesSueafReplication: false,
        canonicalTimeSeriesSueStatus: "BLOCKED_QUARTERLY_EPS_HISTORY_AND_FORECAST_VINTAGE",
        parameterSearch: false,
      },
      crossSectionalMomentum: {
        recipeId: "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
        sourceDoi: JT_MOMENTUM_DOI,
        implementation: "J6/K6 with one-month skip, top/bottom deciles, six-month holding",
        parameterSearch: false,
      },
      high52WeekMomentum: {
        recipeId: "FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1",
        sourceDoi: GH_52W_HIGH_DOI,
        implementation: "current price / prior 252-session high, top/bottom deciles, six-month holding",
        parameterSearch: false,
      },
    },
    dataWindow: { startInclusive: new Date(EVAL_START).toISOString(), endExclusive: new Date(EVAL_END).toISOString(), completeDates: dates },
    universe: {
      currentSnapshotBias: true,
      rawNasdaqRows: universe.rawRows,
      requestedSymbols: requested.length,
      dailyReadySymbols: dailyUniverse.length,
      cohortPolicy: "broad current-liquidity approximation reused from #1473: LARGE top80, MID top100, SMALL top120",
      fullUsMarketTop2PctClaimAllowed: false,
      earningsResearchSymbols: earningsResearchUniverse.length,
    },
    dataSources: {
      daily: "Yahoo public chart 1d",
      intraday: "Yahoo public chart 5m range=60d",
      earningsSurprise: "Nasdaq public company earnings-surprise endpoint, best-effort fail-closed",
      earningsAvailableSymbols,
    },
    commonBreakout: {
      status: "BASELINE_REPLAY_COMPLETE",
      candidateDays: [...commonByDate.values()].filter((rows) => rows.length).length,
      candidateCount: [...commonByDate.values()].reduce((sum, rows) => sum + rows.length, 0),
      intradaySymbolsRequested: neededIntraday.length,
      normal: { metrics: summarizeTrades(commonNormal), portfolioDiagnostic: portfolioDiagnostic(commonNormal), trades: commonNormal },
      stress: { metrics: summarizeTrades(commonStress), portfolioDiagnostic: portfolioDiagnostic(commonStress), trades: commonStress.length },
    },
    episodicPivot: {
      status: earningsAvailableSymbols > 0 ? "CATALYST_AWARE_REPLAY_COMPLETE" : "BLOCKED_EARNINGS_CATALYST_DATA",
      gapCandidates: epGapCandidates.length,
      priceVolumeMechanicsCandidates: epMechanics.length,
      confirmedEarningsCandidates: epMechanics.filter((row) => row.catalystConfirmed).length,
      trueEpRequiresCatalyst: true,
      normal: { metrics: summarizeTrades(epConfirmed), trades: epConfirmed },
      stress: { metrics: summarizeTrades(epStress), trades: epStress.length },
      mechanicsOnly: epMechanics,
    },
    pead: {
      status: earningsAvailableSymbols > 0 ? "ANALYST_SUE_PROXY_REPLICATION_COMPLETE" : "BLOCKED_EARNINGS_SURPRISE_DATA",
      eventHorizonRows: pead.length,
      windows: {
        PRIOR: { startInclusive: PEAD_PRIOR_START, endExclusive: PEAD_RECENT_START, byHorizon: summarizePead(pead.filter((row) => row.validationWindow === "PRIOR")) },
        RECENT: { startInclusive: PEAD_RECENT_START, endExclusive: PEAD_RECENT_END, byHorizon: summarizePead(pead.filter((row) => row.validationWindow === "RECENT")) },
      },
      byHorizon: summarizePead(pead),
      canonicalIbesSueafReplication: false,
      canonicalTimeSeriesSueStatus: "BLOCKED_QUARTERLY_EPS_HISTORY_AND_FORECAST_VINTAGE",
      rows: pead,
    },
    academicMomentum,
    pitMembershipStress,
    costs: { normalPerSide: NORMAL_COST, stressPerSide: STRESS_COST },
    accountPolicy: ACCOUNT,
    lookahead: {
      D1CandidateUsesOnlyPriorCompletedDailyBars: true,
      leaderRanksArePointInTimeWithinBoundedCohort: true,
      ORHEntryUsesNextCompleted5mOpenAfterTriggerBar: true,
      lowOfDayStopUsesOnlyLowObservedBeforeEntry: true,
      movingAverageExitExecutesNextSessionOpenAfterCloseSignal: true,
      earningsEventTradeUsesSameOrPreviousReportDateOnly: true,
      peadEntersFirstFullSessionStrictlyAfterReportDate: true,
    },
    promotionAssessment: {
      QULLAMAGGIE_COMMON_BREAKOUT_V1: {
        status: "RESEARCH_HOLD_BASELINE_NEGATIVE",
        reason: "bounded broad-cohort baseline is negative after costs; do not tune to rescue",
        overlayResearchAllowed: true,
        automaticPromotionAllowed: false,
      },
      QULLAMAGGIE_EP_V1: {
        status: "RESEARCH_HOLD_SOURCE_EVIDENCE_INCOMPLETE",
        reason: "small EPS-catalyst sample and historical revenue/guidance evidence incomplete",
        overlayResearchAllowed: true,
        automaticPromotionAllowed: false,
      },
      PEAD_EARNINGS_SURPRISE_V1: {
        status: "RESEARCH_HOLD_TEMPORAL_GENERALIZATION_FAILED",
        reason: "RECENT analyst-SUE proxy spread does not generalize to PRIOR window; canonical I/B/E/S/FOS SUE unavailable",
        overlayResearchAllowed: false,
        automaticPromotionAllowed: false,
      },
      CROSS_SECTIONAL_PRICE_MOMENTUM_V1: {
        status: "BLOCKED_PIT_UNIVERSE_AND_OUTLIER_CONCENTRATION",
        reason: "large descriptive spread is current-snapshot survivorship-biased and materially concentrated in extreme winners",
        nextRequiredEvidence: "materialized US point-in-time membership + removed/delisted listings + corporate actions + same recipe rerun",
        automaticPromotionAllowed: false,
      },
      FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1: {
        status: "RESEARCH_HOLD_UNSTABLE_FORMATION_SIGN",
        reason: "descriptive six-month spreads change sign across fixed formation cohorts and PIT universe remains missing",
        automaticPromotionAllowed: false,
      },
      pitUniverseEvidence: {
        canonicalAdapterOnMain: true,
        adapter: "stock-point-in-time-evidence-adapter-v1",
        alphaVantageHistoricalMembershipStressStatus: pitMembershipStress.status,
        historicalMembershipStressUsesCurrentMembershipForSelection: pitMembershipStress.selectionUsesCurrentMembership,
        materializedUsPitDatasetReady: false,
        firstZero: "US_PIT_MEMBERSHIP_REMOVED_LISTINGS_CORPORATE_ACTION_DATASET_NOT_MATERIALIZED",
      },
    },
    safety: {
      researchOnly: true,
      publicMarketDataOnly: true,
      privateAccountRequestAllowed: false,
      orderRouteCalled: false,
      liveExecutionAllowed: false,
      executionAuthority: "NONE",
      profitabilityPromotionAllowed: false,
      economicSampleCredit: 0,
    },
    limitations: [
      "This is a 300-symbol broad current-liquidity approximation, not the entire US market; Qullamaggie's top-1-2% scan is reproduced only inside this bounded cohort.",
      "Current Nasdaq membership/liquidity introduces survivorship/current-snapshot bias.",
      "Yahoo public 5m history is bounded to recent history; this is not a multi-year intraday proof.",
      "Common Breakout qualitative terms such as orderly consolidation are converted into fixed, preregistered higher-low/range-tightening rules without parameter search.",
      "True EP credit requires a matched positive earnings-surprise event. Gap+volume without catalyst remains mechanics-only and cannot be labeled EP.",
      "Nasdaq earnings-surprise availability is best-effort; missing event data fails closed instead of being inferred from price.",
      "PEAD uses an analyst-SUE proxy from Nasdaq actual/consensus EPS scaled by a one-month-prior price and reports PRIOR/RECENT windows separately. Nasdaq does not prove the exact 30-day I/B/E/S forecast vintage, so this is not canonical SUEAF.",
      "Canonical Foster-Olsen-Shevlin SUE needs current EPS, EPS four quarters earlier, and the standard deviation of quarterly EPS changes over prior quarters; those fields are not available in the current repository and remain fail-closed.",
      "No historical guidance, revenue-growth, analyst-revision, news-text, order-book, short-interest, wave/candle or AI overlay is used in the baseline.",
      "Academic momentum and 52-week-high outputs apply a $5 formation-price floor, use current-snapshot symbols, daily approximations to monthly portfolio formation, and do not construct the papers' full overlapping monthly portfolio return series.",
      "The Alpha Vantage PIT membership stress lane uses historical active membership only for deterministic sampling, but Yahoo history is not canonical removed-listing terminal-price or corporate-action evidence, so it cannot set materializedUsPitDatasetReady=true.",
      "Historical replay is not genuine OOS/Forward, broker fill evidence, or PROFITABILITY_PROVEN.",
    ],
  };

  const out = resolve(process.argv[2] ?? "docs/us-reference-recipes-v2.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: report.status,
    dailyReadySymbols: report.universe.dailyReadySymbols,
    commonCandidates: report.commonBreakout.candidateCount,
    commonTrades: report.commonBreakout.normal.metrics.trades,
    epGapCandidates: report.episodicPivot.gapCandidates,
    epConfirmedTrades: report.episodicPivot.normal.metrics.trades,
    peadRows: report.pead.eventHorizonRows,
    pead5TopDecileMean: report.pead.byHorizon?.["5"]?.analystSueTopDecile?.metrics?.meanNetReturn ?? null,
    jtMomentumSpread: report.academicMomentum.jtMomentumJ6K6Skip1.aggregate.meanDescriptiveTopMinusBottomReturn,
    high52Spread: report.academicMomentum.high52WeekK6.aggregate.meanDescriptiveTopMinusBottomReturn,
    pitMembershipStatus: report.pitMembershipStress.status,
    pitCredentialMode: report.pitMembershipStress.credentialMode ?? null,
    pitError: report.pitMembershipStress.error ?? null,
    pitMomentumSpread: report.pitMembershipStress.jtMomentumJ6K6Skip1.aggregate.meanDescriptiveTopMinusBottomReturn,
    pitHigh52Spread: report.pitMembershipStress.high52WeekK6.aggregate.meanDescriptiveTopMinusBottomReturn,
    earningsAvailableSymbols,
  }));
}
await main();
