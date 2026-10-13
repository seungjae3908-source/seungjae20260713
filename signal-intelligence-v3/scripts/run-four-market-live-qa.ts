// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { createCryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import { resolveScannerCanonicalPaperIdentity } from '../../api-server/src/services/scanner-canonical-paper-identity.service';
import {
  getCandles as getYahooCandles,
  getQuote as getYahooQuote,
  resetYahooProviderRuntimeForDiagnostics,
  yahooProviderDiagnostics,
} from '../../api-server/src/providers/yahoo';
import { diagnoseCanonicalHandoffJoin } from '../src/canonical-handoff-diagnostics.mjs';
import { validateMemberAutoTradingPaperHandoff } from '../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import {
  qualifyStockProviders,
  selectQualifiedStockPriceProvider,
} from '../src/stock-provider-qualification.mjs';

const OUTPUT = path.resolve(process.argv[2] ?? 'four-market-live-qa.json');
const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const HANDOFF_PATH = path.resolve(process.env.MEMBER_AUTO_TRADING_HANDOFF_PATH?.trim()
  || '/opt/stock-app-data/paper-forward-v1/runtime-state/handoff/member-auto-trading-latest.json');
const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const EXACT_SHA = /^[0-9a-f]{40}$/u;

if (!EXACT_SHA.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const PROFILES = Object.freeze([
  Object.freeze({ strategy: 'SCALPING', strategyMode: 'scalping', timeframe: '15m' }),
  Object.freeze({ strategy: 'SWING', strategyMode: 'swing', timeframe: '60m' }),
  Object.freeze({ strategy: 'MID_LONG', strategyMode: 'position', timeframe: '1D' }),
]);

const REPRESENTATIVES = Object.freeze({
  KR_STOCK: Object.freeze({ market: 'KR_STOCK', scannerMarket: 'KR', symbol: '005930', providerSymbol: '005930.KS', name: 'Samsung Electronics', exchange: 'KOSPI', currency: 'KRW', assetType: 'STOCK' }),
  US_STOCK: Object.freeze({ market: 'US_STOCK', scannerMarket: 'US', symbol: 'AAPL', providerSymbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', currency: 'USD', assetType: 'STOCK' }),
  CRYPTO_SPOT: Object.freeze({ market: 'CRYPTO_SPOT', scannerMarket: 'spot', symbol: 'BTC' }),
  CRYPTO_FUTURES: Object.freeze({ market: 'CRYPTO_FUTURES', scannerMarket: 'futures', symbol: 'BTCUSDT' }),
});

const providerMetrics = {
  upbit: { requests: 0, http200: 0, failures: [] },
  bitget: { requests: 0, http200: 0, failures: [] },
};
const publicCache = new Map();
const publicInFlight = new Map();
const providerNextStartAt = { upbit: 0, bitget: 0 };
const providerTail = { upbit: Promise.resolve(), bitget: Promise.resolve() };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function schedule(provider, operation) {
  let release;
  const previous = providerTail[provider];
  providerTail[provider] = new Promise((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, providerNextStartAt[provider] - Date.now());
  if (delay) await sleep(delay);
  providerNextStartAt[provider] = Date.now() + (provider === 'upbit' ? 140 : 90);
  let started;
  try { started = operation(); } catch (error) { release(); throw error; }
  release();
  return await started;
}

function retryDelay(response, attempt) {
  const seconds = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(2_000, seconds * 1_000);
  return Math.min(1_000, 200 * (2 ** attempt));
}

async function fetchPublicJson(url, provider) {
  if (publicCache.has(url)) return publicCache.get(url);
  if (publicInFlight.has(url)) return publicInFlight.get(url);
  const request = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`${provider.toUpperCase()}_QA_TIMEOUT`)), 8_000);
      let response = null;
      try {
        response = await schedule(provider, () => {
          providerMetrics[provider].requests += 1;
          return fetch(url, {
            method: 'GET', signal: controller.signal,
            headers: { accept: 'application/json', 'user-agent': 'signal-intelligence-four-market-live-qa/1.0' },
          });
        });
        if (!response.ok) {
          const error = new Error(`${provider.toUpperCase()}_HTTP_${response.status}`);
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await sleep(retryDelay(response, attempt));
            continue;
          }
          throw error;
        }
        const body = await response.json();
        providerMetrics[provider].http200 += 1;
        publicCache.set(url, body);
        return body;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && response == null) {
          await sleep(retryDelay(null, attempt));
          continue;
        }
      } finally { clearTimeout(timeout); }
    }
    const code = String(lastError?.message ?? lastError ?? 'UNKNOWN').slice(0, 180);
    providerMetrics[provider].failures.push({ url: new URL(url).pathname, code });
    throw lastError ?? new Error(`${provider.toUpperCase()}_QA_FAILED`);
  })().finally(() => publicInFlight.delete(url));
  publicInFlight.set(url, request);
  return request;
}

async function probeYahoo() {
  resetYahooProviderRuntimeForDiagnostics();
  const observedAt = new Date().toISOString();
  try {
    const [quote, candles] = await Promise.all([getYahooQuote('AAPL'), getYahooCandles('AAPL', '1D')]);
    const payloadValidated = Number(quote?.price) > 0
      && Array.isArray(candles)
      && candles.length >= 30
      && candles.filter((row) => Number(row?.volume) > 0).length >= 30;
    return { httpStatus: payloadValidated ? 200 : 502, payloadValidated, observedAt,
      usageTermsConfirmed: process.env.SIGNAL_INTELLIGENCE_YAHOO_USAGE_CONFIRMED === 'true', error: null };
  } catch (error) {
    const message = String(error?.message ?? error);
    const status = Number(message.match(/YAHOO_CHART_HTTP_(\d{3})/u)?.[1] ?? 0) || null;
    return { httpStatus: status, payloadValidated: false, observedAt,
      usageTermsConfirmed: process.env.SIGNAL_INTELLIGENCE_YAHOO_USAGE_CONFIRMED === 'true', error: message.slice(0, 300) };
  }
}

async function probeNasdaqTrader() {
  const observedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('NASDAQ_TRADER_QA_TIMEOUT')), 8_000);
  try {
    const response = await fetch(NASDAQ_LISTED_URL, { signal: controller.signal, headers: { accept: 'text/plain', 'user-agent': 'signal-intelligence-four-market-live-qa/1.0' } });
    const text = await response.text();
    const payloadValidated = response.status === 200
      && text.startsWith('Symbol|Security Name|')
      && text.includes('\nAAPL|')
      && text.split('\n').length > 1_000;
    return { httpStatus: response.status, payloadValidated, observedAt, usageTermsConfirmed: true,
      scope: 'SYMBOL_DIRECTORY_ONLY_NOT_A_PRICE_FEED' };
  } catch (error) {
    return { httpStatus: null, payloadValidated: false, observedAt, usageTermsConfirmed: true,
      scope: 'SYMBOL_DIRECTORY_ONLY_NOT_A_PRICE_FEED', error: String(error?.message ?? error).slice(0, 300) };
  } finally { clearTimeout(timeout); }
}

function stockBlocker(comparison) {
  const yahoo = comparison.find((row) => row.provider === 'YAHOO_CHART');
  const official = comparison.filter((row) => ['TOSS_INVEST', 'KIWOOM', 'FINNHUB'].includes(row.provider));
  if (yahoo?.observedHttpStatus === 429) return 'YAHOO_HTTP_429_SHARED_EGRESS_PROVIDER_LIMIT';
  if (!yahoo?.usageTermsConfirmed) return 'YAHOO_USAGE_TERMS_NOT_CONFIRMED';
  if (official.every((row) => !row.actualQueryVerified)) return 'OFFICIAL_STOCK_PROVIDER_NOT_ACTUALLY_VERIFIED';
  return 'QUALIFIED_STOCK_PRICE_PROVIDER_UNAVAILABLE';
}

async function runStockLane(asset, profile, selectedProvider) {
  if (!selectedProvider || selectedProvider.provider !== 'YAHOO_CHART') {
    return { market: asset.market, strategy: profile.strategy, timeframe: profile.timeframe,
      querySuccessCount: 0, status: 'BLOCKED_PROVIDER', blockReason: 'QUALIFIED_STOCK_PRICE_PROVIDER_UNAVAILABLE',
      cards: [], providerErrors: 1, timeouts: 0, actualData: false };
  }
  const originalGet = ScannerUniverseService.get;
  const originalCandles = MarketDataService.getCandles;
  const originalQuote = MarketDataService.getQuote;
  const observed = { candles: 0, candleVolumeRows: 0, quote: 0 };
  const universe = { entries: [{ ticker: asset.symbol, name: asset.name, market: asset.scannerMarket,
    currency: asset.currency, assetType: asset.assetType, exchange: asset.exchange, listingStatus: 'LISTED', source: 'live-qa-explicit-symbol' }],
    totalCount: 1, source: 'live-qa-explicit-symbol', partial: false, stale: false, providerErrorCount: 0, loadedAt: new Date().toISOString() };
  try {
    ScannerUniverseService.get = async (market) => market === asset.scannerMarket ? universe : originalGet.call(ScannerUniverseService, market);
    MarketDataService.getCandles = async () => {
      const rows = await getYahooCandles(asset.providerSymbol, profile.timeframe);
      observed.candles = rows.length;
      observed.candleVolumeRows = rows.filter((row) => Number(row?.volume) > 0).length;
      return rows;
    };
    MarketDataService.getQuote = async () => {
      const quote = await getYahooQuote(asset.providerSymbol);
      if (Number(quote?.price) > 0) observed.quote = 1;
      return { ...quote, ticker: asset.symbol, symbol: asset.symbol, name: asset.name };
    };
    const raw = await StockSignalScannerService.scan({ memberId: 'four-market-live-qa', market: asset.scannerMarket,
      indicators: [], filters: { timeframe: profile.timeframe }, cursor: 0, batchSize: 10, strategyMode: profile.strategyMode });
    const response = withScannerCanonicalActions(raw);
    return { market: asset.market, strategy: profile.strategy, timeframe: profile.timeframe,
      querySuccessCount: observed.candles >= 30 && observed.candleVolumeRows >= 30 && observed.quote > 0 ? 1 : 0,
      status: response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE', blockReason: null,
      cards: response.cards, providerErrors: response.execution.providerErrorCount, timeouts: response.execution.timeoutCount,
      actualData: observed.candles >= 30 && observed.candleVolumeRows >= 30 && observed.quote > 0, observed };
  } catch (error) {
    return { market: asset.market, strategy: profile.strategy, timeframe: profile.timeframe,
      querySuccessCount: 0, status: 'BLOCKED_PROVIDER', blockReason: String(error?.message ?? error).split(':')[0],
      cards: [], providerErrors: 1, timeouts: 0, actualData: false };
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
  const rows = await fetchPublicJson(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(`KRW-${symbol}`)}`, 'upbit');
  const row = rows?.[0];
  if (!row || !(Number(row.trade_price) > 0)) throw new Error(`UPBIT_TICKER_INVALID:${symbol}`);
  const value = { symbol, name: symbol, price: Number(row.trade_price), changePercent: Number(row.signed_change_rate ?? 0) * 100,
    volume: Number(row.acc_trade_volume_24h ?? 0), tradingValue: Number(row.acc_trade_price_24h ?? 0), bid: null, ask: null,
    fundingRate: null, openInterest: null, timestamp: Number(row.timestamp ?? Date.now()), warning: false };
  cryptoMeta.set(key, value); return value;
}

async function bitgetTicker(symbol) {
  let rows = cryptoMeta.get('futures:ALL');
  if (!rows) {
    const body = await fetchPublicJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', 'bitget');
    if (String(body?.code) !== '00000' || !Array.isArray(body?.data)) throw new Error('BITGET_TICKERS_INVALID');
    rows = body.data; cryptoMeta.set('futures:ALL', rows);
  }
  const row = rows.find((item) => String(item.symbol).toUpperCase() === symbol);
  if (!row) throw new Error(`BITGET_TICKER_MISSING:${symbol}`);
  const price = Number(row.markPrice ?? row.lastPr);
  return { symbol, name: symbol, price, changePercent: Number(row.change24h ?? 0) * 100,
    volume: Number(row.baseVolume ?? 0), tradingValue: Number(row.usdtVolume ?? 0), bid: Number(row.bidPr) || null,
    ask: Number(row.askPr) || null, fundingRate: Number(row.fundingRate) || 0, openInterest: Number(row.holdingAmount) || 0,
    timestamp: Number(row.ts ?? Date.now()), warning: false };
}

function cryptoCandleUrl(market, symbol, timeframe) {
  if (market === 'spot') {
    const code = encodeURIComponent(`KRW-${symbol}`);
    if (timeframe === '1D') return [`https://api.upbit.com/v1/candles/days?market=${code}&count=200`, 'upbit'];
    const unit = timeframe === '60m' ? 60 : 15;
    return [`https://api.upbit.com/v1/candles/minutes/${unit}?market=${code}&count=200`, 'upbit'];
  }
  const granularity = timeframe === '60m' ? '1H' : timeframe;
  return [`https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${encodeURIComponent(granularity)}&limit=200`, 'bitget'];
}

function normalizeUpbit(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ time: Number(row.timestamp ?? Date.parse(`${row.candle_date_time_utc}Z`)),
    open: Number(row.opening_price), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.trade_price),
    volume: Number(row.candle_acc_trade_volume), quoteVolume: Number(row.candle_acc_trade_price) || null }))
    .filter((row) => row.time > 0 && row.close > 0).sort((left, right) => left.time - right.time);
}

function normalizeBitget(body) {
  if (String(body?.code) !== '00000' || !Array.isArray(body?.data)) return [];
  return body.data.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[6]) || null }))
    .filter((row) => row.time > 0 && row.close > 0).sort((left, right) => left.time - right.time);
}

async function runCryptoLane(asset, profile) {
  const observed = { candles: 0, candleVolumeRows: 0, ticker: 0, tickerVolume: 0, spread: 0 };
  try {
    const ticker = asset.scannerMarket === 'spot' ? await upbitTicker(asset.symbol) : await bitgetTicker(asset.symbol);
    observed.ticker = Number(ticker.price) > 0 ? 1 : 0;
    observed.tickerVolume = Number(ticker.volume) > 0 ? 1 : 0;
    const scanner = createCryptoSignalScannerService({
      async getUniverse() { return { rows: [ticker], source: asset.scannerMarket === 'spot' ? 'upbit-public' : 'bitget-public', providerErrorCount: 0 }; },
      async getCandles(market, symbol, timeframe) {
        const [url, provider] = cryptoCandleUrl(market, symbol, timeframe);
        const body = await fetchPublicJson(url, provider);
        const rows = market === 'spot' ? normalizeUpbit(body) : normalizeBitget(body);
        observed.candles = Math.max(observed.candles, rows.length);
        observed.candleVolumeRows = Math.max(
          observed.candleVolumeRows,
          rows.filter((row) => Number(row?.volume) > 0).length,
        );
        return rows;
      },
      async getSpread(market, current) {
        if (market === 'futures') {
          if (current.bid && current.ask) observed.spread = 1;
          return { bid: current.bid, ask: current.ask };
        }
        const rows = await fetchPublicJson(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(`KRW-${current.symbol}`)}&level=0`, 'upbit');
        const unit = rows?.[0]?.orderbook_units?.[0];
        const spread = { bid: Number(unit?.bid_price) || null, ask: Number(unit?.ask_price) || null };
        if (spread.bid && spread.ask) observed.spread = 1;
        return spread;
      },
      now: Date.now,
    });
    const raw = await scanner.scan({ memberId: 'four-market-live-qa', market: asset.scannerMarket, strategyMode: profile.strategyMode,
      timeframe: profile.timeframe, condition: 'trend', cursor: 0, batchSize: 5 });
    const aligned = await CryptoPricePrecisionService.align(asset.scannerMarket, raw);
    const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: profile.strategyMode, limit: 10 });
    const cards = ranking.cards
      .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
      .filter((card) => asset.scannerMarket === 'spot' ? card.direction === 'LONG' : ['LONG', 'SHORT'].includes(card.direction));
    const response = withScannerCanonicalActions({ ...aligned, cards, execution: { ...aligned.execution,
      finalDisplayedCount: cards.length, sGradeCount: cards.filter((card) => card.signalGrade === 'S').length } });
    const actualData = observed.ticker > 0
      && observed.tickerVolume > 0
      && observed.candles >= 30
      && observed.candleVolumeRows >= 30
      && observed.spread > 0;
    return { market: asset.market, strategy: profile.strategy, timeframe: profile.timeframe,
      querySuccessCount: actualData ? 1 : 0, status: response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE',
      blockReason: actualData ? null : 'CRYPTO_PUBLIC_DATA_INCOMPLETE', cards: response.cards,
      providerErrors: response.execution.providerErrorCount, timeouts: response.execution.timeoutCount, actualData, observed };
  } catch (error) {
    return { market: asset.market, strategy: profile.strategy, timeframe: profile.timeframe,
      querySuccessCount: 0, status: 'BLOCKED_PROVIDER', blockReason: String(error?.message ?? error).split(':')[0],
      cards: [], providerErrors: 1, timeouts: 0, actualData: false, observed };
  }
}

async function readHandoff() {
  try {
    const parsed = JSON.parse(await readFile(HANDOFF_PATH, 'utf8'));
    return { value: validateMemberAutoTradingPaperHandoff(parsed, Date.now()), error: null };
  }
  catch (error) { return { value: null, error: error?.code === 'ENOENT' ? 'HANDOFF_FILE_MISSING' : 'HANDOFF_FILE_UNREADABLE' }; }
}

function riskEvidenceBySignal(handoff) {
  return Object.fromEntries((handoff?.entries ?? [])
    .map((entry) => [entry?.identity?.signalId, entry?.riskEvidence])
    .filter(([signalId]) => typeof signalId === 'string' && signalId.length > 0));
}

function canonicalFor(rows) {
  const bySignal = {};
  for (const row of rows) {
    for (const card of row.cards.filter((candidate) => candidate.signalGrade === 'S' && candidate.strongSignalEligible === true)) {
      bySignal[card.signalId] = resolveScannerCanonicalPaperIdentity({ card, market: row.market, researchCodeSha: SERVICE_SHA });
    }
  }
  return bySignal;
}

function handoffExpectedSha(handoff) {
  const values = [...new Set((handoff?.entries ?? []).map((entry) => String(entry?.identity?.researchCodeSha ?? '').toLowerCase()).filter((value) => EXACT_SHA.test(value)))];
  return values.length === 1 ? values[0] : null;
}

async function main() {
  const [yahooObservation, nasdaqObservation, handoffRead] = await Promise.all([
    probeYahoo(), probeNasdaqTrader(), readHandoff(),
  ]);
  const handoff = handoffRead.value;
  const observations = { YAHOO_CHART: yahooObservation, NASDAQ_TRADER: nasdaqObservation };
  const stockProviderComparison = qualifyStockProviders(observations);
  const selectedKr = selectQualifiedStockPriceProvider({ market: 'KR_STOCK', observations });
  const selectedUs = selectQualifiedStockPriceProvider({ market: 'US_STOCK', observations });
  const rows = [];
  for (const profile of PROFILES) rows.push(await runStockLane(REPRESENTATIVES.KR_STOCK, profile, selectedKr));
  for (const profile of PROFILES) rows.push(await runStockLane(REPRESENTATIVES.US_STOCK, profile, selectedUs));
  for (const profile of PROFILES) rows.push(await runCryptoLane(REPRESENTATIVES.CRYPTO_SPOT, profile));
  for (const profile of PROFILES) rows.push(await runCryptoLane(REPRESENTATIVES.CRYPTO_FUTURES, profile));
  const canonicalBySignalId = canonicalFor(rows);
  const riskBySignalId = riskEvidenceBySignal(handoff);
  const expectedServiceSha = handoffExpectedSha(handoff);
  const join = diagnoseCanonicalHandoffJoin({ lanes: rows, canonicalBySignalId, riskBySignalId, handoff,
    serviceSha: SERVICE_SHA, expectedServiceSha, workerResult: null });
  const fallbackStockReason = stockBlocker(stockProviderComparison);
  for (const row of rows) {
    if ((row.market === 'KR_STOCK' || row.market === 'US_STOCK') && row.blockReason === 'QUALIFIED_STOCK_PRICE_PROVIDER_UNAVAILABLE') {
      row.blockReason = fallbackStockReason;
    }
    const laneJoin = diagnoseCanonicalHandoffJoin({ lanes: [row], canonicalBySignalId, riskBySignalId, handoff,
      serviceSha: SERVICE_SHA, expectedServiceSha, workerResult: null });
    row.sGradeCandidates = laneJoin.sGradeCandidateCount;
    row.canonicalIdentityReady = laneJoin.canonicalIdentityCount;
    row.riskApproved = laneJoin.riskApprovedCount;
    row.canonicalHandoffJoin = laneJoin.canonicalHandoffJoin;
    row.workerDelivery = laneJoin.worker.status;
    delete row.cards;
  }
  const report = {
    schemaVersion: 'four-market-live-qa-v1', generatedAt: new Date().toISOString(), serviceSha: SERVICE_SHA,
    publicDataOnly: true, actualOrders: 0, privateRequests: 0, executionAuthority: 'NONE',
    providerObservations: { yahoo: yahooObservation, yahooGovernor: yahooProviderDiagnostics(), nasdaqTrader: nasdaqObservation,
      upbit: providerMetrics.upbit, bitget: providerMetrics.bitget },
    stockProviderComparison,
    selectedStockProviders: { KR_STOCK: selectedKr?.provider ?? null, US_STOCK: selectedUs?.provider ?? null },
    handoff: { pathConfigured: Boolean(process.env.MEMBER_AUTO_TRADING_HANDOFF_PATH?.trim()), readError: handoffRead?.error ?? null,
      status: handoff?.status ?? 'MISSING', entryCount: handoff?.entryCount ?? 0 },
    summary: { laneCount: rows.length, querySuccessCount: rows.reduce((sum, row) => sum + row.querySuccessCount, 0),
      blockedLaneCount: rows.filter((row) => row.status === 'BLOCKED_PROVIDER').length,
      sGradeCandidates: rows.reduce((sum, row) => sum + row.sGradeCandidates, 0),
      canonicalHandoffJoin: join.canonicalHandoffJoin, workerDelivery: join.worker.status },
    canonicalDiagnostics: join,
    lanes: rows,
  };
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: rows.length === 12 && report.actualOrders === 0, output: OUTPUT, ...report.summary }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

