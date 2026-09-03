import { calculateAllocation } from '../modules/portfolio/intelligence-v2.ts';
import { simulatePortfolioShock, type PortfolioShock } from '../modules/portfolio/portfolio-shock-scenario.ts';

export type InvestmentToolName = 'getPortfolioSummary' | 'getPortfolioRisk' | 'runPortfolioWhatIf';
export type InvestmentDataState = 'AVAILABLE' | 'PARTIAL' | 'NOT_AVAILABLE' | 'INSUFFICIENT_SAMPLE' | 'STALE';
export type InvestmentEvidence = { source: string; dataset: string; asOf: string; freshness: InvestmentDataState; provenance: string; sampleSize: number | null };
export type InvestmentToolEnvelope<T> = {
  tool: InvestmentToolName; status: InvestmentDataState; asOf: string; data: T; evidence: InvestmentEvidence[]; warnings: string[];
  safety: { readOnly: true; simulationOnly: boolean; orderAuthority: 'none'; exchangeRequestSent: false };
};
export type CopilotHolding = { ticker: string; name: string; market: string; normalizedKRW: number | null };
export type CopilotPortfolioSnapshot = {
  status: string; asOf: string;
  totalAssets: { normalizedKRW: number | null; knownNormalizedKRW: number };
  cash: { totalKRW: number | null };
  valuationPnl: { normalizedKRW: number | null; returnPercent: number | null };
  top5Concentration: { percent: number | null };
  riskClassification: { level: string | null; reason: string };
  holdings: CopilotHolding[]; missingSources: string[];
};
export type { PortfolioShock };

export class InvestmentToolValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'InvestmentToolValidationError'; }
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function evidence(snapshot: CopilotPortfolioSnapshot): InvestmentEvidence[] {
  return [{ source: 'Portfolio Intelligence V2', dataset: 'canonical_portfolio_snapshot', asOf: snapshot.asOf,
    freshness: snapshot.status === 'READY' ? 'AVAILABLE' : 'PARTIAL',
    provenance: 'portfolio_holdings + public quote provider + deterministic KRW normalization', sampleSize: snapshot.holdings.length }];
}
function state(snapshot: CopilotPortfolioSnapshot): InvestmentDataState {
  if (snapshot.totalAssets.normalizedKRW == null) return snapshot.holdings.length ? 'PARTIAL' : 'NOT_AVAILABLE';
  return snapshot.status === 'READY' ? 'AVAILABLE' : 'PARTIAL';
}
function envelope<T>(tool: InvestmentToolName, snapshot: CopilotPortfolioSnapshot, data: T, warnings: string[], simulationOnly = false): InvestmentToolEnvelope<T> {
  return { tool, status: state(snapshot), asOf: snapshot.asOf, data, evidence: evidence(snapshot),
    warnings: [...new Set([...snapshot.missingSources, ...warnings])],
    safety: { readOnly: true, simulationOnly, orderAuthority: 'none', exchangeRequestSent: false } };
}
export function getPortfolioSummaryTool(snapshot: CopilotPortfolioSnapshot) {
  return envelope('getPortfolioSummary', snapshot, { totalEquityKRW: snapshot.totalAssets.normalizedKRW,
    knownEquityKRW: snapshot.totalAssets.knownNormalizedKRW, cashKRW: snapshot.cash.totalKRW,
    unrealizedPnlKRW: snapshot.valuationPnl.normalizedKRW, netReturnPercent: snapshot.valuationPnl.returnPercent,
    holdingCount: snapshot.holdings.length }, []);
}
export function getPortfolioRiskTool(snapshot: CopilotPortfolioSnapshot) {
  const allocation = calculateAllocation(snapshot.holdings.map((row) => ({ key: row.ticker, normalizedKRWAmount: row.normalizedKRW })));
  const weights = new Map(allocation.weights.map((row) => [row.key, row.weightPercent]));
  const known = snapshot.holdings.filter((row) => finite(row.normalizedKRW) && row.normalizedKRW >= 0)
    .sort((left, right) => (right.normalizedKRW ?? 0) - (left.normalizedKRW ?? 0));
  const largest = known[0] ?? null;
  return envelope('getPortfolioRisk', snapshot, { riskLevel: snapshot.riskClassification.level,
    riskReason: snapshot.riskClassification.reason, top5ConcentrationPercent: snapshot.top5Concentration.percent,
    concentrationEvidenceStatus: allocation.status,
    largestKnownHolding: largest ? { ticker: largest.ticker, name: largest.name, market: largest.market,
      normalizedKRW: largest.normalizedKRW, knownPortfolioPercent: weights.get(largest.ticker) ?? null } : null,
    volatility: { status: 'INSUFFICIENT_SAMPLE', value: null },
    valueAtRisk: { status: 'NOT_AVAILABLE', value: null },
    conditionalValueAtRisk: { status: 'NOT_AVAILABLE', value: null } },
  known.length === snapshot.holdings.length ? [] : ['HOLDING_VALUE_PARTIAL']);
}
export function runPortfolioWhatIfTool(snapshot: CopilotPortfolioSnapshot, input: { shocks: PortfolioShock[] }) {
  if (!Array.isArray(input.shocks) || input.shocks.length < 1 || input.shocks.length > 20) {
    throw new InvestmentToolValidationError('INVALID_SHOCKS', '1개 이상 20개 이하의 충격 시나리오가 필요합니다.');
  }
  const seen = new Set<string>();
  const shocks = input.shocks.map((shock) => {
    const ticker = String(shock?.ticker ?? '').trim().toUpperCase();
    if (!ticker || !finite(shock?.changePercent) || shock.changePercent < -100 || shock.changePercent > 100 || seen.has(ticker)) {
      throw new InvestmentToolValidationError('INVALID_SHOCK', '종목별 충격은 중복 없이 -100%에서 100% 사이여야 합니다.');
    }
    seen.add(ticker); return { ticker, changePercent: shock.changePercent };
  });
  const result = simulatePortfolioShock({ equityKRW: snapshot.totalAssets.normalizedKRW, positions: snapshot.holdings, shocks });
  return envelope('runPortfolioWhatIf', snapshot, result,
    result.scenarioStatus === 'SIMULATED' ? [] : ['SIMULATION_INPUT_EVIDENCE_PARTIAL'], true);
}
export type InvestmentToolRequest =
  | { tool: 'getPortfolioSummary'; arguments?: Record<string, never> }
  | { tool: 'getPortfolioRisk'; arguments?: Record<string, never> }
  | { tool: 'runPortfolioWhatIf'; arguments: { shocks: PortfolioShock[] } };
export function executeInvestmentTool(snapshot: CopilotPortfolioSnapshot, request: Extract<InvestmentToolRequest, { tool: 'getPortfolioSummary' }>): ReturnType<typeof getPortfolioSummaryTool>;
export function executeInvestmentTool(snapshot: CopilotPortfolioSnapshot, request: Extract<InvestmentToolRequest, { tool: 'getPortfolioRisk' }>): ReturnType<typeof getPortfolioRiskTool>;
export function executeInvestmentTool(snapshot: CopilotPortfolioSnapshot, request: Extract<InvestmentToolRequest, { tool: 'runPortfolioWhatIf' }>): ReturnType<typeof runPortfolioWhatIfTool>;
export function executeInvestmentTool(snapshot: CopilotPortfolioSnapshot, request: InvestmentToolRequest) {
  if (request.tool === 'getPortfolioSummary') return getPortfolioSummaryTool(snapshot);
  if (request.tool === 'getPortfolioRisk') return getPortfolioRiskTool(snapshot);
  if (request.tool === 'runPortfolioWhatIf') return runPortfolioWhatIfTool(snapshot, request.arguments);
  throw new InvestmentToolValidationError('TOOL_NOT_ALLOWED', '허용되지 않은 투자 도구입니다.');
}
