import type { TradingExchange, TradingPlanInput } from './trade-automation.types';

export type FuturesLiveExecutionAuthority = 'NONE' | 'FUTURES_LIVE_LIMITED';

export type FuturesLiveCapability =
  | 'BALANCE_READ'
  | 'POSITION_READ'
  | 'OPEN_ORDER_READ'
  | 'ORDER_CREATE'
  | 'ORDER_CANCEL'
  | 'ORDER_AMEND';

export const FUTURES_LIVE_ALLOWED_CAPABILITIES = Object.freeze([
  'BALANCE_READ',
  'POSITION_READ',
  'OPEN_ORDER_READ',
  'ORDER_CREATE',
  'ORDER_CANCEL',
  'ORDER_AMEND',
] as const satisfies readonly FuturesLiveCapability[]);

export const FUTURES_LIVE_HARD_DENIED_CAPABILITIES = Object.freeze([
  'WITHDRAW',
  'TRANSFER',
  'EXTERNAL_WALLET_SEND',
] as const);

type Environment = Record<string, string | undefined>;

const CAPABILITY_SET = new Set<string>(FUTURES_LIVE_ALLOWED_CAPABILITIES);
const DENIED_SET = new Set<string>(FUTURES_LIVE_HARD_DENIED_CAPABILITIES);

function csvSet(value: string | undefined) {
  return new Set(String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean));
}

function enabled(environment: Environment, key: string) {
  return environment[key] === 'true';
}

function requiredCapabilities(capability: FuturesLiveCapability): FuturesLiveCapability[] {
  if (capability === 'ORDER_CREATE') {
    return ['BALANCE_READ', 'POSITION_READ', 'OPEN_ORDER_READ', 'ORDER_CREATE'];
  }
  if (capability === 'ORDER_CANCEL') return ['OPEN_ORDER_READ', 'ORDER_CANCEL'];
  if (capability === 'ORDER_AMEND') return ['POSITION_READ', 'OPEN_ORDER_READ', 'ORDER_AMEND'];
  return [capability];
}

export function futuresLiveExecutionAuthority(
  environment: Environment = process.env,
): FuturesLiveExecutionAuthority {
  return String(environment.FUTURES_LIVE_EXECUTION_AUTHORITY ?? 'NONE').trim().toUpperCase()
    === 'FUTURES_LIVE_LIMITED'
    ? 'FUTURES_LIVE_LIMITED'
    : 'NONE';
}

export function futuresLiveCapabilityDecision(input: {
  exchange: TradingExchange;
  capability: FuturesLiveCapability;
  plan?: Pick<TradingPlanInput,
    'exchange' | 'market' | 'side' | 'leverage' | 'marginMode' | 'reduceOnly'> | null;
  environment?: Environment;
}) {
  const environment = input.environment ?? process.env;
  const blockers: string[] = [];
  const authority = futuresLiveExecutionAuthority(environment);
  const configuredCapabilities = csvSet(environment.FUTURES_LIVE_CAPABILITY_ALLOWLIST);
  const configuredMarkets = csvSet(environment.FUTURES_LIVE_MARKET_ALLOWLIST);
  const unknownCapabilities = [...configuredCapabilities]
    .filter((value) => !CAPABILITY_SET.has(value) && !DENIED_SET.has(value));
  const deniedCapabilities = [...configuredCapabilities].filter((value) => DENIED_SET.has(value));

  if (input.exchange !== 'bitget') blockers.push('FUTURES_LIVE_PROVIDER_NOT_SUPPORTED');
  if (authority !== 'FUTURES_LIVE_LIMITED') blockers.push('FUTURES_LIVE_EXECUTION_AUTHORITY_MISMATCH');
  for (const key of [
    'LIVE_TRADING',
    'ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_ACTIVATION_APPROVED',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
    'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED',
    'BITGET_FUTURES_LIVE_ORDER_ENABLED',
  ]) {
    if (!enabled(environment, key)) blockers.push(`${key}_OFF`);
  }
  if (unknownCapabilities.length > 0) blockers.push('FUTURES_LIVE_CAPABILITY_ALLOWLIST_INVALID');
  if (deniedCapabilities.length > 0) blockers.push('FUTURES_LIVE_DENIED_CAPABILITY_REQUESTED');
  if (!configuredMarkets.has('CRYPTO_FUTURES') || configuredMarkets.size !== 1) {
    blockers.push('FUTURES_LIVE_MARKET_ALLOWLIST_INVALID');
  }
  for (const required of requiredCapabilities(input.capability)) {
    if (!configuredCapabilities.has(required)) blockers.push(`FUTURES_LIVE_CAPABILITY_MISSING_${required}`);
  }

  const configuredMaxLeverage = Number(environment.FUTURES_LIVE_MAX_LEVERAGE ?? 0);
  if (![2, 3].includes(configuredMaxLeverage)) blockers.push('FUTURES_LIVE_MAX_LEVERAGE_INVALID');
  if (String(environment.FUTURES_LIVE_MARGIN_MODE ?? '').trim().toLowerCase() !== 'isolated') {
    blockers.push('FUTURES_LIVE_MARGIN_MODE_INVALID');
  }

  if (input.plan) {
    if (input.plan.exchange !== 'bitget') blockers.push('FUTURES_LIVE_PROVIDER_PLAN_MISMATCH');
    if (String(input.plan.market ?? '').trim().toUpperCase() !== 'USDT-FUTURES') {
      blockers.push('FUTURES_LIVE_MARKET_NOT_SUPPORTED');
    }
    if (!['buy', 'sell', 'long', 'short'].includes(input.plan.side)) {
      blockers.push('FUTURES_LIVE_SIDE_NOT_SUPPORTED');
    }
    if (input.plan.marginMode !== 'isolated') blockers.push('FUTURES_LIVE_ISOLATED_MARGIN_REQUIRED');
    const leverage = Number(input.plan.leverage ?? 0);
    if (![2, 3].includes(leverage) || leverage > configuredMaxLeverage) {
      blockers.push('FUTURES_LIVE_LEVERAGE_NOT_ALLOWED');
    }
  }

  return {
    allowed: blockers.length === 0,
    blockCodes: [...new Set(blockers)],
    authority,
    exchange: input.exchange,
    capability: input.capability,
    configuredCapabilities: [...configuredCapabilities].sort(),
    configuredMarkets: [...configuredMarkets].sort(),
    maxLeverage: configuredMaxLeverage,
    marginMode: String(environment.FUTURES_LIVE_MARGIN_MODE ?? '').trim().toLowerCase(),
    hardDeniedCapabilities: [...FUTURES_LIVE_HARD_DENIED_CAPABILITIES],
  };
}

export function futuresLiveCapabilityEnabled(
  capability: FuturesLiveCapability,
  environment: Environment = process.env,
) {
  return futuresLiveCapabilityDecision({
    exchange: 'bitget',
    capability,
    environment,
  }).allowed;
}

export function futuresLivePlanCapabilityDecision(
  plan: Pick<TradingPlanInput,
    'exchange' | 'market' | 'side' | 'leverage' | 'marginMode' | 'reduceOnly'>,
  capability: FuturesLiveCapability,
  environment: Environment = process.env,
) {
  return futuresLiveCapabilityDecision({
    exchange: plan.exchange,
    capability,
    plan,
    environment,
  });
}

export function futuresLiveRuntimeStatus(environment: Environment = process.env) {
  return {
    executionAuthority: futuresLiveExecutionAuthority(environment),
    capabilityAllowlist: [...csvSet(environment.FUTURES_LIVE_CAPABILITY_ALLOWLIST)].sort(),
    marketAllowlist: [...csvSet(environment.FUTURES_LIVE_MARKET_ALLOWLIST)].sort(),
    maxLeverage: Number(environment.FUTURES_LIVE_MAX_LEVERAGE ?? 0),
    marginMode: String(environment.FUTURES_LIVE_MARGIN_MODE ?? '').trim().toLowerCase(),
    providerCapabilities: Object.fromEntries(
      FUTURES_LIVE_ALLOWED_CAPABILITIES.map((capability) => [
        capability,
        futuresLiveCapabilityEnabled(capability, environment),
      ]),
    ),
    hardDeniedCapabilities: Object.fromEntries(
      FUTURES_LIVE_HARD_DENIED_CAPABILITIES.map((capability) => [capability, false]),
    ),
  };
}
