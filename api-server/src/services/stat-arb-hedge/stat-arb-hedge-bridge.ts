import type { TradingPlanInput } from '../trade-automation.types';
import type { HedgeLegState, HedgePairState } from './stat-arb-hedge.types';

/**
 * Projects one hedge leg onto the existing `TradingPlanInput` shape so the
 * order-path validators that already protect the single-leg handoff
 * (`validateBitgetContractRules`, Upbit amount formatting, idempotency,
 * kill-switch scope) can be run against it in tests. This is a read-only
 * bridge: nothing here submits to `trade-automation.service`.
 */
export function hedgeLegToTradingPlanInput(pair: HedgePairState, leg: HedgeLegState, accountMode: TradingPlanInput['accountMode']): TradingPlanInput {
  const spotLeg = leg.product === 'spot';
  const quantity = leg.targetQuantity;
  const price = leg.averagePrice ?? leg.referencePrice;
  const estimatedKrw = spotLeg ? quantity * price : quantity * price * pair.fxKrwPerUsdt;
  return {
    exchange: leg.venue === 'upbit' ? 'upbit' : 'bitget',
    accountMode,
    strategyId: `stat-arb:${pair.strategyId}`,
    signalId: pair.entrySignalId,
    signalOccurrenceId: `${pair.pairId}:${leg.legId}`,
    symbol: leg.symbol,
    market: spotLeg ? 'crypto_spot' : 'crypto_futures',
    side: leg.side,
    orderType: 'market',
    quantity,
    quoteAmount: spotLeg && leg.side === 'buy' ? estimatedKrw : null,
    estimatedKrw,
    stopPrice: 0,
    targetPrices: [],
    splitRatios: [1],
    leverage: spotLeg ? null : pair.leverage,
    marginMode: spotLeg ? null : 'isolated',
    reduceOnly: !spotLeg && leg.side === 'long',
    signalReasons: ['STAT_ARB_HEDGE_LEG'],
    marketSnapshot: {
      observedAt: new Date(pair.updatedAtMs).toISOString(), dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0, orderbookGapPercent: 0,
      halted: false, availableBalance: 0, accountValueKrw: 0, dailyPnlPercent: 0, assetExposurePercent: 0, openPositionCount: 0,
      dailyOrderCount: 0, consecutiveLosses: 0, currentPrice: price,
    },
    entryPrice: price,
  };
}
