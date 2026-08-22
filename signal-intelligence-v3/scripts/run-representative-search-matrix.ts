// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { createCryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const OUTPUT_JSON = path.resolve(process.argv[2] ?? 'representative-search-matrix.json');
const OUTPUT_MD = path.resolve(process.argv[3] ?? 'representative-search-matrix.md');
const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const NOW = Date.now();

const PROFILES = Object.freeze([
  Object.freeze({ id: 'SCALPING', strategyMode: 'scalping', timeframe: '15m' }),
  Object.freeze({ id: 'SWING', strategyMode: 'swing', timeframe: '60m' }),
  Object.freeze({ id: 'MID_LONG', strategyMode: 'position', timeframe: '1D' }),
]);

const STOCKS = Object.freeze([
  Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '005930', name: 'Samsung Electronics', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '000660', name: 'SK Hynix', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '035420', name: 'NAVER', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '005380', name: 'Hyundai Motor', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '068270', name: 'Celltrion', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'AMZN', name: 'Amazon', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'GOOGL', name: 'Alphabet A', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'SPY', name: 'SPDR S&P 500 ETF', exchange: 'NYSE_ARCA', currency: 'USD', assetType: 'ETF' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'QQQ', name: 'Invesco QQQ', exchange: 'NASDAQ', currency: 'USD', assetType: 'ETF' }),
  Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'BRK.B', name: 'Berkshire Hathaway B', exchange: 'NYSE', currency: 'USD', assetType: 'STOCK' }),
]);

const CRYPTO = Object.freeze([
  ...['BTC', 'ETH', 'XRP', 'SOL', 'DOGE'].map((symbol) => Object.freeze({ market: 'CRYPTO_SPOT', scannerMarket: 'spot', symbol })),
  ...['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'].map((symbol) => Object.freeze({ market: 'CRYPTO_FUTURES', scannerMarket: 'futures', symbol })),
]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function scheduler(minIntervalMs) {
  let tail = Promise.resolve();
  let nextAt = 0;
  return async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const delay = Math.max(0, nextAt - Date.now());
    if (delay) await sleep(delay);
    nextAt = Date.now() + minIntervalMs;
    release();
    return operation();
  };
}

const yahooStart = scheduler(160);
const upbitStart = scheduler(140);
const bitgetStart = scheduler(90);

async function retry(operation, attempts = 4, baseMs = 180) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(baseMs * attempt);
    }
  }
  throw lastError;
}

async function fetchJson(url, hostKind) {
  const schedule = hostKind === 'upbit' ? upbitStart : bitgetStart;
  return retry(async (attempt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('REPRESENTATIVE_PROVIDER_TIMEOUT')), 9_000);
    try {
      const response = await schedule(() => fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'signal-intelligence-v3-representative/1.0' },
      }));
      if (!response.ok) {
        const error = Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
        if (response.status === 429 && attempt < 4) {
          const after = Number(response.headers.get('retry-after'));
          if (Number.isFinite(after) && after > 0) await sleep(after * 1000);
        }
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  });
}

function stockProviderCandidates(asset) {
  if (asset.market === 'KR_STOCK') {
    const primary = `${asset.symbol}.${/KOSDAQ/u.test(asset.exchange) ? 'KQ' : 'KS'}`;
    return [primary, primary.endsWith('.KQ') ? `${asset.symbol}.KS` : `${asset.symbol}.KQ`];
  }
  const rows = [asset.symbol];
  if (asset.symbol.includes('.')) rows.push(asset.symbol.replace(/\./gu, '-'));
  if (asset.symbol.includes('-')) rows.push(asset.symbol.replace(/-/gu, '.'));
  return [...new Set(rows)];
}

async function yahooFallback(asset, operation) {
  let lastError;
  for (const providerSymbol of stockProviderCandidates(asset)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return { value: await yahooStart(() => operation(providerSymbol)), providerSymbol }; }
      catch (error) { lastError = error; if (attempt < 3) await sleep(180 * attempt); }
    }
  }
  throw lastError ?? new Error('YAHOO_REPRESENTATIVE_FAILED');
}

function candleStats(rows, providerSymbol) {
  if (!Array.isArray(rows) || !rows.length) return { count: 0, first: null, last: null, providerSymbol };
  const time = (row) => typeof row.time === 'number' ? (row.time > 1e11 ? row.time : row.time * 1000) : Date.parse(String(row.time));
  return { count: rows.length, first: new Date(time(rows[0])).toISOString(), last: new Date(time(rows.at(-1))).toISOString(), providerSymbol };
}

function searchStatus(response, snapshot, market) {
  if (!response) return 'SEARCH_FAILURE';
  if (response.outcome === 'PROVIDER_FAILURE' || response.outcome === 'REQUEST_TIMEOUT') return 'SEARCH_FAILURE';
  if (response.universe?.partial || response.universe?.stale || Number(response.universe?.providerErrorCount ?? 0) > 0) return 'SEARCH_FAILURE';
  if (Number(response.execution?.providerErrorCount ?? 0) > 0 || Number(response.execution?.timeoutCount ?? 0) > 0) return 'SEARCH_FAILURE';
  if (['stale', 'unavailable', 'untrusted'].includes(String(response.dataState ?? '').toLowerCase())) return 'SEARCH_FAILURE';
  const listCount = market === 'KR_STOCK' ? snapshot.lists.krBuy.length
    : market === 'US_STOCK' ? snapshot.lists.usBuy.length
      : market === 'CRYPTO_SPOT' ? snapshot.lists.spotBuy.length
        : snapshot.lists.futuresLong.length + snapshot.lists.futuresShort.length;
  return listCount > 0 ? 'CANDIDATE' : 'VALID_NO_TRADE';
}

async function runStock(asset, profile) {
  const originalGet = ScannerUniverseService.get;
  const originalCandles = MarketDataService.getCandles;
  const originalQuote = MarketDataService.getQuote;
  const observed = {};
  const entry = {
    ticker: asset.symbol, name: asset.name, market: asset.scannerMarket, currency: asset.currency,
    assetType: asset.assetType, exchange: asset.exchange, listingStatus: 'LISTED', source: 'representative-explicit-public-test',
  };
  const universe = {
    entries: [entry], totalCount: 1, source: 'representative-explicit-public-test', partial: false,
    stale: false, providerErrorCount: 0, loadedAt: new Date().toISOString(),
  };
  try {
    ScannerUniverseService.get = async (market) => market === asset.scannerMarket ? universe : originalGet.call(ScannerUniverseService, market);
    MarketDataService.getCandles = async (_ticker, timeframe = '1D') => {
      const resolved = await yahooFallback(asset, (providerSymbol) => yahoo.getCandles(providerSymbol, timeframe));
      observed[String(timeframe)] = candleStats(resolved.value, resolved.providerSymbol);
      return resolved.value;
    };
    MarketDataService.getQuote = async () => {
      const resolved = await yahooFallback(asset, (providerSymbol) => yahoo.getQuote(providerSymbol));
      return { ...resolved.value, ticker: asset.symbol, symbol: asset.symbol, name: asset.name };
    };
    const response = await StockSignalScannerService.scan({
      memberId: 'signal-intelligence-v3-representative', market: asset.scannerMarket, indicators: [],
      filters: { timeframe: profile.timeframe }, cursor: 0, batchSize: 10, strategyMode: profile.strategyMode,
    });
    const adapted = adaptCanonicalScannerCards(response.cards.map((card) => ({ card, timeframe: profile.timeframe })), { nowMs: Date.now() });
    const snapshot = runSignalIntelligenceV3(adapted);
    return {
      market: asset.market, symbol: asset.symbol, profile: profile.id, timeframe: profile.timeframe,
      status: searchStatus(response, snapshot, asset.market), providerErrors: response.execution.providerErrorCount,
      timeouts: response.execution.timeoutCount, responseDataState: response.dataState, cardCount: response.cards.length,
      cards: response.cards.map((card) => ({ action: card.action ?? null, direction: card.direction ?? null, grade: card.signalGrade ?? null, score: card.score, strongSignalEligible: card.strongSignalEligible === true, dataState: card.dataState, riskLevel: card.riskLevel ?? null })),
      v3Rows: snapshot.rows.map((row) => ({ direction: row.direction, state: row.state, reasons: row.reasons, utilityR: row.utilityR })),
      listCounts: { buy: asset.market === 'KR_STOCK' ? snapshot.lists.krBuy.length : snapshot.lists.usBuy.length },
      observedCandles: observed,
    };
  } finally {
    ScannerUniverseService.get = originalGet;
    MarketDataService.getCandles = originalCandles;
    MarketDataService.getQuote = originalQuote;
  }
}

const cryptoMeta = new Map();
async function upbitTicker(symbol) {
  const key = `spot:${symbol}`;
  if (cryptoMeta.has(key)) return cryptoMeta.get(key);
  const rows = await fetchJson(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(`KRW-${symbol}`)}`, 'upbit');
  const row = rows?.[0];
  if (!row || !(Number(row.trade_price) > 0)) throw new Error(`UPBIT_TICKER_UNAVAILABLE:${symbol}`);
  const value = { symbol, name: symbol, price: Number(row.trade_price), changePercent: Number(row.signed_change_rate ?? 0) * 100, volume: Number(row.acc_trade_volume_24h ?? 0), tradingValue: Number(row.acc_trade_price_24h ?? 0), bid: null, ask: null, fundingRate: null, openInterest: null, timestamp: Number(row.timestamp ?? Date.now()), warning: false };
  cryptoMeta.set(key, value); return value;
}
async function bitgetTicker(symbol) {
  const key = `futures:${symbol}`;
  if (cryptoMeta.has(key)) return cryptoMeta.get(key);
  let all = cryptoMeta.get('futures:ALL');
  if (!all) {
    const payload = await fetchJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', 'bitget');
    if (String(payload?.code) !== '00000' || !Array.isArray(payload?.data)) throw new Error('BITGET_TICKERS_UNAVAILABLE');
    all = payload.data; cryptoMeta.set('futures:ALL', all);
  }
  const row = all.find((item) => String(item.symbol).toUpperCase() === symbol);
  if (!row) throw new Error(`BITGET_TICKER_UNAVAILABLE:${symbol}`);
  const price = Number(row.markPrice ?? row.lastPr);
  const value = { symbol, name: symbol, price, changePercent: Number(row.change24h ?? 0) * 100, volume: Number(row.baseVolume ?? 0), tradingValue: Number(row.usdtVolume ?? 0), bid: Number(row.bidPr) || null, ask: Number(row.askPr) || null, fundingRate: Number(row.fundingRate) || 0, openInterest: Number(row.holdingAmount) || 0, timestamp: Number(row.ts ?? Date.now()), warning: false };
  cryptoMeta.set(key, value); return value;
}

function cryptoCandleUrl(market, symbol, timeframe) {
  if (market === 'spot') {
    const code = encodeURIComponent(`KRW-${symbol}`);
    if (timeframe === '1D') return [`https://api.upbit.com/v1/candles/days?market=${code}&count=200`, 'upbit'];
    const unit = timeframe === '60m' ? 60 : timeframe === '15m' ? 15 : 1;
    return [`https://api.upbit.com/v1/candles/minutes/${unit}?market=${code}&count=200`, 'upbit'];
  }
  const granularity = timeframe === '60m' ? '1H' : timeframe;
  return [`https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${encodeURIComponent(granularity)}&limit=200`, 'bitget'];
}

function normalizeUpbitCandles(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ time: Number(row.timestamp ?? Date.parse(`${row.candle_date_time_utc}Z`)), open: Number(row.opening_price), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.trade_price), volume: Number(row.candle_acc_trade_volume), quoteVolume: Number(row.candle_acc_trade_price) || null })).filter((row) => row.time > 0 && row.close > 0).sort((a, b) => a.time - b.time);
}
function normalizeBitgetCandles(payload) {
  if (String(payload?.code) !== '00000' || !Array.isArray(payload?.data)) return [];
  return payload.data.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[6]) || null })).filter((row) => row.time > 0 && row.close > 0).sort((a, b) => a.time - b.time);
}

async function runCrypto(asset, profile) {
  const observed = {};
  const ticker = asset.scannerMarket === 'spot' ? await upbitTicker(asset.symbol) : await bitgetTicker(asset.symbol);
  const providers = {
    async getUniverse() { return { rows: [ticker], source: asset.scannerMarket === 'spot' ? 'upbit-public' : 'bitget-public', providerErrorCount: 0 }; },
    async getCandles(market, symbol, timeframe) {
      const [url, hostKind] = cryptoCandleUrl(market, symbol, timeframe);
      const payload = await fetchJson(url, hostKind);
      const rows = market === 'spot' ? normalizeUpbitCandles(payload) : normalizeBitgetCandles(payload);
      observed[String(timeframe)] = { count: rows.length, first: rows.length ? new Date(rows[0].time).toISOString() : null, last: rows.length ? new Date(rows.at(-1).time).toISOString() : null, providerSymbol: market === 'spot' ? `KRW-${symbol}` : symbol };
      return rows;
    },
    async getSpread(market, current) {
      if (market === 'futures') return { bid: current.bid, ask: current.ask };
      const rows = await fetchJson(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(`KRW-${current.symbol}`)}&level=0`, 'upbit');
      const unit = rows?.[0]?.orderbook_units?.[0];
      return { bid: Number(unit?.bid_price) || null, ask: Number(unit?.ask_price) || null };
    },
    now: Date.now,
  };
  const scanner = createCryptoSignalScannerService(providers);
  const raw = await scanner.scan({ memberId: 'signal-intelligence-v3-representative', market: asset.scannerMarket, strategyMode: profile.strategyMode, timeframe: profile.timeframe, condition: 'trend', cursor: 0, batchSize: 5 });
  const aligned = await CryptoPricePrecisionService.align(asset.scannerMarket, raw);
  const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: profile.strategyMode, limit: 10 });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => asset.scannerMarket === 'spot' ? card.direction === 'LONG' : card.direction === 'LONG' || card.direction === 'SHORT');
  const response = withScannerCanonicalActions({ ...aligned, cards, execution: { ...aligned.execution, finalDisplayedCount: cards.length } });
  const adapted = adaptCanonicalScannerCards(response.cards.map((card) => ({ card, timeframe: profile.timeframe })), { nowMs: Date.now() });
  const snapshot = runSignalIntelligenceV3(adapted);
  if (asset.market === 'CRYPTO_SPOT' && snapshot.rows.some((row) => row.direction !== 'BUY')) throw new Error(`SPOT_NON_BUY_DIRECTION:${asset.symbol}:${profile.id}`);
  return {
    market: asset.market, symbol: asset.symbol, profile: profile.id, timeframe: profile.timeframe,
    status: searchStatus(response, snapshot, asset.market), providerErrors: response.execution.providerErrorCount,
    timeouts: response.execution.timeoutCount, responseDataState: response.dataState, cardCount: response.cards.length,
    cards: response.cards.map((card) => ({ action: card.action ?? null, direction: card.direction ?? null, grade: card.signalGrade ?? null, score: card.score, strongSignalEligible: card.strongSignalEligible === true, dataState: card.dataState, riskLevel: card.riskLevel ?? null })),
    v3Rows: snapshot.rows.map((row) => ({ direction: row.direction, state: row.state, reasons: row.reasons, utilityR: row.utilityR, leverageStatus: row.leverage?.status ?? null })),
    listCounts: { long: snapshot.lists.futuresLong.length, short: snapshot.lists.futuresShort.length, buy: snapshot.lists.spotBuy.length },
    observedCandles: observed,
  };
}

async function save(file, text) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text, 'utf8'); }
function md(report) {
  const rows = report.rows.map((row) => `| ${row.market} | ${row.symbol} | ${row.profile} | ${row.timeframe} | ${row.status} | ${row.providerErrors ?? '-'} | ${row.timeouts ?? '-'} | ${row.cardCount ?? 0} |`);
  return `# Signal Intelligence V3 Representative Search Matrix\n\n- service SHA: ${report.serviceSha}\n- public data only: true\n- actual orders/private requests: 0\n- profiles: SCALPING=15m, SWING=60m, MID_LONG=1D\n- CANDIDATE is not a profitability guarantee; VALID_NO_TRADE is a valid search result.\n\n| Market | Symbol | Profile | TF | Result | Provider errors | Timeouts | Cards |\n|---|---|---|---|---|---:|---:|---:|\n${rows.join('\n')}\n`;
}

const rows = [];
for (const asset of STOCKS) {
  for (const profile of PROFILES) {
    try { rows.push(await runStock(asset, profile)); }
    catch (error) { rows.push({ market: asset.market, symbol: asset.symbol, profile: profile.id, timeframe: profile.timeframe, status: 'TECHNICAL_FAILURE', error: String(error?.message ?? error).slice(0, 700) }); }
  }
}
for (const asset of CRYPTO) {
  for (const profile of PROFILES) {
    try { rows.push(await runCrypto(asset, profile)); }
    catch (error) { rows.push({ market: asset.market, symbol: asset.symbol, profile: profile.id, timeframe: profile.timeframe, status: 'TECHNICAL_FAILURE', error: String(error?.message ?? error).slice(0, 700) }); }
  }
}
const summary = Object.fromEntries(['CANDIDATE', 'VALID_NO_TRADE', 'SEARCH_FAILURE', 'TECHNICAL_FAILURE'].map((status) => [status, rows.filter((row) => row.status === status).length]));
const report = { schemaVersion: 1, serviceSha: SERVICE_SHA || null, generatedAt: new Date().toISOString(), publicDataOnly: true, executionAuthority: 'NONE', profiles: PROFILES, representativeCount: STOCKS.length + CRYPTO.length, rowCount: rows.length, summary, rows };
await save(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await save(OUTPUT_MD, md(report));
console.log(JSON.stringify({ ok: summary.TECHNICAL_FAILURE === 0, ...summary, rowCount: rows.length, output: OUTPUT_JSON }, null, 2));
if (summary.TECHNICAL_FAILURE > 0) process.exitCode = 1;
