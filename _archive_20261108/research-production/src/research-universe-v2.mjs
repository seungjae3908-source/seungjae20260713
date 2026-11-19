// Full-market research universe with a liquidity filter.
//
// The V1 combination universe is 20 hand-picked, long-lived names per data
// source. V2 starts from EVERY listed symbol of each market and keeps the ones
// that were actually tradeable:
//
//  1. listing: Upbit KRW markets, Bitget USDT perpetuals, KRX listed stocks,
//     NASDAQ-Trader listed US securities (public endpoints only);
//  2. liquidity probe: daily candles up to 2025-12-31 (BEFORE the sealed 2026
//     holdout, so nothing that happened in 2026 decides membership), median
//     daily traded value over the last 120 trading days of 2025 and a minimum
//     listing age;
//  3. research set: up to `researchPerSource` liquid names stratified into
//     large / mid / small liquidity terciles (equal thirds), deterministic;
//     watch set: up to `watchPerSource` liquid names for forward paper trading.
//
// A source's snapshot is frozen once complete and is never silently changed:
// a new snapshot is a new experiment (the lane runner keys its state on the
// symbol set) and the cumulative trial ledger keeps counting.
//
// Known limit: listing endpoints only show symbols that still trade today, so
// delisted names are absent (survivorship bias). This is reported, not hidden.
// Research only: public data, no orders, executionAuthority NONE.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeResearchSymbol } from '../../market-prediction-lab/src/research-governance.js';
import { collectYahooStockHistory } from '../../market-prediction-lab/src/yahoo-stock-history.js';
import { COMBINATION_UNIVERSE_V1 } from './combination-search-lane-v1.mjs';

export const RESEARCH_UNIVERSE_CONTRACT_V2 = 'research-universe/v2';
const DAY = 86_400_000;
const PROBE_END = Date.UTC(2026, 0, 1) - 1;

export const RESEARCH_UNIVERSE_POLICY_V2 = Object.freeze({
  researchPerSource: 60,
  watchPerSource: 300,
  liquidityWindowDays: 120,
  listingRefreshDays: 7,
  // A symbol whose probe failed for its own reason (unsupported, no history)
  // is retried this many times before it is excluded; rate limits (429),
  // 5xx and network errors are the SOURCE's problem: they never count against
  // a symbol, they pause that source for a backoff (Retry-After when given).
  permanentFailureAttempts: 3,
  transientBackoffMs: 15 * 60_000,
  maximumTransientBackoffMs: 6 * 60 * 60_000,
  // Minimum median daily traded value (local currency of the venue) and the
  // minimum number of daily candles before 2026 (listing age).
  sources: Object.freeze({
    UPBIT_1H: Object.freeze({ market: 'CRYPTO_SPOT', minimumDailyValue: 1_000_000_000, minimumHistoryDays: 820, currency: 'KRW' }),
    BITGET_1H: Object.freeze({ market: 'CRYPTO_FUTURES', minimumDailyValue: 20_000_000, minimumHistoryDays: 820, currency: 'USDT' }),
    YAHOO_KR_1D: Object.freeze({ market: 'KR_STOCK', minimumDailyValue: 1_000_000_000, minimumHistoryDays: 1_100, currency: 'KRW' }),
    YAHOO_US_1D: Object.freeze({ market: 'US_STOCK', minimumDailyValue: 5_000_000, minimumHistoryDays: 1_100, currency: 'USD' }),
  }),
});

// ---------- small utilities ----------

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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function httpError(response) {
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return Object.assign(new Error(`UNIVERSE_HTTP_${response.status}`), {
    status: response.status,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter * 1000) : null,
  });
}

async function getJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'seungjae-research/2.0' }, ...init });
  if (!response.ok) throw httpError(response);
  return response.json();
}

async function getText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: 'text/plain', 'user-agent': 'seungjae-research/2.0' } });
  if (!response.ok) throw httpError(response);
  return response.text();
}

const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Rate limit, server error or network failure: retry later, blame no symbol. */
export function isTransientUniverseErrorV1(error) {
  const status = Number(error?.status);
  if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return true;
  const code = String(error?.code ?? error?.cause?.code ?? '');
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  const message = String(error?.message ?? '');
  // Provider collectors name the status in their message (YAHOO_STOCK_HTTP_429, UPBIT_HISTORY_HTTP_503...).
  if (/_HTTP_(?:408|429|5\d\d)(?:\D|$)/u.test(message)) return true;
  if (error?.name === 'AbortError' || /^fetch failed$/iu.test(message) || /request timeout/iu.test(message)) return true;
  return false;
}

function transientBackoffMs(error, count, policy) {
  const requested = Number(error?.retryAfterMs);
  const base = Number.isFinite(requested) && requested > 0 ? requested : policy.transientBackoffMs;
  return Math.min(base * Math.min(2 ** Math.max(0, count - 1), 8), policy.maximumTransientBackoffMs);
}

function noteTransient(entry, source, stage, error, observedAtMs, policy, log) {
  const count = Number(entry.transient?.count ?? 0) + 1;
  const backoffUntil = new Date(observedAtMs + transientBackoffMs(error, count, policy)).toISOString();
  entry.transient = { count, stage, lastReason: String(error?.message ?? error).slice(0, 120), lastAt: new Date(observedAtMs).toISOString(), backoffUntil };
  log.push(`${source}:TRANSIENT_BACKOFF:${stage}:${entry.transient.lastReason.slice(0, 60)}:until=${backoffUntil}`);
}

function inBackoff(entry, observedAtMs) {
  return Boolean(entry?.transient?.backoffUntil) && Date.parse(entry.transient.backoffUntil) > observedAtMs;
}

function pendingSymbols(entry, observedAtMs, policy) {
  return (entry.listing ?? []).filter((symbol) => {
    if (entry.probes[symbol]) return false;
    const failure = entry.failures[symbol];
    if (failure && failure.attempts >= policy.permanentFailureAttempts) return false;
    return !(failure && Date.parse(failure.retryAfter) > observedAtMs);
  });
}

/** Even split of the probe budget: 15 across 4 sources -> 4,4,4,3. */
export function splitProbeBudgetV2(total, parts) {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, index) => base + (index < total % parts ? 1 : 0));
}

// ---------- listings ----------

export async function fetchUpbitKrwListingV2(fetchImpl) {
  const rows = await getJson(fetchImpl, 'https://api.upbit.com/v1/market/all?isDetails=true');
  if (!Array.isArray(rows)) throw new Error('UPBIT_LISTING_SHAPE');
  return rows.filter((row) => typeof row?.market === 'string' && /^KRW-[A-Z0-9]{2,15}$/u.test(row.market))
    .map((row) => ({ symbol: row.market, name: String(row.korean_name ?? row.english_name ?? ''), warning: row.market_warning === 'CAUTION' || row.market_event?.warning === true }));
}

export async function fetchBitgetUsdtPerpListingV2(fetchImpl) {
  const payload = await getJson(fetchImpl, 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES');
  const rows = payload?.data;
  if (!Array.isArray(rows)) throw new Error('BITGET_LISTING_SHAPE');
  return rows.filter((row) => typeof row?.symbol === 'string' && /^[A-Z0-9]{2,20}USDT$/u.test(row.symbol)
    && (row.symbolStatus == null || row.symbolStatus === 'normal'))
    .map((row) => ({ symbol: row.symbol, name: row.baseCoin ?? '' }));
}

export async function fetchKrxStockListingV2(fetchImpl) {
  const response = await fetchImpl('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
      'User-Agent': 'Mozilla/5.0',
    },
    body: 'bld=dbms%2Fcomm%2Ffinder%2Ffinder_stkisu&mktsel=ALL&searchText=',
  });
  if (!response.ok) throw new Error(`KRX_LISTING_HTTP_${response.status}`);
  const rows = (await response.json())?.block1;
  if (!Array.isArray(rows)) throw new Error('KRX_LISTING_SHAPE');
  // Numeric six-digit codes only: alphanumeric codes are not served by the
  // public daily-candle source (an explained exclusion, not a silent one).
  const out = rows.filter((row) => /^\d{6}$/u.test(String(row?.short_code ?? '').trim()))
    .filter((row) => String(row.marketName ?? '').includes('KOSPI') || String(row.marketName ?? '').includes('KOSDAQ')
      || String(row.marketName ?? '').includes('코스피') || String(row.marketName ?? '').includes('코스닥'))
    .map((row) => ({ symbol: String(row.short_code).trim(), name: String(row.codeName ?? ''), board: String(row.marketName ?? '') }));
  if (out.length < 1000) throw new Error(`KRX_LISTING_INCOMPLETE:${out.length}`);
  return out;
}

function parsePipeTable(text, symbolColumn) {
  const lines = String(text).split(/\r?\n/u).filter((line) => line.includes('|'));
  if (lines.length < 2) throw new Error('NASDAQ_LISTING_SHAPE');
  const header = lines[0].split('|');
  const at = (name) => header.indexOf(name);
  const symbol = at(symbolColumn); const test = at('Test Issue'); const etf = at('ETF'); const name = at('Security Name');
  if (symbol < 0) throw new Error('NASDAQ_LISTING_HEADER');
  return lines.slice(1).filter((line) => !line.startsWith('File Creation Time')).map((line) => line.split('|'))
    .filter((cells) => cells[symbol] && (test < 0 || cells[test] !== 'Y'))
    .map((cells) => ({ symbol: cells[symbol].trim(), name: name >= 0 ? cells[name] : '', etf: etf >= 0 && cells[etf] === 'Y' }));
}

export async function fetchUsListingV2(fetchImpl) {
  const [nasdaq, other] = await Promise.all([
    getText(fetchImpl, 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'),
    getText(fetchImpl, 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'),
  ]);
  const rows = [...parsePipeTable(nasdaq, 'Symbol'), ...parsePipeTable(other, 'ACT Symbol')];
  // Plain tickers only (no warrants, units, preferred classes with dots/$).
  const out = [...new Map(rows.filter((row) => /^[A-Z]{1,5}$/u.test(row.symbol)).map((row) => [row.symbol, row])).values()];
  if (out.length < 2000) throw new Error(`US_LISTING_INCOMPLETE:${out.length}`);
  return out;
}

const LISTING_FETCHERS = Object.freeze({
  UPBIT_1H: fetchUpbitKrwListingV2,
  BITGET_1H: fetchBitgetUsdtPerpListingV2,
  YAHOO_KR_1D: fetchKrxStockListingV2,
  YAHOO_US_1D: fetchUsListingV2,
});

// ---------- daily liquidity probes (history up to 2025-12-31 only) ----------

async function upbitDaily(fetchImpl, symbol) {
  const out = new Map();
  let to = new Date(PROBE_END).toISOString();
  for (let page = 0; page < 8; page += 1) {
    const rows = await getJson(fetchImpl, `https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(symbol)}&to=${encodeURIComponent(to)}&count=200`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    let oldest = Infinity;
    for (const row of rows) {
      const timestamp = Date.parse(`${row.candle_date_time_utc}Z`);
      const close = Number(row.trade_price); const value = Number(row.candle_acc_trade_price);
      if (Number.isFinite(timestamp) && timestamp <= PROBE_END && Number.isFinite(close) && Number.isFinite(value)) out.set(timestamp, { timestamp, close, value });
      oldest = Math.min(oldest, timestamp);
    }
    if (rows.length < 200 || !Number.isFinite(oldest)) break;
    to = new Date(oldest - 1).toISOString();
  }
  return [...out.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function bitgetDaily(fetchImpl, symbol) {
  const out = new Map();
  let endTime = PROBE_END;
  for (let page = 0; page < 8; page += 1) {
    const payload = await getJson(fetchImpl, `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=1D&endTime=${endTime}&limit=200`);
    const rows = payload?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;
    let oldest = Infinity;
    for (const row of rows) {
      const timestamp = Number(row[0]); const close = Number(row[4]); const quoteVolume = Number(row[6] ?? (Number(row[5]) * close));
      if (Number.isFinite(timestamp) && timestamp <= PROBE_END && Number.isFinite(close) && Number.isFinite(quoteVolume)) out.set(timestamp, { timestamp, close, value: quoteVolume });
      oldest = Math.min(oldest, timestamp);
    }
    if (rows.length < 200 || !Number.isFinite(oldest)) break;
    endTime = oldest - 1;
  }
  return [...out.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function yahooDaily(fetchImpl, source, symbol) {
  const history = await collectYahooStockHistory({ market: source === 'YAHOO_KR_1D' ? 'KR_STOCK' : 'US_STOCK', symbol,
    startTime: PROBE_END - (6 * 365 * DAY), endTime: PROBE_END, fetchImpl });
  return history.candles.filter((row) => row.timestamp <= PROBE_END)
    .map((row) => ({ timestamp: row.timestamp, close: Number(row.close), value: Number(row.close) * Number(row.volume) }));
}

export async function probeDailyLiquidityV2({ source, symbol, fetchImpl, policy = RESEARCH_UNIVERSE_POLICY_V2 }) {
  const spec = policy.sources[source];
  if (!spec) throw new Error('UNIVERSE_SOURCE_UNKNOWN');
  const rows = source === 'UPBIT_1H' ? await upbitDaily(fetchImpl, symbol)
    : source === 'BITGET_1H' ? await bitgetDaily(fetchImpl, symbol)
      : await yahooDaily(fetchImpl, source, symbol);
  const recent = rows.slice(-policy.liquidityWindowDays);
  const medianDailyValue = median(recent.map((row) => row.value));
  const historyDays = rows.length === 0 ? 0 : Math.round((rows.at(-1).timestamp - rows[0].timestamp) / DAY) + 1;
  // Days with zero value (halted, suspended) count against the name.
  const zeroValueShare = recent.length === 0 ? 1 : recent.filter((row) => !(row.value > 0)).length / recent.length;
  return Object.freeze({
    symbol, historyDays, candles: rows.length, medianDailyValue, zeroValueShare,
    liquid: medianDailyValue != null && medianDailyValue >= spec.minimumDailyValue && historyDays >= spec.minimumHistoryDays && zeroValueShare <= 0.05,
  });
}

// ---------- selection ----------

/** Stratified, deterministic research set: equal thirds from large/mid/small liquidity. */
export function selectStratifiedUniverseV2(probes, count) {
  const liquid = probes.filter((row) => row.liquid).sort((a, b) => b.medianDailyValue - a.medianDailyValue || a.symbol.localeCompare(b.symbol));
  if (liquid.length <= count) return liquid.map((row) => ({ symbol: row.symbol, tier: tierOf(liquid, row) }));
  const third = Math.ceil(liquid.length / 3);
  const tiers = [liquid.slice(0, third), liquid.slice(third, 2 * third), liquid.slice(2 * third)];
  const perTier = [Math.ceil(count / 3), Math.ceil(count / 3), count - (2 * Math.ceil(count / 3))];
  const out = [];
  tiers.forEach((rows, tier) => {
    // Evenly spaced inside each tier, so it is not only the top of the tier.
    const take = Math.min(perTier[tier], rows.length);
    for (let k = 0; k < take; k += 1) {
      const row = rows[Math.floor((k * rows.length) / take)];
      out.push({ symbol: row.symbol, tier: ['LARGE', 'MID', 'SMALL'][tier] });
    }
  });
  return out;
}

function tierOf(sorted, row) {
  const index = sorted.indexOf(row);
  const third = sorted.length / 3;
  return index < third ? 'LARGE' : index < 2 * third ? 'MID' : 'SMALL';
}

// ---------- state machine ----------

function universePath(root) { return join(root, 'research-universe-v2', 'state.json'); }
function snapshotPath(root) { return join(root, 'research-universe-v2', 'snapshot.json'); }

/**
 * Bounded tick: refreshes stale listings and probes up to `maximumProbes`
 * symbols. When every listed symbol of a source has been probed, that
 * source's research and watch sets are frozen into the snapshot.
 */
export async function refreshResearchUniverseV2({
  stateRoot,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  maximumProbes = 25,
  policy = RESEARCH_UNIVERSE_POLICY_V2,
  listingFetchers = LISTING_FETCHERS,
  prober = probeDailyLiquidityV2,
  clock = () => Date.now(),
  budgetMs = Infinity,
} = {}) {
  const startedMs = clock();
  if (!stateRoot) throw new Error('UNIVERSE_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const observedAtMs = Date.parse(observedAt);
  const state = (await readJson(universePath(stateRoot))) ?? { contract: RESEARCH_UNIVERSE_CONTRACT_V2, sources: {} };
  const snapshot = (await readJson(snapshotPath(stateRoot))) ?? { contract: RESEARCH_UNIVERSE_CONTRACT_V2, sources: {} };
  const log = [];
  const sourceIds = Object.keys(policy.sources);

  // Pass 1: listings. A frozen snapshot is never re-listed: membership changes
  // only by an explicit new snapshot (delete the frozen source to rebuild it).
  for (const source of sourceIds) {
    const entry = state.sources[source] ??= { listing: null, listedAt: null, probes: {}, failures: {} };
    if (snapshot.sources[source]) continue;
    if (inBackoff(entry, observedAtMs)) { log.push(`${source}:BACKOFF:${entry.transient.backoffUntil}`); continue; }
    const listingAge = entry.listedAt ? observedAtMs - Date.parse(entry.listedAt) : Infinity;
    if (entry.listing == null || listingAge > policy.listingRefreshDays * DAY) {
      try {
        const listing = await listingFetchers[source](fetchImpl);
        entry.listing = listing.map((row) => row.symbol).sort();
        entry.listingDetail = Object.fromEntries(listing.map((row) => [row.symbol, { name: row.name ?? '', warning: row.warning === true, etf: row.etf === true, board: row.board ?? null }]));
        entry.listedAt = observedAt;
        log.push(`${source}:LISTED:${entry.listing.length}`);
      } catch (error) {
        if (isTransientUniverseErrorV1(error)) noteTransient(entry, source, 'LISTING', error, observedAtMs, policy, log);
        else log.push(`${source}:LISTING_FAILED:${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  // Pass 2: probes. The budget is split evenly across the sources that still
  // have work (rotating which one gets the remainder and the leftovers), so a
  // large listing never starves the other markets.
  const active = sourceIds.filter((source) => !snapshot.sources[source] && state.sources[source]?.listing
    && !inBackoff(state.sources[source], observedAtMs) && pendingSymbols(state.sources[source], observedAtMs, policy).length > 0);
  const rotation = Number.isInteger(state.probeRotation) ? state.probeRotation : 0;
  const order = active.length ? [...active.slice(rotation % active.length), ...active.slice(0, rotation % active.length)] : [];
  state.probeRotation = rotation + 1;
  const quotas = splitProbeBudgetV2(maximumProbes, order.length);
  const quotaBySource = {};
  let spare = 0;
  for (const [index, source] of order.entries()) {
    const entry = state.sources[source];
    let allowance = quotas[index] + spare;
    quotaBySource[source] = allowance;
    spare = 0;
    for (const symbol of pendingSymbols(entry, observedAtMs, policy)) {
      if (allowance <= 0 || clock() - startedMs >= budgetMs) break;
      allowance -= 1;
      try {
        entry.probes[symbol] = await prober({ source, symbol, fetchImpl, policy });
        delete entry.failures[symbol];
        if (entry.transient) entry.transient = { ...entry.transient, count: 0, backoffUntil: null };
      } catch (error) {
        if (isTransientUniverseErrorV1(error)) {
          // The source is rate limiting or down: pause it, keep the symbol pending.
          noteTransient(entry, source, 'PROBE', error, observedAtMs, policy, log);
          break;
        }
        const attempts = Number(entry.failures[symbol]?.attempts ?? 0) + 1;
        entry.failures[symbol] = { attempts, reason: String(error?.message ?? error).slice(0, 120), retryAfter: new Date(observedAtMs + (attempts * 3_600_000)).toISOString() };
      }
    }
    spare = Math.max(0, allowance);
  }

  // Freeze every listed source whose symbols are all probed or excluded.
  for (const source of sourceIds) {
    const entry = state.sources[source];
    if (snapshot.sources[source] || !entry?.listing) continue;
    const pending = entry.listing.filter((symbol) => !entry.probes[symbol] && !(entry.failures[symbol]?.attempts >= policy.permanentFailureAttempts));
    if (pending.length === 0) {
      const probes = Object.values(entry.probes);
      const research = selectStratifiedUniverseV2(probes, policy.researchPerSource);
      const watch = probes.filter((row) => row.liquid).sort((a, b) => b.medianDailyValue - a.medianDailyValue || a.symbol.localeCompare(b.symbol))
        .slice(0, policy.watchPerSource).map((row) => row.symbol);
      snapshot.sources[source] = {
        frozenAt: observedAt,
        listed: entry.listing.length,
        probed: probes.length,
        unprobeable: Object.keys(entry.failures).length,
        liquid: probes.filter((row) => row.liquid).length,
        research: research.map((row) => row.symbol),
        researchTiers: Object.fromEntries(research.map((row) => [row.symbol, row.tier])),
        watch,
        liquidity: Object.fromEntries(probes.filter((row) => row.liquid).map((row) => [row.symbol, Math.round(row.medianDailyValue)])),
        selectionDigest: createHash('sha256').update(JSON.stringify(research)).digest('hex'),
        survivorshipBias: 'CURRENT_LISTINGS_ONLY',
        liquidityMeasuredThrough: '2025-12-31',
      };
      log.push(`${source}:FROZEN:research=${research.length}:watch=${watch.length}:liquid=${snapshot.sources[source].liquid}`);
    } else {
      log.push(`${source}:PROBING:${Object.keys(entry.probes).length}/${entry.listing.length}`);
    }
  }
  await atomicJson(universePath(stateRoot), state);
  await atomicJson(snapshotPath(stateRoot), snapshot);
  return Object.freeze({
    contract: RESEARCH_UNIVERSE_CONTRACT_V2, observedAt, log, frozenSources: Object.keys(snapshot.sources),
    quotas: quotaBySource,
    backoff: Object.fromEntries(sourceIds.filter((source) => inBackoff(state.sources[source], observedAtMs))
      .map((source) => [source, { until: state.sources[source].transient.backoffUntil, count: state.sources[source].transient.count, stage: state.sources[source].transient.stage }])),
  });
}

export async function readResearchUniverseSnapshotV2(stateRoot) {
  return (await readJson(snapshotPath(stateRoot))) ?? { contract: RESEARCH_UNIVERSE_CONTRACT_V2, sources: {} };
}

/**
 * Lane-runner universe: frozen V2 research sets where available, the V1 list
 * otherwise. Same shape as COMBINATION_UNIVERSE_V1.
 */
// A frozen set can hold a listing the backtest contract rejects (Upbit lists
// one-letter bases such as KRW-W; the contract needs 2+). One such symbol
// threw for the whole combination search, so drop it before any lane runs.
function researchSymbolsV2(source, symbols) {
  const market = RESEARCH_UNIVERSE_POLICY_V2.sources[source]?.market;
  if (!market || !Array.isArray(symbols)) return symbols;
  return symbols.filter((symbol) => {
    try { return normalizeResearchSymbol(market, symbol) === symbol; } catch { return false; }
  });
}

export function combinationUniverseFromSnapshotV2(snapshot, { fallback = COMBINATION_UNIVERSE_V1, minimumSymbols = 12 } = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(fallback).map(([source, spec]) => {
    const frozen = snapshot?.sources?.[source];
    const research = researchSymbolsV2(source, frozen?.research);
    const symbols = Array.isArray(research) && research.length >= minimumSymbols ? research : spec.symbols;
    return [source, Object.freeze({ ...spec, symbols: Object.freeze([...symbols]), universeVersion: symbols === spec.symbols ? 'V1' : 'V2' })];
  })));
}

/** Forward-paper watch list: liquid names (V2) united with the research set. */
export function watchUniverseFromSnapshotV2(snapshot, { fallback = COMBINATION_UNIVERSE_V1 } = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(fallback).map(([source, spec]) => {
    const frozen = snapshot?.sources?.[source];
    const symbols = researchSymbolsV2(source, [...new Set([...(frozen?.watch ?? []), ...(frozen?.research ?? spec.symbols)])]);
    return [source, Object.freeze([...symbols])];
  })));
}
