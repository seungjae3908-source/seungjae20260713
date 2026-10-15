import { createHash } from 'node:crypto';
import type { CanonicalAccountSnapshot, AccountProvider } from '../features/account-readonly/account-readonly.contract';
import {
  USER_MARKET_CAPITAL_POLICY_VERSION,
  type TradingAssetClass,
  type TradingCapitalAllocationPolicy,
  type TradingPlanInput,
  type TradingPolicy,
} from './trade-automation.types';

export const AUTO_TRADING_CAPITAL_ALLOCATION_POLICY_VERSION = USER_MARKET_CAPITAL_POLICY_VERSION;
export const MARKET_MINIMUM_CAPITAL_KRW: Record<TradingAssetClass, number> = Object.freeze({
  domestic_stock: 1_000,
  us_stock: 1_000,
  crypto_spot: 5_000,
  crypto_futures: 5_000,
});

const finiteNonNegative = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;
const roundKrw = (value: number) => Math.floor((value + Number.EPSILON) * 100) / 100;

export function capitalProviderForMarket(
  policy: Pick<TradingPolicy, 'stockBrokerByMarket'>,
  market: TradingAssetClass,
): AccountProvider {
  if (market === 'crypto_spot') return 'upbit';
  if (market === 'crypto_futures') return 'bitget';
  return market === 'us_stock' ? 'kiwoom' : policy.stockBrokerByMarket?.domestic_stock ?? 'kiwoom';
}

export function capitalCurrencyForMarket(market: TradingAssetClass) {
  if (market === 'us_stock') return 'USD';
  if (market === 'crypto_futures') return 'USDT';
  return 'KRW';
}

export function tradingCapitalChargeKrw(
  plan: Pick<TradingPlanInput, 'exchange' | 'estimatedKrw' | 'leverage'>,
) {
  if (!finiteNonNegative(plan.estimatedKrw)) return Number.POSITIVE_INFINITY;
  if (plan.exchange !== 'bitget') return plan.estimatedKrw;
  const leverage = Number(plan.leverage);
  return Number.isInteger(leverage) && leverage >= 2
    ? roundKrw(plan.estimatedKrw / leverage) : Number.POSITIVE_INFINITY;
}

export function effectiveCapitalAllocation(
  policy: Pick<TradingPolicy, 'capitalAllocationByMarket' | 'maxOrderKrw' | 'maxAssetClassKrw'>,
  market: TradingAssetClass,
) {
  const allocation = policy.capitalAllocationByMarket[market];
  const configured = allocation?.configured === true;
  return Object.freeze({
    configured,
    operatingCapitalKrw: configured ? allocation.operatingCapitalKrw : policy.maxAssetClassKrw[market],
    maxOrderKrw: configured
      ? Math.min(policy.maxOrderKrw, allocation.maxOrderKrw)
      : policy.maxOrderKrw,
    compoundAboveAllocation: false as const,
  });
}

export function profitTargetCapitalBaseKrw(
  policy: Pick<TradingPolicy, 'capitalAllocationByMarket'>,
  market: TradingAssetClass,
  legacyBaseKrw: number,
) {
  const allocation = policy.capitalAllocationByMarket[market];
  return allocation?.configured === true ? allocation.operatingCapitalKrw : legacyBaseKrw;
}

export type CapitalAllocationMarketReadiness = Readonly<{
  market: TradingAssetClass;
  provider: AccountProvider;
  currency: string;
  verified: boolean;
  actualAvailableKrw: number | null;
  roleMaximumKrw: number;
  currentlyAllocatedKrw: number;
  currentMaximumConfigurableKrw: number | null;
  excludedKrw: number | null;
  accountScopeId: string | null;
  reason: string | null;
  observedAt: string | null;
  futuresMarginAllocationKrw: number | null;
  futuresNominalCeilingKrw: number | null;
}>;

function snapshotAvailable(
  snapshot: CanonicalAccountSnapshot,
  market: TradingAssetClass,
  krwPerQuoteCurrency: number | null,
) {
  if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED'
    || snapshot.errorCode != null || !Array.isArray(snapshot.openOrders)) return null;
  const currency = capitalCurrencyForMarket(market);
  const native = [
    ...(snapshot.balances ?? []).filter((row) => row.currency.toUpperCase() === currency)
      .flatMap((row) => finiteNonNegative(row.available) ? [row.available] : []),
    ...(snapshot.accounts ?? []).filter((row) => row.currency?.toUpperCase() === currency)
      .flatMap((row) => finiteNonNegative(row.buyingPower) ? [row.buyingPower] : []),
  ];
  if (native.length === 0) return null;
  const fx = currency === 'KRW' ? 1 : krwPerQuoteCurrency;
  if (fx == null || !Number.isFinite(fx) || fx <= 0) return null;
  return roundKrw(Math.max(...native) * fx);
}

function accountScopeId(provider: AccountProvider, snapshot: CanonicalAccountSnapshot, currency: string) {
  const references = (snapshot.accounts ?? []).map((row) => row.accountRef).filter(Boolean).sort();
  const basis = `${provider}:${currency}:${references.join('|') || 'provider-account'}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

/**
 * Read-only projection. It never moves funds and never treats an unavailable
 * broker balance as zero or as the role ceiling. Available buying power already
 * excludes broker-locked orders; configured sibling lanes sharing a provider
 * are deducted again so the same cash cannot be promised twice.
 */
export function buildCapitalAllocationReadiness(input: Readonly<{
  policy: TradingPolicy;
  roleMaximumPerMarketKrw: number;
  snapshots: Partial<Record<AccountProvider, CanonicalAccountSnapshot>>;
  krwPerCurrency: Partial<Record<'USD' | 'USDT', number>>;
  leverage: number;
}>): Record<TradingAssetClass, CapitalAllocationMarketReadiness> {
  const markets: TradingAssetClass[] = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'];
  const providers = Object.fromEntries(markets.map((market) => [market,
    capitalProviderForMarket(input.policy, market)])) as Record<TradingAssetClass, AccountProvider>;
  return Object.fromEntries(markets.map((market) => {
    const provider = providers[market];
    const snapshot = input.snapshots[provider];
    const currency = capitalCurrencyForMarket(market);
    const fx = currency === 'USD' ? input.krwPerCurrency.USD ?? null
      : currency === 'USDT' ? input.krwPerCurrency.USDT ?? null : 1;
    const available = snapshot ? snapshotAvailable(snapshot, market, fx) : null;
    const configured = input.policy.capitalAllocationByMarket[market];
    const currentlyAllocatedKrw = configured.configured ? configured.operatingCapitalKrw : 0;
    const siblingReserved = markets.filter((candidate) => candidate !== market
      && providers[candidate] === provider
      && input.policy.capitalAllocationByMarket[candidate].configured)
      .reduce((sum, candidate) => sum
        + input.policy.capitalAllocationByMarket[candidate].operatingCapitalKrw, 0);
    // A configured allocation is a logical ceiling, not cash returned by the
    // provider. Adding it to buying power would fabricate capacity after
    // manual spending or a drawdown. Sibling lanes on the same provider are
    // conservatively reserved to prevent promising the same cash twice.
    const maximum = available == null ? null
      : roundKrw(Math.max(0, Math.min(input.roleMaximumPerMarketKrw,
        available - siblingReserved)));
    const reason = !snapshot ? 'ACCOUNT_READBACK_REQUIRED'
      : available == null ? (currency === 'KRW' ? 'AVAILABLE_BALANCE_UNVERIFIED' : 'FX_OR_AVAILABLE_BALANCE_UNVERIFIED')
        : maximum! < MARKET_MINIMUM_CAPITAL_KRW[market] ? 'AVAILABLE_BALANCE_BELOW_MINIMUM' : null;
    const scopeId = snapshot && available != null ? accountScopeId(provider, snapshot, currency) : null;
    return [market, Object.freeze({
      market, provider, currency, verified: reason == null,
      actualAvailableKrw: available,
      roleMaximumKrw: input.roleMaximumPerMarketKrw,
      currentlyAllocatedKrw,
      currentMaximumConfigurableKrw: maximum,
      excludedKrw: available == null ? null : roundKrw(Math.max(0, available - currentlyAllocatedKrw)),
      accountScopeId: scopeId,
      reason,
      observedAt: snapshot?.checkedAt ?? null,
      futuresMarginAllocationKrw: market === 'crypto_futures' ? currentlyAllocatedKrw : null,
      futuresNominalCeilingKrw: market === 'crypto_futures'
        ? roundKrw(currentlyAllocatedKrw * input.leverage) : null,
    })];
  })) as Record<TradingAssetClass, CapitalAllocationMarketReadiness>;
}

export function serverAuthoredCapitalAllocation(
  requested: TradingCapitalAllocationPolicy,
  readiness: CapitalAllocationMarketReadiness,
  now: Date,
  current?: TradingCapitalAllocationPolicy,
): TradingCapitalAllocationPolicy {
  if (!requested.configured) return Object.freeze({
    configured: false, operatingCapitalKrw: 0,
    maxOrderKrw: Math.min(requested.maxOrderKrw, readiness.roleMaximumKrw),
    compoundAboveAllocation: false, policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION,
    updatedAt: now.toISOString(), accountScopeId: null,
  });
  const safeReduction = current?.configured === true
    && requested.operatingCapitalKrw <= current.operatingCapitalKrw
    && requested.maxOrderKrw <= current.maxOrderKrw;
  if ((!safeReduction && (!readiness.verified || readiness.currentMaximumConfigurableKrw == null))
    || requested.operatingCapitalKrw < MARKET_MINIMUM_CAPITAL_KRW[readiness.market]
    || (!safeReduction && requested.operatingCapitalKrw > readiness.currentMaximumConfigurableKrw!)) {
    throw new Error(readiness.reason ?? 'CAPITAL_ALLOCATION_AVAILABLE_BALANCE_EXCEEDED');
  }
  if (!Number.isFinite(requested.maxOrderKrw) || requested.maxOrderKrw < MARKET_MINIMUM_CAPITAL_KRW[readiness.market]
    || requested.maxOrderKrw > requested.operatingCapitalKrw) {
    throw new Error('CAPITAL_ALLOCATION_ORDER_LIMIT_INVALID');
  }
  return Object.freeze({
    configured: true,
    operatingCapitalKrw: roundKrw(requested.operatingCapitalKrw),
    maxOrderKrw: roundKrw(requested.maxOrderKrw),
    compoundAboveAllocation: false,
    policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION,
    updatedAt: now.toISOString(),
    accountScopeId: readiness.accountScopeId ?? (safeReduction ? current?.accountScopeId ?? null : null),
  });
}
