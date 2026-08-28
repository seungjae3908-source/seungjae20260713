import {
  TRADING_RISK_POLICY,
} from './trading-risk-engine.service';
import type {
  AuthoritativePaperRiskPolicyEvidenceV1,
  AuthoritativePaperRiskSizingMarket,
} from './authoritative-paper-risk-sizing-source.service';

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION =
  'authoritative-paper-generic-risk-policy-producer-v1' as const;

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_MAXIMUM_AGE_MS = 30_000 as const;

export type AuthoritativePaperGenericRiskPolicyRequest = Readonly<{
  market: AuthoritativePaperRiskSizingMarket;
  strategyScope: string;
  symbolScopes?: '*' | readonly string[];
}>;

export type AuthoritativePaperGenericRiskPolicyProducer = (
  request: AuthoritativePaperGenericRiskPolicyRequest,
) => AuthoritativePaperRiskPolicyEvidenceV1;

const SUPPORTED_MARKETS = new Set<AuthoritativePaperRiskSizingMarket>([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/u.test(symbol) ? symbol : null;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

function normalizeSymbolScopes(
  value: '*' | readonly string[] | undefined,
): '*' | readonly string[] {
  if (value == null || value === '*') return '*';
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_SYMBOL_SCOPE_REQUIRED');
  }
  const normalized = value.map(normalizeSymbol);
  if (normalized.some((symbol) => symbol == null)) {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_SYMBOL_SCOPE_INVALID');
  }
  return Object.freeze([...new Set(normalized as string[])]);
}

function validateCanonicalPolicyAuthority(): void {
  if (!positive(TRADING_RISK_POLICY.riskWarningPercent)
    || !positive(TRADING_RISK_POLICY.maximumRiskPercent)
    || TRADING_RISK_POLICY.riskWarningPercent > TRADING_RISK_POLICY.maximumRiskPercent
    || !positive(TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage)
    || TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage < 1) {
    throw new Error('AUTHORITATIVE_GENERIC_RISK_POLICY_CANONICAL_AUTHORITY_INVALID');
  }
}

export function createAuthoritativePaperGenericRiskPolicyProducer(input: Readonly<{
  researchCodeSha: string;
  now?: () => number;
}>): AuthoritativePaperGenericRiskPolicyProducer {
  if (!exactSha(input?.researchCodeSha)) {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_EXACT_RESEARCH_SHA_REQUIRED');
  }
  const now = input.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_CLOCK_REQUIRED');
  }
  validateCanonicalPolicyAuthority();
  const researchCodeSha = input.researchCodeSha;

  const producer: AuthoritativePaperGenericRiskPolicyProducer = (request) => {
    if (!SUPPORTED_MARKETS.has(request?.market)) {
      throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_MARKET_UNSUPPORTED');
    }
    if (!nonEmpty(request?.strategyScope)) {
      throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_STRATEGY_SCOPE_REQUIRED');
    }
    const observedAtMs = now();
    if (!positive(observedAtMs)) {
      throw new Error('AUTHORITATIVE_GENERIC_RISK_POLICY_OBSERVED_AT_INVALID');
    }
    const symbolScopes = normalizeSymbolScopes(request.symbolScopes);
    const futures = request.market === 'CRYPTO_FUTURES';
    const policy = {
      schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1' as const,
      policyId: 'canonical-trading-risk-policy',
      policyVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
      source: 'api-server/src/services/trading-risk-engine.service.ts#TRADING_RISK_POLICY',
      provenance: Object.freeze([
        'TRADING_RISK_POLICY',
        AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
        `researchCodeSha:${researchCodeSha}`,
      ]),
      observedAtMs,
      maximumAgeMs: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_MAXIMUM_AGE_MS,
      researchCodeSha,
      marketScopes: Object.freeze([request.market]),
      strategyScopes: Object.freeze([request.strategyScope.trim()]),
      symbolScopes,
      riskPercent: TRADING_RISK_POLICY.riskWarningPercent,
      requestedLeverage: 1,
      maximumLeverage: futures
        ? TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage
        : null,
      marginMode: futures ? 'isolated' as const : 'cash' as const,
    } satisfies AuthoritativePaperRiskPolicyEvidenceV1;
    return deepFreeze(policy) as AuthoritativePaperRiskPolicyEvidenceV1;
  };

  return Object.freeze(producer);
}

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
  policyAuthority: 'TRADING_RISK_POLICY',
  riskPercentSource: 'riskWarningPercent',
  requestedLeverage: 1,
  leverageEscalationAllowed: false,
  futuresMaximumLeverageSource: 'cryptoFuturesAppMaximumLeverage',
  genericSymbolFallback: '*',
  fabricatedPairPolicyAllowed: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  realOrderAllowed: false,
  financialMutationAllowed: false,
});
