import type { CanonicalAccountSnapshot, CanonicalPosition } from '../features/account-readonly/account-readonly.contract';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { canonicalAutomaticLivePositions, partitionAutomaticLiveProviderPositions } from './automatic-live-position-isolation.service';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import { ADMIN_FOUR_PAPER_MARKETS, adminMarketCurrentEpochSettlementScope,
  inspectAdminFourMarketPaperWallets, inspectMemberFourMarketPaperWallets } from './admin-four-market-paper-capital.service';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown) => finite(value) && value > 0 ? value : null;
const key = (symbol: string) => symbol.trim().toUpperCase().replace(/^KRW-/u, '');
const isAuto = (plan: TradingPlan) => plan.executionMode === 'automatic'
  || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF')
  || plan.signalReasons.some(reason => reason.startsWith('AUTO_EXIT_ENTRY_PLAN:'));
const marketFor = (provider: string, market: string) => provider === 'upbit' ? 'UPBIT'
  : provider === 'bitget' ? 'BITGET' : market.toUpperCase();

function entryEvidence(plan: TradingPlan, orders: readonly TradingOrder[]) {
  const order = orders.find(row => row.planId === plan.id
    && ['FILLED', 'PARTIALLY_FILLED'].includes(row.state) && row.filledQuantity > 0);
  return {
    planId: plan.id, strategyId: plan.strategyId, signalId: plan.signalId,
    observedAt: plan.marketSnapshot.observedAt ?? null,
    filledAt: order?.exchangeUpdatedAt ?? order?.updatedAt ?? null,
    entryPrice: positive(order?.averageFillPrice),
    // Stored entry plan, NOT a claim that protective exchange orders exist.
    targetPrices: plan.targetPrices.filter(value => positive(value) != null).slice(0, 6),
    stopPrice: positive(plan.stopPrice), protectionStatus: order?.protectionStatus ?? 'UNKNOWN',
    reasons: plan.signalReasons.filter(reason => !/^(?:CANONICAL_|ACCOUNT_READONLY_|AUTO_EXIT_ENTRY_PLAN:|HANDOFF_ID:|FX:|STOCK_BROKER:|TOP_OF_BOOK_GAP_PROXY$)/u.test(reason))
      .slice(0, 20).map(reason => reason.slice(0, 500)),
  };
}

function holding(position: CanonicalPosition, provider: string, ownership: 'AUTO' | 'MANUAL' | 'UNRESOLVED',
  plan: TradingPlan | null, orders: readonly TradingOrder[], id: string) {
  return {
    id, provider, market: marketFor(provider, position.market), symbol: position.symbol,
    displayName: position.displayName?.trim().slice(0, 120) || position.symbol,
    ownership, quantity: finite(position.quantity) ? position.quantity : null,
    averageEntryPrice: positive(position.averageEntryPrice), currentPrice: positive(position.currentPrice),
    marketValue: finite(position.marketValue) ? position.marketValue : null,
    unrealizedPnl: finite(position.unrealizedPnl) ? position.unrealizedPnl : null,
    unrealizedPnlPercent: finite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : null,
    currency: provider === 'upbit' || position.market === 'KR' ? 'KRW'
      : provider === 'bitget' ? 'USDT' : 'USD',
    side: position.side, leverage: position.leverage, marginMode: position.marginMode,
    entryEvidence: plan ? entryEvidence(plan, orders) : null,
  };
}

const safety = {
  schemaVersion: 'trading-holdings-readonly-v1',
  readOnly: true, orderRequests: 0, cancelRequests: 0, amendRequests: 0,
  transferRequests: 0, withdrawalRequests: 0, credentialsReturned: false,
  liveTradingAuthorityGranted: false, autoTradingAuthorityGranted: false,
} as const;

/** Display only. Never adopts assets, creates plans, or grants execution authority. */
export function liveTradingHoldings(snapshot: CanonicalAccountSnapshot, plans: readonly TradingPlan[], orders: readonly TradingOrder[]) {
  if (!Array.isArray(snapshot.positions)) throw new Error('HOLDINGS_PROVIDER_DATA_UNAVAILABLE');
  let owned: ReturnType<typeof canonicalAutomaticLivePositions> = [];
  let autoPositions: CanonicalPosition[] = [];
  let blocker: string | null = null;
  try {
    if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED' || snapshot.errorCode != null) {
      throw new Error('HOLDINGS_SNAPSHOT_NOT_FRESH');
    }
    owned = canonicalAutomaticLivePositions(plans, orders);
    autoPositions = partitionAutomaticLiveProviderPositions(snapshot, owned).automaticOwned;
  } catch (error) {
    blocker = error instanceof Error ? error.message.split(':')[0]! : 'HOLDINGS_OWNERSHIP_UNRESOLVED';
  }
  const items = snapshot.positions.flatMap((position, index) => {
    if (snapshot.provider === 'upbit' && key(position.symbol) === 'KRW' || position.quantity === 0) return [];
    const autoOwned = !blocker && autoPositions.includes(position);
    const plan = autoOwned ? owned.find(row => row.plan.exchange === snapshot.provider
      && key(row.plan.symbol) === key(position.symbol)
      && (snapshot.provider === 'upbit' || snapshot.provider === 'bitget'
        || row.plan.market.toUpperCase() === position.market.toUpperCase()))?.plan ?? null : null;
    return [holding(position, snapshot.provider, blocker ? 'UNRESOLVED' : autoOwned ? 'AUTO' : 'MANUAL',
      plan, orders, snapshot.provider + ':' + position.market + ':' + position.symbol + ':' + index)];
  });
  return { ...safety, accountMode: 'live', checkedAt: snapshot.checkedAt, stale: snapshot.stale,
    ownershipVerified: blocker == null, blocker, items };
}

/** Simulated canonical fills only. Wallet epochs are supplied by the Paper-only route. */
export function paperTradingHoldings(plans: readonly TradingPlan[], orders: readonly TradingOrder[], origin: 'automatic' | 'manual',
  wallet?: { records: readonly StoredPaperJournalRecord[]; role: 'admin' | 'member'; nowMs: number }) {
  if (plans.length >= 200 || orders.length >= 500) throw new Error('HOLDINGS_HISTORY_INCOMPLETE');
  let paperPlans = plans.filter(plan => plan.accountMode === 'paper');
  if (origin === 'automatic' && wallet) {
    const summary = wallet.role === 'admin' ? inspectAdminFourMarketPaperWallets(wallet.records, wallet.nowMs)
      : inspectMemberFourMarketPaperWallets(wallet.records, wallet.nowMs);
    if (!summary.ready) throw new Error('HOLDINGS_PAPER_WALLET_EPOCH_UNVERIFIED');
    const scopes = ADMIN_FOUR_PAPER_MARKETS.map(market => adminMarketCurrentEpochSettlementScope({
      market, plans: paperPlans, orders, openedAtMs: summary.marketWallets[market].openedAtMs!, nowMs: wallet.nowMs,
    }));
    if (scopes.some(scope => !scope.valid)) throw new Error('HOLDINGS_PAPER_WALLET_EPOCH_UNVERIFIED');
    paperPlans = scopes.flatMap(scope => scope.plans);
    orders = scopes.flatMap(scope => scope.orders);
  }
  const paperIds = new Set(paperPlans.map(plan => plan.id));
  const paperOrders = orders.filter(order => paperIds.has(order.planId));
  const projected = canonicalAutomaticLivePositions(
    paperPlans.map(plan => ({ ...plan, accountMode: 'live' as const, executionMode: 'automatic' as const })),
    paperOrders,
  );
  const items = projected.flatMap(({ plan, remainingQuantity }) => {
    const original = paperPlans.find(row => row.id === plan.id)!;
    if (isAuto(original) !== (origin === 'automatic')) return [];
    const order = paperOrders.find(row => row.planId === plan.id)!;
    return [holding({
      market: plan.market, symbol: plan.symbol, quantity: remainingQuantity, availableQuantity: remainingQuantity,
      averageEntryPrice: positive(order.averageFillPrice), currentPrice: null, marketValue: null,
      unrealizedPnl: null, unrealizedPnlPercent: null, side: plan.side, leverage: plan.leverage ?? null,
      liquidationPrice: null, marginMode: plan.marginMode ?? null,
    }, plan.exchange, origin === 'automatic' ? 'AUTO' : 'MANUAL', original, paperOrders, plan.id)];
  });
  return { ...safety, accountMode: 'paper', checkedAt: new Date().toISOString(), stale: false,
    ownershipVerified: true, blocker: null, items };
}
