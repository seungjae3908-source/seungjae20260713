import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  AUTO_TRADING_V2_CONFIG,
  AUTO_TRADING_V2_STRATEGY_ID,
  evaluateAutoTradingV2KillSwitch,
  evaluateAutoTradingV2Signal,
  fetchAutoTradingV2PublicSnapshot,
  simulateAutoTradingV2Execution,
  type AutoTradingV2Direction,
  type AutoTradingV2MarketSnapshot,
} from './auto-trading-v2.service';
import { estimateAutoTradingV2Liquidation } from './auto-trading-v2-simulation.service';
import { createSupabaseUserBrokerTelegramRepository } from '../features/user-broker-telegram/user-broker-telegram.repository';
import { UserBrokerTelegramService } from '../features/user-broker-telegram/user-broker-telegram.service';
import type {
  PortfolioSyncSink,
  TelegramTransport,
  UserExecutionEvent,
  UserExecutionEventType,
} from '../features/user-broker-telegram/user-broker-telegram.types';

const CONFIG_ID = 'auto-trading-v2-config';
const PREFIX = 'atv2-';
const WORKER_INTERVAL_MS = 30_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;

const disabledTransport: TelegramTransport = {
  async send() { return { ok: false, errorCode: 'DELIVERY_WORKER_OWNS_SEND' }; },
};
const noOpPortfolioSink: PortfolioSyncSink = { async accept() {} };

let timer: NodeJS.Timeout | null = null;
let cycleRunning = false;
const activeUsers = new Set<string>();

export type AutoTradingV2WorkerHealth = {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  intervalMs: number;
  realOrderCount: 0;
  realCancelCount: 0;
  privateTradingApiCount: 0;
};

type WorkerConfig = {
  recordType: 'auto_trading_v2_config';
  mode: 'PAPER' | 'SHADOW' | 'OFF';
  equityKrw: number;
  riskPerTradePercent: number;
  leverage: number;
  stopMode: 'FIXED_STOP' | 'ATR_STOP';
  atrMultiplier: number;
  dailyPnlPercent: number;
  weeklyDrawdownPercent: number;
  consecutiveLosses: number;
  safeHalt: boolean;
  newEntryDisabled: boolean;
  haltReasons: string[];
  updatedAt: string;
};

type PositionPayload = {
  recordType: 'auto_trading_v2_position';
  mode: 'PAPER' | 'SHADOW';
  symbol: string;
  direction: AutoTradingV2Direction;
  status: 'ACTIVE' | 'CLOSED';
  strategyId: string;
  strategyVersion: string;
  signalId: string;
  executionId: string;
  clientOrderId: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  trailingDistance: number;
  trailingStop: number | null;
  notionalKrw: number;
  requiredMarginKrw: number;
  leverage: number;
  riskPerTradePercent: number;
  remainingFraction: number;
  partialTpDone: boolean;
  positionProtected: boolean;
  realizedPnlKrw: number;
  unrealizedPnlKrw: number;
  entryFeeKrw: number;
  exitFeesKrw: number;
  fundingCostKrw: number;
  maxFavorableExcursionPercent: number;
  maxAdverseExcursionPercent: number;
  nextFundingTime: number | null;
  lastFundingAppliedAt: number | null;
  estimatedLiquidationPrice: number;
  liquidationDistancePercent: number;
  liquidationModel: 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT';
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  executionStates: string[];
  realOrderCount: 0;
  realCancelCount: 0;
  privateTradingApiCount: 0;
};

type StorageRow = {
  user_id: string;
  id: string;
  payload: Record<string, unknown>;
  version: number;
  deleted_at: string | null;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function configFrom(value: unknown): WorkerConfig | null {
  if (!isRecord(value) || value.recordType !== 'auto_trading_v2_config') return null;
  const mode = value.mode === 'PAPER' || value.mode === 'SHADOW' ? value.mode : 'OFF';
  return {
    recordType: 'auto_trading_v2_config',
    mode,
    equityKrw: Math.max(10_000, Number(value.equityKrw) || 1_000_000),
    riskPerTradePercent: Math.min(AUTO_TRADING_V2_CONFIG.riskPerTradeMaxPercent, Math.max(0.01, Number(value.riskPerTradePercent) || AUTO_TRADING_V2_CONFIG.riskPerTradeDefaultPercent)),
    leverage: Math.min(AUTO_TRADING_V2_CONFIG.leverageCap, Math.max(1, Math.round(Number(value.leverage) || AUTO_TRADING_V2_CONFIG.defaultLeverage))),
    stopMode: value.stopMode === 'FIXED_STOP' ? 'FIXED_STOP' : 'ATR_STOP',
    atrMultiplier: Math.min(2.5, Math.max(1.5, Number(value.atrMultiplier) || AUTO_TRADING_V2_CONFIG.defaultAtrStopMultiplier)),
    dailyPnlPercent: Number(value.dailyPnlPercent) || 0,
    weeklyDrawdownPercent: Number(value.weeklyDrawdownPercent) || 0,
    consecutiveLosses: Math.max(0, Math.round(Number(value.consecutiveLosses) || 0)),
    safeHalt: value.safeHalt === true,
    newEntryDisabled: value.newEntryDisabled === true,
    haltReasons: Array.isArray(value.haltReasons) ? value.haltReasons.map(String).slice(0, 30) : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function positionFrom(value: unknown): PositionPayload | null {
  if (!isRecord(value) || value.recordType !== 'auto_trading_v2_position' || value.status !== 'ACTIVE') return null;
  return value as unknown as PositionPayload;
}

async function getRow(client: SupabaseClient, table: string, userId: string, id: string): Promise<StorageRow | null> {
  const { data, error } = await client.from(table)
    .select('user_id,id,payload,version,deleted_at,updated_at')
    .eq('user_id', userId).eq('id', id).maybeSingle();
  if (error) throw new Error(`AUTO_TRADING_V2_WORKER_DB_READ:${table}`);
  return data ? data as StorageRow : null;
}

async function upsertPayload(
  client: SupabaseClient,
  table: string,
  userId: string,
  id: string,
  payload: Record<string, unknown>,
  now: Date,
) {
  const existing = await getRow(client, table, userId, id);
  const { error } = await client.from(table).upsert({
    user_id: userId,
    id,
    payload,
    version: (existing?.version ?? 0) + 1,
    deleted_at: null,
    updated_at: now.toISOString(),
  }, { onConflict: 'user_id,id' });
  if (error) throw new Error(`AUTO_TRADING_V2_WORKER_DB_WRITE:${table}`);
}

function telegramService() {
  return new UserBrokerTelegramService(
    createSupabaseUserBrokerTelegramRepository(),
    disabledTransport,
    noOpPortfolioSink,
  );
}

function event(input: {
  userId: string;
  mode: 'PAPER' | 'SHADOW';
  type: UserExecutionEventType;
  symbol: string;
  direction?: AutoTradingV2Direction | null;
  sourceEventId: string;
  executionId?: string | null;
  price?: number | null;
  realizedPnl?: number | null;
  metadata?: Record<string, unknown>;
}): UserExecutionEvent {
  return {
    id: `${PREFIX}worker-tg-${stableId(`${input.userId}:${input.sourceEventId}:${input.type}`)}`,
    sourceEventId: input.sourceEventId,
    userId: input.userId,
    brokerConnectionRef: null,
    orderPlanId: null,
    executionId: input.executionId ?? null,
    type: input.type,
    source: 'PAPER_EXECUTION',
    executionMethod: 'AUTO_POLICY',
    symbol: input.symbol,
    market: 'USDT-M-FUTURES',
    side: input.direction === 'LONG' ? 'long' : input.direction === 'SHORT' ? 'short' : null,
    quantity: null,
    price: input.price ?? null,
    maskedAccount: null,
    strategy: AUTO_TRADING_V2_STRATEGY_ID,
    remainingQuantity: null,
    realizedPnl: input.realizedPnl ?? null,
    averageEntryPrice: null,
    averageExitPrice: null,
    occurredAt: new Date().toISOString(),
    metadata: { executionMode: input.mode, liveTrading: false, worker: 'AUTO_TRADING_V2', ...input.metadata },
  };
}

async function notify(input: Parameters<typeof event>[0]) {
  try { await telegramService().recordEvent(event(input)); } catch { /* notification failure never creates a trade */ }
}

function pnlPercent(direction: AutoTradingV2Direction, entry: number, current: number) {
  return direction === 'LONG' ? (current - entry) / entry * 100 : (entry - current) / entry * 100;
}

function marketExitPrice(direction: AutoTradingV2Direction, mark: number) {
  const slippage = AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent / 100;
  return direction === 'LONG' ? mark * (1 - slippage) : mark * (1 + slippage);
}

function stopExitPrice(direction: AutoTradingV2Direction, stop: number) {
  const slippage = AUTO_TRADING_V2_CONFIG.stopSlippagePercent / 100;
  return direction === 'LONG' ? stop * (1 - slippage) : stop * (1 + slippage);
}

function realizedSlice(position: PositionPayload, exitPrice: number, fraction: number) {
  const notional = position.notionalKrw * fraction;
  const gross = notional * pnlPercent(position.direction, position.entryPrice, exitPrice) / 100;
  const exitFee = notional * (AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent / 2) / 100;
  return { pnl: gross - exitFee, exitFee };
}

async function closePosition(
  client: SupabaseClient,
  userId: string,
  position: PositionPayload,
  exitPrice: number,
  reason: 'STOP' | 'TRAILING' | 'LIQUIDATION_SIMULATION',
  now: Date,
) {
  const slice = realizedSlice(position, exitPrice, position.remainingFraction);
  const net = position.realizedPnlKrw + slice.pnl - position.entryFeeKrw - position.fundingCostKrw;
  const closed: PositionPayload = {
    ...position,
    status: 'CLOSED',
    remainingFraction: 0,
    realizedPnlKrw: net,
    unrealizedPnlKrw: 0,
    exitFeesKrw: position.exitFeesKrw + slice.exitFee,
    closedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    exitPrice,
    exitReason: reason,
    executionStates: [...position.executionStates, reason === 'TRAILING' ? 'TRAILING' : 'CLOSED'].filter((value, index, values) => index === 0 || value !== values[index - 1]),
  };
  if (closed.executionStates.at(-1) !== 'CLOSED') closed.executionStates.push('CLOSED');
  await upsertPayload(client, 'paper_positions', userId, `${PREFIX}position-${position.symbol}`, closed as unknown as Record<string, unknown>, now);
  await upsertPayload(client, 'paper_journal_entries', userId, `${PREFIX}outcome-${position.executionId}`, {
    recordType: 'auto_trading_v2_performance_outcome',
    mode: position.mode,
    symbol: position.symbol,
    side: position.direction.toLowerCase(),
    market: 'CRYPTO_FUTURES',
    source: position.mode === 'PAPER' ? 'APP_PAPER' : 'APP_SHADOW',
    strategy: position.strategyId,
    strategyVersion: position.strategyVersion,
    signalId: position.signalId,
    executionId: position.executionId,
    entryPrice: position.entryPrice,
    exitPrice,
    netPnl: net,
    fees: position.entryFeeKrw + position.exitFeesKrw + slice.exitFee,
    fundingCost: position.fundingCostKrw,
    slippageCost: position.notionalKrw * AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent / 100,
    riskPercent: position.riskPerTradePercent,
    leverage: position.leverage,
    marginMode: 'ISOLATED',
    exitReason: reason,
    maxFavorableExcursion: position.maxFavorableExcursionPercent,
    maxAdverseExcursion: position.maxAdverseExcursionPercent,
    estimatedLiquidationPrice: position.estimatedLiquidationPrice,
    liquidationDistancePercent: position.liquidationDistancePercent,
    liquidationModel: position.liquidationModel,
    wouldEnter: true,
    wouldFill: true,
    wouldStop: reason === 'STOP',
    wouldTP: position.partialTpDone,
    wouldLiquidate: reason === 'LIQUIDATION_SIMULATION',
    wouldPnL: net,
    killSwitchState: false,
    openedAt: position.openedAt,
    closedAt: now.toISOString(),
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
  }, now);
  await notify({
    userId, mode: position.mode,
    type: reason === 'STOP' ? 'STOP_FILLED' : reason === 'TRAILING' ? 'TRAILING_EXIT' : 'POSITION_CLOSED',
    symbol: position.symbol, direction: position.direction,
    sourceEventId: `${position.executionId}:worker-close:${reason}`,
    executionId: position.executionId, price: exitPrice, realizedPnl: net,
    metadata: { exitReason: reason, wouldLiquidate: reason === 'LIQUIDATION_SIMULATION' },
  });
  return closed;
}

async function advancePosition(
  client: SupabaseClient,
  userId: string,
  position: PositionPayload,
  snapshot: AutoTradingV2MarketSnapshot,
  now: Date,
) {
  let next: PositionPayload = { ...position, updatedAt: now.toISOString() };
  const excursion = pnlPercent(position.direction, position.entryPrice, snapshot.markPrice);
  next.maxFavorableExcursionPercent = Math.max(position.maxFavorableExcursionPercent, excursion);
  next.maxAdverseExcursionPercent = Math.min(position.maxAdverseExcursionPercent, excursion);

  if (position.nextFundingTime && now.getTime() >= position.nextFundingTime && position.lastFundingAppliedAt !== position.nextFundingTime) {
    next.fundingCostKrw += position.notionalKrw * snapshot.fundingRate * (position.direction === 'LONG' ? 1 : -1);
    next.lastFundingAppliedAt = position.nextFundingTime;
  }
  if (snapshot.nextFundingTime) next.nextFundingTime = snapshot.nextFundingTime;

  const liquidationTriggered = position.direction === 'LONG'
    ? snapshot.markPrice <= position.estimatedLiquidationPrice
    : snapshot.markPrice >= position.estimatedLiquidationPrice;
  if (liquidationTriggered) return closePosition(client, userId, next, marketExitPrice(position.direction, snapshot.markPrice), 'LIQUIDATION_SIMULATION', now);

  const effectiveStop = position.trailingStop ?? position.stopPrice;
  const stopTriggered = position.direction === 'LONG' ? snapshot.markPrice <= effectiveStop : snapshot.markPrice >= effectiveStop;
  if (stopTriggered) {
    const trailing = position.partialTpDone && position.trailingStop != null;
    return closePosition(client, userId, next, trailing ? marketExitPrice(position.direction, snapshot.markPrice) : stopExitPrice(position.direction, position.stopPrice), trailing ? 'TRAILING' : 'STOP', now);
  }

  const tpTriggered = !position.partialTpDone && (position.direction === 'LONG'
    ? snapshot.markPrice >= position.targetPrice
    : snapshot.markPrice <= position.targetPrice);
  if (tpTriggered) {
    const fraction = AUTO_TRADING_V2_CONFIG.tp1ExitFraction;
    const slice = realizedSlice(next, position.targetPrice, fraction);
    next.realizedPnlKrw += slice.pnl;
    next.exitFeesKrw += slice.exitFee;
    next.remainingFraction = 1 - fraction;
    next.partialTpDone = true;
    next.trailingStop = position.direction === 'LONG'
      ? Math.max(position.stopPrice, snapshot.markPrice - position.trailingDistance)
      : Math.min(position.stopPrice, snapshot.markPrice + position.trailingDistance);
    next.executionStates = [...next.executionStates, 'PARTIAL_TP', 'TRAILING'];
    await notify({
      userId, mode: position.mode, type: 'TAKE_PROFIT_FILLED', symbol: position.symbol, direction: position.direction,
      sourceEventId: `${position.executionId}:worker-tp1`, executionId: position.executionId, price: position.targetPrice,
      realizedPnl: slice.pnl, metadata: { partialExitFraction: fraction, remainingFraction: next.remainingFraction },
    });
  } else if (position.partialTpDone) {
    const candidate = position.direction === 'LONG'
      ? snapshot.markPrice - position.trailingDistance
      : snapshot.markPrice + position.trailingDistance;
    next.trailingStop = position.direction === 'LONG'
      ? Math.max(position.trailingStop ?? position.stopPrice, candidate)
      : Math.min(position.trailingStop ?? position.stopPrice, candidate);
  }
  next.unrealizedPnlKrw = position.notionalKrw * next.remainingFraction * excursion / 100;
  await upsertPayload(client, 'paper_positions', userId, `${PREFIX}position-${position.symbol}`, next as unknown as Record<string, unknown>, now);
  return next;
}

async function computeRiskState(client: SupabaseClient, userId: string, equityKrw: number, now: Date) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client.from('paper_journal_entries')
    .select('payload,updated_at')
    .eq('user_id', userId)
    .like('id', `${PREFIX}outcome-%`)
    .gte('updated_at', weekAgo)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw new Error('AUTO_TRADING_V2_WORKER_OUTCOME_READ');
  const rows = (data ?? []) as Array<{ payload: Record<string, unknown>; updated_at: string }>;
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const dailyPnl = rows.filter((row) => new Date(row.updated_at) >= startOfDay)
    .reduce((sum, row) => sum + (Number(row.payload.netPnl) || 0), 0);
  const weeklyPnl = rows.reduce((sum, row) => sum + (Number(row.payload.netPnl) || 0), 0);
  let consecutiveLosses = 0;
  for (const row of rows) {
    if ((Number(row.payload.netPnl) || 0) < 0) consecutiveLosses += 1;
    else break;
  }
  return {
    dailyPnlPercent: dailyPnl / Math.max(equityKrw, 1) * 100,
    weeklyDrawdownPercent: Math.min(0, weeklyPnl / Math.max(equityKrw, 1) * 100),
    consecutiveLosses,
  };
}

async function reconcileUser(client: SupabaseClient, userId: string) {
  const { data, error } = await client.from('paper_positions')
    .select('id,payload')
    .eq('user_id', userId)
    .like('id', `${PREFIX}position-%`)
    .is('deleted_at', null);
  if (error) throw new Error('AUTO_TRADING_V2_WORKER_RECONCILE_READ');
  const active = (data ?? []).map((row) => ({ id: String(row.id), position: positionFrom(row.payload) })).filter((row) => row.position);
  const reasons: string[] = [];
  const symbols = new Set<string>();
  for (const row of active) {
    const position = row.position!;
    if (!position.positionProtected) reasons.push(`PROTECTIVE_STOP_MISSING:${position.symbol}`);
    if (symbols.has(position.symbol)) reasons.push(`DUPLICATE_ACTIVE_POSITION:${position.symbol}`);
    symbols.add(position.symbol);
    const order = await getRow(client, 'paper_orders', userId, `${PREFIX}order-${position.signalId}`);
    if (!order || String(order.payload.executionId ?? '') !== position.executionId) reasons.push(`POSITION_STATE_MISMATCH:${position.symbol}`);
  }
  return { safe: reasons.length === 0, reasons, active: active.map((row) => row.position!) };
}

async function persistConfig(client: SupabaseClient, userId: string, config: WorkerConfig, now: Date) {
  await upsertPayload(client, 'paper_accounts', userId, CONFIG_ID, { ...config, updatedAt: now.toISOString() } as unknown as Record<string, unknown>, now);
}

async function persistSignal(client: SupabaseClient, userId: string, config: WorkerConfig, decision: ReturnType<typeof evaluateAutoTradingV2Signal>, now: Date) {
  const id = `${PREFIX}signal-${decision.signalId}`;
  if (await getRow(client, 'paper_journal_entries', userId, id)) return;
  await upsertPayload(client, 'paper_journal_entries', userId, id, {
    recordType: 'auto_trading_v2_signal', mode: config.mode, strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion, eligibility: decision.eligibility, signalId: decision.signalId,
    idempotencyKey: decision.idempotencyKey, symbol: decision.symbol, direction: decision.direction,
    regime: decision.regime, timeframe: decision.timeframe, allowed: decision.allowed,
    blockReasons: decision.blockReasons, reasons: decision.reasons,
    dataQuality: decision.snapshot.dataStale ? 'STALE' : 'GOOD', observedAt: decision.snapshot.observedAt,
    worker: true, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0,
  }, now);
  if (decision.direction) await notify({
    userId, mode: config.mode === 'SHADOW' ? 'SHADOW' : 'PAPER', type: 'SIGNAL_DETECTED', symbol: decision.symbol,
    direction: decision.direction, sourceEventId: `${decision.signalId}:worker-signal`, price: decision.snapshot.markPrice,
    metadata: { allowed: decision.allowed, regime: decision.regime, blockReasons: decision.blockReasons },
  });
}

async function openPosition(client: SupabaseClient, userId: string, config: WorkerConfig, decision: ReturnType<typeof evaluateAutoTradingV2Signal>, now: Date) {
  if (!decision.allowed || !decision.direction || !decision.orderPlan || (config.mode !== 'PAPER' && config.mode !== 'SHADOW')) return false;
  const orderId = `${PREFIX}order-${decision.signalId}`;
  if (await getRow(client, 'paper_orders', userId, orderId)) return false;
  const execution = simulateAutoTradingV2Execution(decision, config.mode);
  const liquidation = estimateAutoTradingV2Liquidation({
    direction: decision.direction, entryPrice: execution.entryPrice, stopPrice: execution.stopPrice, leverage: execution.leverage,
  });
  if (!liquidation.stopBeforeLiquidation || !execution.positionProtected) return false;

  await upsertPayload(client, 'paper_orders', userId, orderId, {
    recordType: 'auto_trading_v2_order_plan', mode: config.mode, strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion, eligibility: decision.eligibility, symbol: decision.symbol,
    market: 'USDT-M-FUTURES', timeframe: decision.timeframe, direction: decision.direction,
    signalId: decision.signalId, idempotencyKey: decision.idempotencyKey,
    executionId: execution.executionId, clientOrderId: execution.clientOrderId,
    marginMode: 'ISOLATED', entryPrice: execution.entryPrice, stopPrice: execution.stopPrice,
    targetPrice: execution.targetPrice, trailingDistance: execution.trailingDistance,
    notionalKrw: execution.notionalKrw, requiredMarginKrw: execution.requiredMarginKrw,
    leverage: execution.leverage, riskPerTradePercent: decision.orderPlan.position.riskPerTradePercent,
    estimatedLiquidationPrice: liquidation.estimatedLiquidationPrice,
    liquidationDistancePercent: liquidation.liquidationDistancePercent,
    liquidationModel: liquidation.model, executionStates: execution.states, positionProtected: true,
    wouldEnter: true, wouldFill: true, wouldStop: false, wouldTP: false, wouldLiquidate: false, wouldPnL: 0,
    worker: true, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0,
  }, now);

  const entryFeeKrw = execution.notionalKrw * (AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent / 2) / 100;
  const position: PositionPayload = {
    recordType: 'auto_trading_v2_position', mode: config.mode, symbol: decision.symbol, direction: decision.direction,
    status: 'ACTIVE', strategyId: decision.strategyId, strategyVersion: decision.strategyVersion,
    signalId: decision.signalId, executionId: execution.executionId, clientOrderId: execution.clientOrderId,
    entryPrice: execution.entryPrice, stopPrice: execution.stopPrice, targetPrice: execution.targetPrice,
    trailingDistance: execution.trailingDistance, trailingStop: null, notionalKrw: execution.notionalKrw,
    requiredMarginKrw: execution.requiredMarginKrw, leverage: execution.leverage,
    riskPerTradePercent: decision.orderPlan.position.riskPerTradePercent, remainingFraction: 1,
    partialTpDone: false, positionProtected: true, realizedPnlKrw: 0, unrealizedPnlKrw: 0,
    entryFeeKrw, exitFeesKrw: 0, fundingCostKrw: 0, maxFavorableExcursionPercent: 0,
    maxAdverseExcursionPercent: 0, nextFundingTime: decision.snapshot.nextFundingTime, lastFundingAppliedAt: null,
    estimatedLiquidationPrice: liquidation.estimatedLiquidationPrice,
    liquidationDistancePercent: liquidation.liquidationDistancePercent, liquidationModel: liquidation.model,
    openedAt: now.toISOString(), updatedAt: now.toISOString(), closedAt: null, exitPrice: null, exitReason: null,
    executionStates: execution.states, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0,
  };
  await upsertPayload(client, 'paper_positions', userId, `${PREFIX}position-${decision.symbol}`, position as unknown as Record<string, unknown>, now);
  await upsertPayload(client, 'paper_journal_entries', userId, `${PREFIX}execution-${execution.executionId}`, {
    recordType: 'auto_trading_v2_execution_event', ...execution, symbol: decision.symbol, direction: decision.direction,
    regime: decision.regime, reasons: decision.reasons, liquidation, worker: true,
  }, now);
  await notify({
    userId, mode: config.mode, type: 'POSITION_OPENED', symbol: decision.symbol, direction: decision.direction,
    sourceEventId: `${execution.executionId}:worker-opened`, executionId: execution.executionId,
    price: execution.entryPrice, metadata: { stopPrice: execution.stopPrice, targetPrice: execution.targetPrice,
      riskPercent: position.riskPerTradePercent, leverage: position.leverage, liquidationDistancePercent: liquidation.liquidationDistancePercent },
  });
  return true;
}

async function processUser(client: SupabaseClient, userId: string, initialConfig: WorkerConfig, now: Date) {
  if (activeUsers.has(userId)) return { userId, skipped: 'BUSY' as const };
  activeUsers.add(userId);
  try {
    const reconciliation = await reconcileUser(client, userId);
    const riskState = await computeRiskState(client, userId, initialConfig.equityKrw, now);
    const risk = evaluateAutoTradingV2KillSwitch({
      ...riskState,
      orderStateMismatch: reconciliation.reasons.some((reason) => reason.startsWith('POSITION_STATE_MISMATCH')),
      positionStateMismatch: reconciliation.reasons.some((reason) => reason.startsWith('DUPLICATE_ACTIVE_POSITION')),
      protectiveStopMissing: reconciliation.reasons.some((reason) => reason.startsWith('PROTECTIVE_STOP_MISSING')),
    });
    const config: WorkerConfig = {
      ...initialConfig,
      ...riskState,
      newEntryDisabled: risk.newEntryDisabled || !reconciliation.safe,
      safeHalt: risk.safeHalt || !reconciliation.safe,
      haltReasons: [...new Set([...risk.reasons, ...reconciliation.reasons])],
      updatedAt: now.toISOString(),
    };
    await persistConfig(client, userId, config, now);

    const results: Array<{ symbol: string; action: string }> = [];
    for (const symbol of SYMBOLS) {
      const row = await getRow(client, 'paper_positions', userId, `${PREFIX}position-${symbol}`);
      const active = positionFrom(row?.payload);
      const snapshot = await fetchAutoTradingV2PublicSnapshot(symbol);
      if (active) {
        const updated = await advancePosition(client, userId, active, snapshot, now);
        results.push({ symbol, action: updated.status === 'CLOSED' ? 'CLOSED' : 'POSITION_UPDATED' });
        continue;
      }
      const decision = evaluateAutoTradingV2Signal(snapshot, {
        equityKrw: config.equityKrw,
        mode: config.safeHalt || config.newEntryDisabled ? 'OFF' : config.mode,
        riskPerTradePercent: config.riskPerTradePercent,
        leverage: config.leverage,
        stopMode: config.stopMode,
        atrMultiplier: config.atrMultiplier,
        dailyPnlPercent: config.dailyPnlPercent,
        weeklyDrawdownPercent: config.weeklyDrawdownPercent,
        consecutiveLosses: config.consecutiveLosses,
      });
      await persistSignal(client, userId, config, decision, now);
      if (snapshot.dataStale) await notify({
        userId, mode: config.mode === 'SHADOW' ? 'SHADOW' : 'PAPER', type: 'STALE_DATA', symbol,
        direction: decision.direction, sourceEventId: `${decision.signalId}:worker-stale`, price: snapshot.markPrice,
        metadata: { observedAt: snapshot.observedAt },
      });
      const opened = !config.safeHalt && !config.newEntryDisabled && await openPosition(client, userId, config, decision, now);
      results.push({ symbol, action: opened ? 'OPENED' : 'NO_TRADE' });
    }
    return { userId, skipped: null, reconciliation, risk, results };
  } finally {
    activeUsers.delete(userId);
  }
}

export function autoTradingV2WorkerHealth(): AutoTradingV2WorkerHealth {
  const enabled = process.env.AUTO_TRADING_V2_WORKER_ENABLED !== 'false';
  if (!enabled) return { enabled: false, ready: false, reason: 'AUTO_TRADING_V2_WORKER_DISABLED', intervalMs: WORKER_INTERVAL_MS, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0 };
  if (!hasSupabaseServerKey()) return { enabled: true, ready: false, reason: 'SUPABASE_SERVER_KEY_REQUIRED', intervalMs: WORKER_INTERVAL_MS, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0 };
  return { enabled: true, ready: true, reason: null, intervalMs: WORKER_INTERVAL_MS, realOrderCount: 0, realCancelCount: 0, privateTradingApiCount: 0 };
}

export async function runAutoTradingV2WorkerCycle(now = new Date()) {
  const health = autoTradingV2WorkerHealth();
  if (!health.ready || cycleRunning) return { ok: false, health, skipped: cycleRunning ? 'CYCLE_BUSY' : health.reason, users: [] };
  cycleRunning = true;
  try {
    const client = getSupabase();
    const { data, error } = await client.from('paper_accounts')
      .select('user_id,id,payload,version,deleted_at,updated_at')
      .eq('id', CONFIG_ID)
      .is('deleted_at', null);
    if (error) throw new Error('AUTO_TRADING_V2_WORKER_CONFIG_READ');
    const rows = (data ?? []) as StorageRow[];
    const active = rows.map((row) => ({ userId: row.user_id, config: configFrom(row.payload) }))
      .filter((row): row is { userId: string; config: WorkerConfig } => Boolean(row.config && (row.config.mode === 'PAPER' || row.config.mode === 'SHADOW')));
    const users = [];
    for (const row of active) {
      try { users.push(await processUser(client, row.userId, row.config, now)); }
      catch (error) { users.push({ userId: row.userId, skipped: 'ERROR' as const, error: error instanceof Error ? error.message.slice(0, 120) : 'AUTO_TRADING_V2_WORKER_USER_FAILED' }); }
    }
    return { ok: true, health, skipped: null, users, realOrderCount: 0 as const, realCancelCount: 0 as const, privateTradingApiCount: 0 as const };
  } finally {
    cycleRunning = false;
  }
}

export function startAutoTradingV2Worker() {
  const health = autoTradingV2WorkerHealth();
  if (!health.ready || timer) {
    console.log(`[auto-trading-v2-worker] ${health.ready ? 'already-started' : health.reason}`);
    return health;
  }
  const run = () => void runAutoTradingV2WorkerCycle().catch((error) => {
    console.error('[auto-trading-v2-worker] cycle failed', error instanceof Error ? error.message : 'unknown');
  });
  run();
  timer = setInterval(run, WORKER_INTERVAL_MS);
  timer.unref?.();
  console.log(`[auto-trading-v2-worker] started interval=${WORKER_INTERVAL_MS}ms LIVE_TRADING=false privateTradingApiCount=0`);
  return health;
}
