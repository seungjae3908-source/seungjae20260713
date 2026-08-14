import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { analyzeMarket } from '../src/engine.js';
import { predictTinyModel } from '../src/tiny-model.js';
import { BitgetPublicClient } from '../src/bitget-public-client.js';
import { collectBitgetCandles } from '../src/bitget-candle-collector.js';
import { collectFundingRateHistory, createTemporalDerivativesProvider } from '../src/derivatives-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLASS_NAMES = Object.freeze(['bullish', 'neutral', 'bearish']);
const CONFIGS = Object.freeze([
  Object.freeze({ group: 'crypto-futures-15m', timeframe: '15m', horizon: 8, lookback: 200, days: 7, step: 8 }),
  Object.freeze({ group: 'crypto-futures-1h', timeframe: '1h', horizon: 12, lookback: 200, days: 15, step: 12 }),
]);
const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);

function predictedClass(probabilities) {
  return CLASS_NAMES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASS_NAMES[0]);
}

function actualDirection(actualReturn, atrPct) {
  const threshold = Math.max(Math.abs(atrPct) * 0.35, 0.002);
  if (actualReturn > threshold) return 'bullish';
  if (actualReturn < -threshold) return 'bearish';
  return 'neutral';
}

function distribution(rows, selector) {
  return Object.fromEntries(CLASS_NAMES.map((name) => [name, rows.filter((row) => selector(row) === name).length]));
}

function brier(probabilities, actual) {
  return CLASS_NAMES.reduce((sum, name) => sum + (probabilities[name] - (name === actual ? 1 : 0)) ** 2, 0);
}

function metrics(rows, probabilitySelector) {
  if (!rows.length) return null;
  const confusion = Object.fromEntries(CLASS_NAMES.map((actual) => [actual, Object.fromEntries(CLASS_NAMES.map((predicted) => [predicted, 0]))]));
  let hits = 0;
  let logLoss = 0;
  let brierScore = 0;
  for (const row of rows) {
    const probabilities = probabilitySelector(row);
    const predicted = predictedClass(probabilities);
    confusion[row.actualDirection][predicted] += 1;
    if (predicted === row.actualDirection) hits += 1;
    logLoss += -Math.log(Math.max(probabilities[row.actualDirection], 1e-12));
    brierScore += brier(probabilities, row.actualDirection);
  }
  const perClass = {};
  for (const name of CLASS_NAMES) {
    const tp = confusion[name][name];
    const fp = CLASS_NAMES.reduce((sum, actual) => sum + (actual === name ? 0 : confusion[actual][name]), 0);
    const fn = CLASS_NAMES.reduce((sum, predicted) => sum + (predicted === name ? 0 : confusion[name][predicted]), 0);
    const precision = tp / Math.max(tp + fp, 1);
    const recall = tp / Math.max(tp + fn, 1);
    const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-12);
    perClass[name] = { precision, recall, f1 };
  }
  const recalls = CLASS_NAMES.map((name) => perClass[name].recall);
  return {
    sampleCount: rows.length,
    accuracy: hits / rows.length,
    macroF1: CLASS_NAMES.reduce((sum, name) => sum + perClass[name].f1, 0) / CLASS_NAMES.length,
    balancedAccuracy: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
    logLoss: logLoss / rows.length,
    brier: brierScore / rows.length,
    perClass,
    confusion,
  };
}

async function loadV1Candidate(group) {
  const artifact = JSON.parse(await readFile(resolve('docs/candidate-models', `${group}.json`), 'utf8'));
  if (!artifact?.model?.trained) throw new Error(`missing trained V1 candidate for ${group}`);
  return artifact.model;
}

async function buildRows({ client, config, symbol, model, endTime }) {
  const startTime = endTime - config.days * DAY_MS;
  const candleResult = await collectBitgetCandles({
    client,
    market: 'CRYPTO_FUTURES',
    symbol,
    timeframe: config.timeframe,
    startTime,
    endTime,
  });
  const candles = candleResult.candles;
  if (candles.length < config.lookback + config.horizon + 1) {
    throw new Error(`${config.group}:${symbol} insufficient candles: ${candles.length}`);
  }
  const funding = await collectFundingRateHistory({
    client,
    symbol,
    startTime: startTime - 12 * 60 * 60 * 1000,
    endTime,
  });
  const derivativesProvider = createTemporalDerivativesProvider({
    fundingHistory: funding.records,
    openInterestSnapshots: [],
    openInterestTrainingParityConfirmed: false,
  });
  const rows = [];
  for (let index = config.lookback - 1; index + config.horizon < candles.length; index += config.step) {
    const history = candles.slice(index - config.lookback + 1, index + 1);
    const anchor = history.at(-1);
    const futureEnd = candles[index + config.horizon];
    const temporal = derivativesProvider({ anchorTimestamp: anchor.timestamp });
    if (temporal.featureAvailability.openInterestKnown !== false || temporal.derivativesFeatures.openInterestChange !== undefined) {
      throw new Error(`${config.group}:${symbol}:${anchor.timestamp} OI parity contract failed`);
    }
    const blended = analyzeMarket({
      market: 'CRYPTO_FUTURES',
      symbol,
      timeframe: config.timeframe,
      horizon: config.horizon,
      candles: history,
      derivativesFeatures: temporal.derivativesFeatures,
      marketFeatures: {},
      collectedAt: anchor.timestamp,
      source: 'bitget-public-recent-deployment-parity',
    }, { model });
    const modelOnly = predictTinyModel(blended.features, model);
    const actualReturn = (futureEnd.close / anchor.close) - 1;
    rows.push({
      symbol,
      timeframe: config.timeframe,
      anchorTimestamp: anchor.timestamp,
      futureEndTimestamp: futureEnd.timestamp,
      actualReturn,
      actualDirection: actualDirection(actualReturn, blended.indicators.atrPct),
      atrPct: blended.indicators.atrPct,
      ruleScore: blended.ruleScore,
      blendedClass: predictedClass(blended.probabilities),
      blendedProbabilities: blended.probabilities,
      modelOnlyClass: predictedClass(modelOnly.probabilities),
      modelOnlyProbabilities: modelOnly.probabilities,
      openInterestKnown: temporal.featureAvailability.openInterestKnown,
      openInterestFeatureValue: blended.features.openInterestChange,
      fundingKnown: temporal.featureAvailability.fundingKnown,
    });
  }
  return { rows, candleCount: candles.length, fundingCount: funding.records.length, firstCandle: candles[0].timestamp, lastCandle: candles.at(-1).timestamp };
}

const outputPath = resolve(process.argv[2] ?? '/tmp/shadow-oi-parity-fresh/recent-deployment-parity.json');
const endTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 12_000 });
const result = {
  schemaVersion: 1,
  mode: 'fresh_recent_public_settled_replay',
  generatedAt: endTime,
  provider: 'bitget-public-v2',
  selectionOrTuningUsed: false,
  labelsSettledFromFutureCandlesAfterEachAnchor: true,
  overlappingOutcomeWindowsAvoidedByStepEqualsHorizon: true,
  profitabilityEvidence: false,
  finalHoldoutUsed: false,
  thresholdChanged: false,
  classWeightChanged: false,
  labelChanged: false,
  blendWeightChanged: false,
  modelRetrained: false,
  groups: {},
  safety: {
    publicMarketDataOnly: true,
    privateAccountRequests: 0,
    privateTradingRequests: 0,
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    writesSourceShadowState: false,
    executionAuthority: 'NONE',
  },
};

for (const config of CONFIGS) {
  const model = await loadV1Candidate(config.group);
  const groupRows = [];
  const data = {};
  for (const symbol of SYMBOLS) {
    const built = await buildRows({ client, config, symbol, model, endTime });
    groupRows.push(...built.rows);
    data[symbol] = {
      candleCount: built.candleCount,
      fundingCount: built.fundingCount,
      firstCandle: built.firstCandle,
      lastCandle: built.lastCandle,
      replaySamples: built.rows.length,
    };
  }
  const blendedMetrics = metrics(groupRows, (row) => row.blendedProbabilities);
  const modelOnlyMetrics = metrics(groupRows, (row) => row.modelOnlyProbabilities);
  result.groups[config.group] = {
    modelId: model.id,
    sampleCount: groupRows.length,
    actualDistribution: distribution(groupRows, (row) => row.actualDirection),
    blendedPredictionDistribution: distribution(groupRows, (row) => row.blendedClass),
    modelOnlyPredictionDistribution: distribution(groupRows, (row) => row.modelOnlyClass),
    classChangedByBlendCount: groupRows.filter((row) => row.blendedClass !== row.modelOnlyClass).length,
    directionSuppressedByBlendCount: groupRows.filter((row) => row.modelOnlyClass !== 'neutral' && row.blendedClass === 'neutral').length,
    blendedMetrics,
    modelOnlyMetrics,
    deltaModelOnlyMinusBlended: blendedMetrics && modelOnlyMetrics ? {
      accuracy: modelOnlyMetrics.accuracy - blendedMetrics.accuracy,
      macroF1: modelOnlyMetrics.macroF1 - blendedMetrics.macroF1,
      balancedAccuracy: modelOnlyMetrics.balancedAccuracy - blendedMetrics.balancedAccuracy,
      logLossImprovement: blendedMetrics.logLoss - modelOnlyMetrics.logLoss,
      brierImprovement: blendedMetrics.brier - modelOnlyMetrics.brier,
    } : null,
    openInterestContract: {
      knownCount: groupRows.filter((row) => row.openInterestKnown).length,
      effectiveZeroCount: groupRows.filter((row) => row.openInterestFeatureValue === 0).length,
    },
    bySymbol: Object.fromEntries(SYMBOLS.map((symbol) => {
      const rows = groupRows.filter((row) => row.symbol === symbol);
      return [symbol, {
        sampleCount: rows.length,
        actualDistribution: distribution(rows, (row) => row.actualDirection),
        blendedPredictionDistribution: distribution(rows, (row) => row.blendedClass),
        modelOnlyPredictionDistribution: distribution(rows, (row) => row.modelOnlyClass),
        directionSuppressedByBlendCount: rows.filter((row) => row.modelOnlyClass !== 'neutral' && row.blendedClass === 'neutral').length,
      }];
    })),
    data,
  };
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
