import type { TradingCostPolicy } from './profit-first-signal.service.js';
import {
  validatePaperReadiness,
  type PaperMarket,
  type PaperReadinessEvidence,
} from './trade-paper-market-contract.service.js';

export type CostEvidenceQuality = 'OBSERVED' | 'DOCUMENTED' | 'ESTIMATED' | 'NOT_APPLICABLE';

export type PercentCostEvidence = Readonly<{
  valuePercent: number;
  quality: CostEvidenceQuality;
  source: string;
  observedAtMs: number;
}>;

export type SupplementalExecutionCostEvidence = Readonly<{
  costPolicyId: string;
  observedAtMs: number;
  latency: PercentCostEvidence;
  liquidityImpact: PercentCostEvidence;
  partialFillImpact: PercentCostEvidence;
  funding?: PercentCostEvidence;
}>;

export type ScannerCostEvidenceBlocker =
  | 'PAPER_READINESS_BLOCKED'
  | 'COST_POLICY_ID_REQUIRED'
  | 'SUPPLEMENTAL_TIMESTAMP_INVALID'
  | 'SUPPLEMENTAL_EVIDENCE_FROM_FUTURE'
  | 'SUPPLEMENTAL_EVIDENCE_STALE'
  | 'LATENCY_EVIDENCE_REQUIRED'
  | 'LIQUIDITY_IMPACT_EVIDENCE_REQUIRED'
  | 'PARTIAL_FILL_IMPACT_EVIDENCE_REQUIRED'
  | 'FUNDING_EVIDENCE_REQUIRED'
  | 'COST_COMPONENT_INVALID'
  | 'COST_COMPONENT_SOURCE_REQUIRED'
  | 'COST_COMPONENT_TIMESTAMP_INVALID'
  | 'COST_COMPONENT_FROM_FUTURE'
  | 'COST_COMPONENT_STALE'
  | 'NOT_APPLICABLE_COMPONENT_MUST_BE_ZERO'
  | 'FUNDING_NOT_APPLICABLE_ONLY_IF_EXPLICIT_ZERO';

export type ScannerCostEvidenceProvenance = Readonly<{
  market: PaperMarket;
  policyId: string;
  paperCostPolicyVersion: string;
  providerProvenance: string;
  taxPolicyVersion: string | null;
  components: Readonly<Record<
    'commission' | 'tax' | 'spread' | 'slippage' | 'funding' | 'latency' | 'liquidityImpact' | 'partialFillImpact',
    PercentCostEvidence
  >>;
}>;

export type ScannerCostPolicyResult = Readonly<{
  status: 'READY' | 'NOT_EVIDENCED';
  policy: TradingCostPolicy | null;
  provenance: ScannerCostEvidenceProvenance | null;
  blockers: readonly ScannerCostEvidenceBlocker[];
  executionAuthority: 'NONE';
  orderSubmitted: false;
  exchangeRequestSent: false;
  privateApiUsed: false;
  liveTrading: false;
}>;

const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;
const QUALITIES = new Set<CostEvidenceQuality>(['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE']);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function add(blockers: ScannerCostEvidenceBlocker[], blocker: ScannerCostEvidenceBlocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function notApplicable(value: number, source: string, observedAtMs: number): PercentCostEvidence {
  return Object.freeze({ valuePercent: value, quality: 'NOT_APPLICABLE' as const, source, observedAtMs });
}

function derived(value: number, source: string, observedAtMs: number, quality: CostEvidenceQuality = 'OBSERVED'): PercentCostEvidence {
  return Object.freeze({ valuePercent: value, quality, source, observedAtMs });
}

function validateComponent(
  component: PercentCostEvidence | undefined,
  blockers: ScannerCostEvidenceBlocker[],
  requiredBlocker: ScannerCostEvidenceBlocker,
  nowMs: number,
  maxEvidenceAgeMs: number,
): component is PercentCostEvidence {
  if (!component) {
    add(blockers, requiredBlocker);
    return false;
  }
  let valid = true;
  if (!finiteNonNegative(component.valuePercent) || !QUALITIES.has(component.quality)) {
    add(blockers, 'COST_COMPONENT_INVALID');
    valid = false;
  }
  if (!nonEmptyString(component.source)) {
    add(blockers, 'COST_COMPONENT_SOURCE_REQUIRED');
    valid = false;
  }
  if (!Number.isFinite(component.observedAtMs) || component.observedAtMs <= 0) {
    add(blockers, 'COST_COMPONENT_TIMESTAMP_INVALID');
    valid = false;
  } else if (component.observedAtMs > nowMs) {
    add(blockers, 'COST_COMPONENT_FROM_FUTURE');
    valid = false;
  } else if (nowMs - component.observedAtMs > maxEvidenceAgeMs) {
    add(blockers, 'COST_COMPONENT_STALE');
    valid = false;
  }
  if (component.quality === 'NOT_APPLICABLE' && component.valuePercent !== 0) {
    add(blockers, 'NOT_APPLICABLE_COMPONENT_MUST_BE_ZERO');
    valid = false;
  }
  return valid;
}

function result(
  blockers: ScannerCostEvidenceBlocker[],
  policy: TradingCostPolicy | null = null,
  provenance: ScannerCostEvidenceProvenance | null = null,
): ScannerCostPolicyResult {
  return Object.freeze({
    status: blockers.length === 0 ? 'READY' : 'NOT_EVIDENCED',
    policy: blockers.length === 0 ? policy : null,
    provenance: blockers.length === 0 ? provenance : null,
    blockers: Object.freeze([...blockers]),
    executionAuthority: 'NONE',
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateApiUsed: false,
    liveTrading: false,
  });
}

export function buildScannerTradingCostPolicy(input: {
  paperEvidence: PaperReadinessEvidence;
  supplemental: SupplementalExecutionCostEvidence;
  nowMs?: number;
  maxEvidenceAgeMs?: number;
}): ScannerCostPolicyResult {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const blockers: ScannerCostEvidenceBlocker[] = [];

  const readiness = validatePaperReadiness(input.paperEvidence, nowMs, maxEvidenceAgeMs);
  if (!readiness.ready) add(blockers, 'PAPER_READINESS_BLOCKED');

  const supplemental = input.supplemental;
  if (!nonEmptyString(supplemental?.costPolicyId)) add(blockers, 'COST_POLICY_ID_REQUIRED');
  if (!Number.isFinite(supplemental?.observedAtMs) || supplemental.observedAtMs <= 0) {
    add(blockers, 'SUPPLEMENTAL_TIMESTAMP_INVALID');
  } else if (supplemental.observedAtMs > nowMs) {
    add(blockers, 'SUPPLEMENTAL_EVIDENCE_FROM_FUTURE');
  } else if (nowMs - supplemental.observedAtMs > maxEvidenceAgeMs) {
    add(blockers, 'SUPPLEMENTAL_EVIDENCE_STALE');
  }

  const latencyOk = validateComponent(
    supplemental?.latency,
    blockers,
    'LATENCY_EVIDENCE_REQUIRED',
    nowMs,
    maxEvidenceAgeMs,
  );
  const liquidityOk = validateComponent(
    supplemental?.liquidityImpact,
    blockers,
    'LIQUIDITY_IMPACT_EVIDENCE_REQUIRED',
    nowMs,
    maxEvidenceAgeMs,
  );
  const partialFillOk = validateComponent(
    supplemental?.partialFillImpact,
    blockers,
    'PARTIAL_FILL_IMPACT_EVIDENCE_REQUIRED',
    nowMs,
    maxEvidenceAgeMs,
  );

  const paper = input.paperEvidence;
  let funding: PercentCostEvidence;
  if (paper.market === 'CRYPTO_FUTURES') {
    const fundingOk = validateComponent(
      supplemental?.funding,
      blockers,
      'FUNDING_EVIDENCE_REQUIRED',
      nowMs,
      maxEvidenceAgeMs,
    );
    if (!fundingOk) {
      funding = derived(0, 'missing', nowMs, 'ESTIMATED');
    } else {
      funding = supplemental.funding as PercentCostEvidence;
      if (funding.quality === 'NOT_APPLICABLE' && funding.valuePercent !== 0) {
        add(blockers, 'FUNDING_NOT_APPLICABLE_ONLY_IF_EXPLICIT_ZERO');
      }
    }
  } else {
    funding = notApplicable(0, `market-contract:${paper.market}:funding-not-applicable`, paper.observedAtMs);
  }

  if (blockers.length > 0 || !latencyOk || !liquidityOk || !partialFillOk) return result(blockers);

  const commission = derived(paper.feePercent, `${paper.providerProvenance}:fee`, paper.observedAtMs);
  const spread = derived(paper.spreadPercent, `${paper.providerProvenance}:spread`, paper.observedAtMs);
  const slippage = derived(paper.slippagePercent, `${paper.providerProvenance}:slippage`, paper.observedAtMs);
  const tax = paper.market === 'KR_STOCK' || paper.market === 'US_STOCK'
    ? derived(paper.taxPercent, `tax-policy:${paper.taxPolicyVersion}`, paper.observedAtMs, 'DOCUMENTED')
    : notApplicable(0, `market-contract:${paper.market}:tax-not-applicable`, paper.observedAtMs);

  const policy: TradingCostPolicy = Object.freeze({
    id: supplemental.costPolicyId,
    market: paper.market,
    commissionPercent: commission.valuePercent,
    taxPercent: tax.valuePercent,
    spreadPercent: spread.valuePercent,
    slippagePercent: slippage.valuePercent,
    fundingPercent: funding.valuePercent,
    latencyPercent: supplemental.latency.valuePercent,
    liquidityImpactPercent: supplemental.liquidityImpact.valuePercent,
    partialFillImpactPercent: supplemental.partialFillImpact.valuePercent,
    source: 'EXPLICIT_RUNTIME_POLICY',
  });

  const provenance: ScannerCostEvidenceProvenance = Object.freeze({
    market: paper.market,
    policyId: supplemental.costPolicyId,
    paperCostPolicyVersion: paper.costPolicyVersion,
    providerProvenance: paper.providerProvenance,
    taxPolicyVersion: paper.market === 'KR_STOCK' || paper.market === 'US_STOCK' ? paper.taxPolicyVersion : null,
    components: Object.freeze({
      commission,
      tax,
      spread,
      slippage,
      funding,
      latency: supplemental.latency,
      liquidityImpact: supplemental.liquidityImpact,
      partialFillImpact: supplemental.partialFillImpact,
    }),
  });

  return result(blockers, policy, provenance);
}
