import {
  AUTO_TRADING_V2_CONFIG,
  evaluateAutoTradingV2Signal,
  simulateAutoTradingV2Execution,
  type AutoTradingV2Direction,
  type AutoTradingV2MarketSnapshot,
  type AutoTradingV2Mode,
  type AutoTradingV2SignalDecision,
} from './auto-trading-v2.service';

export type AutoTradingV2LiquidationEstimate = {
  model: 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT';
  marginMode: 'ISOLATED';
  leverage: number;
  maintenanceMarginBufferPercent: number;
  estimatedLiquidationPrice: number;
  liquidationDistancePercent: number;
  stopBeforeLiquidation: boolean;
};

export function estimateAutoTradingV2Liquidation(input: {
  direction: AutoTradingV2Direction;
  entryPrice: number;
  stopPrice: number;
  leverage: number;
  maintenanceMarginBufferPercent?: number;
}): AutoTradingV2LiquidationEstimate {
  const entryPrice = Number(input.entryPrice);
  const stopPrice = Number(input.stopPrice);
  const leverage = Math.min(AUTO_TRADING_V2_CONFIG.leverageCap, Math.max(1, Math.round(Number(input.leverage))));
  const maintenanceMarginBufferPercent = Math.min(2, Math.max(0.25, Number(input.maintenanceMarginBufferPercent ?? 0.5)));
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error('AUTO_TRADING_V2_LIQUIDATION_INPUT_INVALID');
  }

  // This intentionally is NOT an exchange liquidation formula. It is a conservative,
  // deterministic isolated-margin simulation guard for PAPER/SHADOW only. Actual LIVE
  // liquidation protection must use the exchange's current maintenance-margin tiers.
  const grossBufferPercent = Math.max(0.5, (100 / leverage) - maintenanceMarginBufferPercent);
  const estimatedLiquidationPrice = input.direction === 'LONG'
    ? entryPrice * (1 - grossBufferPercent / 100)
    : entryPrice * (1 + grossBufferPercent / 100);
  const liquidationDistancePercent = Math.abs(entryPrice - estimatedLiquidationPrice) / entryPrice * 100;
  const stopBeforeLiquidation = input.direction === 'LONG'
    ? stopPrice > estimatedLiquidationPrice
    : stopPrice < estimatedLiquidationPrice;

  return {
    model: 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT',
    marginMode: 'ISOLATED',
    leverage,
    maintenanceMarginBufferPercent,
    estimatedLiquidationPrice,
    liquidationDistancePercent,
    stopBeforeLiquidation,
  };
}

export type AutoTradingV2HistoricalReplayResult = {
  mode: 'PAPER' | 'SHADOW';
  closedCandleOnly: true;
  strategyId: string;
  strategyVersion: string;
  evaluatedSnapshots: number;
  executableSignals: number;
  duplicateSignalsSkipped: number;
  longSignals: number;
  shortSignals: number;
  blockedSignals: number;
  signals: Array<{
    signalId: string;
    idempotencyKey: string;
    symbol: string;
    observedAt: string;
    direction: AutoTradingV2Direction;
    regime: string;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    leverage: number;
    riskPerTradePercent: number;
    liquidation: AutoTradingV2LiquidationEstimate;
    realOrderCount: 0;
    realCancelCount: 0;
    privateTradingApiCount: 0;
  }>;
};

export function replayAutoTradingV2HistoricalSnapshots(
  snapshots: readonly AutoTradingV2MarketSnapshot[],
  input: {
    mode: Extract<AutoTradingV2Mode, 'PAPER' | 'SHADOW'>;
    equityKrw: number;
    riskPerTradePercent?: number;
    leverage?: number;
  },
): AutoTradingV2HistoricalReplayResult {
  const ordered = [...snapshots]
    .filter((snapshot) => snapshot.closedCandleOnly === true)
    .sort((left, right) => left.lastClosedCandleTime - right.lastClosedCandleTime || left.symbol.localeCompare(right.symbol));
  const seen = new Set<string>();
  const decisions: AutoTradingV2SignalDecision[] = [];
  let duplicateSignalsSkipped = 0;
  let blockedSignals = 0;

  for (const snapshot of ordered) {
    const decision = evaluateAutoTradingV2Signal(snapshot, {
      mode: input.mode,
      equityKrw: input.equityKrw,
      riskPerTradePercent: input.riskPerTradePercent,
      leverage: input.leverage,
    });
    if (!decision.allowed || !decision.direction || !decision.orderPlan) {
      blockedSignals += 1;
      continue;
    }
    if (seen.has(decision.idempotencyKey)) {
      duplicateSignalsSkipped += 1;
      continue;
    }
    seen.add(decision.idempotencyKey);
    decisions.push(decision);
  }

  const signals = decisions.map((decision) => {
    const execution = simulateAutoTradingV2Execution(decision, input.mode);
    const liquidation = estimateAutoTradingV2Liquidation({
      direction: decision.direction!,
      entryPrice: execution.entryPrice,
      stopPrice: execution.stopPrice,
      leverage: execution.leverage,
    });
    return {
      signalId: decision.signalId,
      idempotencyKey: decision.idempotencyKey,
      symbol: decision.symbol,
      observedAt: decision.snapshot.observedAt,
      direction: decision.direction!,
      regime: decision.regime,
      entryPrice: execution.entryPrice,
      stopPrice: execution.stopPrice,
      targetPrice: execution.targetPrice,
      leverage: execution.leverage,
      riskPerTradePercent: decision.orderPlan!.position.riskPerTradePercent,
      liquidation,
      realOrderCount: 0 as const,
      realCancelCount: 0 as const,
      privateTradingApiCount: 0 as const,
    };
  });

  return {
    mode: input.mode,
    closedCandleOnly: true,
    strategyId: decisions[0]?.strategyId ?? 'crypto-futures-pullback-v1',
    strategyVersion: decisions[0]?.strategyVersion ?? '1.0.0',
    evaluatedSnapshots: ordered.length,
    executableSignals: signals.length,
    duplicateSignalsSkipped,
    longSignals: signals.filter((signal) => signal.direction === 'LONG').length,
    shortSignals: signals.filter((signal) => signal.direction === 'SHORT').length,
    blockedSignals,
    signals,
  };
}
