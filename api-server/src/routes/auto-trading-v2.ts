import { createHash } from 'node:crypto';
import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createSupabasePaperJournalRepository } from '../services/paper-journal-supabase.repository';
import type { PaperJournalRepository, PaperJournalRecordKind, StoredPaperJournalRecord } from '../services/paper-journal.types';
import {
  AUTO_TRADING_V2_CONFIG,
  AUTO_TRADING_V2_STRATEGY_ID,
  AUTO_TRADING_V2_STRATEGY_VERSION,
  AUTO_TRADING_V2_SUPPORTED_SYMBOLS,
  autoTradingV2SafetyEnvelope,
  evaluateAutoTradingV2KillSwitch,
  evaluateAutoTradingV2Signal,
  fetchAutoTradingV2PublicSnapshot,
  simulateAutoTradingV2Execution,
  type AutoTradingV2Direction,
  type AutoTradingV2MarketSnapshot,
  type AutoTradingV2Mode,
  type AutoTradingV2StopMode,
} from '../services/auto-trading-v2.service';
import { createSupabaseUserBrokerTelegramRepository } from '../features/user-broker-telegram/user-broker-telegram.repository';
import { CanonicalPortfolioSyncSink } from '../features/user-broker-telegram/user-broker-telegram.runtime';
import { UserBrokerTelegramService } from '../features/user-broker-telegram/user-broker-telegram.service';
import type {
  PortfolioSyncSink,
  TelegramTransport,
  UserExecutionEvent,
  UserExecutionEventType,
} from '../features/user-broker-telegram/user-broker-telegram.types';

const router: IRouter = Router();
const CONFIG_ID = 'auto-trading-v2-config';
const RECORD_PREFIX = 'atv2-';
const MAX_JOURNAL_ROWS = 100;

const disabledTelegramTransport: TelegramTransport = {
  async send() { return { ok: false, errorCode: 'TELEGRAM_DELIVERY_WORKER_REQUIRED' }; },
};
const noOpPortfolioSink: PortfolioSyncSink = { async accept() {} };

type RuntimeConfig = {
  recordType: 'auto_trading_v2_config';
  mode: Exclude<AutoTradingV2Mode, 'LIVE'>;
  equityKrw: number;
  riskPerTradePercent: number;
  leverage: number;
  stopMode: AutoTradingV2StopMode;
  atrMultiplier: number;
  dailyPnlPercent: number;
  weeklyDrawdownPercent: number;
  consecutiveLosses: number;
  safeHalt: boolean;
  newEntryDisabled: boolean;
  haltReasons: string[];
  updatedAt: string;
};

type RuntimePosition = {
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

function defaultConfig(now = new Date()): RuntimeConfig {
  return {
    recordType: 'auto_trading_v2_config',
    mode: 'OFF',
    equityKrw: 1_000_000,
    riskPerTradePercent: AUTO_TRADING_V2_CONFIG.riskPerTradeDefaultPercent,
    leverage: AUTO_TRADING_V2_CONFIG.defaultLeverage,
    stopMode: 'ATR_STOP',
    atrMultiplier: AUTO_TRADING_V2_CONFIG.defaultAtrStopMultiplier,
    dailyPnlPercent: 0,
    weeklyDrawdownPercent: 0,
    consecutiveLosses: 0,
    safeHalt: false,
    newEntryDisabled: false,
    haltReasons: [],
    updatedAt: now.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function runtimeConfig(payload: unknown, now = new Date()): RuntimeConfig {
  const base = defaultConfig(now);
  if (!isRecord(payload) || payload.recordType !== 'auto_trading_v2_config') return base;
  const mode = payload.mode === 'PAPER' || payload.mode === 'SHADOW' ? payload.mode : 'OFF';
  const stopMode = payload.stopMode === 'FIXED_STOP' ? 'FIXED_STOP' : 'ATR_STOP';
  return {
    ...base,
    mode,
    equityKrw: clamp(finite(payload.equityKrw, base.equityKrw), 10_000, 10_000_000_000),
    riskPerTradePercent: clamp(finite(payload.riskPerTradePercent, base.riskPerTradePercent), 0.01, AUTO_TRADING_V2_CONFIG.riskPerTradeMaxPercent),
    leverage: Math.round(clamp(finite(payload.leverage, base.leverage), 1, AUTO_TRADING_V2_CONFIG.leverageCap)),
    stopMode,
    atrMultiplier: clamp(finite(payload.atrMultiplier, base.atrMultiplier), 1.5, 2.5),
    dailyPnlPercent: finite(payload.dailyPnlPercent, 0),
    weeklyDrawdownPercent: finite(payload.weeklyDrawdownPercent, 0),
    consecutiveLosses: Math.max(0, Math.round(finite(payload.consecutiveLosses, 0))),
    safeHalt: payload.safeHalt === true,
    newEntryDisabled: payload.newEntryDisabled === true,
    haltReasons: Array.isArray(payload.haltReasons) ? payload.haltReasons.map(String).slice(0, 30) : [],
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : now.toISOString(),
  };
}

function member(req: AuthenticatedRequest) {
  if (!req.member?.id || !req.accessToken) throw new Error('LOGIN_REQUIRED');
  return {
    userId: req.member.id,
    repository: createSupabasePaperJournalRepository(req.accessToken, req.member.id),
  };
}

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function upsert(
  repository: PaperJournalRepository,
  userId: string,
  kind: PaperJournalRecordKind,
  id: string,
  payload: Record<string, unknown>,
  now = new Date(),
) {
  const existing = await repository.getRecord(userId, kind, id);
  const timestamp = now.toISOString();
  return repository.upsertRecord(userId, {
    kind,
    id,
    version: (existing?.version ?? 0) + 1,
    updatedAt: timestamp,
    deletedAt: null,
    payload,
  }, timestamp);
}

async function readConfig(repository: PaperJournalRepository, userId: string) {
  const record = await repository.getRecord(userId, 'account', CONFIG_ID);
  return runtimeConfig(record?.payload);
}

async function saveConfig(repository: PaperJournalRepository, userId: string, config: RuntimeConfig, now = new Date()) {
  const next = { ...config, updatedAt: now.toISOString() } satisfies RuntimeConfig;
  await upsert(repository, userId, 'account', CONFIG_ID, next as unknown as Record<string, unknown>, now);
  return next;
}

function positionFrom(record: StoredPaperJournalRecord): RuntimePosition | null {
  if (record.kind !== 'position' || !record.id.startsWith(`${RECORD_PREFIX}position-`) || !isRecord(record.payload)) return null;
  if (record.payload.recordType !== 'auto_trading_v2_position') return null;
  return record.payload as unknown as RuntimePosition;
}

function activePositions(records: StoredPaperJournalRecord[]) {
  return records.map(positionFrom).filter((position): position is RuntimePosition => Boolean(position && position.status === 'ACTIVE'));
}

function executionIds(records: StoredPaperJournalRecord[]) {
  return new Set(records
    .filter((record) => record.kind === 'order' && record.id.startsWith(`${RECORD_PREFIX}order-`))
    .map((record) => String(record.payload.executionId ?? ''))
    .filter(Boolean));
}

async function reconciliation(repository: PaperJournalRepository, userId: string, records?: StoredPaperJournalRecord[]) {
  const snapshot = records ?? await repository.listSnapshot(userId);
  const positions = activePositions(snapshot);
  const orders = executionIds(snapshot);
  const reasons: string[] = [];
  for (const position of positions) {
    if (!position.positionProtected) reasons.push(`PROTECTIVE_STOP_MISSING:${position.symbol}`);
    if (!orders.has(position.executionId)) reasons.push(`POSITION_STATE_MISMATCH:${position.symbol}`);
  }
  const bySymbol = new Map<string, number>();
  for (const position of positions) bySymbol.set(position.symbol, (bySymbol.get(position.symbol) ?? 0) + 1);
  for (const [symbol, count] of bySymbol) if (count > 1) reasons.push(`DUPLICATE_ACTIVE_POSITION:${symbol}`);
  return {
    state: reasons.length ? 'SAFE_HALT' as const : 'SAFE' as const,
    tradingEnabled: reasons.length === 0,
    reasons,
    activePositions: positions,
    localStateLoaded: true,
    virtualExchangeStateLoaded: true,
    openOrdersCompared: true,
    positionsCompared: true,
    protectiveStopsChecked: true,
    privateTradingApiCount: 0 as const,
  };
}

function notificationService(repository: PaperJournalRepository, userId: string) {
  return new UserBrokerTelegramService(
    createSupabaseUserBrokerTelegramRepository(),
    disabledTelegramTransport,
    new CanonicalPortfolioSyncSink(repository, userId),
  );
}

function notificationEvent(input: {
  userId: string;
  mode: 'PAPER' | 'SHADOW';
  type: UserExecutionEventType;
  symbol: string;
  direction?: AutoTradingV2Direction | null;
  sourceEventId: string;
  executionId?: string | null;
  price?: number | null;
  realizedPnl?: number | null;
  averageEntryPrice?: number | null;
  averageExitPrice?: number | null;
  strategy?: string | null;
  metadata?: Record<string, unknown>;
}): UserExecutionEvent {
  const side = input.direction === 'LONG' ? 'long' : input.direction === 'SHORT' ? 'short' : null;
  return {
    id: `atv2-tg-${stableId(`${input.userId}:${input.sourceEventId}:${input.type}`)}`,
    sourceEventId: input.sourceEventId,
    userId: input.userId,
    brokerConnectionRef: 'bitget',
    orderPlanId: null,
    executionId: input.executionId ?? null,
    type: input.type,
    source: 'PAPER_EXECUTION',
    executionMethod: 'AUTO_POLICY',
    symbol: input.symbol,
    market: 'USDT-M-FUTURES',
    side,
    quantity: null,
    price: input.price ?? null,
    maskedAccount: null,
    strategy: input.strategy ?? AUTO_TRADING_V2_STRATEGY_ID,
    remainingQuantity: null,
    realizedPnl: input.realizedPnl ?? null,
    averageEntryPrice: input.averageEntryPrice ?? null,
    averageExitPrice: input.averageExitPrice ?? null,
    occurredAt: new Date().toISOString(),
    metadata: { executionMode: input.mode, liveTrading: false, ...input.metadata },
  };
}

async function notify(repository: PaperJournalRepository, event: UserExecutionEvent) {
  try {
    return await notificationService(repository, event.userId).recordEvent(event);
  } catch {
    return { inserted: false, deliveryQueued: false, notificationError: true };
  }
}

function pnlPercent(direction: AutoTradingV2Direction, entry: number, current: number) {
  return direction === 'LONG' ? (current - entry) / entry * 100 : (entry - current) / entry * 100;
}

function exitPriceForStop(position: RuntimePosition) {
  const slip = AUTO_TRADING_V2_CONFIG.stopSlippagePercent / 100;
  return position.direction === 'LONG' ? position.stopPrice * (1 - slip) : position.stopPrice * (1 + slip);
}

function exitPriceForMarket(position: RuntimePosition, markPrice: number) {
  const slip = AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent / 100;
  return position.direction === 'LONG' ? markPrice * (1 - slip) : markPrice * (1 + slip);
}

function realizedForSlice(position: RuntimePosition, exitPrice: number, fraction: number) {
  const grossPercent = pnlPercent(position.direction, position.entryPrice, exitPrice) / 100;
  const notional = position.notionalKrw * fraction;
  const exitFee = notional * (AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent / 2) / 100;
  return { pnl: notional * grossPercent - exitFee, exitFee };
}

async function closePosition(
  repository: PaperJournalRepository,
  userId: string,
  position: RuntimePosition,
  exitPrice: number,
  reason: 'STOP' | 'TRAILING' | 'MANUAL_GUARD',
  now: Date,
) {
  const slice = realizedForSlice(position, exitPrice, position.remainingFraction);
  const realizedPnlKrw = position.realizedPnlKrw + slice.pnl - position.entryFeeKrw - position.fundingCostKrw;
  const states = [...position.executionStates];
  if (reason === 'TRAILING' && states.at(-1) !== 'TRAILING') states.push('TRAILING');
  states.push('CLOSED');
  const closed: RuntimePosition = {
    ...position,
    status: 'CLOSED',
    remainingFraction: 0,
    realizedPnlKrw,
    unrealizedPnlKrw: 0,
    exitFeesKrw: position.exitFeesKrw + slice.exitFee,
    updatedAt: now.toISOString(),
    closedAt: now.toISOString(),
    exitPrice,
    exitReason: reason,
    executionStates: states,
  };
  await upsert(repository, userId, 'position', `${RECORD_PREFIX}position-${position.symbol}`, closed as unknown as Record<string, unknown>, now);
  await upsert(repository, userId, 'journal', `${RECORD_PREFIX}outcome-${position.executionId}`, {
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
    netPnl: realizedPnlKrw,
    fees: position.entryFeeKrw + position.exitFeesKrw + slice.exitFee,
    fundingCost: position.fundingCostKrw,
    slippageCost: position.notionalKrw * AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent / 100,
    riskPercent: position.riskPerTradePercent,
    leverage: position.leverage,
    marginMode: 'ISOLATED',
    exitReason: reason,
    invalidation: null,
    maxFavorableExcursion: position.maxFavorableExcursionPercent,
    maxAdverseExcursion: position.maxAdverseExcursionPercent,
    openedAt: position.openedAt,
    closedAt: now.toISOString(),
    killSwitchState: false,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
  }, now);
  const eventType: UserExecutionEventType = reason === 'STOP' ? 'STOP_FILLED' : reason === 'TRAILING' ? 'TRAILING_EXIT' : 'POSITION_CLOSED';
  await notify(repository, notificationEvent({
    userId, mode: position.mode, type: eventType, symbol: position.symbol, direction: position.direction,
    sourceEventId: `${position.executionId}:close:${reason}`, executionId: position.executionId,
    price: exitPrice, realizedPnl: realizedPnlKrw, averageEntryPrice: position.entryPrice, averageExitPrice: exitPrice,
    metadata: { exitReason: reason, fees: position.entryFeeKrw + position.exitFeesKrw + slice.exitFee, funding: position.fundingCostKrw },
  }));
  return closed;
}

async function advancePosition(
  repository: PaperJournalRepository,
  userId: string,
  position: RuntimePosition,
  snapshot: AutoTradingV2MarketSnapshot,
  now = new Date(),
) {
  let next: RuntimePosition = { ...position, updatedAt: now.toISOString() };
  const excursion = pnlPercent(position.direction, position.entryPrice, snapshot.markPrice);
  next.maxFavorableExcursionPercent = Math.max(position.maxFavorableExcursionPercent, excursion);
  next.maxAdverseExcursionPercent = Math.min(position.maxAdverseExcursionPercent, excursion);
  if (position.nextFundingTime && now.getTime() >= position.nextFundingTime && position.lastFundingAppliedAt !== position.nextFundingTime) {
    const signedFunding = position.notionalKrw * snapshot.fundingRate * (position.direction === 'LONG' ? 1 : -1);
    next.fundingCostKrw += signedFunding;
    next.lastFundingAppliedAt = position.nextFundingTime;
    next.nextFundingTime = snapshot.nextFundingTime;
  } else if (snapshot.nextFundingTime) {
    next.nextFundingTime = snapshot.nextFundingTime;
  }
  const stopTriggered = position.direction === 'LONG'
    ? snapshot.markPrice <= (position.trailingStop ?? position.stopPrice)
    : snapshot.markPrice >= (position.trailingStop ?? position.stopPrice);
  if (stopTriggered) {
    const trailing = position.partialTpDone && position.trailingStop != null;
    return closePosition(repository, userId, next, trailing ? exitPriceForMarket(next, snapshot.markPrice) : exitPriceForStop(next), trailing ? 'TRAILING' : 'STOP', now);
  }
  const tpTriggered = !position.partialTpDone && (position.direction === 'LONG'
    ? snapshot.markPrice >= position.targetPrice
    : snapshot.markPrice <= position.targetPrice);
  if (tpTriggered) {
    const fraction = AUTO_TRADING_V2_CONFIG.tp1ExitFraction;
    const slice = realizedForSlice(next, position.targetPrice, fraction);
    next.realizedPnlKrw += slice.pnl;
    next.exitFeesKrw += slice.exitFee;
    next.remainingFraction = Math.max(0, 1 - fraction);
    next.partialTpDone = true;
    next.trailingStop = position.direction === 'LONG'
      ? Math.max(position.stopPrice, snapshot.markPrice - position.trailingDistance)
      : Math.min(position.stopPrice, snapshot.markPrice + position.trailingDistance);
    next.executionStates = [...next.executionStates, 'PARTIAL_TP', 'TRAILING'];
    await notify(repository, notificationEvent({
      userId, mode: position.mode, type: 'TAKE_PROFIT_FILLED', symbol: position.symbol, direction: position.direction,
      sourceEventId: `${position.executionId}:tp1`, executionId: position.executionId, price: position.targetPrice,
      realizedPnl: slice.pnl, averageEntryPrice: position.entryPrice,
      metadata: { partialExitFraction: fraction, remainingFraction: next.remainingFraction },
    }));
  } else if (position.partialTpDone) {
    const candidate = position.direction === 'LONG'
      ? snapshot.markPrice - position.trailingDistance
      : snapshot.markPrice + position.trailingDistance;
    next.trailingStop = position.direction === 'LONG'
      ? Math.max(position.trailingStop ?? position.stopPrice, candidate)
      : Math.min(position.trailingStop ?? position.stopPrice, candidate);
  }
  next.unrealizedPnlKrw = position.notionalKrw * next.remainingFraction * excursion / 100;
  await upsert(repository, userId, 'position', `${RECORD_PREFIX}position-${position.symbol}`, next as unknown as Record<string, unknown>, now);
  return next;
}

async function openFromDecision(
  repository: PaperJournalRepository,
  userId: string,
  config: RuntimeConfig,
  decision: ReturnType<typeof evaluateAutoTradingV2Signal>,
  now = new Date(),
  options: { stopRegistrationFails?: boolean; partialFillFraction?: number } = {},
) {
  if (config.mode !== 'PAPER' && config.mode !== 'SHADOW') return null;
  const orderId = `${RECORD_PREFIX}order-${decision.signalId}`;
  const duplicate = await repository.getRecord(userId, 'order', orderId);
  if (duplicate) return { duplicate: true, order: duplicate.payload, position: null };
  const simulation = simulateAutoTradingV2Execution(decision, config.mode, options);
  await upsert(repository, userId, 'order', orderId, {
    recordType: 'auto_trading_v2_order_plan',
    strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion,
    eligibility: decision.eligibility,
    symbol: decision.symbol,
    market: 'USDT-M-FUTURES',
    timeframe: decision.timeframe,
    direction: decision.direction,
    signalId: decision.signalId,
    idempotencyKey: decision.idempotencyKey,
    executionId: simulation.executionId,
    clientOrderId: simulation.clientOrderId,
    mode: config.mode,
    marginMode: 'ISOLATED',
    entryPrice: simulation.entryPrice,
    stopPrice: simulation.stopPrice,
    targetPrice: simulation.targetPrice,
    trailingDistance: simulation.trailingDistance,
    notionalKrw: simulation.notionalKrw,
    requiredMarginKrw: simulation.requiredMarginKrw,
    leverage: simulation.leverage,
    riskPerTradePercent: decision.orderPlan?.position.riskPerTradePercent ?? config.riskPerTradePercent,
    executionStates: simulation.states,
    positionProtected: simulation.positionProtected,
    wouldEnter: simulation.wouldEnter,
    wouldFill: simulation.wouldFill,
    wouldStop: simulation.wouldStop,
    wouldTP: simulation.wouldTP,
    wouldLiquidate: simulation.wouldLiquidate,
    wouldPnL: simulation.wouldPnlKrw,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
    createdAt: now.toISOString(),
  }, now);
  await upsert(repository, userId, 'journal', `${RECORD_PREFIX}execution-${simulation.executionId}`, {
    recordType: 'auto_trading_v2_execution_event',
    ...simulation,
    symbol: decision.symbol,
    direction: decision.direction,
    regime: decision.regime,
    reasons: decision.reasons,
    createdAt: now.toISOString(),
  }, now);
  if (!simulation.positionProtected || !decision.direction || !decision.orderPlan) {
    const halted = await saveConfig(repository, userId, {
      ...config,
      safeHalt: true,
      newEntryDisabled: true,
      haltReasons: ['PROTECTIVE_STOP_MISSING'],
    }, now);
    await upsert(repository, userId, 'journal', `${RECORD_PREFIX}kill-${simulation.executionId}`, {
      recordType: 'auto_trading_v2_kill_switch_event',
      reasons: halted.haltReasons,
      safeHalt: true,
      newEntryDisabled: true,
      symbol: decision.symbol,
      createdAt: now.toISOString(),
    }, now);
    await notify(repository, notificationEvent({
      userId, mode: config.mode, type: 'KILL_SWITCH', symbol: decision.symbol, direction: decision.direction,
      sourceEventId: `${simulation.executionId}:protective-stop-missing`, executionId: simulation.executionId,
      metadata: { reason: 'PROTECTIVE_STOP_MISSING' },
    }));
    return { duplicate: false, order: simulation, position: null, safeHalt: true };
  }
  const entryFeeKrw = simulation.notionalKrw * (AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent / 2) / 100;
  const position: RuntimePosition = {
    recordType: 'auto_trading_v2_position',
    mode: config.mode,
    symbol: decision.symbol,
    direction: decision.direction,
    status: 'ACTIVE',
    strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion,
    signalId: decision.signalId,
    executionId: simulation.executionId,
    clientOrderId: simulation.clientOrderId,
    entryPrice: simulation.entryPrice,
    stopPrice: simulation.stopPrice,
    targetPrice: simulation.targetPrice,
    trailingDistance: simulation.trailingDistance,
    trailingStop: null,
    notionalKrw: simulation.notionalKrw,
    requiredMarginKrw: simulation.requiredMarginKrw,
    leverage: simulation.leverage,
    riskPerTradePercent: decision.orderPlan.position.riskPerTradePercent,
    remainingFraction: 1,
    partialTpDone: false,
    positionProtected: true,
    realizedPnlKrw: 0,
    unrealizedPnlKrw: 0,
    entryFeeKrw,
    exitFeesKrw: 0,
    fundingCostKrw: 0,
    maxFavorableExcursionPercent: 0,
    maxAdverseExcursionPercent: 0,
    nextFundingTime: decision.snapshot.nextFundingTime,
    lastFundingAppliedAt: null,
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    executionStates: simulation.states,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
  };
  await upsert(repository, userId, 'position', `${RECORD_PREFIX}position-${decision.symbol}`, position as unknown as Record<string, unknown>, now);
  await notify(repository, notificationEvent({
    userId, mode: config.mode, type: 'POSITION_OPENED', symbol: decision.symbol, direction: decision.direction,
    sourceEventId: `${simulation.executionId}:opened`, executionId: simulation.executionId, price: simulation.entryPrice,
    metadata: { stopPrice: simulation.stopPrice, targetPrice: simulation.targetPrice, riskPercent: position.riskPerTradePercent, leverage: position.leverage },
  }));
  return { duplicate: false, order: simulation, position, safeHalt: false };
}

async function persistSignal(
  repository: PaperJournalRepository,
  userId: string,
  config: RuntimeConfig,
  decision: ReturnType<typeof evaluateAutoTradingV2Signal>,
  now = new Date(),
) {
  const id = `${RECORD_PREFIX}signal-${decision.signalId}`;
  if (!await repository.getRecord(userId, 'journal', id)) {
    await upsert(repository, userId, 'journal', id, {
      recordType: 'auto_trading_v2_signal',
      mode: config.mode,
      strategyId: decision.strategyId,
      strategyVersion: decision.strategyVersion,
      eligibility: decision.eligibility,
      signalId: decision.signalId,
      idempotencyKey: decision.idempotencyKey,
      symbol: decision.symbol,
      direction: decision.direction,
      regime: decision.regime,
      timeframe: decision.timeframe,
      allowed: decision.allowed,
      blockReasons: decision.blockReasons,
      reasons: decision.reasons,
      dataQuality: decision.snapshot.dataStale ? 'STALE' : 'GOOD',
      observedAt: decision.snapshot.observedAt,
      createdAt: now.toISOString(),
    }, now);
    if (decision.direction) await notify(repository, notificationEvent({
      userId, mode: config.mode === 'OFF' ? 'PAPER' : config.mode, type: 'SIGNAL_DETECTED', symbol: decision.symbol,
      direction: decision.direction, sourceEventId: `${decision.signalId}:signal`, strategy: decision.strategyId,
      price: decision.snapshot.markPrice, metadata: { allowed: decision.allowed, regime: decision.regime, blockReasons: decision.blockReasons },
    }));
  }
}

async function tickSymbol(
  repository: PaperJournalRepository,
  userId: string,
  config: RuntimeConfig,
  symbol: string,
  records: StoredPaperJournalRecord[],
  faultOptions: { stopRegistrationFails?: boolean; partialFillFraction?: number } = {},
) {
  const snapshot = await fetchAutoTradingV2PublicSnapshot(symbol);
  const active = activePositions(records).find((position) => position.symbol === symbol);
  if (active) {
    const position = await advancePosition(repository, userId, active, snapshot);
    return { symbol, snapshot, action: position.status === 'CLOSED' ? 'CLOSED' : 'POSITION_UPDATED', position };
  }
  const decision = evaluateAutoTradingV2Signal(snapshot, {
    equityKrw: config.equityKrw,
    mode: config.safeHalt ? 'OFF' : config.mode,
    riskPerTradePercent: config.riskPerTradePercent,
    leverage: config.leverage,
    stopMode: config.stopMode,
    atrMultiplier: config.atrMultiplier,
    dailyPnlPercent: config.dailyPnlPercent,
    weeklyDrawdownPercent: config.weeklyDrawdownPercent,
    consecutiveLosses: config.consecutiveLosses,
    protectiveStopMissing: false,
  });
  await persistSignal(repository, userId, config, decision);
  if (snapshot.dataStale && config.mode !== 'OFF') {
    await notify(repository, notificationEvent({
      userId, mode: config.mode, type: 'STALE_DATA', symbol, direction: decision.direction,
      sourceEventId: `${decision.signalId}:stale`, price: snapshot.markPrice,
      metadata: { observedAt: snapshot.observedAt, lastClosedCandleTime: snapshot.lastClosedCandleTime },
    }));
  }
  const risk = evaluateAutoTradingV2KillSwitch({
    dailyPnlPercent: config.dailyPnlPercent,
    weeklyDrawdownPercent: config.weeklyDrawdownPercent,
    consecutiveLosses: config.consecutiveLosses,
    marketDataStale: snapshot.dataStale,
    spreadAbnormal: snapshot.spreadPercent > AUTO_TRADING_V2_CONFIG.maxSpreadPercent,
    volatilityAbnormal: snapshot.atrPercent > AUTO_TRADING_V2_CONFIG.maxAtrPercent
      || snapshot.markIndexDislocationPercent > AUTO_TRADING_V2_CONFIG.maxMarkIndexDislocationPercent,
  });
  if (risk.reasons.length) {
    await upsert(repository, userId, 'journal', `${RECORD_PREFIX}risk-${decision.signalId}`, {
      recordType: 'auto_trading_v2_risk_event',
      symbol,
      signalId: decision.signalId,
      newEntryDisabled: risk.newEntryDisabled,
      safeHalt: risk.safeHalt,
      reasons: risk.reasons,
      createdAt: new Date().toISOString(),
    });
    await notify(repository, notificationEvent({
      userId, mode: config.mode === 'OFF' ? 'PAPER' : config.mode, type: 'KILL_SWITCH', symbol, direction: decision.direction,
      sourceEventId: `${decision.signalId}:risk:${risk.reasons.join(',')}`, price: snapshot.markPrice,
      metadata: { reasons: risk.reasons, safeHalt: risk.safeHalt, newEntryDisabled: risk.newEntryDisabled },
    }));
  }
  if (!decision.allowed || config.mode === 'OFF' || config.safeHalt || config.newEntryDisabled) {
    return { symbol, snapshot, action: 'NO_TRADE', decision, risk };
  }
  const opened = await openFromDecision(repository, userId, config, decision, new Date(), faultOptions);
  return { symbol, snapshot, action: opened?.duplicate ? 'DUPLICATE_BLOCKED' : opened?.safeHalt ? 'SAFE_HALT' : 'OPENED', decision, risk, opened };
}

function safeMode(value: unknown): Exclude<AutoTradingV2Mode, 'LIVE'> {
  const mode = String(value ?? '').toUpperCase();
  if (mode === 'LIVE') throw new Error('AUTO_TRADING_V2_LIVE_LOCKED');
  if (mode === 'PAPER' || mode === 'SHADOW' || mode === 'OFF') return mode;
  throw new Error('AUTO_TRADING_V2_MODE_INVALID');
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message.split(':')[0].slice(0, 120) : 'AUTO_TRADING_V2_FAILED';
}

function errorStatus(code: string) {
  if (code === 'LOGIN_REQUIRED') return 401;
  if (code === 'AUTO_TRADING_V2_LIVE_LOCKED') return 403;
  if (code.includes('PUBLIC_HTTP') || code.includes('STORAGE')) return 503;
  return 400;
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const [config, records] = await Promise.all([readConfig(repository, userId), repository.listSnapshot(userId)]);
    const reconciled = await reconciliation(repository, userId, records);
    const positions = activePositions(records);
    const latest = records
      .filter((record) => record.id.startsWith(RECORD_PREFIX) && !record.deletedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20)
      .map((record) => ({ kind: record.kind, id: record.id, updatedAt: record.updatedAt, payload: record.payload }));
    return res.json({
      ok: true,
      ...autoTradingV2SafetyEnvelope(),
      config,
      effectiveMode: config.safeHalt ? 'OFF' : config.mode,
      strategy: {
        id: AUTO_TRADING_V2_STRATEGY_ID,
        version: AUTO_TRADING_V2_STRATEGY_VERSION,
        eligibility: AUTO_TRADING_V2_CONFIG.strategyEligibility,
        parameterSelection: 'PARAMETER_STABILITY',
        rvolCandidatesPercent: AUTO_TRADING_V2_CONFIG.rvolCandidatesPercent,
        selectedRvolPercent: AUTO_TRADING_V2_CONFIG.selectedRvolPercent,
        researchOnlyProfitClaim: false,
      },
      supportedSymbols: AUTO_TRADING_V2_SUPPORTED_SYMBOLS,
      marginMode: 'ISOLATED',
      leverageCap: AUTO_TRADING_V2_CONFIG.leverageCap,
      positions,
      reconciliation: reconciled,
      latest,
      health: {
        app: 'UP',
        marketData: 'PUBLIC_ONLY',
        signalEngine: 'READY',
        riskEngine: config.safeHalt ? 'HALTED' : 'READY',
        executionEngine: config.safeHalt ? 'HALTED' : config.mode === 'OFF' ? 'OFF' : 'SIMULATION_READY',
        reconciliation: reconciled.state,
        database: 'UP',
        telegram: 'QUEUE_INTEGRATED',
        overall: config.safeHalt || reconciled.state !== 'SAFE' ? 'DEGRADED' : 'UP',
      },
    });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, ...autoTradingV2SafetyEnvelope() });
  }
});

router.get('/market', async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshots = await Promise.all(AUTO_TRADING_V2_SUPPORTED_SYMBOLS.map((symbol) => fetchAutoTradingV2PublicSnapshot(symbol)));
    return res.json({ ok: true, snapshots, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, snapshots: [], ...autoTradingV2SafetyEnvelope() });
  }
});

router.post('/mode', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const mode = safeMode(req.body?.mode);
    const current = await readConfig(repository, userId);
    const records = await repository.listSnapshot(userId);
    const reconciled = await reconciliation(repository, userId, records);
    if (mode !== 'OFF' && reconciled.state !== 'SAFE') {
      return res.status(409).json({ ok: false, error: 'AUTO_TRADING_V2_RECONCILIATION_REQUIRED', reconciliation: reconciled, ...autoTradingV2SafetyEnvelope() });
    }
    const body = isRecord(req.body) ? req.body : {};
    const next: RuntimeConfig = {
      ...current,
      mode,
      equityKrw: clamp(finite(body.equityKrw, current.equityKrw), 10_000, 10_000_000_000),
      riskPerTradePercent: clamp(finite(body.riskPerTradePercent, current.riskPerTradePercent), 0.01, AUTO_TRADING_V2_CONFIG.riskPerTradeMaxPercent),
      leverage: Math.round(clamp(finite(body.leverage, current.leverage), 1, AUTO_TRADING_V2_CONFIG.leverageCap)),
      stopMode: body.stopMode === 'FIXED_STOP' ? 'FIXED_STOP' : body.stopMode === 'ATR_STOP' ? 'ATR_STOP' : current.stopMode,
      atrMultiplier: clamp(finite(body.atrMultiplier, current.atrMultiplier), 1.5, 2.5),
      safeHalt: false,
      newEntryDisabled: false,
      haltReasons: [],
      updatedAt: new Date().toISOString(),
    };
    const saved = await saveConfig(repository, userId, next);
    return res.json({ ok: true, config: saved, reconciliation: reconciled, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, ...autoTradingV2SafetyEnvelope() });
  }
});

router.post('/risk-state', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const current = await readConfig(repository, userId);
    const next: RuntimeConfig = {
      ...current,
      dailyPnlPercent: finite(req.body?.dailyPnlPercent, current.dailyPnlPercent),
      weeklyDrawdownPercent: finite(req.body?.weeklyDrawdownPercent, current.weeklyDrawdownPercent),
      consecutiveLosses: Math.max(0, Math.round(finite(req.body?.consecutiveLosses, current.consecutiveLosses))),
      updatedAt: new Date().toISOString(),
    };
    const kill = evaluateAutoTradingV2KillSwitch(next);
    next.newEntryDisabled = kill.newEntryDisabled;
    next.safeHalt = kill.safeHalt;
    next.haltReasons = kill.reasons;
    const saved = await saveConfig(repository, userId, next);
    return res.json({ ok: true, config: saved, killSwitch: kill, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, ...autoTradingV2SafetyEnvelope() });
  }
});

router.post('/tick', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const config = await readConfig(repository, userId);
    if (config.mode === 'OFF') return res.json({ ok: true, action: 'OFF', results: [], config, ...autoTradingV2SafetyEnvelope() });
    const records = await repository.listSnapshot(userId);
    const reconciled = await reconciliation(repository, userId, records);
    if (config.safeHalt || reconciled.state !== 'SAFE') {
      return res.status(409).json({ ok: false, error: 'AUTO_TRADING_V2_SAFE_HALT', config, reconciliation: reconciled, ...autoTradingV2SafetyEnvelope() });
    }
    const requested = Array.isArray(req.body?.symbols) ? req.body.symbols.map((value: unknown) => String(value).toUpperCase()) : [...AUTO_TRADING_V2_SUPPORTED_SYMBOLS];
    const symbols = [...new Set(requested)].filter((symbol) => (AUTO_TRADING_V2_SUPPORTED_SYMBOLS as readonly string[]).includes(symbol));
    if (!symbols.length) throw new Error('AUTO_TRADING_V2_NO_SUPPORTED_SYMBOL');
    const allowFaultInjection = process.env.AUTO_TRADING_V2_FAULT_INJECTION === 'true' && process.env.NODE_ENV !== 'production';
    const faultOptions = allowFaultInjection ? {
      stopRegistrationFails: req.body?.simulateStopRegistrationFailure === true,
      partialFillFraction: finite(req.body?.partialFillFraction, 1),
    } : {};
    const results = [];
    let currentRecords = records;
    for (const symbol of symbols) {
      const result = await tickSymbol(repository, userId, config, symbol, currentRecords, faultOptions);
      results.push(result);
      currentRecords = await repository.listSnapshot(userId);
      if (result.action === 'SAFE_HALT') break;
    }
    return res.json({ ok: true, results, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, ...autoTradingV2SafetyEnvelope() });
  }
});

router.post('/reconcile', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const config = await readConfig(repository, userId);
    const result = await reconciliation(repository, userId);
    if (result.state !== 'SAFE' && config.mode !== 'OFF') {
      await saveConfig(repository, userId, { ...config, safeHalt: true, newEntryDisabled: true, haltReasons: result.reasons });
      await notify(repository, notificationEvent({
        userId, mode: config.mode, type: 'RECONCILIATION_ERROR', symbol: 'USDT-M',
        sourceEventId: `reconcile:${stableId(result.reasons.join('|'))}`, metadata: { reasons: result.reasons },
      }));
    }
    return res.status(result.state === 'SAFE' ? 200 : 409).json({ ok: result.state === 'SAFE', reconciliation: result, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, ...autoTradingV2SafetyEnvelope() });
  }
});

router.get('/journal', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = member(req);
    const records = (await repository.listSnapshot(userId))
      .filter((record) => record.id.startsWith(RECORD_PREFIX) && !record.deletedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_JOURNAL_ROWS)
      .map((record) => ({ kind: record.kind, id: record.id, version: record.version, updatedAt: record.updatedAt, payload: record.payload }));
    return res.json({ ok: true, records, ...autoTradingV2SafetyEnvelope() });
  } catch (error) {
    const code = errorCode(error);
    return res.status(errorStatus(code)).json({ ok: false, error: code, records: [], ...autoTradingV2SafetyEnvelope() });
  }
});

export default router;
