import type { TradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import {
  isEvidenceBackedAutoStrategyId,
  RULE_PACK_PILOT_PROFILE,
} from './evidence-backed-auto-strategy-catalog.service';

export type RulePackPilotLossReference = Readonly<{ closedAt: string; signalId: string }>;
export type RulePackPilotCapitalState = Readonly<{
  initialOperatingCapitalKrw: number;
  operatingCapitalKrw: number;
  reserveKrw: number;
  highWaterMarkKrw: number;
  maxEntryKrw: number;
  realizedNetPnlKrw: number;
  compoundedProfitKrw: number;
  settledTradeCount: number;
  dailyRealizedPnlKrw: number;
  dailyLosingTrades: number;
  consecutiveLosses: number;
  latestLossBySymbol: Readonly<Record<string, RulePackPilotLossReference>>;
  settlementReady: boolean;
  blockers: readonly string[];
  reserveWithdrawalAutomatic: false;
}>;
export type RulePackPilotRealizedTrade = Readonly<{
  id: string;
  symbol: string;
  signalId: string;
  closedAt: string;
  netPnlKrw: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function roundKrw(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function kstDay(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year + '-' + byType.month + '-' + byType.day;
}
function normalizedSymbol(value: string) {
  return value.trim().toUpperCase().replace(/^KRW-/u, '');
}

export function deriveRulePackPilotCapitalFromTrades(
  trades: readonly RulePackPilotRealizedTrade[],
  now = new Date(),
): RulePackPilotCapitalState {
  let operatingCapitalKrw = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  let reserveKrw = 0;
  let highWaterMarkKrw = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  let realizedNetPnlKrw = 0;
  let compoundedProfitKrw = 0;
  let consecutiveLosses = 0;
  let dailyRealizedPnlKrw = 0;
  let dailyLosingTrades = 0;
  const latestLossBySymbol: Record<string, RulePackPilotLossReference> = {};
  const today = kstDay(now);

  const sorted = [...trades].sort((left, right) => {
    const time = Date.parse(left.closedAt) - Date.parse(right.closedAt);
    return time !== 0 ? time : left.id.localeCompare(right.id);
  });

  for (const trade of sorted) {
    if (!finite(trade.netPnlKrw) || !Number.isFinite(Date.parse(trade.closedAt))) continue;
    const pnl = trade.netPnlKrw;
    realizedNetPnlKrw += pnl;
    if (kstDay(trade.closedAt) === today) {
      dailyRealizedPnlKrw += pnl;
      if (pnl < 0) dailyLosingTrades += 1;
    }

    if (pnl < 0) {
      operatingCapitalKrw = Math.max(0, operatingCapitalKrw + pnl);
      consecutiveLosses += 1;
      latestLossBySymbol[normalizedSymbol(trade.symbol)] = Object.freeze({
        closedAt: trade.closedAt, signalId: trade.signalId,
      });
      continue;
    }

    consecutiveLosses = 0;
    const totalBefore = operatingCapitalKrw + reserveKrw;
    const totalAfter = totalBefore + pnl;
    const newHighProfit = Math.max(0, totalAfter - highWaterMarkKrw);
    const recoveryProfit = Math.max(0, pnl - newHighProfit);
    const compound = newHighProfit * RULE_PACK_PILOT_PROFILE.profitCompoundShare;
    const reserve = newHighProfit - compound;
    operatingCapitalKrw += recoveryProfit + compound;
    reserveKrw += reserve;
    compoundedProfitKrw += compound;
    highWaterMarkKrw += newHighProfit;
  }

  return Object.freeze({
    initialOperatingCapitalKrw: RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw,
    operatingCapitalKrw: roundKrw(operatingCapitalKrw),
    reserveKrw: roundKrw(reserveKrw),
    highWaterMarkKrw: roundKrw(highWaterMarkKrw),
    maxEntryKrw: roundKrw(operatingCapitalKrw),
    realizedNetPnlKrw: roundKrw(realizedNetPnlKrw),
    compoundedProfitKrw: roundKrw(compoundedProfitKrw),
    settledTradeCount: sorted.length,
    dailyRealizedPnlKrw: roundKrw(dailyRealizedPnlKrw),
    dailyLosingTrades,
    consecutiveLosses,
    latestLossBySymbol: Object.freeze({ ...latestLossBySymbol }),
    settlementReady: true,
    blockers: Object.freeze([]),
    reserveWithdrawalAutomatic: false,
  });
}

function planForBrokerOrder(
  brokerOrderId: string,
  ordersByKey: Map<string, TradingOrder>,
  plansById: Map<string, TradingPlan>,
) {
  const order = ordersByKey.get(brokerOrderId) ?? null;
  return order ? plansById.get(order.planId) ?? null : null;
}

export async function readRulePackPilotCapitalState(
  repository: TradingRepository,
  userId: string,
  now = new Date(),
): Promise<RulePackPilotCapitalState> {
  const [payloads, orders, plans] = await Promise.all([
    readTradeAutomationJournalPayloads(repository, userId),
    repository.listOrders(userId),
    repository.listPlans(userId),
  ]);
  const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, now);
  const ordersByKey = new Map<string, TradingOrder>();
  for (const order of orders) {
    ordersByKey.set(order.id, order);
    if (order.exchangeOrderId) ordersByKey.set(order.exchangeOrderId, order);
  }
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  const trades: RulePackPilotRealizedTrade[] = [];
  const blockers: string[] = [];

  for (const trade of journal.trades) {
    if (trade.status !== 'CLOSED' || !trade.closedAt || !trade.strategy
      || !isEvidenceBackedAutoStrategyId(trade.strategy)
      || (trade.source !== 'APP_AUTO' && trade.source !== 'APP_MANUAL')) continue;
    const entryPlan = planForBrokerOrder(trade.initialEntry.orderId, ordersByKey, plansById);
    if (!entryPlan || entryPlan.accountMode !== 'live'
      || !isEvidenceBackedAutoStrategyId(entryPlan.strategyId)) {
      blockers.push('PILOT_CAPITAL_ENTRY_LINEAGE_UNAVAILABLE');
      continue;
    }

    const entryNotionalNative = trade.entryPrice * trade.initialEntry.quantity;
    if (!(entryNotionalNative > 0) || !(entryPlan.estimatedKrw > 0)) {
      blockers.push('PILOT_CAPITAL_ENTRY_FX_BASIS_UNAVAILABLE');
      continue;
    }
    if (trade.fees == null || !finite(trade.fees)) {
      blockers.push('PILOT_CAPITAL_FEE_EVIDENCE_UNAVAILABLE');
      continue;
    }
    if (trade.market === 'KR_STOCK' && (trade.tax == null || !finite(trade.tax))) {
      blockers.push('PILOT_CAPITAL_KR_TAX_EVIDENCE_UNAVAILABLE');
      continue;
    }

    const tax = trade.tax == null ? 0 : trade.tax;
    const netPnlNative = trade.grossPnl - trade.fees - tax;
    const krwPerQuote = entryPlan.estimatedKrw / entryNotionalNative;
    if (!finite(krwPerQuote) || krwPerQuote <= 0) {
      blockers.push('PILOT_CAPITAL_FX_BASIS_INVALID');
      continue;
    }
    trades.push(Object.freeze({
      id: trade.id, symbol: trade.symbol, signalId: entryPlan.signalId,
      closedAt: trade.closedAt, netPnlKrw: netPnlNative * krwPerQuote,
    }));
  }

  const derived = deriveRulePackPilotCapitalFromTrades(trades, now);
  const uniqueBlockers = [...new Set(blockers)].sort();
  return Object.freeze({
    ...derived,
    settlementReady: uniqueBlockers.length === 0,
    blockers: Object.freeze(uniqueBlockers),
  });
}