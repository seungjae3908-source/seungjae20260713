import type { CanonicalAccountSnapshot, CanonicalPosition, AccountProvider } from '../features/account-readonly/account-readonly.contract';
import { createVaultBackedAccountReaders } from '../features/account-readonly/account-readonly.runtime';
import type { TradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import { tradingHistoryComplete } from './trade-history-completeness.service';

export const AUTOMATIC_LIVE_POSITION_ISOLATION_POLICY = 'manual-protected-auto-ledger-v1';
const TOLERANCE = 1e-8;
const EXIT_PARENT = 'AUTO_EXIT_ENTRY_PLAN:';
const symbolKey = (value: string) => value.trim().toUpperCase().replace(/^KRW-/u, '');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const automatic = (plan: TradingPlan) => plan.executionMode === 'automatic'
  || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF')
  || plan.signalReasons.some((reason) => reason.startsWith(EXIT_PARENT));
const sameInstrument = (plan: TradingPlan, provider: AccountProvider, position: CanonicalPosition) =>
  plan.exchange === provider && symbolKey(plan.symbol) === symbolKey(position.symbol)
  && (provider !== 'kiwoom' && provider !== 'toss'
    || plan.market.toUpperCase() === position.market.toUpperCase());

export type AutomaticLiveOwnedPosition = Readonly<{ plan: TradingPlan; remainingQuantity: number }>;

/** Only actual canonical fills confer ownership. Plans and manual holdings never do. */
export function canonicalAutomaticLivePositions(plans: readonly TradingPlan[], orders: readonly TradingOrder[]): AutomaticLiveOwnedPosition[] {
  // Repository page bounds cannot prove that older AUTO fills never existed.
  if (!tradingHistoryComplete(plans, 200) || !tradingHistoryComplete(orders, 500)) {
    throw new Error('BACKGROUND_LIVE_OWNERSHIP_HISTORY_INCOMPLETE');
  }
  for (const order of orders) {
    const plan = plans.find((row) => row.id === order.planId);
    if (!plan && order.filledQuantity > TOLERANCE) throw new Error('BACKGROUND_LIVE_CANONICAL_PLAN_MISSING');
    if (plan?.accountMode === 'live' && automatic(plan)) {
      if (['PARTIALLY_FILLED', 'FILLED'].includes(order.state)
        && (!finite(order.filledQuantity) || order.filledQuantity <= TOLERANCE)
        || order.filledQuantity > TOLERANCE && !['PARTIALLY_FILLED', 'FILLED'].includes(order.state)) {
        throw new Error('BACKGROUND_LIVE_CANONICAL_FILL_RECONCILIATION_REQUIRED');
      }
    }
  }
  const filled = (order: TradingOrder) => ['PARTIALLY_FILLED', 'FILLED'].includes(order.state)
    && finite(order.filledQuantity) && order.filledQuantity > TOLERANCE;
  return plans.flatMap((plan) => {
    if (plan.accountMode !== 'live' || plan.reduceOnly || !automatic(plan)) return [];
    const entries = orders.filter((order) => order.planId === plan.id && filled(order));
    if (entries.length === 0) return [];
    if (entries.length !== 1 || entries[0]!.userId !== plan.userId || entries[0]!.exchange !== plan.exchange) {
      throw new Error('BACKGROUND_LIVE_CANONICAL_OWNERSHIP_AMBIGUOUS');
    }
    let exited = 0;
    for (const exit of plans.filter((row) => row.accountMode === 'live' && row.reduceOnly && automatic(row)
      && row.signalReasons.includes(`${EXIT_PARENT}${plan.id}`))) {
      if (exit.userId !== plan.userId || exit.exchange !== plan.exchange
        || symbolKey(exit.symbol) !== symbolKey(plan.symbol) || exit.market !== plan.market) {
        throw new Error('BACKGROUND_LIVE_CANONICAL_EXIT_PARENT_MISMATCH');
      }
      const closingSide = plan.exchange === 'bitget'
        ? plan.side === 'long' ? 'short' : plan.side === 'short' ? 'long' : null
        : plan.side === 'buy' ? 'sell' : null;
      if (closingSide === null || exit.side !== closingSide
        || exit.signalReasons.filter((reason) => reason.startsWith(EXIT_PARENT)).length !== 1) {
        // A same-direction fill cannot reduce AUTO ownership, including partial
        // closes. Checking only fully closed budget reservations is too late.
        throw new Error('BACKGROUND_LIVE_CANONICAL_EXIT_DIRECTION_INVALID');
      }
      const exitOrders = orders.filter((order) => order.planId === exit.id && filled(order));
      if (exitOrders.length > 1 || exitOrders.some((order) => order.userId !== plan.userId || order.exchange !== plan.exchange)) {
        throw new Error('BACKGROUND_LIVE_CANONICAL_OWNERSHIP_AMBIGUOUS');
      }
      exited += exitOrders.reduce((sum, order) => sum + order.filledQuantity, 0);
    }
    if (exited > entries[0]!.filledQuantity + TOLERANCE) throw new Error('BACKGROUND_LIVE_CANONICAL_EXIT_QUANTITY_DRIFT');
    const remainingQuantity = entries[0]!.filledQuantity - exited;
    return remainingQuantity > TOLERANCE ? [{ plan, remainingQuantity }] : [];
  });
}

/** Recomputed from fresh broker data; no baseline/adoption/synthetic fill is persisted. */
export function partitionAutomaticLiveProviderPositions(
  snapshot: Pick<CanonicalAccountSnapshot, 'provider' | 'positions'>,
  owned: readonly AutomaticLiveOwnedPosition[],
) {
  if (!Array.isArray(snapshot.positions)) throw new Error('BACKGROUND_LIVE_PROVIDER_POSITIONS_UNAVAILABLE');
  const manualProtected: CanonicalPosition[] = [];
  const automaticOwned: CanonicalPosition[] = [];
  const seen = new Set<string>();
  for (const position of snapshot.positions) {
    if (snapshot.provider === 'upbit' && symbolKey(position.symbol) === 'KRW') continue;
    if (!finite(position.quantity)) throw new Error('BACKGROUND_LIVE_PROVIDER_POSITION_QUANTITY_UNAVAILABLE');
    // Even broker dust is protected manual property. Tolerance is for AUTO
    // reconciliation, never permission to buy into or sell a manual holding.
    if (position.quantity === 0) continue;
    if (snapshot.provider !== 'bitget' && position.quantity < 0) throw new Error('BACKGROUND_LIVE_CASH_SHORT_POSITION_FORBIDDEN');
    const key = `${position.market.toUpperCase()}:${symbolKey(position.symbol)}`;
    if (!symbolKey(position.symbol) || seen.has(key)) throw new Error('BACKGROUND_LIVE_PROVIDER_POSITION_AMBIGUOUS');
    seen.add(key);
    const matches = owned.filter(({ plan }) => sameInstrument(plan, snapshot.provider, position));
    if (matches.length === 0) { manualProtected.push(position); continue; }
    if (matches.length !== 1) throw new Error('BACKGROUND_LIVE_CANONICAL_OWNERSHIP_AMBIGUOUS');
    const match = matches[0]!;
    if (snapshot.provider === 'bitget' && String(position.side).toLowerCase() !== match.plan.side) {
      throw new Error('BACKGROUND_LIVE_PROVIDER_POSITION_SIDE_MISMATCH');
    }
    if (snapshot.provider === 'bitget' && position.leverage !== match.plan.leverage) throw new Error('BACKGROUND_LIVE_PROVIDER_LEVERAGE_DRIFT');
    if (!finite(position.availableQuantity)
      || Math.abs(Math.abs(position.quantity) - match.remainingQuantity) > Math.max(TOLERANCE, match.remainingQuantity * 1e-6)
      || Math.abs(Math.abs(position.availableQuantity) - match.remainingQuantity) > Math.max(TOLERANCE, match.remainingQuantity * 1e-6)) {
      throw new Error('BACKGROUND_LIVE_POSITION_QUANTITY_DRIFT');
    }
    automaticOwned.push(position);
  }
  for (const position of owned.filter(({ plan }) => plan.exchange === snapshot.provider)) {
    if (!automaticOwned.some((row) => sameInstrument(position.plan, snapshot.provider, row))) {
      throw new Error('BACKGROUND_LIVE_OWNED_POSITION_MISSING');
    }
  }
  return { manualProtected, automaticOwned };
}

export function assertAutomaticLiveSnapshotIsolation(snapshot: CanonicalAccountSnapshot, owned: readonly AutomaticLiveOwnedPosition[], maximumLeverage = 7) {
  if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED' || snapshot.errorCode != null) {
    throw new Error('BACKGROUND_LIVE_ACCOUNT_SNAPSHOT_NOT_FRESH');
  }
  if (!Array.isArray(snapshot.openOrders) || snapshot.openOrders.length !== 0) throw new Error('BACKGROUND_LIVE_OPEN_ORDERS_UNRECONCILED');
  const partition = partitionAutomaticLiveProviderPositions(snapshot, owned);
  if (snapshot.provider === 'bitget') {
    if (snapshot.positionMode !== 'one_way_mode') throw new Error('BITGET_ONE_WAY_MODE_REQUIRED');
    for (const position of [...partition.manualProtected, ...partition.automaticOwned]) {
      if (position.marginMode !== 'isolated') throw new Error('BITGET_MARGIN_MODE_MISMATCH');
      if (!Number.isInteger(position.leverage) || position.leverage! < 2 || position.leverage! > maximumLeverage) throw new Error('BITGET_LEVERAGE_LIMIT');
    }
  }
  return partition;
}

export function assertAutomaticLiveTargetIsolation(snapshot: CanonicalAccountSnapshot, owned: readonly AutomaticLiveOwnedPosition[], plan: TradingPlan) {
  const partition = assertAutomaticLiveSnapshotIsolation(snapshot, owned);
  if (snapshot.provider !== plan.exchange) throw new Error('BACKGROUND_LIVE_ACCOUNT_PROVIDER_MISMATCH');
  if (partition.manualProtected.some((position) => sameInstrument(plan, snapshot.provider, position))) {
    throw new Error('BACKGROUND_LIVE_MANUAL_ASSET_PROTECTED');
  }
  if (!plan.reduceOnly) {
    if (partition.automaticOwned.some((position) => sameInstrument(plan, snapshot.provider, position))) {
      throw new Error('BACKGROUND_LIVE_AUTOMATIC_POSITION_ALREADY_OPEN');
    }
    return;
  }
  const parentId = plan.signalReasons.find((reason) => reason.startsWith(EXIT_PARENT))?.slice(EXIT_PARENT.length);
  const parent = owned.find((position) => position.plan.id === parentId
    && position.plan.userId === plan.userId && sameInstrument(position.plan, snapshot.provider, {
      symbol: plan.symbol, market: plan.market,
    } as CanonicalPosition));
  if (!parent || !finite(plan.quantity) || plan.quantity <= 0 || plan.quantity > parent.remainingQuantity + TOLERANCE) {
    throw new Error('BACKGROUND_LIVE_CANONICAL_EXIT_OWNERSHIP_REQUIRED');
  }
  if (snapshot.provider === 'bitget' && plan.side !== (parent.plan.side === 'long' ? 'short' : 'long')
    || snapshot.provider !== 'bitget' && plan.side !== 'sell') throw new Error('REDUCE_ONLY_SIDE_INVALID');
}

/** Execution stores secretKey; the Kiwoom read-only provider uses appSecret. No vault write. */
export function automaticExecutionReadonlyCredentials(provider: AccountProvider, raw: Record<string, string>) {
  if (provider !== 'kiwoom') return raw;
  const appSecret = typeof raw.appSecret === 'string' ? raw.appSecret.trim() : '';
  const secretKey = typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '';
  if (appSecret && secretKey && appSecret !== secretKey) throw new Error('CREDENTIALS_UNAVAILABLE');
  return { ...raw, appSecret: appSecret || secretKey };
}

/** Uses the execution connection's encrypted vault, with a transport restricted to reads. */
export async function readAutomaticLiveExecutionAccount(repository: TradingRepository, userId: string, provider: AccountProvider) {
  const readers = createVaultBackedAccountReaders({
    decryptCredentials: (envelope) => automaticExecutionReadonlyCredentials(provider, decryptTradingCredentials(envelope)),
    repositoryFactory: (owner) => ({
      async get(requester, requestedProvider) {
        if (owner !== userId || requester !== owner || requestedProvider !== provider) throw new Error('ACCOUNT_READONLY_USER_SCOPE_MISMATCH');
        const connection = await repository.getConnection(userId, provider);
        if (!connection || connection.accountMode !== 'live') return null;
        return { ...connection, provider, userId, encryptedCredentials: connection.encryptedCredentials ?? null };
      },
      async save() { throw new Error('READONLY_REQUEST_REJECTED'); },
      async remove() { throw new Error('READONLY_REQUEST_REJECTED'); },
    }),
  });
  return readers[provider]!({ userId, accessToken: 'server-execution-readonly' });
}

export function automaticLiveIsolationReceipt(snapshot: CanonicalAccountSnapshot, owned: readonly AutomaticLiveOwnedPosition[], maximumLeverage: number) {
  const partition = assertAutomaticLiveSnapshotIsolation(snapshot, owned, maximumLeverage);
  return {
    policyVersion: AUTOMATIC_LIVE_POSITION_ISOLATION_POLICY, provider: snapshot.provider,
    ready: true, manualProtectedPositionCount: partition.manualProtected.length,
    automaticOwnedPositionCount: partition.automaticOwned.length, ambiguousPositionCount: 0,
    manualEntryBlocked: true, canonicalExitOnly: true, fresh: true,
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    liveTradingAuthorityGranted: false, autoTradingAuthorityGranted: false,
  };
}
