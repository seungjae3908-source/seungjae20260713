import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { analyzeMarketShockReverseStudyV1 } from '../../market-prediction-lab/src/market-shock-reverse-study-v1.js';
import { collectUpbitSpotHistory } from '../../market-prediction-lab/src/upbit-spot-history.js';

export const MARKET_SHOCK_REVERSE_LANE_CONTRACT_V1 = 'market-shock-reverse-lane/v1';

const SHA40 = /^[a-f0-9]{40}$/u;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const FINAL_HOLDOUT_START = Date.UTC(2026, 0, 1);
const LOOKBACK_DAYS = 120;

const SAFETY = Object.freeze({
  researchOnly: true,
  finalHoldoutUsed: false,
  formulaCandidateGenerated: false,
  paperRegistrationAllowed: false,
  liveTrading: false,
  autoTrading: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('SHOCK_LANE_RESEARCH_SHA_INVALID');
  return sha;
}

function exactIso(value) {
  const raw = String(value ?? '');
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) throw new Error('SHOCK_LANE_TIMESTAMP_INVALID');
  return raw;
}

function safeError(error) {
  return String(error?.message ?? error ?? 'MARKET_DATA_UNAVAILABLE').trim().toUpperCase()
    .replace(/[^A-Z0-9_.:-]/gu, '_').slice(0, 180) || 'MARKET_DATA_UNAVAILABLE';
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function period(observedAt) {
  const observedHour = Math.floor(Date.parse(observedAt) / HOUR_MS) * HOUR_MS;
  const endTime = Math.min(observedHour, FINAL_HOLDOUT_START - HOUR_MS);
  return Object.freeze({ startTime: endTime - LOOKBACK_DAYS * DAY_MS, endTime });
}

async function countedFetch(fetchImpl, counter, url, options) {
  counter.attempted += 1;
  try {
    const response = await fetchImpl(url, options);
    if (response.status === 200) counter.http200 += 1;
    else counter.httpNon200 += 1;
    return response;
  } catch (error) {
    counter.networkFailed += 1;
    throw error;
  }
}

export async function loadPublicShockDatasetsV1({ observedAt, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const range = period(exactIso(observedAt));
  const upbitRequests = { attempted: 0, http200: 0, httpNon200: 0, networkFailed: 0 };
  const bitgetRequests = { attempted: 0, http200: 0, httpNon200: 0, networkFailed: 0 };
  const upbit = collectUpbitSpotHistory({
    symbol: 'BTC', timeframe: '60m', startTime: range.startTime, endTime: range.endTime,
    maxPages: 20, minIntervalMs: 120,
    fetchImpl: (...args) => countedFetch(fetchImpl, upbitRequests, ...args),
  });
  const client = new BitgetPublicClient({
    fetchImpl: (...args) => countedFetch(fetchImpl, bitgetRequests, ...args),
    timeoutMs: 12_000, maxRetries: 2, minIntervalMs: 125,
  });
  const bitget = collectBitgetCandles({
    client, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', timeframe: '1h',
    startTime: range.startTime, endTime: range.endTime, maxCandles: LOOKBACK_DAYS * 24,
  });
  const [upbitResult, bitgetResult] = await Promise.allSettled([upbit, bitget]);
  const datasets = [];
  const sources = [];
  if (upbitResult.status === 'fulfilled') {
    const value = upbitResult.value;
    datasets.push({ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', timeframe: '1h',
      datasetIdentity: `upbit-public-candles:KRW-BTC:1h:${value.firstTimestamp}:${value.lastTimestamp}:${value.candleCount}`,
      candles: value.candles });
    sources.push({ provider: 'UPBIT', status: 'READY', reason: null, candleCount: value.candleCount,
      firstTimestamp: value.firstTimestamp, lastTimestamp: value.lastTimestamp, requests: upbitRequests });
  } else sources.push({ provider: 'UPBIT', status: 'BLOCKED_DATA', reason: safeError(upbitResult.reason),
    candleCount: 0, firstTimestamp: null, lastTimestamp: null, requests: upbitRequests });
  if (bitgetResult.status === 'fulfilled') {
    const value = bitgetResult.value;
    const first = value.candles[0]?.timestamp ?? null;
    const last = value.candles.at(-1)?.timestamp ?? null;
    datasets.push({ market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', timeframe: '1h',
      datasetIdentity: `bitget-public-v2:BTCUSDT:1h:${first}:${last}:${value.candles.length}`,
      candles: value.candles });
    sources.push({ provider: 'BITGET', status: 'READY', reason: null, candleCount: value.candles.length,
      firstTimestamp: first, lastTimestamp: last, requests: bitgetRequests });
  } else sources.push({ provider: 'BITGET', status: 'BLOCKED_DATA', reason: safeError(bitgetResult.reason),
    candleCount: 0, firstTimestamp: null, lastTimestamp: null, requests: bitgetRequests });
  return Object.freeze({ range, datasets: Object.freeze(datasets), sources: Object.freeze(sources) });
}

function studySummary(study) {
  return Object.freeze({
    studyDigest: study.studyDigest,
    market: study.market,
    symbol: study.symbol,
    timeframe: study.timeframe,
    datasetIdentity: study.datasetIdentity,
    candleCount: study.dataset.candleCount,
    firstTimestamp: study.dataset.firstTimestamp,
    lastTimestamp: study.dataset.lastTimestamp,
    eventCounts: study.eventCounts,
    hypotheses: Object.freeze(study.studies.map((row) => Object.freeze({
      direction: row.direction,
      status: row.status,
      hypothesis: row.hypothesis,
    }))),
    unavailableFeatures: study.unavailableFeatures,
    formulaCandidateGenerated: false,
    executionAuthority: 'NONE',
  });
}

export async function runMarketShockReverseLaneV1({
  stateRoot: rawRoot,
  researchCodeSha: rawSha,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  loadDatasets = loadPublicShockDatasetsV1,
} = {}) {
  const stateRoot = resolve(String(rawRoot ?? ''));
  if (!rawRoot || typeof loadDatasets !== 'function') throw new Error('SHOCK_LANE_CONFIGURATION_INVALID');
  const researchCodeSha = exactSha(rawSha);
  const observedAt = exactIso(now());
  const requestedPeriod = period(observedAt);
  const latestPath = join(stateRoot, 'latest', 'market-shock-reverse-lane-v1.json');
  const prior = await readOptional(latestPath);
  if (prior?.researchCodeSha === researchCodeSha && prior?.requestedPeriod?.endTime === requestedPeriod.endTime
    && ['COMPLETE', 'PARTIAL_DATA', 'BLOCKED_DATA'].includes(prior?.status)) {
    const priorCore = { ...prior };
    delete priorCore.resultDigest;
    const resumedCore = { ...priorCore, observedAt, cacheHit: true, actualPublicRequestsThisRun: 0 };
    const resumed = Object.freeze({ ...resumedCore, resultDigest: digest(resumedCore) });
    await atomicJson(latestPath, resumed);
    await atomicJson(join(stateRoot, 'market-shock-research', 'runs', `${resumed.resultDigest}.json`), resumed);
    return resumed;
  }
  const loaded = await loadDatasets({ observedAt, fetchImpl });
  const studies = [];
  const failures = [];
  for (const dataset of loaded.datasets ?? []) {
    try {
      const study = analyzeMarketShockReverseStudyV1(dataset);
      studies.push(study);
      await atomicJson(join(stateRoot, 'market-shock-research', `${study.studyDigest}.json`), study);
    } catch (error) {
      failures.push(Object.freeze({ market: dataset.market, symbol: dataset.symbol, reason: safeError(error) }));
    }
  }
  const actualPublicRequests = (loaded.sources ?? []).reduce((sum, row) => sum + Number(row.requests?.attempted ?? 0), 0);
  const readySources = (loaded.sources ?? []).filter((row) => row.status === 'READY').length;
  const status = studies.length === 0 ? 'BLOCKED_DATA'
    : readySources === (loaded.sources ?? []).length && failures.length === 0 ? 'COMPLETE' : 'PARTIAL_DATA';
  const summaries = studies.map(studySummary);
  const eventCount = summaries.reduce((sum, row) => sum + row.eventCounts.trainSurge + row.eventCounts.trainDrop
    + row.eventCounts.oosSurge + row.eventCounts.oosDrop, 0);
  const hypothesisCount = summaries.reduce((sum, row) => sum + row.hypotheses.filter((item) => item.hypothesis != null).length, 0);
  const supportedHypothesisCount = summaries.reduce((sum, row) => sum
    + row.hypotheses.filter((item) => item.status === 'RESEARCH_HYPOTHESIS_ONLY').length, 0);
  const core = {
    schemaVersion: 1,
    contract: MARKET_SHOCK_REVERSE_LANE_CONTRACT_V1,
    status,
    observedAt,
    researchCodeSha,
    requestedPeriod: requestedPeriod,
    cacheHit: false,
    actualPublicRequests,
    actualPublicRequestsThisRun: actualPublicRequests,
    sourceResults: loaded.sources ?? [],
    studyCount: studies.length,
    eventCount,
    researchHypothesisCount: hypothesisCount,
    oosSupportedHypothesisCount: supportedHypothesisCount,
    formulaCandidateCount: 0,
    backtestCount: 0,
    studies: summaries,
    failures,
    nextAction: supportedHypothesisCount > 0 ? 'PREDECLARE_FORMULA_AND_RUN_SEPARATE_COST_AWARE_BACKTEST' : 'COLLECT_MORE_NON_HOLDOUT_DATA',
    safety: SAFETY,
  };
  const result = Object.freeze({ ...core, resultDigest: digest(core) });
  await atomicJson(latestPath, result);
  await atomicJson(join(stateRoot, 'market-shock-research', 'runs', `${result.resultDigest}.json`), result);
  return result;
}
