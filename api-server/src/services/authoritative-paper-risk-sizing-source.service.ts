import {
  calculateTradingRisk,
  TRADING_RISK_POLICY,
  type RiskEngineResult,
} from './trading-risk-engine.service';
import {
  validateImmutablePaperTradingStateSnapshot,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { PaperContractRules, PaperSide } from './paper-trading.types';

export const AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION =
  'authoritative-paper-risk-sizing-source-v1' as const;

export type AuthoritativePaperRiskSizingMarket =
  | 'KR_STOCK'
  | 'US_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES';

export type AuthoritativePaperRiskPolicyEvidenceV1 = Readonly<{
  schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1';
  policyId: string;
  policyVersion: string;
  source: string;
  provenance: readonly string[];
  observedAtMs: number;
  maximumAgeMs: number;
  researchCodeSha: string;
  marketScopes: readonly AuthoritativePaperRiskSizingMarket[];
  strategyScopes: readonly string[];
  symbolScopes: '*' | readonly string[];
  riskPercent: number;
  requestedLeverage: number;
  maximumLeverage: number | null;
  marginMode: 'cash' | 'isolated' | 'cross';
}>;

export type AuthoritativePaperContractRulesEvidenceV1 = Readonly<{
  schemaVersion: 'authoritative-paper-contract-rules-evidence-v1';
  ruleVersion: string;
  market: AuthoritativePaperRiskSizingMarket;
  symbol: string;
  source: string;
  provenance: readonly string[];
  observedAtMs: number;
  maximumAgeMs: number;
  rules: PaperContractRules;
}>;

export type AuthoritativePaperMarketRiskEvidenceV1 = Readonly<{
  schemaVersion: 'authoritative-paper-market-risk-evidence-v1';
  market: AuthoritativePaperRiskSizingMarket;
  symbol: string;
  entryPrice: number;
  stopLossPrice: number;
  source: string;
  provenance: readonly string[];
  observedAtMs: number;
  maximumAgeMs: number;
  status: 'live' | 'delayed' | 'cached' | 'disconnected' | 'error' | 'insufficient';
}>;

export type AuthoritativePaperRiskCostEvidenceV1 = Readonly<{
  schemaVersion: 'authoritative-paper-risk-cost-evidence-v1';
  market: AuthoritativePaperRiskSizingMarket;
  symbol: string;
  source: string;
  provenance: readonly string[];
  observedAtMs: number;
  maximumAgeMs: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  estimatedFundingRate: number;
}>;

export type AuthoritativePaperRiskSizingInput = Readonly<{
  market: AuthoritativePaperRiskSizingMarket;
  symbol: string;
  strategyScope: string;
  side: 'LONG' | 'SHORT';
  researchCodeSha: string;
  paperStateSourceSha: string;
  paperAccountId: string;
  riskPolicy: AuthoritativePaperRiskPolicyEvidenceV1 | unknown;
  paperStateSnapshot: PaperTradingStateSnapshot | unknown;
  contractRulesEvidence: AuthoritativePaperContractRulesEvidenceV1 | unknown;
  marketEvidence: AuthoritativePaperMarketRiskEvidenceV1 | unknown;
  costEvidence: AuthoritativePaperRiskCostEvidenceV1 | unknown;
}>;

export type AuthoritativePaperRiskSizingStatus = 'PRESENT' | 'BLOCKED_DATA' | 'NO_TRADE';

export type AuthoritativePaperRiskSizingEvidence = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION;
  status: AuthoritativePaperRiskSizingStatus;
  source: 'GENERIC_AUTHORITATIVE_PAPER_RISK_SIZING';
  provenance: readonly string[];
  generatedAt: string;
  observedAtMs: number | null;
  market: AuthoritativePaperRiskSizingMarket | null;
  symbol: string | null;
  strategyScope: string | null;
  side: 'LONG' | 'SHORT' | null;
  researchCodeSha: string | null;
  paperStateSourceSha: string | null;
  paperAccountId: string | null;
  equity: number | null;
  riskPercent: number | null;
  requestedLeverage: number | null;
  effectiveLeverage: number | null;
  marginMode: 'cash' | 'isolated' | 'cross' | null;
  policyId: string | null;
  policyVersion: string | null;
  contractRuleVersion: string | null;
  entryPrice: number | null;
  stopLossPrice: number | null;
  rawQuantity: number | null;
  roundedQuantity: number | null;
  targetQuantity: number | null;
  estimatedNotional: number | null;
  riskAmount: number | null;
  valid: boolean;
  eligible: boolean;
  blockers: readonly string[];
  blockedReason: string | null;
  riskEngineResult: Readonly<RiskEngineResult> | null;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
  privateProviderCallCount: 0;
  realOrderSideEffectCount: 0;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function normalizeSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/u.test(symbol) ? symbol : null;
}

function fresh(observedAtMs: number, maximumAgeMs: number, nowMs: number): boolean {
  return positive(observedAtMs)
    && positive(maximumAgeMs)
    && observedAtMs <= nowMs
    && nowMs - observedAtMs <= maximumAgeMs;
}

function nonEmptyStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

function marketSupported(value: unknown): value is AuthoritativePaperRiskSizingMarket {
  return value === 'KR_STOCK'
    || value === 'US_STOCK'
    || value === 'CRYPTO_SPOT'
    || value === 'CRYPTO_FUTURES';
}

function sideSupported(market: AuthoritativePaperRiskSizingMarket, side: unknown): side is 'LONG' | 'SHORT' {
  if (side !== 'LONG' && side !== 'SHORT') return false;
  return market === 'CRYPTO_FUTURES' || side === 'LONG';
}

function tradingRiskMarket(market: AuthoritativePaperRiskSizingMarket): 'stock' | 'crypto-spot' | 'crypto-futures' {
  if (market === 'CRYPTO_FUTURES') return 'crypto-futures';
  if (market === 'CRYPTO_SPOT') return 'crypto-spot';
  return 'stock';
}

function toPaperSide(side: 'LONG' | 'SHORT'): PaperSide {
  return side === 'LONG' ? 'long' : 'short';
}

function blankEvidence(
  input: Partial<AuthoritativePaperRiskSizingInput>,
  nowMs: number,
  status: Exclude<AuthoritativePaperRiskSizingStatus, 'PRESENT'>,
  blockers: readonly string[],
  partial: Partial<AuthoritativePaperRiskSizingEvidence> = {},
): AuthoritativePaperRiskSizingEvidence {
  const market = marketSupported(input.market) ? input.market : null;
  const symbol = normalizeSymbol(input.symbol);
  const side = input.side === 'LONG' || input.side === 'SHORT' ? input.side : null;
  return deepFreeze({
    schemaVersion: AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION,
    status,
    source: 'GENERIC_AUTHORITATIVE_PAPER_RISK_SIZING',
    provenance: [],
    generatedAt: new Date(nowMs).toISOString(),
    observedAtMs: null,
    market,
    symbol,
    strategyScope: nonEmpty(input.strategyScope) ? input.strategyScope.trim() : null,
    side,
    researchCodeSha: exactSha(input.researchCodeSha) ? input.researchCodeSha : null,
    paperStateSourceSha: exactSha(input.paperStateSourceSha) ? input.paperStateSourceSha : null,
    paperAccountId: nonEmpty(input.paperAccountId) ? input.paperAccountId.trim() : null,
    equity: null,
    riskPercent: null,
    requestedLeverage: null,
    effectiveLeverage: null,
    marginMode: null,
    policyId: null,
    policyVersion: null,
    contractRuleVersion: null,
    entryPrice: null,
    stopLossPrice: null,
    rawQuantity: null,
    roundedQuantity: null,
    targetQuantity: null,
    estimatedNotional: null,
    riskAmount: null,
    valid: false,
    eligible: false,
    blockers: [...new Set(blockers)],
    blockedReason: blockers[0] ?? null,
    riskEngineResult: null,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    privateProviderCallCount: 0,
    realOrderSideEffectCount: 0,
    ...partial,
  }) as AuthoritativePaperRiskSizingEvidence;
}

function validatePolicy(
  value: unknown,
  input: Readonly<{
    market: AuthoritativePaperRiskSizingMarket;
    symbol: string;
    strategyScope: string;
    researchCodeSha: string;
  }>,
  nowMs: number,
): { policy: AuthoritativePaperRiskPolicyEvidenceV1 | null; blockers: string[] } {
  const blockers: string[] = [];
  const object = record(value);
  if (!object) return { policy: null, blockers: ['RISK_POLICY_MISSING'] };
  if (object.schemaVersion !== 'authoritative-paper-generic-risk-policy-evidence-v1') blockers.push('RISK_POLICY_SCHEMA_INVALID');
  if (!nonEmpty(object.policyId)) blockers.push('RISK_POLICY_ID_MISSING');
  if (!nonEmpty(object.policyVersion)) blockers.push('RISK_POLICY_VERSION_MISSING');
  if (!nonEmpty(object.source)) blockers.push('RISK_POLICY_SOURCE_MISSING');
  if (!nonEmptyStrings(object.provenance)) blockers.push('RISK_POLICY_PROVENANCE_MISSING');
  if (!fresh(Number(object.observedAtMs), Number(object.maximumAgeMs), nowMs)) blockers.push('RISK_POLICY_STALE_OR_INVALID');
  if (!exactSha(object.researchCodeSha) || object.researchCodeSha !== input.researchCodeSha) blockers.push('RISK_POLICY_RESEARCH_SHA_MISMATCH');
  if (!Array.isArray(object.marketScopes) || !object.marketScopes.includes(input.market)) blockers.push('RISK_POLICY_WRONG_MARKET_SCOPE');
  if (!Array.isArray(object.strategyScopes) || !object.strategyScopes.includes(input.strategyScope)) blockers.push('RISK_POLICY_WRONG_STRATEGY_SCOPE');
  const symbolScopes = object.symbolScopes;
  if (symbolScopes !== '*' && (!Array.isArray(symbolScopes) || !symbolScopes.map(normalizeSymbol).includes(input.symbol))) {
    blockers.push('RISK_POLICY_WRONG_SYMBOL_SCOPE');
  }
  if (!positive(object.riskPercent) || object.riskPercent > TRADING_RISK_POLICY.maximumRiskPercent) blockers.push('RISK_POLICY_RISK_PERCENT_INVALID');
  if (!positive(object.requestedLeverage)) blockers.push('RISK_POLICY_REQUESTED_LEVERAGE_MISSING_OR_INVALID');
  if (object.maximumLeverage != null && !positive(object.maximumLeverage)) blockers.push('RISK_POLICY_MAXIMUM_LEVERAGE_INVALID');
  if (positive(object.requestedLeverage) && positive(object.maximumLeverage)
    && object.requestedLeverage > object.maximumLeverage) blockers.push('RISK_POLICY_REQUESTED_LEVERAGE_EXCEEDS_POLICY');
  if (input.market === 'CRYPTO_FUTURES') {
    if (!positive(object.maximumLeverage)) blockers.push('RISK_POLICY_MAXIMUM_LEVERAGE_REQUIRED');
    if (object.marginMode !== 'isolated' && object.marginMode !== 'cross') blockers.push('RISK_POLICY_MARGIN_MODE_INVALID');
  } else {
    if (object.marginMode !== 'cash') blockers.push('RISK_POLICY_CASH_MARGIN_MODE_REQUIRED');
    if (object.requestedLeverage !== 1) blockers.push('RISK_POLICY_CASH_LEVERAGE_MUST_BE_EXPLICIT_ONE');
  }
  return blockers.length > 0
    ? { policy: null, blockers }
    : { policy: value as AuthoritativePaperRiskPolicyEvidenceV1, blockers };
}

function validateContractRulesEvidence(
  value: unknown,
  market: AuthoritativePaperRiskSizingMarket,
  symbol: string,
  nowMs: number,
): { evidence: AuthoritativePaperContractRulesEvidenceV1 | null; blockers: string[] } {
  const blockers: string[] = [];
  const object = record(value);
  if (!object) return { evidence: null, blockers: ['CONTRACT_RULES_MISSING'] };
  if (object.schemaVersion !== 'authoritative-paper-contract-rules-evidence-v1') blockers.push('CONTRACT_RULES_SCHEMA_INVALID');
  if (object.market !== market) blockers.push('CONTRACT_RULES_WRONG_MARKET');
  if (normalizeSymbol(object.symbol) !== symbol) blockers.push('CONTRACT_RULES_WRONG_SYMBOL');
  if (!nonEmpty(object.ruleVersion)) blockers.push('CONTRACT_RULE_VERSION_MISSING');
  if (!nonEmpty(object.source)) blockers.push('CONTRACT_RULES_SOURCE_MISSING');
  if (!nonEmptyStrings(object.provenance)) blockers.push('CONTRACT_RULES_PROVENANCE_MISSING');
  if (!fresh(Number(object.observedAtMs), Number(object.maximumAgeMs), nowMs)) blockers.push('CONTRACT_RULES_STALE_OR_INVALID');
  const rules = record(object.rules);
  if (!rules) return { evidence: null, blockers: [...blockers, 'CONTRACT_RULES_INVALID'] };
  if (normalizeSymbol(rules.symbol) !== symbol) blockers.push('CONTRACT_RULES_PAYLOAD_SYMBOL_MISMATCH');
  if (rules.status !== 'live') blockers.push('CONTRACT_RULES_NOT_LIVE');
  const updatedAtMs = typeof rules.updatedAt === 'string' ? Date.parse(rules.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs)
    || !fresh(updatedAtMs, Number(object.maximumAgeMs), nowMs)) blockers.push('CONTRACT_RULES_PAYLOAD_STALE');
  if (!positive(rules.quantityStep)) blockers.push('CONTRACT_RULES_QUANTITY_STEP_REQUIRED');
  if (!finite(rules.quantityPrecision) || !Number.isInteger(rules.quantityPrecision)
    || rules.quantityPrecision < 0 || rules.quantityPrecision > 12) blockers.push('CONTRACT_RULES_QUANTITY_PRECISION_REQUIRED');
  if (!positive(rules.minimumQuantity)) blockers.push('CONTRACT_RULES_MINIMUM_QUANTITY_REQUIRED');
  if (!positive(rules.minimumNotional)) blockers.push('CONTRACT_RULES_MINIMUM_NOTIONAL_REQUIRED');
  if (market === 'CRYPTO_FUTURES') {
    if (!positive(rules.maximumLeverage)) blockers.push('CONTRACT_RULES_MAXIMUM_LEVERAGE_REQUIRED');
    if (!nonNegative(rules.maintenanceMarginRate) || Number(rules.maintenanceMarginRate) >= 1) {
      blockers.push('CONTRACT_RULES_MAINTENANCE_MARGIN_REQUIRED');
    }
  } else if (rules.maximumLeverage != null && !positive(rules.maximumLeverage)) {
    blockers.push('CONTRACT_RULES_MAXIMUM_LEVERAGE_INVALID');
  }
  return blockers.length > 0
    ? { evidence: null, blockers }
    : { evidence: value as AuthoritativePaperContractRulesEvidenceV1, blockers };
}

function validateMarketEvidence(
  value: unknown,
  market: AuthoritativePaperRiskSizingMarket,
  symbol: string,
  side: 'LONG' | 'SHORT',
  nowMs: number,
): { evidence: AuthoritativePaperMarketRiskEvidenceV1 | null; blockers: string[] } {
  const blockers: string[] = [];
  const object = record(value);
  if (!object) return { evidence: null, blockers: ['MARKET_EVIDENCE_MISSING'] };
  if (object.schemaVersion !== 'authoritative-paper-market-risk-evidence-v1') blockers.push('MARKET_EVIDENCE_SCHEMA_INVALID');
  if (object.market !== market) blockers.push('MARKET_EVIDENCE_WRONG_MARKET');
  if (normalizeSymbol(object.symbol) !== symbol) blockers.push('MARKET_EVIDENCE_WRONG_SYMBOL');
  if (!nonEmpty(object.source)) blockers.push('MARKET_EVIDENCE_SOURCE_MISSING');
  if (!nonEmptyStrings(object.provenance)) blockers.push('MARKET_EVIDENCE_PROVENANCE_MISSING');
  if (!fresh(Number(object.observedAtMs), Number(object.maximumAgeMs), nowMs)) blockers.push('MARKET_EVIDENCE_STALE_OR_INVALID');
  if (object.status !== 'live') blockers.push('MARKET_EVIDENCE_NOT_LIVE');
  if (!positive(object.entryPrice)) blockers.push('MARKET_ENTRY_PRICE_INVALID');
  if (!positive(object.stopLossPrice)) blockers.push('MARKET_STOP_PRICE_INVALID');
  if (positive(object.entryPrice) && positive(object.stopLossPrice)) {
    if (side === 'LONG' && object.stopLossPrice >= object.entryPrice) blockers.push('MARKET_STOP_DIRECTION_INVALID');
    if (side === 'SHORT' && object.stopLossPrice <= object.entryPrice) blockers.push('MARKET_STOP_DIRECTION_INVALID');
  }
  return blockers.length > 0
    ? { evidence: null, blockers }
    : { evidence: value as AuthoritativePaperMarketRiskEvidenceV1, blockers };
}

function validateCostEvidence(
  value: unknown,
  market: AuthoritativePaperRiskSizingMarket,
  symbol: string,
  nowMs: number,
): { evidence: AuthoritativePaperRiskCostEvidenceV1 | null; blockers: string[] } {
  const blockers: string[] = [];
  const object = record(value);
  if (!object) return { evidence: null, blockers: ['RISK_COST_EVIDENCE_MISSING'] };
  if (object.schemaVersion !== 'authoritative-paper-risk-cost-evidence-v1') blockers.push('RISK_COST_EVIDENCE_SCHEMA_INVALID');
  if (object.market !== market) blockers.push('RISK_COST_EVIDENCE_WRONG_MARKET');
  if (normalizeSymbol(object.symbol) !== symbol) blockers.push('RISK_COST_EVIDENCE_WRONG_SYMBOL');
  if (!nonEmpty(object.source)) blockers.push('RISK_COST_EVIDENCE_SOURCE_MISSING');
  if (!nonEmptyStrings(object.provenance)) blockers.push('RISK_COST_EVIDENCE_PROVENANCE_MISSING');
  if (!fresh(Number(object.observedAtMs), Number(object.maximumAgeMs), nowMs)) blockers.push('RISK_COST_EVIDENCE_STALE_OR_INVALID');
  if (!nonNegative(object.entryFeeRate) || !nonNegative(object.exitFeeRate) || !nonNegative(object.slippageRate)) {
    blockers.push('RISK_COST_RATE_INVALID');
  }
  if (!finite(object.estimatedFundingRate)) blockers.push('RISK_FUNDING_RATE_INVALID');
  if (market !== 'CRYPTO_FUTURES' && object.estimatedFundingRate !== 0) {
    blockers.push('RISK_FUNDING_MUST_BE_EXPLICIT_ZERO_WHEN_NOT_APPLICABLE');
  }
  return blockers.length > 0
    ? { evidence: null, blockers }
    : { evidence: value as AuthoritativePaperRiskCostEvidenceV1, blockers };
}

export function buildAuthoritativePaperRiskSizingEvidence(
  input: AuthoritativePaperRiskSizingInput,
  nowMs = Date.now(),
): AuthoritativePaperRiskSizingEvidence {
  if (!finite(nowMs) || nowMs <= 0) {
    throw new TypeError('AUTHORITATIVE_PAPER_RISK_SIZING_CLOCK_INVALID');
  }
  if (!marketSupported(input?.market)) {
    return blankEvidence(input ?? {}, nowMs, 'BLOCKED_DATA', ['UNSUPPORTED_MARKET']);
  }
  const market = input.market;
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['SYMBOL_INVALID']);
  if (!nonEmpty(input.strategyScope)) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['STRATEGY_SCOPE_REQUIRED']);
  if (!sideSupported(market, input.side)) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['UNSUPPORTED_SIDE']);
  if (!exactSha(input.researchCodeSha)) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['RESEARCH_SHA_INVALID']);
  if (!exactSha(input.paperStateSourceSha)) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['PAPER_STATE_SOURCE_SHA_INVALID']);
  if (!nonEmpty(input.paperAccountId)) return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['PAPER_ACCOUNT_ID_REQUIRED']);

  const strategyScope = input.strategyScope.trim();
  const policyCheck = validatePolicy(input.riskPolicy, {
    market,
    symbol,
    strategyScope,
    researchCodeSha: input.researchCodeSha,
  }, nowMs);
  if (!policyCheck.policy) return blankEvidence(input, nowMs, 'BLOCKED_DATA', policyCheck.blockers);
  const policy = policyCheck.policy;

  let snapshot: PaperTradingStateSnapshot;
  try {
    snapshot = validateImmutablePaperTradingStateSnapshot(input.paperStateSnapshot, nowMs);
  } catch (error) {
    return blankEvidence(input, nowMs, 'BLOCKED_DATA', [
      error instanceof Error && error.message.includes('STALE') ? 'PAPER_STATE_STALE' : 'PAPER_STATE_MISSING_OR_INVALID',
    ], {
      riskPercent: policy.riskPercent,
      requestedLeverage: policy.requestedLeverage,
      marginMode: policy.marginMode,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
    });
  }
  const snapshotBlockers: string[] = [];
  if (snapshot.accountId !== input.paperAccountId.trim()) snapshotBlockers.push('PAPER_STATE_WRONG_ACCOUNT');
  if (snapshot.market !== market) snapshotBlockers.push('PAPER_STATE_WRONG_MARKET');
  if (snapshot.sourceSha !== input.paperStateSourceSha) snapshotBlockers.push('PAPER_STATE_WRONG_SOURCE_SHA');
  if (!positive(snapshot.equity) || snapshot.equity !== snapshot.state.account.equity) snapshotBlockers.push('PAPER_STATE_EQUITY_INVALID');
  if (snapshotBlockers.length > 0) {
    return blankEvidence(input, nowMs, 'BLOCKED_DATA', snapshotBlockers, {
      equity: positive(snapshot.equity) ? snapshot.equity : null,
      riskPercent: policy.riskPercent,
      requestedLeverage: policy.requestedLeverage,
      marginMode: policy.marginMode,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
    });
  }

  const contractCheck = validateContractRulesEvidence(input.contractRulesEvidence, market, symbol, nowMs);
  if (!contractCheck.evidence) {
    return blankEvidence(input, nowMs, 'BLOCKED_DATA', contractCheck.blockers, {
      equity: snapshot.equity,
      riskPercent: policy.riskPercent,
      requestedLeverage: policy.requestedLeverage,
      marginMode: policy.marginMode,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
    });
  }
  const contractEvidence = contractCheck.evidence;
  const rules = contractEvidence.rules;
  if (positive(rules.maximumLeverage) && policy.requestedLeverage > rules.maximumLeverage) {
    return blankEvidence(input, nowMs, 'BLOCKED_DATA', ['REQUESTED_LEVERAGE_EXCEEDS_CONTRACT'], {
      equity: snapshot.equity,
      riskPercent: policy.riskPercent,
      requestedLeverage: policy.requestedLeverage,
      marginMode: policy.marginMode,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      contractRuleVersion: contractEvidence.ruleVersion,
    });
  }

  const marketCheck = validateMarketEvidence(input.marketEvidence, market, symbol, input.side, nowMs);
  if (!marketCheck.evidence) return blankEvidence(input, nowMs, 'BLOCKED_DATA', marketCheck.blockers, {
    equity: snapshot.equity,
    riskPercent: policy.riskPercent,
    requestedLeverage: policy.requestedLeverage,
    marginMode: policy.marginMode,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    contractRuleVersion: contractEvidence.ruleVersion,
  });
  const marketEvidence = marketCheck.evidence;

  const costCheck = validateCostEvidence(input.costEvidence, market, symbol, nowMs);
  if (!costCheck.evidence) return blankEvidence(input, nowMs, 'BLOCKED_DATA', costCheck.blockers, {
    equity: snapshot.equity,
    riskPercent: policy.riskPercent,
    requestedLeverage: policy.requestedLeverage,
    marginMode: policy.marginMode,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    contractRuleVersion: contractEvidence.ruleVersion,
    entryPrice: marketEvidence.entryPrice,
    stopLossPrice: marketEvidence.stopLossPrice,
  });
  const costEvidence = costCheck.evidence;

  const paperSide = toPaperSide(input.side);
  const openPositions = snapshot.state.positions.filter((position) => position.status !== 'closed');
  const openExposure = openPositions.reduce((sum, position) => sum + position.notionalValue, 0);
  const sameDirectionExposure = openPositions
    .filter((position) => position.side === paperSide)
    .reduce((sum, position) => sum + position.notionalValue, 0);

  const riskEngineResult = calculateTradingRisk({
    market: tradingRiskMarket(market),
    symbol,
    side: paperSide,
    accountBalance: snapshot.equity,
    entryPrice: marketEvidence.entryPrice,
    stopLossPrice: marketEvidence.stopLossPrice,
    targetPrice1: null,
    targetPrice2: null,
    leverage: policy.requestedLeverage,
    riskPercent: policy.riskPercent,
    entryFeeRate: costEvidence.entryFeeRate,
    exitFeeRate: costEvidence.exitFeeRate,
    slippageRate: costEvidence.slippageRate,
    estimatedFundingRate: costEvidence.estimatedFundingRate,
    quantityStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    minimumQuantity: rules.minimumQuantity,
    minimumNotional: rules.minimumNotional,
    maintenanceMarginRate: market === 'CRYPTO_FUTURES' ? rules.maintenanceMarginRate : null,
    maximumLeverage: rules.maximumLeverage,
    appMaximumLeverage: market === 'CRYPTO_FUTURES' ? policy.maximumLeverage : null,
    contractRulesStatus: rules.status,
    dailyRealizedPnl: snapshot.state.riskState.dailyRealizedPnl,
    weeklyRealizedPnl: snapshot.state.riskState.weeklyRealizedPnl,
    consecutiveLosses: snapshot.state.riskState.consecutiveLosses,
    openExposure,
    sameDirectionExposure,
    dataStatus: marketEvidence.status,
  }, new Date(nowMs));

  const provenance = [
    ...policy.provenance,
    ...snapshot.provenance,
    ...contractEvidence.provenance,
    ...marketEvidence.provenance,
    ...costEvidence.provenance,
    policy.source,
    contractEvidence.source,
    marketEvidence.source,
    costEvidence.source,
    'trading-risk-engine.service.ts',
  ].filter(nonEmpty);
  const observedAtMs = Math.min(
    policy.observedAtMs,
    snapshot.observedAtMs,
    contractEvidence.observedAtMs,
    marketEvidence.observedAtMs,
    costEvidence.observedAtMs,
  );
  const common = {
    provenance,
    observedAtMs,
    market,
    symbol,
    strategyScope,
    side: input.side,
    researchCodeSha: input.researchCodeSha,
    paperStateSourceSha: input.paperStateSourceSha,
    paperAccountId: snapshot.accountId,
    equity: snapshot.equity,
    riskPercent: policy.riskPercent,
    requestedLeverage: policy.requestedLeverage,
    effectiveLeverage: policy.requestedLeverage,
    marginMode: policy.marginMode,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    contractRuleVersion: contractEvidence.ruleVersion,
    entryPrice: marketEvidence.entryPrice,
    stopLossPrice: marketEvidence.stopLossPrice,
    rawQuantity: riskEngineResult.rawQuantity,
    roundedQuantity: riskEngineResult.recommendedQuantity,
    estimatedNotional: riskEngineResult.notionalValue,
    riskAmount: riskEngineResult.maximumRiskAmount,
    riskEngineResult,
  } as const;

  if (!riskEngineResult.allowed
    || !positive(riskEngineResult.recommendedQuantity)
    || !positive(riskEngineResult.notionalValue)
    || !positive(riskEngineResult.maximumRiskAmount)) {
    const blockers = riskEngineResult.blockCodes.length > 0
      ? riskEngineResult.blockCodes.map((code) => `RISK_ENGINE_${code}`)
      : ['RISK_ENGINE_NO_ELIGIBLE_QUANTITY'];
    return blankEvidence(input, nowMs, 'NO_TRADE', blockers, {
      ...common,
      targetQuantity: null,
      valid: true,
      eligible: false,
    });
  }

  return deepFreeze({
    schemaVersion: AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION,
    status: 'PRESENT',
    source: 'GENERIC_AUTHORITATIVE_PAPER_RISK_SIZING',
    ...common,
    generatedAt: new Date(nowMs).toISOString(),
    targetQuantity: riskEngineResult.recommendedQuantity,
    valid: true,
    eligible: true,
    blockers: [],
    blockedReason: null,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    privateProviderCallCount: 0,
    realOrderSideEffectCount: 0,
  }) as AuthoritativePaperRiskSizingEvidence;
}

export const AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION,
  riskPolicyDecisionAuthority: 'NONE',
  riskPercentDefaultAllowed: false,
  leverageDefaultAllowed: false,
  equityDefaultAllowed: false,
  minimumQuantityFabricationAllowed: false,
  unknownEvidenceIsZero: false,
  existingTradingRiskEngineRequired: true,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  financialMutationAllowed: false,
  privateProviderCallCount: 0,
  realOrderSideEffectCount: 0,
});
