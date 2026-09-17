import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
import { sha256Canonical } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import { BACKTEST_PAPER_HANDOFF_VERSION, type BacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import { strategyCandidateId } from './strategy-promotion.service';
import type { BacktestRequest } from './backtest-engine.service';
import type { NormalizedCandle } from './futures-market-data.service';
import { sanitizeClosedCandles } from './backtest-indicators.service';

// All references describe the accepted server request, never the currently edited UI form.
// Historical/manual references grant no Natural Paper, profitability or execution credit.
export function buildBacktestPaperHandoffs(
  request: BacktestRequest, candles: readonly NormalizedCandle[], researchCodeSha: string,
): readonly BacktestPaperHandoff[] {
  const exitPolicy = {
    stopLossMode: request.stopLossMode, stopLossValue: request.stopLossValue,
    takeProfitMode: request.takeProfitMode, takeProfitValue: request.takeProfitValue,
    trailingStop: request.trailingStop ? {
      enabled: request.trailingStop.enabled,
      activationR: request.trailingStop.activationR ?? (request.trailingStop.enabled ? 1 : null),
      distanceR: request.trailingStop.distanceR ?? (request.trailingStop.enabled ? 1 : null),
    } : null,
    intrabarPriority: request.intrabarPriority ?? 'stop_first',
  };
  const costPolicy = {
    entryFeeRate: request.entryFeeRate, exitFeeRate: request.exitFeeRate, slippageRate: request.slippageRate,
    fundingRatePerInterval: request.fundingRatePerInterval ?? 0,
    fundingIntervalHours: request.fundingIntervalHours ?? 8,
  };
  const riskPolicy = {
    riskPercent: request.riskPercent, leverage: request.leverage,
    maximumConcurrentPositions: request.maximumConcurrentPositions, maximumTradesPerDay: request.maximumTradesPerDay,
    quantityStep: request.quantityStep ?? null, quantityPrecision: request.quantityPrecision ?? null,
    minimumQuantity: request.minimumQuantity ?? null, minimumNotional: request.minimumNotional ?? null,
    maximumLeverage: request.maximumLeverage ?? null, contractRulesStatus: request.contractRulesStatus ?? null,
  };
  const parameterHash = sha256Canonical({ parameters: request.parameters, exitPolicy, costPolicy, riskPolicy });
  const strategyId = `BACKTEST_ENGINE:${request.strategy}`;
  const costPolicyRef = `backtest-cost-v1:${sha256Canonical(costPolicy)}`;
  const riskPolicyRef = `backtest-risk-v1:${sha256Canonical(riskPolicy)}`;
  const exitPolicyRef = `backtest-exit-v1:${sha256Canonical(exitPolicy)}`;
  const consumedCandles = sanitizeClosedCandles(candles).data
    .filter((candle) => candle.timestamp >= request.startTime && candle.timestamp <= request.endTime);
  const datasetDigest = sha256Canonical(consumedCandles.map((candle) => ({
    symbol: candle.symbol, market: candle.market, timeframe: candle.timeframe, timestamp: candle.timestamp,
    open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume,
    source: candle.source, isClosed: candle.isClosed,
  })));
  const sides: readonly ('LONG' | 'SHORT')[] = request.side === 'both' ? ['LONG', 'SHORT']
    : request.side === 'long' ? ['LONG'] : ['SHORT'];
  return Object.freeze(sides.map((side) => {
    const resolution = resolveCanonicalStrategyIdentity({
      strategyId, strategyFamily: 'BACKTEST_ENGINE', strategyVersion: 'phase5-backtest-v1',
      market: 'CRYPTO_FUTURES', direction: side, timeframe: request.timeframe, parameterHash,
      researchCodeSha, formulaIdentity: { strategy: request.strategy, parameters: request.parameters },
      datasetId: `backtest-candles:${datasetDigest}`, datasetDigest,
      datasetStart: new Date(request.startTime).toISOString(), datasetEnd: new Date(request.endTime).toISOString(),
      costPolicyVersion: costPolicyRef, riskPolicyVersion: riskPolicyRef,
      evidenceSchemaVersion: BACKTEST_PAPER_HANDOFF_VERSION,
    });
    const datasetMatches = consumedCandles.length > 0 && consumedCandles.every((candle) => candle.symbol === request.symbol
      && candle.timeframe === request.timeframe && candle.market === request.market);
    const candidateId = datasetMatches && resolution.status === 'IDENTITY_COMPLETE' ? strategyCandidateId({
      strategyFamily: 'BACKTEST_ENGINE', strategyId, strategyVersion: 'phase5-backtest-v1', parameterHash,
      market: 'CRYPTO_FUTURES', assetClass: 'CRYPTO_FUTURES', symbol: request.symbol, universe: request.symbol,
      timeframe: request.timeframe, strategyHorizon: null, direction: side, researchCodeSha,
      costPolicyVersion: costPolicyRef, riskPolicyVersion: riskPolicyRef,
    }) : null;
    return Object.freeze({
      schemaVersion: BACKTEST_PAPER_HANDOFF_VERSION, source: 'backtest-result' as const, status: 'REFERENCE_ONLY' as const,
      candidateId, strategyId, parameterHash, market: 'CRYPTO_FUTURES' as const, symbol: request.symbol,
      timeframe: request.timeframe, side, leverage: request.leverage, riskPolicyRef, costPolicyRef, exitPolicyRef,
      blockers: Object.freeze([
        ...resolution.blockers, ...resolution.missingFields.map((field) => `MISSING:${field}`),
        ...(datasetMatches ? [] : ['BACKTEST_DATASET_IDENTITY_MISMATCH']),
        'CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE', 'NATURAL_PAPER_EVIDENCE_NOT_PROVEN',
      ]),
      executionAuthority: 'NONE' as const, evidenceCredit: 0 as const, orderSubmitted: false as const,
      privateTradingApiAllowed: false as const,
    });
  }));
}
