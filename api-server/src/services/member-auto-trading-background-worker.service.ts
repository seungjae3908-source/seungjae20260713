import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasCapability, type MemberAccessProfile } from '../../../packages/member-access/src/index.js';
import {
  validateMemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoffEntry,
} from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  createServiceRoleTradingRepository,
  type TradingRepository,
} from './trade-automation.repository';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import {
  createServiceRolePaperJournalRepository,
} from './paper-journal-supabase.repository';
import type { PaperJournalRepository } from './paper-journal.types';
import type {
  TradingAssetClass,
  TradingExchange,
  TradingOrder,
  TradingPlan,
  TradingPlanInput,
  TradingPolicy,
  TradingSide,
} from './trade-automation.types';
import {
  resolveMemberAutoTradingKrwRate,
  type MemberAutoTradingFxQuote,
} from './member-auto-trading-fx.service';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_HANDOFF_PATH =
  '/opt/stock-app-data/paper-forward-v1/runtime-state/handoff/member-auto-trading-latest.json';
const MAX_MEMBERS_PER_TICK = 200;
const MAX_ENTRIES_PER_TICK = 40;
const ACTIVE_ORDER_STATES = new Set([
  'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'RECOVERY_REQUIRED',
]);

type EligibleMember = Readonly<{
  userId: string;
  profile: MemberAccessProfile;
  policy: TradingPolicy;
}>;

type MemberRuntimeState = Readonly<{
  accountEquity: number;
  dailyPnlPercent: number;
  weeklyPnlPercent: number;
  consecutiveLosses: number;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
}>;

export interface MemberAutoTradingBackgroundSource {
  readHandoff(nowMs: number): Promise<MemberAutoTradingPaperHandoff | null>;
  listEligibleMembers(): Promise<readonly EligibleMember[]>;
  tradingRepositoryFor(userId: string): TradingRepository;
  paperJournalRepositoryFor(userId: string): PaperJournalRepository;
  resolveFx(
    market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
    nowMs: number,
  ): Promise<MemberAutoTradingFxQuote>;
}

export type MemberAutoTradingBackgroundRunResult = {
  handoffStatus: 'MISSING' | 'BLOCKED_DATA' | 'READY';
  members: number;
  entries: number;
  evaluated: number;
  skipped: number;
  blocked: number;
  createdPlans: number;
  filledOrders: number;
  duplicates: number;
  failures: number;
  liveOrders: 0;
  privateTradingRequests: 0;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketMapping(market: MemberAutoTradingPaperHandoffEntry['identity']['market']): {
  exchange: TradingExchange;
  assetClass: TradingAssetClass;
  planMarket: string;
} {
  if (market === 'KR_STOCK') return { exchange: 'kiwoom', assetClass: 'domestic_stock', planMarket: 'KR' };
  if (market === 'US_STOCK') return { exchange: 'kiwoom', assetClass: 'us_stock', planMarket: 'US' };
  if (market === 'CRYPTO_SPOT') return { exchange: 'upbit', assetClass: 'crypto_spot', planMarket: 'KRW' };
  return { exchange: 'bitget', assetClass: 'crypto_futures', planMarket: 'USDT-FUTURES' };
}

function sideFor(direction: MemberAutoTradingPaperHandoffEntry['identity']['direction']): TradingSide {
  if (direction === 'BUY') return 'buy';
  if (direction === 'LONG') return 'long';
  return 'short';
}

function currentPrice(entry: MemberAutoTradingPaperHandoffEntry) {
  const quote = record(entry.publicQuote);
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!positive(bid) || !positive(ask) || ask < bid) throw new Error('BACKGROUND_TOP_OF_BOOK_REQUIRED');
  const midpoint = (bid + ask) / 2;
  return {
    bid,
    ask,
    midpoint,
    executionPrice: entry.identity.direction === 'SHORT' ? bid : ask,
    spreadPercent: (ask - bid) / midpoint * 100,
  };
}

function recentMovePercent(entry: MemberAutoTradingPaperHandoffEntry, observedAtMs: number, midpoint: number) {
  const learning = record(entry.signal.learningSnapshot);
  const reference = Number(learning?.referencePrice ?? learning?.entryPrice);
  const dataTimestampMs = isoMs(learning?.dataTimestamp);
  if (!positive(reference) || dataTimestampMs == null
    || dataTimestampMs > observedAtMs || observedAtMs - dataTimestampMs > 60_000) {
    throw new Error('BACKGROUND_ONE_MINUTE_MOVE_EVIDENCE_REQUIRED');
  }
  return (midpoint - reference) / reference * 100;
}

function exitPlan(entry: MemberAutoTradingPaperHandoffEntry) {
  const learning = record(entry.signal.learningSnapshot);
  const stop = Number(learning?.stopLoss);
  const targets = [learning?.target1, learning?.target2]
    .map(Number)
    .filter((value): value is number => positive(value));
  if (!positive(stop) || targets.length === 0) throw new Error('BACKGROUND_EXIT_PLAN_REQUIRED');
  const price = currentPrice(entry).executionPrice;
  const long = entry.identity.direction !== 'SHORT';
  if ((long && stop >= price) || (!long && stop <= price)) throw new Error('BACKGROUND_STOP_DIRECTION_INVALID');
  if (targets.some((target) => long ? target <= price : target >= price)) {
    throw new Error('BACKGROUND_TARGET_DIRECTION_INVALID');
  }
  return { stop, targets };
}

function costPercent(entry: MemberAutoTradingPaperHandoffEntry, key: string) {
  const cost = record(entry.execution.costPolicy);
  const rate = Number(cost?.[key]);
  return finite(rate) && rate >= 0 ? rate * 100 : null;
}

function policyAllowsEntry(member: EligibleMember, entry: MemberAutoTradingPaperHandoffEntry) {
  const mapping = marketMapping(entry.identity.market);
  const policy = member.policy;
  if (policy.mode !== 'automatic' || !policy.automaticEnabled || policy.emergencyStopped || policy.newEntriesStopped) return false;
  if (!policy.marketEnabled[mapping.assetClass] || !policy.exchangeEnabled[mapping.exchange]) return false;
  const symbol = mapping.exchange === 'upbit'
    ? entry.identity.symbol.toUpperCase().replace(/^KRW-/u, '')
    : entry.identity.symbol.toUpperCase();
  const assets = policy.enabledAssets[mapping.exchange];
  if (assets.length > 0 && !assets.includes(symbol)) return false;
  if (policy.enabledStrategies.length > 0 && !policy.enabledStrategies.includes(entry.identity.strategyId)) return false;
  return true;
}

function activePlans(plans: readonly TradingPlan[], orders: readonly TradingOrder[]) {
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  return orders
    .filter((order) => ACTIVE_ORDER_STATES.has(order.state))
    .flatMap((order) => {
      const plan = planById.get(order.planId);
      return plan ? [plan] : [];
    });
}

function currentConsecutiveLosses(journal: readonly Record<string, unknown>[]) {
  const closed = journal
    .filter((row) => typeof row.closedAt === 'string' && finite(Number(row.netPnl)))
    .sort((a, b) => Date.parse(String(b.closedAt)) - Date.parse(String(a.closedAt)));
  let count = 0;
  for (const row of closed) {
    if (Number(row.netPnl) < 0) count += 1;
    else break;
  }
  return count;
}

function pnlPercentSince(
  journal: readonly Record<string, unknown>[],
  equity: number,
  cutoffMs: number,
) {
  const pnl = journal.reduce((sum, row) => {
    const closedAt = isoMs(row.closedAt);
    const net = Number(row.netPnl);
    return closedAt != null && closedAt >= cutoffMs && finite(net) ? sum + net : sum;
  }, 0);
  return pnl / equity * 100;
}

async function memberRuntimeState(
  userId: string,
  repository: TradingRepository,
  paper: PaperJournalRepository,
  nowMs: number,
): Promise<MemberRuntimeState> {
  const [records, plans, orders] = await Promise.all([
    paper.listSnapshot(userId),
    repository.listPlans(userId),
    repository.listOrders(userId),
  ]);
  const accounts = records.filter((row) => row.kind === 'account' && row.deletedAt == null)
    .map((row) => record(row.payload))
    .filter((row): row is Record<string, unknown> => row != null);
  if (accounts.length !== 1 || !positive(Number(accounts[0]?.equity))) {
    throw new Error('BACKGROUND_PAPER_ACCOUNT_REQUIRED');
  }
  const equity = Number(accounts[0]!.equity);
  const journal = records.filter((row) => row.kind === 'journal' && row.deletedAt == null)
    .map((row) => record(row.payload))
    .filter((row): row is Record<string, unknown> => row != null);
  return Object.freeze({
    accountEquity: equity,
    dailyPnlPercent: pnlPercentSince(journal, equity, nowMs - 24 * 60 * 60_000),
    weeklyPnlPercent: pnlPercentSince(journal, equity, nowMs - 7 * 24 * 60 * 60_000),
    consecutiveLosses: currentConsecutiveLosses(journal),
    plans,
    orders,
  });
}

function exposureState(
  runtime: MemberRuntimeState,
  policy: TradingPolicy,
  entry: MemberAutoTradingPaperHandoffEntry,
  nowMs: number,
) {
  const active = activePlans(runtime.plans, runtime.orders);
  const mapping = marketMapping(entry.identity.market);
  const side = sideFor(entry.identity.direction);
  const sameInstrument = active.filter((plan) => plan.exchange === mapping.exchange
    && plan.symbol.toUpperCase() === entry.identity.symbol.toUpperCase());
  const sameStrategy = active.filter((plan) => plan.strategyId === entry.identity.strategyId);
  const sameClass = active.filter((plan) => marketMappingForPlan(plan).assetClass === mapping.assetClass);
  const sum = (plans: readonly TradingPlan[]) => plans.reduce((total, plan) => total + Math.max(0, Number(plan.estimatedKrw) || 0), 0);
  const accountExposureKrw = sum(active);
  const instrumentExposureKrw = sum(sameInstrument);
  return {
    accountExposureKrw,
    instrumentExposureKrw,
    strategyExposureKrw: sum(sameStrategy),
    assetClassExposureKrw: sum(sameClass),
    openRiskKrw: active.reduce((total, plan) => total + plannedRiskKrw(plan), 0),
    openPositionCount: active.length,
    dailyOrderCount: runtime.orders.filter((order) => {
      const at = Date.parse(order.createdAt);
      return Number.isFinite(at) && at >= nowMs - 24 * 60 * 60_000;
    }).length,
    existingPositionSide: sameInstrument.find((plan) => plan.side === side)?.side
      ?? sameInstrument[0]?.side
      ?? null,
    assetExposurePercent: instrumentExposureKrw / Math.max(1, policy.totalCapitalKrw) * 100,
    availableBalance: Math.max(0, policy.totalCapitalKrw - accountExposureKrw),
  };
}

function marketMappingForPlan(plan: TradingPlan) {
  if (plan.exchange === 'upbit') return { assetClass: 'crypto_spot' as const };
  if (plan.exchange === 'bitget') return { assetClass: 'crypto_futures' as const };
  return { assetClass: plan.market === 'US' ? 'us_stock' as const : 'domestic_stock' as const };
}

function plannedRiskKrw(plan: TradingPlan) {
  const reference = Number(plan.entryPrice ?? plan.limitPrice ?? plan.marketSnapshot.currentPrice);
  const stop = Number(plan.stopPrice);
  return positive(reference) && positive(stop)
    ? Math.max(0, Number(plan.estimatedKrw) || 0) * Math.abs(reference - stop) / reference
    : Math.max(0, Number(plan.estimatedKrw) || 0);
}

function snapshotMarketStatus(entry: MemberAutoTradingPaperHandoffEntry) {
  const evidence = record(entry.execution.dataEvidence);
  const session = record(evidence?.session);
  if (entry.identity.market === 'KR_STOCK' || entry.identity.market === 'US_STOCK') {
    const status = String(session?.status ?? 'UNKNOWN').toUpperCase();
    return status === 'OPEN' ? 'OPEN' as const : status === 'HALTED' ? 'HALTED' as const : 'CLOSED' as const;
  }
  const status = String(evidence?.marketStatus ?? evidence?.contractStatus ?? '').toUpperCase();
  return status === 'TRADABLE' ? 'OPEN' as const : 'HALTED' as const;
}

function buildPlanInput(
  member: EligibleMember,
  entry: MemberAutoTradingPaperHandoffEntry,
  runtime: MemberRuntimeState,
  fx: MemberAutoTradingFxQuote,
  nowMs: number,
): TradingPlanInput {
  const mapping = marketMapping(entry.identity.market);
  const quote = currentPrice(entry);
  const exits = exitPlan(entry);
  const evidence = record(entry.execution.dataEvidence);
  const observedAtMs = Number(evidence?.asOfMs);
  if (!finite(observedAtMs) || observedAtMs <= 0 || observedAtMs > nowMs) {
    throw new Error('BACKGROUND_MARKET_TIMESTAMP_INVALID');
  }
  const move = recentMovePercent(entry, observedAtMs, quote.midpoint);
  const quantity = Number(entry.riskEvidence.recommendedQuantity);
  if (!positive(quantity)) throw new Error('BACKGROUND_RISK_QUANTITY_REQUIRED');
  if (mapping.exchange === 'kiwoom' && !Number.isSafeInteger(quantity)) {
    throw new Error('BACKGROUND_STOCK_QUANTITY_MUST_BE_INTEGER');
  }
  const estimatedKrw = quantity * quote.executionPrice * fx.krwPerQuoteCurrency;
  if (!positive(estimatedKrw)) throw new Error('BACKGROUND_ORDER_KRW_INVALID');

  const exposure = exposureState(runtime, member.policy, entry, nowMs);
  const slippage = costPercent(entry, 'slippageRate');
  const fee = costPercent(entry, 'commissionRate');
  const averageSpread = costPercent(entry, 'spreadRate');
  if (slippage == null || fee == null || averageSpread == null) {
    throw new Error('BACKGROUND_COST_EVIDENCE_REQUIRED');
  }
  const marketStatus = snapshotMarketStatus(entry);
  const leverageEvidence = Number(evidence?.leverage);
  const marginModeEvidence = String(evidence?.marginMode ?? '').toLowerCase();
  let leverage: 2 | 3 | null = null;
  let marginMode: 'crossed' | 'isolated' | null = null;
  if (mapping.exchange === 'bitget') {
    if ((leverageEvidence !== 2 && leverageEvidence !== 3)
      || leverageEvidence !== member.policy.bitgetLeverage) {
      throw new Error('BACKGROUND_LEVERAGE_EVIDENCE_MISMATCH');
    }
    if (marginModeEvidence !== 'crossed' && marginModeEvidence !== 'isolated') {
      throw new Error('BACKGROUND_MARGIN_MODE_EVIDENCE_REQUIRED');
    }
    leverage = leverageEvidence;
    marginMode = marginModeEvidence;
  }

  const side = sideFor(entry.identity.direction);
  const observedAt = new Date(observedAtMs).toISOString();
  const signalObservedAt = typeof entry.signal.timestampMs === 'number'
    ? new Date(entry.signal.timestampMs).toISOString()
    : observedAt;

  return {
    exchange: mapping.exchange,
    accountMode: 'paper',
    strategyId: entry.identity.strategyId,
    signalId: entry.identity.signalId,
    symbol: entry.identity.symbol,
    market: mapping.planMarket,
    side,
    orderType: 'market',
    quantity,
    quoteAmount: mapping.exchange === 'upbit' ? estimatedKrw : null,
    limitPrice: quote.executionPrice,
    estimatedKrw,
    stopPrice: exits.stop,
    targetPrices: exits.targets,
    splitRatios: [100],
    leverage,
    marginMode,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: [
      'CANONICAL_PAPER_HANDOFF',
      `HANDOFF_ID:${entry.handoffId}`,
      `FX:${fx.source}`,
      'TOP_OF_BOOK_GAP_PROXY',
    ],
    marketSnapshot: {
      observedAt,
      riskObservedAt: observedAt,
      dataDelayMs: nowMs - observedAtMs,
      oneMinuteMovePercent: move,
      spreadPercent: quote.spreadPercent,
      orderbookGapPercent: quote.spreadPercent,
      halted: marketStatus !== 'OPEN',
      availableBalance: exposure.availableBalance,
      accountValueKrw: member.policy.totalCapitalKrw,
      dailyPnlPercent: runtime.dailyPnlPercent,
      weeklyPnlPercent: runtime.weeklyPnlPercent,
      assetExposurePercent: exposure.assetExposurePercent,
      accountExposureKrw: exposure.accountExposureKrw,
      instrumentExposureKrw: exposure.instrumentExposureKrw,
      strategyExposureKrw: exposure.strategyExposureKrw,
      assetClassExposureKrw: exposure.assetClassExposureKrw,
      openRiskKrw: exposure.openRiskKrw,
      openPositionCount: exposure.openPositionCount,
      dailyOrderCount: exposure.dailyOrderCount,
      consecutiveLosses: runtime.consecutiveLosses,
      existingPositionSide: exposure.existingPositionSide,
      liquidationDistancePercent: mapping.exchange === 'bitget'
        ? Number(evidence?.liquidationDistancePct)
        : null,
      openOrderExposureKrw: exposure.accountExposureKrw,
      currentPrice: quote.midpoint,
      plannedPrice: quote.executionPrice,
      marketStatus,
      providerTimeOffsetMs: nowMs - observedAtMs,
      source: `member-auto-trading-paper-handoff-v1:${String(evidence?.provider ?? 'PUBLIC')}:TOP_OF_BOOK`,
      availableLiquidityKrw: null,
      estimatedSlippagePercent: slippage,
      estimatedFeePercent: fee,
      correlatedExposurePercent: null,
      signalState: 'entry_ready',
      signalObservedAt,
    },
    entryPrice: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    estimatedSlippagePercent: null,
    averageSpreadPercent: null,
    economics: null,
  };
}

function intervalMs(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(parsed)))
    : DEFAULT_INTERVAL_MS;
}

function errorCode(error: unknown) {
  const value = error instanceof Error ? error.message.split(':')[0] : 'BACKGROUND_AUTOMATION_FAILED';
  return /^[A-Z0-9_]+$/u.test(value) ? value : 'BACKGROUND_AUTOMATION_FAILED';
}

export class MemberAutoTradingBackgroundWorker {
  private running = false;

  constructor(private readonly source: MemberAutoTradingBackgroundSource) {}

  async runOnce(now = new Date()): Promise<MemberAutoTradingBackgroundRunResult> {
    const result: MemberAutoTradingBackgroundRunResult = {
      handoffStatus: 'MISSING',
      members: 0,
      entries: 0,
      evaluated: 0,
      skipped: 0,
      blocked: 0,
      createdPlans: 0,
      filledOrders: 0,
      duplicates: 0,
      failures: 0,
      liveOrders: 0,
      privateTradingRequests: 0,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const nowMs = now.getTime();
      const handoff = await this.source.readHandoff(nowMs);
      if (!handoff) return result;
      result.handoffStatus = handoff.status;
      if (handoff.status !== 'READY' || handoff.entryCount === 0) return result;

      const members = (await this.source.listEligibleMembers()).slice(0, MAX_MEMBERS_PER_TICK);
      result.members = members.length;
      const entries = handoff.entries.slice(0, MAX_ENTRIES_PER_TICK);
      result.entries = entries.length;
      const fxCache = new Map<string, MemberAutoTradingFxQuote>();

      for (const member of members) {
        if (!hasCapability(member.profile, 'canAccessAutoTrading')) {
          result.skipped += entries.length;
          continue;
        }
        const repository = this.source.tradingRepositoryFor(member.userId);
        const paper = this.source.paperJournalRepositoryFor(member.userId);
        let runtime: MemberRuntimeState;
        try {
          runtime = await memberRuntimeState(member.userId, repository, paper, nowMs);
        } catch {
          result.blocked += entries.length;
          continue;
        }

        for (const entry of entries) {
          if (!policyAllowsEntry(member, entry)) {
            result.skipped += 1;
            continue;
          }
          result.evaluated += 1;
          try {
            let fx = fxCache.get(entry.identity.market);
            if (!fx) {
              fx = await this.source.resolveFx(entry.identity.market, nowMs);
              fxCache.set(entry.identity.market, fx);
            }
            const input = buildPlanInput(member, entry, runtime, fx, nowMs);
            const automation = new TradeAutomationService(repository);
            const execution = new TradeExecutionService(repository);
            const persistentStop = await repository.getGlobalEmergencyStop();
            const created = await automation.createPlan(
              member.userId,
              input,
              member.policy,
              member.policy.emergencyStopped
                || persistentStop
                || process.env.TRADING_EMERGENCY_STOP === 'true',
            );
            if (!created.plan) {
              result.blocked += 1;
              continue;
            }
            if (created.duplicate) result.duplicates += 1;
            else result.createdPlans += 1;

            let plan = created.plan;
            if (plan.state === 'APPROVAL_PENDING') {
              plan = await automation.beginAutomaticPlan(member.userId, plan.id);
            }
            if (plan.state !== 'SUBMITTED') {
              result.blocked += 1;
              continue;
            }
            const createdOrder = await automation.createOrder(member.userId, plan);
            if (createdOrder.duplicate) result.duplicates += 1;
            const order = createdOrder.duplicate
              ? createdOrder.order
              : await execution.execute(member.userId, plan, createdOrder.order);
            if (order.state === 'FILLED') result.filledOrders += createdOrder.duplicate ? 0 : 1;
            else if (order.state === 'REJECTED' || order.state === 'RECOVERY_REQUIRED') result.blocked += 1;
          } catch (error) {
            const code = errorCode(error);
            if (code.startsWith('BACKGROUND_')
              || code.includes('RISK')
              || code.includes('LIMIT')
              || code.includes('BLOCKED')) result.blocked += 1;
            else result.failures += 1;
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}

export class SupabaseMemberAutoTradingBackgroundSource implements MemberAutoTradingBackgroundSource {
  constructor(
    private readonly client: SupabaseClient = getSupabase(),
    private readonly handoffPath = process.env.MEMBER_AUTO_TRADING_HANDOFF_PATH?.trim()
      || DEFAULT_HANDOFF_PATH,
  ) {
    if (!hasSupabaseServerKey()) throw new Error('TRADE_AUTOMATION_SERVICE_ROLE_REQUIRED');
  }

  async readHandoff(nowMs: number) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.resolve(this.handoffPath), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    return validateMemberAutoTradingPaperHandoff(parsed, nowMs);
  }

  async listEligibleMembers() {
    const { data, error } = await this.client.from('trade_automation_profiles')
      .select('user_id,payload').limit(MAX_MEMBERS_PER_TICK);
    if (error) throw new Error('BACKGROUND_POLICY_LIST_FAILED');
    const rows = (data ?? []).flatMap((row) => {
      const userId = String(row.user_id ?? '').trim();
      if (!userId) return [];
      const policy = normalizeTradingPolicy((row.payload ?? {}) as Partial<TradingPolicy>);
      return policy.mode === 'automatic' && policy.automaticEnabled ? [{ userId, policy }] : [];
    });
    if (rows.length === 0) return [];
    const { data: profiles, error: profileError } = await this.client.from('profiles')
      .select('id,role,status,membership_level,is_active').in('id', rows.map((row) => row.userId));
    if (profileError) throw new Error('BACKGROUND_MEMBER_LIST_FAILED');
    const byId = new Map((profiles ?? []).map((profile) => [String(profile.id), profile as MemberAccessProfile & { id: string }]));
    return rows.flatMap((row) => {
      const profile = byId.get(row.userId);
      return profile && hasCapability(profile, 'canAccessAutoTrading')
        ? [Object.freeze({ userId: row.userId, policy: row.policy, profile })]
        : [];
    });
  }

  tradingRepositoryFor(userId: string) {
    return createServiceRoleTradingRepository(userId, this.client);
  }

  paperJournalRepositoryFor(userId: string) {
    return createServiceRolePaperJournalRepository(userId, this.client);
  }

  resolveFx(market: MemberAutoTradingPaperHandoffEntry['identity']['market'], nowMs: number) {
    return resolveMemberAutoTradingKrwRate(market, { nowMs });
  }
}

export function startMemberAutoTradingBackgroundWorker(): { stop(): void } | null {
  if (process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED !== 'true') {
    console.log('[member-auto-trading-background] disabled; explicit enable flag is required');
    return null;
  }
  if (!hasSupabaseServerKey()) {
    console.error('[member-auto-trading-background] blocked: service-role Supabase configuration is required');
    return null;
  }
  const worker = new MemberAutoTradingBackgroundWorker(new SupabaseMemberAutoTradingBackgroundSource());
  const tick = async () => {
    try {
      const result = await worker.runOnce(new Date());
      if (result.evaluated > 0 || result.failures > 0) {
        console.log('[member-auto-trading-background] tick', result);
      }
    } catch (error) {
      console.error('[member-auto-trading-background] tick failed', {
        errorCode: errorCode(error),
      });
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs(process.env.MEMBER_AUTO_TRADING_BACKGROUND_INTERVAL_MS));
  timer.unref?.();
  console.log('[member-auto-trading-background] started in Paper-only mode');
  return { stop: () => clearInterval(timer) };
}
