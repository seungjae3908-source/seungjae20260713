import type {
  TradingAssetClass,
  TradingExchange,
  TradingPlanInput,
} from './trade-automation.types';

export type LiveExecutionAuthority = 'NONE' | 'MANUAL' | 'AUTOMATIC' | 'SPOT_LIVE_LIMITED';

export type SpotLiveCapability =
  | 'BALANCE_READ'
  | 'POSITION_READ'
  | 'OPEN_ORDER_READ'
  | 'ORDER_CREATE'
  | 'ORDER_CANCEL'
  | 'ORDER_AMEND';

export type SpotLiveMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT';

export const SPOT_LIVE_ALLOWED_CAPABILITIES = Object.freeze([
  'BALANCE_READ',
  'POSITION_READ',
  'OPEN_ORDER_READ',
  'ORDER_CREATE',
  'ORDER_CANCEL',
  'ORDER_AMEND',
] as const satisfies readonly SpotLiveCapability[]);

export const SPOT_LIVE_HARD_DENIED_CAPABILITIES = Object.freeze([
  'WITHDRAW',
  'TRANSFER',
  'EXTERNAL_WALLET_SEND',
  'FUTURES',
  'MARGIN',
  'SHORT',
  'LEVERAGE',
] as const);

export const SPOT_LIVE_ALLOWED_MARKETS = Object.freeze([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
] as const satisfies readonly SpotLiveMarket[]);

type Environment = Record<string, string | undefined>;

const CAPABILITY_SET = new Set<string>(SPOT_LIVE_ALLOWED_CAPABILITIES);
const DENIED_SET = new Set<string>(SPOT_LIVE_HARD_DENIED_CAPABILITIES);
const MARKET_SET = new Set<string>(SPOT_LIVE_ALLOWED_MARKETS);

const PROVIDER_CAPABILITIES: Record<TradingExchange, ReadonlySet<SpotLiveCapability>> = {
  // No Bitget order creation is allowed. Lookup/cancel remain available only for
  // query-first recovery of an order that predates this authority boundary.
  bitget: new Set(['OPEN_ORDER_READ', 'ORDER_CANCEL']),
  upbit: new Set(['BALANCE_READ', 'POSITION_READ', 'OPEN_ORDER_READ', 'ORDER_CREATE', 'ORDER_CANCEL']),
  kiwoom: new Set(SPOT_LIVE_ALLOWED_CAPABILITIES),
  toss: new Set(SPOT_LIVE_ALLOWED_CAPABILITIES),
};

const PROVIDER_MARKETS: Record<TradingExchange, ReadonlySet<SpotLiveMarket>> = {
  bitget: new Set(),
  upbit: new Set(['CRYPTO_SPOT']),
  kiwoom: new Set(['KR_STOCK', 'US_STOCK']),
  toss: new Set(['KR_STOCK']),
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function csvSet(value: string | undefined) {
  return new Set(String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean));
}

function enabled(environment: Environment, key: string) {
  return environment[key] === 'true';
}

function providerFlag(exchange: TradingExchange) {
  return `${exchange.toUpperCase()}_LIVE_ORDER_ENABLED`;
}

function requiredCapabilities(capability: SpotLiveCapability): SpotLiveCapability[] {
  if (capability === 'ORDER_CREATE') {
    return ['BALANCE_READ', 'POSITION_READ', 'OPEN_ORDER_READ', 'ORDER_CREATE'];
  }
  if (capability === 'ORDER_CANCEL') return ['OPEN_ORDER_READ', 'ORDER_CANCEL'];
  if (capability === 'ORDER_AMEND') {
    return ['POSITION_READ', 'OPEN_ORDER_READ', 'ORDER_AMEND'];
  }
  return [capability];
}

export function liveExecutionAuthority(environment: Environment = process.env): LiveExecutionAuthority {
  const authority = String(environment.executionAuthority ?? 'NONE').trim().toUpperCase();
  if (authority === 'MANUAL' || authority === 'AUTOMATIC' || authority === 'SPOT_LIVE_LIMITED') {
    return authority;
  }
  return 'NONE';
}

export function spotLiveMarketForPlan(
  plan: Pick<TradingPlanInput, 'exchange' | 'market'>,
): SpotLiveMarket | null {
  if (plan.exchange === 'upbit' && plan.market.toUpperCase() === 'KRW') return 'CRYPTO_SPOT';
  if ((plan.exchange === 'kiwoom' || plan.exchange === 'toss') && plan.market.toUpperCase() === 'KR') {
    return 'KR_STOCK';
  }
  if (plan.exchange === 'kiwoom' && plan.market.toUpperCase() === 'US') {
    return 'US_STOCK';
  }
  return null;
}

export function spotLiveAssetClassForMarket(market: SpotLiveMarket): TradingAssetClass {
  if (market === 'KR_STOCK') return 'domestic_stock';
  if (market === 'US_STOCK') return 'us_stock';
  return 'crypto_spot';
}

export function spotLiveCapabilityDecision(input: {
  exchange: TradingExchange;
  capability: SpotLiveCapability;
  plan?: Pick<TradingPlanInput,
  'exchange' | 'market' | 'side' | 'leverage' | 'marginMode' | 'stockBroker'> | null;
  environment?: Environment;
}) {
  const environment = input.environment ?? process.env;
  const blockers: string[] = [];
  const authority = liveExecutionAuthority(environment);
  const configuredCapabilities = csvSet(environment.SPOT_LIVE_CAPABILITY_ALLOWLIST);
  const configuredMarkets = csvSet(environment.SPOT_LIVE_MARKET_ALLOWLIST);
  const unknownCapabilities = [...configuredCapabilities]
    .filter((value) => !CAPABILITY_SET.has(value) && !DENIED_SET.has(value));
  const explicitlyDeniedCapabilities = [...configuredCapabilities].filter((value) => DENIED_SET.has(value));
  const unknownMarkets = [...configuredMarkets].filter((value) => !MARKET_SET.has(value));

  if (authority !== 'SPOT_LIVE_LIMITED') blockers.push('SPOT_LIVE_EXECUTION_AUTHORITY_MISMATCH');
  for (const key of [
    'LIVE_TRADING',
    'ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_ACTIVATION_APPROVED',
    'SPOT_LIVE_LIMITED_ACTIVATION_APPROVED',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ]) {
    if (!enabled(environment, key)) blockers.push(`${key}_OFF`);
  }
  if (!enabled(environment, providerFlag(input.exchange))) blockers.push('SPOT_LIVE_PROVIDER_GATE_OFF');
  if (input.exchange === 'bitget'
    && (input.capability === 'ORDER_CREATE' || input.capability === 'ORDER_AMEND' || input.plan)) {
    blockers.push('FUTURES_HARD_DISABLED');
  }
  if (PROVIDER_MARKETS[input.exchange].size === 0
    && (input.capability === 'ORDER_CREATE' || input.capability === 'ORDER_AMEND')) {
    blockers.push('SPOT_LIVE_PROVIDER_NOT_SUPPORTED');
  }
  if (unknownCapabilities.length > 0) blockers.push('SPOT_LIVE_CAPABILITY_ALLOWLIST_INVALID');
  if (explicitlyDeniedCapabilities.length > 0) blockers.push('SPOT_LIVE_DENIED_CAPABILITY_REQUESTED');
  if (unknownMarkets.length > 0) blockers.push('SPOT_LIVE_MARKET_ALLOWLIST_INVALID');

  for (const required of requiredCapabilities(input.capability)) {
    if (!configuredCapabilities.has(required)) blockers.push(`SPOT_LIVE_CAPABILITY_MISSING_${required}`);
    if (!PROVIDER_CAPABILITIES[input.exchange].has(required)) {
      blockers.push(`SPOT_LIVE_PROVIDER_CAPABILITY_UNSUPPORTED_${required}`);
    }
  }

  if (input.capability === 'ORDER_CREATE' || input.capability === 'ORDER_AMEND') {
    const providerMarketConfigured = [...PROVIDER_MARKETS[input.exchange]]
      .some((market) => configuredMarkets.has(market));
    if (!providerMarketConfigured) blockers.push('SPOT_LIVE_PROVIDER_MARKET_NOT_ALLOWED');
  }

  let market: SpotLiveMarket | null = null;
  if (input.plan) {
    if (input.plan.exchange !== input.exchange) blockers.push('SPOT_LIVE_PROVIDER_PLAN_MISMATCH');
    market = spotLiveMarketForPlan(input.plan);
    if (!market) blockers.push('SPOT_LIVE_MARKET_NOT_SUPPORTED');
    else if (!configuredMarkets.has(market)) blockers.push('SPOT_LIVE_MARKET_NOT_ALLOWED');
    if (input.plan.side !== 'buy' && input.plan.side !== 'sell') blockers.push('SHORT_HARD_DISABLED');
    if (input.plan.leverage != null) blockers.push('LEVERAGE_HARD_DISABLED');
    if (input.plan.marginMode != null) blockers.push('MARGIN_HARD_DISABLED');
    if (market === 'CRYPTO_SPOT' && input.capability === 'ORDER_AMEND') {
      blockers.push('CRYPTO_SPOT_AMEND_HARD_DISABLED');
    }
    if ((market === 'KR_STOCK' || market === 'US_STOCK')
      && input.plan.stockBroker != null && input.plan.stockBroker !== input.exchange) {
      blockers.push('SPOT_LIVE_STOCK_BROKER_MISMATCH');
    }
  }

  const blockCodes = unique(blockers);
  return {
    allowed: blockCodes.length === 0,
    blockCodes,
    authority,
    exchange: input.exchange,
    capability: input.capability,
    market,
    configuredCapabilities: [...configuredCapabilities].sort(),
    configuredMarkets: [...configuredMarkets].sort(),
    hardDeniedCapabilities: [...SPOT_LIVE_HARD_DENIED_CAPABILITIES],
  };
}

export function spotLiveCapabilityEnabled(
  exchange: TradingExchange,
  capability: SpotLiveCapability,
  environment: Environment = process.env,
) {
  return spotLiveCapabilityDecision({ exchange, capability, environment }).allowed;
}

export function spotLivePlanCapabilityDecision(
  plan: Pick<TradingPlanInput,
  'exchange' | 'market' | 'side' | 'leverage' | 'marginMode' | 'stockBroker'>,
  capability: SpotLiveCapability,
  environment: Environment = process.env,
) {
  return spotLiveCapabilityDecision({
    exchange: plan.exchange,
    capability,
    plan,
    environment,
  });
}

export function spotLiveRuntimeStatus(environment: Environment = process.env) {
  const exchanges = (['bitget', 'upbit', 'kiwoom', 'toss'] as const).map((exchange) => [
    exchange,
    Object.fromEntries(SPOT_LIVE_ALLOWED_CAPABILITIES.map((capability) => [
      capability,
      spotLiveCapabilityEnabled(exchange, capability, environment),
    ])),
  ]);
  return {
    executionAuthority: liveExecutionAuthority(environment),
    capabilityAllowlist: [...csvSet(environment.SPOT_LIVE_CAPABILITY_ALLOWLIST)].sort(),
    marketAllowlist: [...csvSet(environment.SPOT_LIVE_MARKET_ALLOWLIST)].sort(),
    providerCapabilities: Object.fromEntries(exchanges),
    hardDeniedCapabilities: Object.fromEntries(
      SPOT_LIVE_HARD_DENIED_CAPABILITIES.map((capability) => [capability, false]),
    ),
  };
}
