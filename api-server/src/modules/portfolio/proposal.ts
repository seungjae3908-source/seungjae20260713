import type {
  EvidenceStatus,
  PortfolioAllocation,
  PortfolioProposalInput,
  PortfolioProposalResult,
  ProposalCandidate,
} from './types.ts';
import { PortfolioValidationError } from './analytics.ts';

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function evidenceStatus(candidate: ProposalCandidate): EvidenceStatus {
  if (candidate.scannerEvidence === 'insufficient' || candidate.backtestEvidence === 'insufficient') return 'insufficient';
  if (candidate.scannerEvidence === 'partial' || candidate.backtestEvidence === 'partial') return 'partial';
  return 'verified';
}

function rejectionReasons(candidate: ProposalCandidate, input: PortfolioProposalInput): string[] {
  const reasons: string[] = [];
  if (!input.markets.includes(candidate.market)) reasons.push('MARKET_NOT_SELECTED');
  if (candidate.dataQuality !== 'pass') reasons.push(candidate.dataQuality === 'fail' ? 'DATA_QUALITY_FAILED' : 'DATA_QUALITY_UNKNOWN');
  if (candidate.liquidity !== 'pass') reasons.push(candidate.liquidity === 'fail' ? 'LIQUIDITY_FAILED' : 'LIQUIDITY_UNKNOWN');
  if (candidate.risk !== 'pass') reasons.push(candidate.risk === 'fail' ? 'RISK_FAILED' : 'RISK_UNKNOWN');
  if (input.allocationPolicy?.requireKnownCorrelation && candidate.correlation !== 'pass') {
    reasons.push(candidate.correlation === 'fail' ? 'CORRELATION_FAILED' : 'CORRELATION_UNKNOWN');
  }
  if (input.allocationPolicy?.requireVerifiedBacktest && candidate.backtestEvidence !== 'verified') reasons.push('BACKTEST_EVIDENCE_NOT_VERIFIED');
  if (input.allocationPolicy?.requireScannerEvidence && candidate.scannerEvidence === 'insufficient') reasons.push('SCANNER_EVIDENCE_INSUFFICIENT');
  if (candidate.price == null || !Number.isFinite(candidate.price) || candidate.price <= 0) reasons.push('PRICE_UNAVAILABLE');
  return reasons;
}

export function proposePortfolio(input: PortfolioProposalInput): PortfolioProposalResult {
  if (!Number.isFinite(input.investmentBudget) || input.investmentBudget <= 0) {
    throw new PortfolioValidationError('INVALID_INVESTMENT_BUDGET', 'investmentBudget must be positive');
  }
  const required = new Set(input.requiredSymbols.map(normalizeSymbol).filter(Boolean));
  const excluded = new Set(input.excludedSymbols.map(normalizeSymbol).filter(Boolean));
  const conflict = [...required].filter((symbol) => excluded.has(symbol));
  if (conflict.length) {
    throw new PortfolioValidationError('REQUIRED_EXCLUDED_CONFLICT', `required and excluded overlap: ${conflict.join(',')}`);
  }
  const policy = input.allocationPolicy;
  if (!policy) {
    return {
      status: 'INSUFFICIENT_POLICY',
      allocations: [],
      rejected: [],
      requiredMissing: [...required],
      notes: ['ALLOCATION_POLICY_REQUIRED'],
    };
  }
  if (!Number.isInteger(policy.maxPositions) || policy.maxPositions <= 0
    || !Number.isFinite(policy.maxPositionWeight) || policy.maxPositionWeight <= 0 || policy.maxPositionWeight > 1
    || !Number.isFinite(policy.minCashWeight) || policy.minCashWeight < 0 || policy.minCashWeight > 1) {
    throw new PortfolioValidationError('INVALID_ALLOCATION_POLICY', 'allocation policy is invalid');
  }

  const deduped = new Map<string, ProposalCandidate>();
  for (const candidate of input.candidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    if (!symbol || excluded.has(symbol)) continue;
    if (!deduped.has(symbol)) deduped.set(symbol, { ...candidate, symbol });
  }

  const rejected: PortfolioProposalResult['rejected'] = [];
  const eligible: ProposalCandidate[] = [];
  for (const candidate of deduped.values()) {
    const reasons = rejectionReasons(candidate, input);
    if (reasons.length) rejected.push({ symbol: candidate.symbol, reasons });
    else eligible.push(candidate);
  }

  const requiredEligible = eligible.filter((candidate) => required.has(candidate.symbol));
  const optionalEligible = eligible.filter((candidate) => !required.has(candidate.symbol));
  const selected = [...requiredEligible, ...optionalEligible]
    .filter((candidate, index, rows) => rows.findIndex((item) => item.symbol === candidate.symbol) === index)
    .slice(0, policy.maxPositions);
  const selectedSymbols = new Set(selected.map((candidate) => candidate.symbol));
  const requiredMissing = [...required].filter((symbol) => !selectedSymbols.has(symbol));

  if (!selected.length || requiredMissing.length) {
    return {
      status: 'INSUFFICIENT_CANDIDATES',
      allocations: [],
      rejected,
      requiredMissing,
      notes: requiredMissing.length ? ['REQUIRED_SYMBOL_NOT_ELIGIBLE'] : ['NO_ELIGIBLE_CANDIDATES'],
    };
  }

  const investableWeight = Math.max(0, 1 - policy.minCashWeight);
  const equalWeight = Math.min(policy.maxPositionWeight, investableWeight / selected.length);
  const allocations: PortfolioAllocation[] = selected.map((candidate) => ({
    assetId: candidate.assetId,
    symbol: candidate.symbol,
    weight: equalWeight,
    budget: input.investmentBudget * equalWeight,
    role: candidate.role?.trim() || 'candidate',
    riskContribution: null,
    rationale: [...(candidate.rationale ?? []), 'DETERMINISTIC_EQUAL_WEIGHT_WITH_POLICY_CAP'],
    evidenceStatus: evidenceStatus(candidate),
  }));
  const allocatedWeight = allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
  const cashWeight = Math.max(0, 1 - allocatedWeight);
  allocations.push({
    assetId: null,
    symbol: 'CASH',
    weight: cashWeight,
    budget: input.investmentBudget * cashWeight,
    role: 'cash',
    riskContribution: null,
    rationale: ['POLICY_MIN_CASH_AND_UNALLOCATED_RESIDUAL'],
    evidenceStatus: 'verified',
  });

  return {
    status: 'READY',
    allocations,
    rejected,
    requiredMissing: [],
    notes: ['INPUT_ORDER_IS_CANDIDATE_RANKING', 'AI_DOES_NOT_SET_WEIGHTS'],
  };
}
