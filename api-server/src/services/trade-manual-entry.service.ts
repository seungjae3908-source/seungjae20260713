import type { CanonicalAccountSnapshot, CanonicalPosition } from '../features/account-readonly/account-readonly.contract';
import { loadFreePublicFxQuotes } from './public-fx.service';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingRepository } from './trade-automation.repository';
import { liveExecutionEnabled } from './trade-automation.service';
import type {
  StockBroker,
  TradingAssetClass,
  TradingExchange,
  TradingMarketSnapshot,
  TradingPlan,
  TradingPlanInput,
  TradingPolicy,
  TradingRiskDecision,
  TradingSide,
} from './trade-automation.types';
import type { TradeExecutionService } from './trade-execution.service';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';

const ACTIVE_STATES = new Set(['APPROVAL_PENDING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'RECOVERY_REQUIRED']);
const FX_MAX_AGE_MS = 72 * 60 * 60_000;

export type ManualEntryMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';

export type ManualEntryInstruction = {
  clientIntentId: string;
  market: ManualEntryMarket;
  symbol: string;
  side: 'BUY' | 'LONG' | 'SHORT';
  orderType: 'market' | 'limit';
  quantity?: number | null;
  quoteAmount?: number | null;
  estimatedKrw: number;
  limitPrice?: number | null;
  stopPrice: number;
  targetPrice: number;
  leverage?: number | null;
  stockExchange?: 'NASDAQ' | 'NYSE' | 'AMEX' | null;
};

export type ManualEntryPrepared = {
  input: TradingPlanInput;
  policy: TradingPolicy;
  emergencyStopped: boolean;
  decision: TradingRiskDecision;
  providerRequests: number;
  accountReadOnly: true;
  orderSubmitted: false;
  cancelRequests: 0;
  amendRequests: 0;
  transferRequests: 0;
  withdrawalRequests: 0;
  fxSource: string;
  fxAsOf: string | null;
};

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/^KRW[-/]/, '').replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function planSymbol(market: ManualEntryMarket, value: unknown) {
  const symbol = normalizedSymbol(value);
  if (!symbol) throw new Error('MANUAL_ENTRY_SYMBOL_REQUIRED');
  if (market === 'BITGET') return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
  if (market === 'UPBIT') return symbol.replace(/USDT$/, '');
  return symbol;
}

function marketForExecution(market: ManualEntryMarket) {
  if (market === 'UPBIT') return 'KRW';
  if (market === 'BITGET') return 'USDT-FUTURES';
  return market;
}

function assetClass(market: ManualEntryMarket): TradingAssetClass {
  if (market === 'KR') return 'domestic_stock';
  if (market === 'US') return 'us_stock';
  if (market === 'UPBIT') return 'crypto_spot';
  return 'crypto_futures';
}

function exchangeFor(market: ManualEntryMarket, policy: TradingPolicy): { exchange: TradingExchange; stockBroker: StockBroker | null } {
  if (market === 'UPBIT') return { exchange: 'upbit', stockBroker: null };
  if (market === 'BITGET') return { exchange: 'bitget', stockBroker: null };
  const key = market === 'US' ? 'us_stock' : 'domestic_stock';
  const broker = policy.stockBrokerByMarket?.[key] ?? 'kiwoom';
  return { exchange: broker, stockBroker: broker };
}

function sideFor(market: ManualEntryMarket, side: ManualEntryInstruction['side']): TradingSide {
  if (market === 'BITGET') {
    if (side !== 'LONG' && side !== 'SHORT') throw new Error('MANUAL_ENTRY_FUTURES_SIDE_REQUIRED');
    return side === 'LONG' ? 'long' : 'short';
  }
  if (side !== 'BUY') throw new Error('MANUAL_ENTRY_LONG_ONLY_MARKET');
  return 'buy';
}

function planAssetClass(plan: TradingPlan): TradingAssetClass {
  if (plan.exchange === 'upbit') return 'crypto_spot';
  if (plan.exchange === 'bitget') return 'crypto_futures';
  return String(plan.market).toUpperCase() === 'US' ? 'us_stock' : 'domestic_stock';
}

function plannedRiskKrw(plan: TradingPlan) {
  const reference = finitePositive(plan.entryPrice ?? plan.limitPrice ?? plan.marketSnapshot.currentPrice);
  const stop = finitePositive(plan.stopPrice);
  if (reference == null || stop == null) return Math.max(0, Number(plan.estimatedKrw) || 0);
  return Math.max(0, Number(plan.estimatedKrw) || 0) * Math.abs(reference - stop) / reference;
}

function marketForPlan(plan: Pick<TradingPlan, 'exchange' | 'market'>): ManualEntryMarket {
  if (plan.exchange === 'upbit') return 'UPBIT';
  if (plan.exchange === 'bitget') return 'BITGET';
  return String(plan.market).toUpperCase() === 'US' ? 'US' : 'KR';
}

function positionMatchesSymbol(position: CanonicalPosition, symbol: string) {
  return normalizedSymbol(position.symbol) === normalizedSymbol(symbol);
}

async function fxEvidence(market: ManualEntryMarket, now: Date) {
  if (market === 'KR' || market === 'UPBIT') {
    return { rate: 1, source: 'KRW_NATIVE', asOf: now.toISOString() };
  }
  const currency = market === 'US' ? 'USD' : 'USDT';
  const { quotes } = await loadFreePublicFxQuotes();
  const quote = quotes.find((item) => item.currency === currency);
  if (!quote || !finitePositive(quote.krwRate)) throw new Error(`MANUAL_ENTRY_${currency}_KRW_FX_REQUIRED`);
  const asOf = Date.parse(quote.asOf);
  if (!Number.isFinite(asOf) || asOf > now.getTime() + 60_000 || now.getTime() - asOf > FX_MAX_AGE_MS) {
    throw new Error(`MANUAL_ENTRY_${currency}_KRW_FX_STALE`);
  }
  return { rate: quote.krwRate, source: quote.source, asOf: quote.asOf };
}

function exposureContext(input: {
  plans: TradingPlan[];
  orders: Awaited<ReturnType<TradingRepository['listOrders']>>;
  policy: TradingPolicy;
  exchange: TradingExchange;
  symbol: string;
  asset: TradingAssetClass;
  side: TradingSide;
  now: Date;
}) {
  const active = input.plans.filter((plan) => plan.accountMode === 'live' && ACTIVE_STATES.has(plan.state));
  const sameInstrument = active.filter((plan) => plan.exchange === input.exchange
    && normalizedSymbol(plan.symbol) === normalizedSymbol(input.symbol));
  const sameStrategy = active.filter((plan) => plan.strategyId === 'manual-discretionary-v1');
  const sameClass = active.filter((plan) => planAssetClass(plan) === input.asset);
  const sum = (plans: TradingPlan[]) => plans.reduce((total, plan) => total + Math.max(0, Number(plan.estimatedKrw) || 0), 0);
  const accountExposureKrw = sum(active);
  const instrumentExposureKrw = sum(sameInstrument);
  const planById = new Map(input.plans.map((plan) => [plan.id, plan]));
  const cutoff = input.now.getTime() - 24 * 60 * 60_000;
  const dailyOrderCount = input.orders.filter((order) => {
    const plan = planById.get(order.planId);
    const at = Date.parse(order.createdAt);
    return plan?.accountMode === 'live' && Number.isFinite(at) && at >= cutoff;
  }).length;
  return {
    accountExposureKrw,
    instrumentExposureKrw,
    strategyExposureKrw: sum(sameStrategy),
    assetClassExposureKrw: sum(sameClass),
    openRiskKrw: active.reduce((total, plan) => total + plannedRiskKrw(plan), 0),
    openPositionCount: active.length,
    dailyOrderCount,
    existingPositionSide: sameInstrument.find((plan) => plan.side === input.side)?.side ?? sameInstrument[0]?.side ?? null,
    assetExposurePercent: instrumentExposureKrw / Math.max(1, input.policy.totalCapitalKrw) * 100,
    correlatedExposurePercent: sum(sameClass) / Math.max(1, input.policy.totalCapitalKrw) * 100,
  };
}

async function journalRiskContext(input: {
  repository: TradingRepository;
  userId: string;
  now: Date;
  accountValueKrw: number;
  plans: TradingPlan[];
  accountSnapshot: CanonicalAccountSnapshot;
}) {
  const payloads = await readTradeAutomationJournalPayloads(input.repository, input.userId);
  const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, input.now);
  const closed = journal.trades.filter((trade) => (trade.source === 'APP_AUTO' || trade.source === 'APP_MANUAL')
    && trade.status === 'CLOSED' && trade.closedAt);
  const quoteCache = new Map<ManualEntryMarket, Awaited<ReturnType<typeof fxEvidence>>>();
  const fxFor = async (market: ManualEntryMarket) => {
    const cached = quoteCache.get(market);
    if (cached) return cached;
    const quote = await fxEvidence(market, input.now);
    quoteCache.set(market, quote);
    return quote;
  };
  const marketForJournal = (market: string): ManualEntryMarket => {
    if (market === 'US_STOCK') return 'US';
    if (market === 'CRYPTO_FUTURES') return 'BITGET';
    if (market === 'CRYPTO_SPOT') return 'UPBIT';
    return 'KR';
  };
  const pnlSince = async (cutoff: number) => {
    let total = 0;
    for (const trade of closed) {
      const at = Date.parse(trade.closedAt ?? '');
      if (!Number.isFinite(at) || at < cutoff) continue;
      if (!Number.isFinite(Number(trade.netPnl))) throw new Error('MANUAL_ENTRY_REALIZED_PNL_EVIDENCE_REQUIRED');
      const fx = await fxFor(marketForJournal(trade.market));
      total += Number(trade.netPnl) * fx.rate;
    }
    return total;
  };

  const activePlans = input.plans.filter((plan) => plan.accountMode === 'live' && ACTIVE_STATES.has(plan.state));
  const planBySymbol = new Map(activePlans.map((plan) => [normalizedSymbol(plan.symbol), plan]));
  let unrealizedKrw = 0;
  for (const position of accountSnapshot.positions ?? []) {
    const quantity = Number(position.quantity);
    if (!Number.isFinite(quantity) || Math.abs(quantity) <= 0) continue;
    const plan = planBySymbol.get(normalizedSymbol(position.symbol));
    if (!plan) continue;
    if (!Number.isFinite(Number(position.unrealizedPnl))) continue;
    const fx = await fxFor(marketForPlan(plan));
    unrealizedKrw += Number(position.unrealizedPnl) * fx.rate;
  }

  const dailyKrw = await pnlSince(input.now.getTime() - 24 * 60 * 60_000) + unrealizedKrw;
  const weeklyKrw = await pnlSince(input.now.getTime() - 7 * 24 * 60 * 60_000) + unrealizedKrw;
  const ordered = closed
    .filter((trade) => Number.isFinite(Number(trade.netPnl)))
    .sort((left, right) => Date.parse(right.closedAt ?? '') - Date.parse(left.closedAt ?? ''));
  let consecutiveLosses = 0;
  for (const trade of ordered) {
    if (Number(trade.netPnl) < 0) consecutiveLosses += 1;
    else break;
  }
  const base = Math.max(1, input.accountValueKrw);
  return {
    dailyPnlPercent: dailyKrw / base * 100,
    weeklyPnlPercent: weeklyKrw / base * 100,
    consecutiveLosses,
  };
}

function validateInstruction(instruction: ManualEntryInstruction) {
  if (!/^[A-Za-z0-9_-]{8,80}$/u.test(String(instruction.clientIntentId ?? ''))) {
    throw new Error('MANUAL_ENTRY_INTENT_ID_INVALID');
  }
  if (!['KR', 'US', 'UPBIT', 'BITGET'].includes(instruction.market)) throw new Error('MANUAL_ENTRY_MARKET_UNSUPPORTED');
  if (!['market', 'limit'].includes(instruction.orderType)) throw new Error('MANUAL_ENTRY_ORDER_TYPE_INVALID');
  if (finitePositive(instruction.estimatedKrw) == null) throw new Error('MANUAL_ENTRY_ESTIMATED_KRW_REQUIRED');
  if (finitePositive(instruction.stopPrice) == null) throw new Error('MANUAL_ENTRY_STOP_PRICE_REQUIRED');
  if (finitePositive(instruction.targetPrice) == null) throw new Error('MANUAL_ENTRY_TARGET_PRICE_REQUIRED');
  if (instruction.orderType === 'limit' && finitePositive(instruction.limitPrice) == null) throw new Error('MANUAL_ENTRY_LIMIT_PRICE_REQUIRED');
  if (instruction.market === 'UPBIT' && instruction.orderType === 'market') {
    if (finitePositive(instruction.quoteAmount) == null) throw new Error('MANUAL_ENTRY_QUOTE_AMOUNT_REQUIRED');
  } else if (finitePositive(instruction.quantity) == null) {
    throw new Error('MANUAL_ENTRY_QUANTITY_REQUIRED');
  }
  if (instruction.market === 'BITGET' && instruction.leverage != null && ![2, 3].includes(Number(instruction.leverage))) {
    throw new Error('MANUAL_ENTRY_LEVERAGE_UNSUPPORTED');
  }
}

function validateAccountSnapshot(snapshot: CanonicalAccountSnapshot, exchange: TradingExchange) {
  if (snapshot.provider !== exchange || snapshot.readOnly !== true) throw new Error('MANUAL_ENTRY_ACCOUNT_PROVIDER_MISMATCH');
  if (!snapshot.connected || snapshot.stale) throw new Error(snapshot.errorCode || 'MANUAL_ENTRY_ACCOUNT_UNAVAILABLE');
  if (snapshot.orderRequests !== 0 || snapshot.cancelRequests !== 0 || snapshot.amendRequests !== 0
    || snapshot.transferRequests !== 0 || snapshot.withdrawalRequests !== 0) {
    throw new Error('MANUAL_ENTRY_READONLY_SAFETY_MISMATCH');
  }
}

export async function prepareManualEntry(input: {
  repository: TradingRepository;
  execution: TradeExecutionService;
  userId: string;
  accountSnapshotFor: (exchange: TradingExchange) => Promise<CanonicalAccountSnapshot>;
  instruction: ManualEntryInstruction;
  now?: Date;
}): Promise<ManualEntryPrepared> {
  const now = input.now ?? new Date();
  validateInstruction(input.instruction);
  const [policy, plans, orders, emergencyStopped] = await Promise.all([
    input.repository.getPolicy(input.userId),
    input.repository.listPlans(input.userId),
    input.repository.listOrders(input.userId),
    input.repository.getGlobalEmergencyStop(),
  ]);
  if (policy.mode !== 'approval') throw new Error('MANUAL_ENTRY_APPROVAL_MODE_REQUIRED');

  const { exchange, stockBroker } = exchangeFor(input.instruction.market, policy);
  const accountSnapshot = await input.accountSnapshotFor(exchange);
  validateAccountSnapshot(accountSnapshot, exchange);
  const symbol = planSymbol(input.instruction.market, input.instruction.symbol);
  const side = sideFor(input.instruction.market, input.instruction.side);
  const asset = assetClass(input.instruction.market);
  const exposure = exposureContext({ plans, orders, policy, exchange, symbol, asset, side, now });
  const fx = await fxEvidence(input.instruction.market, now);
  const manualSignal = `manual:${input.userId}:${input.instruction.clientIntentId}`;
  const observedAt = now.toISOString();

  if ((accountSnapshot.positions ?? []).some((position) => positionMatchesSymbol(position, symbol))
    && exposure.instrumentExposureKrw <= 0) {
    throw new Error('MANUAL_ENTRY_EXTERNAL_POSITION_SAME_SYMBOL');
  }

  const leverage = input.instruction.market === 'BITGET'
    ? Number(input.instruction.leverage ?? policy.bitgetLeverage)
    : null;
  const seedSnapshot: TradingMarketSnapshot = {
    observedAt,
    riskObservedAt: observedAt,
    dataDelayMs: 0,
    oneMinuteMovePercent: 0,
    spreadPercent: 0,
    orderbookGapPercent: 0,
    halted: false,
    availableBalance: 0,
    accountValueKrw: Math.max(1, policy.totalCapitalKrw),
    dailyPnlPercent: 0,
    weeklyPnlPercent: 0,
    assetExposurePercent: exposure.assetExposurePercent,
    accountExposureKrw: exposure.accountExposureKrw,
    instrumentExposureKrw: exposure.instrumentExposureKrw,
    strategyExposureKrw: exposure.strategyExposureKrw,
    assetClassExposureKrw: exposure.assetClassExposureKrw,
    openRiskKrw: exposure.openRiskKrw,
    openPositionCount: exposure.openPositionCount,
    dailyOrderCount: exposure.dailyOrderCount,
    consecutiveLosses: 0,
    existingPositionSide: exposure.existingPositionSide,
    currentPrice: input.instruction.limitPrice ?? null,
    plannedPrice: input.instruction.limitPrice ?? null,
    marketStatus: 'UNKNOWN',
    source: 'manual-entry-server-seed',
    availableLiquidityKrw: null,
    estimatedSlippagePercent: null,
    estimatedFeePercent: null,
    correlatedExposurePercent: exposure.correlatedExposurePercent,
    signalState: 'READY_FOR_APPROVAL',
    signalObservedAt: observedAt,
  };

  const seed: TradingPlanInput = {
    executionMode: 'manual',
    exchange,
    accountMode: 'live',
    stockBroker,
    stockExchange: input.instruction.market === 'US' && exchange === 'kiwoom'
      ? input.instruction.stockExchange ?? null
      : null,
    strategyId: 'manual-discretionary-v1',
    signalId: manualSignal,
    symbol,
    market: marketForExecution(input.instruction.market),
    side,
    orderType: input.instruction.orderType,
    quantity: input.instruction.market === 'UPBIT' && input.instruction.orderType === 'market'
      ? null : finitePositive(input.instruction.quantity),
    quoteAmount: input.instruction.market === 'UPBIT' && input.instruction.orderType === 'market'
      ? finitePositive(input.instruction.quoteAmount) : null,
    limitPrice: input.instruction.orderType === 'limit' ? finitePositive(input.instruction.limitPrice) : null,
    estimatedKrw: Number(input.instruction.estimatedKrw),
    stopPrice: Number(input.instruction.stopPrice),
    targetPrices: [Number(input.instruction.targetPrice)],
    splitRatios: [100],
    leverage,
    marginMode: input.instruction.market === 'BITGET' ? 'isolated' : null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['EXPLICIT_USER_MANUAL_ENTRY', 'SERVER_PROVIDER_PREVIEW_REQUIRED'],
    marketSnapshot: seedSnapshot,
    entryPrice: input.instruction.orderType === 'limit' ? finitePositive(input.instruction.limitPrice) : null,
    entryZoneLow: null,
    entryZoneHigh: null,
    estimatedSlippagePercent: null,
    averageSpreadPercent: null,
    economics: null,
  };

  const preview = await input.execution.previewLiveRiskSnapshot(input.userId, seed, {
    fxKrwPerQuoteCurrency: fx.rate,
    now,
  });
  const accountValueKrw = Math.max(1, Math.min(
    policy.totalCapitalKrw,
    finitePositive(preview.snapshot.accountValueKrw) ?? policy.totalCapitalKrw,
  ));
  const journalRisk = await journalRiskContext({
    repository: input.repository,
    userId: input.userId,
    now,
    accountValueKrw,
    plans,
    accountSnapshot,
  });
  const referencePrice = finitePositive(seed.limitPrice ?? preview.snapshot.currentPrice);
  if (referencePrice == null) throw new Error('MANUAL_ENTRY_REFERENCE_PRICE_UNAVAILABLE');
  const requestedQuantity = finitePositive(seed.quantity);
  const requestedQuote = finitePositive(seed.quoteAmount);
  const providerNotionalKrw = requestedQuantity != null
    ? requestedQuantity * referencePrice * fx.rate
    : requestedQuote != null
      ? requestedQuote * (input.instruction.market === 'UPBIT' ? 1 : fx.rate)
      : null;
  if (providerNotionalKrw == null || !Number.isFinite(providerNotionalKrw) || providerNotionalKrw <= 0) {
    throw new Error('MANUAL_ENTRY_SERVER_NOTIONAL_UNAVAILABLE');
  }
  const clientEstimatedKrw = Number(input.instruction.estimatedKrw);
  const estimatedKrw = Math.max(clientEstimatedKrw, providerNotionalKrw);
  if ((side === 'buy' || side === 'long')
    && (!(seed.stopPrice < referencePrice) || !(seed.targetPrices[0]! > referencePrice))) {
    throw new Error('MANUAL_ENTRY_LONG_STOP_TARGET_INVALID');
  }
  if (side === 'short'
    && (!(seed.stopPrice > referencePrice) || !(seed.targetPrices[0]! < referencePrice))) {
    throw new Error('MANUAL_ENTRY_SHORT_STOP_TARGET_INVALID');
  }

  const finalSnapshot: TradingMarketSnapshot = {
    ...preview.snapshot,
    riskObservedAt: preview.snapshot.observedAt,
    dailyPnlPercent: journalRisk.dailyPnlPercent,
    weeklyPnlPercent: journalRisk.weeklyPnlPercent,
    consecutiveLosses: journalRisk.consecutiveLosses,
    accountExposureKrw: exposure.accountExposureKrw,
    instrumentExposureKrw: exposure.instrumentExposureKrw,
    strategyExposureKrw: exposure.strategyExposureKrw,
    assetClassExposureKrw: exposure.assetClassExposureKrw,
    openRiskKrw: exposure.openRiskKrw,
    openPositionCount: Math.max(exposure.openPositionCount, preview.snapshot.openPositionCount),
    dailyOrderCount: exposure.dailyOrderCount,
    assetExposurePercent: Math.max(exposure.assetExposurePercent, finiteNonNegative(preview.snapshot.assetExposurePercent) ?? 0),
    existingPositionSide: preview.snapshot.existingPositionSide ?? exposure.existingPositionSide,
    correlatedExposurePercent: exposure.correlatedExposurePercent,
    signalState: 'READY_FOR_APPROVAL',
    signalObservedAt: observedAt,
    source: `${preview.snapshot.source ?? 'provider-private-preview'}+manual-user-entry`,
  };
  const finalInput: TradingPlanInput = {
    ...seed,
    estimatedKrw,
    marketSnapshot: finalSnapshot,
    estimatedSlippagePercent: preview.snapshot.estimatedSlippagePercent,
    averageSpreadPercent: preview.snapshot.spreadPercent,
  };
  const decision = evaluateTradingPlan(finalInput, policy, {
    emergencyStopped: emergencyStopped || policy.emergencyStopped || process.env.TRADING_EMERGENCY_STOP === 'true',
    serverLiveEnabled: liveExecutionEnabled(exchange),
  });

  return {
    input: finalInput,
    policy,
    emergencyStopped,
    decision,
    providerRequests: preview.providerRequests,
    accountReadOnly: true,
    orderSubmitted: false,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    fxSource: fx.source,
    fxAsOf: fx.asOf,
  };
}
