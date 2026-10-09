import type { StoredPaperJournalRecord } from './paper-journal.types';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import {
  ADMIN_FOUR_PAPER_MARKETS,
  adminMarketCurrentEpochSettlementScope,
  inspectAdminFourMarketPaperWallets,
  projectAdminMarketCapital,
  type AdminPaperMarket,
} from './admin-four-market-paper-capital.service';
import { tradeAutomationJournalPayloadsFromSnapshot } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';

type MarketCapital = ReturnType<typeof projectAdminMarketCapital>;
function quarantined(market: AdminPaperMarket, error: string, nowMs: number): MarketCapital {
  const neutral = projectAdminMarketCapital(market, [], nowMs);
  return Object.freeze({
    ...neutral, newEntriesAllowed: false, settlementReady: false,
    blockers: Object.freeze([error]),
  });
}

/**
 * One canonical, read-only settlement projection for the admin V2 Worker AND
 * the authenticated admin UI. Original wallets are immutable seed evidence,
 * not live trading equity and never proof of a settled reserve.
 */
export function adminFourMarketPaperCapitalReadback(input: {
  ownerId: string;
  records: readonly StoredPaperJournalRecord[];
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
  nowMs: number;
}) {
  const wallets = inspectAdminFourMarketPaperWallets(input.records, input.nowMs);
  const capital = {} as Record<AdminPaperMarket, MarketCapital>;
  const fullHistory = input.orders.length >= 500 || input.plans.length >= 200
    || input.records.length >= 500;
  const byPlan = new Map(input.plans.map(plan => [plan.id, plan]));
  // A server-owned replay can attach a NEW fill to a pre-wallet plan.
  // Dropping it from the new epoch's PnL, but reporting the market as
  // settled, disagrees with the automatic Worker and hides a live exposure.
  // Isolate the affected market, never quietly treat the fill as zero profit.
  const lateLegacyRetryMarkets = new Set<AdminPaperMarket>();
  const ownerScopeInvalid = input.plans.some(plan => plan.userId !== input.ownerId)
    || input.orders.some(order => order.userId !== input.ownerId);
  for (const order of input.orders) {
    const plan = byPlan.get(order.planId);
    if (!plan || plan.accountMode !== 'paper' || plan.executionMode !== 'automatic') continue;
    const market = adminPaperMarketFromPlan(plan);
    const openedAtMs = wallets.marketWallets[market].openedAtMs;
    if (openedAtMs == null) continue;
    const planTime = Date.parse(plan.createdAt);
    const orderTime = Date.parse(order.createdAt);
    if (!Number.isFinite(planTime) || !Number.isFinite(orderTime)
      || (planTime < openedAtMs && orderTime >= openedAtMs)) {
      lateLegacyRetryMarkets.add(market);
    }
  }
  // Unknown filled orders after a new epoch must not be hidden in an
  // unassigned market or silently priced at zero.
  const orphan = input.orders.some(order => {
    if (byPlan.has(order.planId)) return false;
    const stamp = Date.parse(order.createdAt);
    return wallets.ready && wallets.walletOpenedAtMs != null
      && Number.isFinite(stamp) && stamp >= wallets.walletOpenedAtMs
      && (order.state === 'FILLED' || order.state === 'PARTIALLY_FILLED'
        || order.state === 'RECOVERY_REQUIRED' || order.filledQuantity > 0);
  });

  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    const wallet = wallets.marketWallets[market];
    const fallback = (code: string) => { capital[market] = quarantined(market, code, input.nowMs); };
    if (!wallets.ready || wallet.openedAtMs == null) {
      fallback('ADMIN_PAPER_WALLET_NOT_READY'); continue;
    }
    if (fullHistory || orphan || ownerScopeInvalid) {
      fallback(fullHistory ? 'ADMIN_PAPER_LEDGER_HISTORY_TRUNCATED'
        : ownerScopeInvalid ? 'ADMIN_PAPER_OWNER_SCOPE_MISMATCH'
          : 'ADMIN_PAPER_ORPHAN_FILLED_ORDER');
      continue;
    }
    if (lateLegacyRetryMarkets.has(market)) {
      fallback('ADMIN_PAPER_LEGACY_RETRY_AFTER_NEW_EPOCH'); continue;
    }
    const scoped = adminMarketCurrentEpochSettlementScope({
      market, plans: input.plans, orders: input.orders,
      openedAtMs: wallet.openedAtMs, nowMs: input.nowMs,
    });
    if (!scoped.valid) { fallback('ADMIN_PAPER_WALLET_EPOCH_INVALID'); continue; }
    if (scoped.orders.some(order => ['FILLED','PARTIALLY_FILLED'].includes(order.state)
      && (!(order.filledQuantity > 0) || !(Number(order.averageFillPrice) > 0)))) {
      fallback('ADMIN_PAPER_FILL_EXECUTION_EVIDENCE_INCOMPLETE'); continue;
    }
    // If a new-epoch order has only an unknown plan ID the global guard
    // above quarantines every market before this projection is attempted.
    try {
      const raw = tradeAutomationJournalPayloadsFromSnapshot(
        input.ownerId, scoped.orders, scoped.plans,
      );
      const journal = buildUnifiedTradeJournal(raw, { source: 'APP_PAPER', range: 'ALL' },
        new Date(input.nowMs));
      if (journal.integrityIssues.length) {
        fallback('ADMIN_PAPER_JOURNAL_INTEGRITY_REQUIRED'); continue;
      }
      const closed = journal.trades.filter(trade => trade.source === 'APP_PAPER'
        && trade.status === 'CLOSED');
      capital[market] = projectAdminMarketCapital(market, closed.map(trade => ({
        id: trade.id, market, closedAt: trade.closedAt ?? '',
        netPnlKrw: trade.netPnl ?? Number.NaN,
        fullCostsVerified: trade.costEvidence.status === 'READY'
          && typeof trade.fees === 'number' && Number.isFinite(trade.fees)
          && typeof trade.tax === 'number' && Number.isFinite(trade.tax),
        closeTimeFxVerified: trade.currency === 'KRW',
      })), input.nowMs);
    } catch {
      fallback('ADMIN_PAPER_SETTLEMENT_READBACK_UNAVAILABLE');
    }
  }
  const marketReadback = Object.fromEntries(ADMIN_FOUR_PAPER_MARKETS.map(market => {
    const state = capital[market];
    const reported = state.settlementReady;
    return [market, Object.freeze({
      market,
      settlementReady: reported,
      blockers: state.blockers,
      operatingCapitalKrw: reported ? state.operatingCapitalKrw : null,
      reserveKrw: reported ? state.reserveKrw : null,
      dailyLosingTrades: reported ? state.dailyLosingTrades : null,
      newEntriesAllowed: reported && state.newEntriesAllowed,
      settledTrades: reported ? state.settledTrades : null,
    })];
  })) as Record<AdminPaperMarket, {
    market: AdminPaperMarket; settlementReady: boolean; blockers: readonly string[];
    operatingCapitalKrw: number | null; reserveKrw: number | null;
    dailyLosingTrades: number | null; newEntriesAllowed: boolean;
    settledTrades: number | null;
  }>;
  return Object.freeze({
    walletReady: wallets.ready,
    marketReadback,
    capital,
    realOrdersPlaced: false as const,
    reserveTransferred: false as const,
  });
}
