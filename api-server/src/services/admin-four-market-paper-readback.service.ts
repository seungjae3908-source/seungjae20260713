import type { StoredPaperJournalRecord } from './paper-journal.types';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import {
  ADMIN_FOUR_PAPER_MARKETS,
  adminPaperMarketFromPlan,
  adminMarketCurrentEpochSettlementScope,
  inspectAdminFourMarketPaperWallets,
  projectAdminMarketCapital,
  type AdminPaperMarket,
} from './admin-four-market-paper-capital.service';
import { tradeAutomationJournalPayloadsFromSnapshot } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal, type TradeLeg, type UnifiedTradeCycle } from './unified-trade-journal.service';

type MarketCapital = ReturnType<typeof projectAdminMarketCapital>;

/**
 * Only an actual same-fill Paper cost + FX receipt, durably persisted with
 * each canonical order, can produce an administrative KRW settlement.
 * USD cash equities have entry/exit currency exposure. USDT-margined futures
 * settle native instrument PnL in USDT on close, not FX gain on notional.
 */
function verifiedClosedPaperPnlKrw(
  trade: UnifiedTradeCycle,
  market: AdminPaperMarket,
  ordersById: ReadonlyMap<string, TradingOrder>,
  nowMs: number,
) {
  const blocked = {
    netPnlKrw: Number.NaN,
    fullCostsVerified: false,
    closeTimeFxVerified: false,
  } as const;
  const currency = market === 'domestic_stock' || market === 'crypto_spot' ? 'KRW'
    : market === 'us_stock' ? 'USD' : 'USDT';
  if (trade.status !== 'CLOSED' || trade.currency !== currency
    || trade.costEvidence.status !== 'READY' || !trade.finalExit) return blocked;
  const entries: TradeLeg[] = [trade.initialEntry, ...trade.additions];
  const exits: TradeLeg[] = [...trade.partialExits, trade.finalExit];
  if (!entries.length || !exits.length) return blocked;
  const expectedSource = currency === 'KRW' ? 'NATIVE_KRW'
    : currency === 'USD' ? 'YAHOO:USDKRW=X' : 'UPBIT:KRW-USDT';
  const freshnessMs = currency === 'USD' ? 24 * 60 * 60_000
    : currency === 'USDT' ? 10 * 60_000 : 5 * 60_000;
  let entryQty = 0;
  let exitQty = 0;
  let entryKrw = 0;
  let exitKrw = 0;
  let entryNative = 0;
  let costsKrw = 0;
  const exitFx: Array<{ quantity: number; price: number; rate: number }> = [];
  for (const [positionEffect, legs] of [['ENTRY', entries], ['EXIT', exits]] as const) {
    for (const leg of legs) {
      const order = ordersById.get(leg.orderId);
      const evidence = order?.settlementFxEvidence;
      const at = Date.parse(leg.at);
      const quoteAt = Date.parse(evidence?.observedAt ?? '');
      const rate = evidence?.krwPerQuoteCurrency;
      if (!order || (order.state !== 'FILLED' && order.state !== 'PARTIALLY_FILLED')
        || !Number.isFinite(at) || at > nowMs + 5_000
        || !Number.isFinite(quoteAt) || !Number.isFinite(rate)
        || rate == null || rate <= 0
        || (currency === 'KRW' && rate !== 1)
        || evidence?.source !== expectedSource
        || quoteAt > at + 5_000 || at - quoteAt > freshnessMs
        || order.feeCurrency?.toUpperCase() !== currency
        || order.taxCurrency?.toUpperCase() !== currency
        || typeof order.feeAmount !== 'number' || order.feeAmount < 0
        || typeof order.taxAmount !== 'number' || order.taxAmount < 0
        || !Number.isFinite(leg.price) || leg.price <= 0
        || !Number.isFinite(leg.quantity) || leg.quantity <= 0
        || typeof leg.fees !== 'number' || !Number.isFinite(leg.fees) || leg.fees < 0
        || typeof leg.tax !== 'number' || !Number.isFinite(leg.tax) || leg.tax < 0) {
        return blocked;
      }
      const notional = leg.price * leg.quantity;
      costsKrw += (leg.fees + leg.tax) * rate;
      if (positionEffect === 'ENTRY') {
        entryQty += leg.quantity;
        entryKrw += notional * rate;
        entryNative += notional;
      } else {
        exitQty += leg.quantity;
        exitKrw += notional * rate;
        exitFx.push({ quantity: leg.quantity, price: leg.price, rate });
      }
    }
  }
  const quantityTolerance = Math.max(1e-9, entryQty * 1e-8);
  if (!(entryQty > 0) || Math.abs(entryQty - exitQty) > quantityTolerance) return blocked;
  const long = trade.positionSide === 'LONG';
  let grossKrw = long ? exitKrw - entryKrw : entryKrw - exitKrw;
  if (market === 'crypto_futures') {
    // USDT perpetuals realize price difference in USDT. Do not create
    // fictitious FX gains on the full notional at the entry date.
    const weightedEntryPrice = entryNative / entryQty;
    grossKrw = exitFx.reduce((sum, leg) =>
      sum + (long ? leg.price - weightedEntryPrice
        : weightedEntryPrice - leg.price) * leg.quantity * leg.rate, 0);
  }
  const net = grossKrw - costsKrw;
  if (!Number.isFinite(net)) return blocked;
  return Object.freeze({
    netPnlKrw: net,
    fullCostsVerified: true,
    closeTimeFxVerified: true,
  });
}

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
      // The journal's TradeLeg.orderId is the canonical broker-facing order
      // identity (exchangeOrderId ?? id), not the private database row UUID.
      // Key the same way as tradeAutomationJournalPayloadsFromSnapshot and
      // reject duplicate aliases before one order can certify another fill.
      const ordersByJournalId = new Map<string, TradingOrder>();
      let journalIdCollision = false;
      for (const order of scoped.orders) {
        const journalId = order.exchangeOrderId ?? order.id;
        if (!journalId || ordersByJournalId.has(journalId)) {
          journalIdCollision = true;
          break;
        }
        ordersByJournalId.set(journalId, order);
      }
      if (journalIdCollision) {
        fallback('ADMIN_PAPER_CANONICAL_ORDER_IDENTITY_COLLISION');
        continue;
      }
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
      const ordersById = ordersByJournalId;
      capital[market] = projectAdminMarketCapital(market, closed.map(trade => ({
        id: trade.id, market, closedAt: trade.closedAt ?? '',
        ...verifiedClosedPaperPnlKrw(trade, market, ordersById, input.nowMs),
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
