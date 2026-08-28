import {
  buildAuthoritativePaperRiskSizingEvidence,
  type AuthoritativePaperRiskPolicyEvidenceV1,
  type AuthoritativePaperRiskSizingEvidence,
  type AuthoritativePaperRiskSizingInput,
  type AuthoritativePaperRiskSizingMarket,
} from './authoritative-paper-risk-sizing-source.service';

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION =
  'authoritative-paper-generic-risk-policy-producer-v1' as const;

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_RECORD_VERSION =
  'authoritative-paper-generic-risk-policy-record-v1' as const;

export const AUTHORITATIVE_PAPER_GENERIC_RISK_SIZING_BRIDGE_VERSION =
  'authoritative-paper-generic-risk-sizing-bridge-v1' as const;

export type AuthoritativePaperGenericRiskPolicyRequest = Readonly<{
  market: AuthoritativePaperRiskSizingMarket;
  symbol: string;
  strategyScope: string;
  researchCodeSha: string;
}>;

/**
 * A canonical record is an explicit persisted/configured policy record.
 * The producer never derives financial choices from engine guardrails or market type.
 * Every financial policy field is present on this record; merged #769 remains the
 * final validator and the sole authority allowed to calculate target quantity.
 */
export type AuthoritativePaperGenericRiskPolicyRecordV1 = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_RECORD_VERSION;
  recordId: string;
  recordVersion: string;
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

export type AuthoritativePaperGenericRiskPolicyRecordSource = (
  request: AuthoritativePaperGenericRiskPolicyRequest,
) => unknown | Promise<unknown>;

export type AuthoritativePaperGenericRiskPolicySourceResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  recordId: string | null;
  recordVersion: string | null;
  source: string | null;
  provenance: readonly string[];
  observedAtMs: number | null;
  maximumAgeMs: number | null;
  researchCodeSha: string | null;
  policyEvidence: AuthoritativePaperRiskPolicyEvidenceV1 | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  realOrderAllowed: false;
  financialMutationAllowed: false;
}>;

export type AuthoritativePaperGenericRiskPolicyProducer = (
  request: AuthoritativePaperGenericRiskPolicyRequest,
) => Promise<AuthoritativePaperGenericRiskPolicySourceResult>;

export type AuthoritativePaperGenericRiskSizingBridgeResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_GENERIC_RISK_SIZING_BRIDGE_VERSION;
  policySource: AuthoritativePaperGenericRiskPolicySourceResult;
  sizingEvidence: AuthoritativePaperRiskSizingEvidence;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  realOrderAllowed: false;
  financialMutationAllowed: false;
}>;

const SUPPORTED_MARKETS = new Set<AuthoritativePaperRiskSizingMarket>([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function fresh(observedAtMs: unknown, maximumAgeMs: unknown, nowMs: number): boolean {
  return positive(observedAtMs)
    && positive(maximumAgeMs)
    && observedAtMs <= nowMs
    && nowMs - observedAtMs <= maximumAgeMs;
}

function nonEmptyStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function supportedMarketScopes(
  value: unknown,
): value is readonly AuthoritativePaperRiskSizingMarket[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((market) => SUPPORTED_MARKETS.has(market as AuthoritativePaperRiskSizingMarket));
}

function normalizedSymbolScopes(value: unknown): '*' | readonly string[] | null {
  if (value === '*') return '*';
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes = value.map(normalizeSymbol);
  return scopes.every((symbol): symbol is string => symbol != null)
    ? Object.freeze(scopes)
    : null;
}

function normalizeSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/u.test(symbol) ? symbol : null;
}

function blocked(
  request: Partial<AuthoritativePaperGenericRiskPolicyRequest>,
  blockers: readonly string[],
): AuthoritativePaperGenericRiskPolicySourceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
    status: 'BLOCKED_DATA',
    recordId: null,
    recordVersion: null,
    source: null,
    provenance: Object.freeze([]),
    observedAtMs: null,
    maximumAgeMs: null,
    researchCodeSha: exactSha(request.researchCodeSha) ? request.researchCodeSha : null,
    policyEvidence: null,
    blockers: Object.freeze([...new Set(blockers)]),
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    realOrderAllowed: false,
    financialMutationAllowed: false,
  });
}

function validateRequest(
  request: AuthoritativePaperGenericRiskPolicyRequest,
): readonly string[] {
  const blockers: string[] = [];
  if (!SUPPORTED_MARKETS.has(request?.market)) blockers.push('RISK_POLICY_SOURCE_MARKET_UNSUPPORTED');
  if (!normalizeSymbol(request?.symbol)) blockers.push('RISK_POLICY_SOURCE_SYMBOL_INVALID');
  if (!nonEmpty(request?.strategyScope)) blockers.push('RISK_POLICY_SOURCE_STRATEGY_SCOPE_REQUIRED');
  if (!exactSha(request?.researchCodeSha)) blockers.push('RISK_POLICY_SOURCE_EXACT_RESEARCH_SHA_REQUIRED');
  return blockers;
}

function validateRecordEnvelope(
  value: unknown,
  request: AuthoritativePaperGenericRiskPolicyRequest,
  nowMs: number,
): { record: AuthoritativePaperGenericRiskPolicyRecordV1 | null; blockers: readonly string[] } {
  const blockers: string[] = [];
  const object = record(value);
  if (!object) return { record: null, blockers: ['RISK_POLICY_CANONICAL_RECORD_MISSING'] };

  if (object.schemaVersion !== AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_RECORD_VERSION) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_SCHEMA_INVALID');
  }
  if (!nonEmpty(object.recordId)) blockers.push('RISK_POLICY_CANONICAL_RECORD_ID_MISSING');
  if (!nonEmpty(object.recordVersion)) blockers.push('RISK_POLICY_CANONICAL_RECORD_VERSION_MISSING');
  if (!nonEmpty(object.policyId)) blockers.push('RISK_POLICY_CANONICAL_RECORD_POLICY_ID_MISSING');
  if (!nonEmpty(object.policyVersion)) blockers.push('RISK_POLICY_CANONICAL_RECORD_POLICY_VERSION_MISSING');
  if (!nonEmpty(object.source)) blockers.push('RISK_POLICY_CANONICAL_RECORD_SOURCE_MISSING');
  if (!nonEmptyStrings(object.provenance)) blockers.push('RISK_POLICY_CANONICAL_RECORD_PROVENANCE_MISSING');
  if (!fresh(object.observedAtMs, object.maximumAgeMs, nowMs)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_STALE_OR_INVALID');
  }
  if (!exactSha(object.researchCodeSha) || object.researchCodeSha !== request.researchCodeSha) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_RESEARCH_SHA_MISMATCH');
  }
  if (!supportedMarketScopes(object.marketScopes)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_MARKET_SCOPES_INVALID');
  } else if (!object.marketScopes.includes(request.market)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_WRONG_MARKET_SCOPE');
  }
  if (!nonEmptyStrings(object.strategyScopes)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_STRATEGY_SCOPES_INVALID');
  } else if (!object.strategyScopes.map((scope) => scope.trim()).includes(request.strategyScope.trim())) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_WRONG_STRATEGY_SCOPE');
  }
  const symbolScopes = normalizedSymbolScopes(object.symbolScopes);
  if (!symbolScopes) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_SYMBOL_SCOPES_INVALID');
  } else if (symbolScopes !== '*' && !symbolScopes.includes(normalizeSymbol(request.symbol) as string)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_WRONG_SYMBOL_SCOPE');
  }
  if (!positive(object.riskPercent)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_RISK_PERCENT_INVALID');
  }
  if (!positive(object.requestedLeverage)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_REQUESTED_LEVERAGE_INVALID');
  }
  if (object.maximumLeverage != null && !positive(object.maximumLeverage)) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_MAXIMUM_LEVERAGE_INVALID');
  }
  if (positive(object.requestedLeverage) && positive(object.maximumLeverage)
    && object.requestedLeverage > object.maximumLeverage) {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_REQUESTED_LEVERAGE_EXCEEDS_MAXIMUM');
  }
  if (object.marginMode !== 'cash' && object.marginMode !== 'isolated' && object.marginMode !== 'cross') {
    blockers.push('RISK_POLICY_CANONICAL_RECORD_MARGIN_MODE_INVALID');
  }

  return blockers.length > 0
    ? { record: null, blockers: Object.freeze(blockers) }
    : { record: value as AuthoritativePaperGenericRiskPolicyRecordV1, blockers: Object.freeze([]) };
}

export function createAuthoritativePaperGenericRiskPolicyProducer(input: Readonly<{
  readCanonicalRecord: AuthoritativePaperGenericRiskPolicyRecordSource;
  now?: () => number;
}>): AuthoritativePaperGenericRiskPolicyProducer {
  if (typeof input?.readCanonicalRecord !== 'function') {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_CANONICAL_RECORD_SOURCE_REQUIRED');
  }
  const now = input.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_CLOCK_REQUIRED');
  }

  return async function produceAuthoritativePaperGenericRiskPolicy(
    request: AuthoritativePaperGenericRiskPolicyRequest,
  ): Promise<AuthoritativePaperGenericRiskPolicySourceResult> {
    const requestBlockers = validateRequest(request);
    if (requestBlockers.length > 0) return blocked(request ?? {}, requestBlockers);

    const nowMs = now();
    if (!positive(nowMs)) return blocked(request, ['RISK_POLICY_SOURCE_CLOCK_INVALID']);

    let rawRecord: unknown;
    try {
      rawRecord = await input.readCanonicalRecord(Object.freeze({
        market: request.market,
        symbol: normalizeSymbol(request.symbol) as string,
        strategyScope: request.strategyScope.trim(),
        researchCodeSha: request.researchCodeSha,
      }));
    } catch {
      return blocked(request, ['RISK_POLICY_CANONICAL_RECORD_SOURCE_ERROR']);
    }

    const checked = validateRecordEnvelope(rawRecord, request, nowMs);
    if (!checked.record) return blocked(request, checked.blockers);
    const canonicalRecord = checked.record;
    const symbolScopes = normalizedSymbolScopes(canonicalRecord.symbolScopes) as '*' | readonly string[];
    const policyEvidence: AuthoritativePaperRiskPolicyEvidenceV1 = Object.freeze({
      schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1',
      policyId: canonicalRecord.policyId.trim(),
      policyVersion: canonicalRecord.policyVersion.trim(),
      source: canonicalRecord.source.trim(),
      provenance: Object.freeze(canonicalRecord.provenance.map((item) => item.trim())),
      observedAtMs: canonicalRecord.observedAtMs,
      maximumAgeMs: canonicalRecord.maximumAgeMs,
      researchCodeSha: canonicalRecord.researchCodeSha,
      marketScopes: Object.freeze([...canonicalRecord.marketScopes]),
      strategyScopes: Object.freeze(canonicalRecord.strategyScopes.map((scope) => scope.trim())),
      symbolScopes,
      riskPercent: canonicalRecord.riskPercent,
      requestedLeverage: canonicalRecord.requestedLeverage,
      maximumLeverage: canonicalRecord.maximumLeverage,
      marginMode: canonicalRecord.marginMode,
    });

    return Object.freeze({
      schemaVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
      status: 'PRESENT',
      recordId: canonicalRecord.recordId.trim(),
      recordVersion: canonicalRecord.recordVersion.trim(),
      source: canonicalRecord.source.trim(),
      provenance: Object.freeze([
        ...canonicalRecord.provenance.map((item) => item.trim()),
        `canonicalRecord:${canonicalRecord.recordId.trim()}`,
        `recordVersion:${canonicalRecord.recordVersion.trim()}`,
      ]),
      observedAtMs: canonicalRecord.observedAtMs,
      maximumAgeMs: canonicalRecord.maximumAgeMs,
      researchCodeSha: canonicalRecord.researchCodeSha,
      // Every policy value comes from the explicit canonical record. Merged #769
      // remains the final validator and the sole quantity calculator.
      policyEvidence,
      blockers: Object.freeze([]),
      executionAuthority: 'NONE',
      privateApiAllowed: false,
      liveTrading: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    });
  };
}

/**
 * Canonical caller seam: source selection happens first, then the record-backed policy
 * evidence (or null) is handed to merged #769. #769 remains the only place
 * that validates riskPercent, requestedLeverage, marginMode, maximumLeverage,
 * freshness and market/strategy/symbol scope before any quantity can exist.
 */
export async function buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
  input: Omit<AuthoritativePaperRiskSizingInput, 'riskPolicy'>,
  producer: AuthoritativePaperGenericRiskPolicyProducer,
  nowMs = Date.now(),
): Promise<AuthoritativePaperGenericRiskSizingBridgeResult> {
  if (typeof producer !== 'function') {
    throw new TypeError('AUTHORITATIVE_GENERIC_RISK_POLICY_PRODUCER_REQUIRED');
  }

  const policySource = await producer({
    market: input.market,
    symbol: input.symbol,
    strategyScope: input.strategyScope,
    researchCodeSha: input.researchCodeSha,
  });
  const sizingEvidence = buildAuthoritativePaperRiskSizingEvidence({
    ...input,
    riskPolicy: policySource.policyEvidence,
  }, nowMs);

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_SIZING_BRIDGE_VERSION,
    policySource,
    sizingEvidence,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    realOrderAllowed: false,
    financialMutationAllowed: false,
  });
}

export const AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
  explicitCanonicalRecordRequired: true,
  asyncCanonicalRecordSourceSupported: true,
  engineGuardrailsArePolicyEvidence: false,
  riskPercentDefaultAllowed: false,
  requestedLeverageDefaultAllowed: false,
  marginModeDefaultAllowed: false,
  maximumLeverageDefaultAllowed: false,
  wildcardSymbolDefaultAllowed: false,
  canonicalConsumerValidationRequired: true,
  riskSizingConsumer: 'authoritative-paper-risk-sizing-source.service.ts',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  realOrderAllowed: false,
  financialMutationAllowed: false,
});
