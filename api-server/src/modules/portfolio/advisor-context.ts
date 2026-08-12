import type {
  AdvisorEnvelope,
  InformationAdvisorContext,
  PortfolioAdvisorContext,
  PortfolioAnalyticsResult,
  Position,
} from './types.ts';

export class AdvisorContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AdvisorContextError';
  }
}

const forbiddenKey = /(?:api.?key|secret|credential|authorization|refresh.?token|access.?token|private.?key|execution.?key|broker.?password|account.?number|full.?account|exchange.?auth)/i;
const forbiddenString = /(?:bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9_-]{12,}|authorization\s*:|(?:refresh[_ -]?token|access[_ -]?token|api[_ -]?key|private[_ -]?key|execution[_ -]?key)\s*[:=]\s*\S{8,})/i;

function sanitize(value: unknown, path: string, depth: number): unknown {
  if (depth > 10) throw new AdvisorContextError('ADVISOR_CONTEXT_TOO_DEEP', `context exceeds maximum depth at ${path}`);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (forbiddenString.test(value)) throw new AdvisorContextError('ADVISOR_PRIVATE_DATA_FORBIDDEN', `private data detected at ${path}`);
    return value.slice(0, 20_000);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item, index) => sanitize(item, `${path}[${index}]`, depth + 1));
  if (typeof value !== 'object') return String(value);

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKey.test(key)) throw new AdvisorContextError('ADVISOR_PRIVATE_DATA_FORBIDDEN', `private field forbidden at ${path}.${key}`);
    if (nested === undefined) continue;
    output[key] = sanitize(nested, `${path}.${key}`, depth + 1);
  }
  return output;
}

export function sanitizeAdvisorContext<T>(context: T): T {
  return sanitize(context, '$', 0) as T;
}

export function buildInformationAdvisorEnvelope(
  context: InformationAdvisorContext,
  aiExplanationAvailable: boolean,
): AdvisorEnvelope<InformationAdvisorContext> {
  return {
    context: sanitizeAdvisorContext(context),
    deterministicAnalysisAvailable: true,
    aiExplanationAvailable,
    orderAuthority: 'none',
  };
}

export function buildPortfolioAdvisorContext(
  analytics: PortfolioAnalyticsResult,
  holdings: Position[],
  extra: {
    scannerEvidence?: unknown;
    backtestEvidence?: unknown;
    marketContext?: unknown;
    missing?: string[];
  } = {},
): PortfolioAdvisorContext {
  return sanitizeAdvisorContext({
    portfolioSummary: analytics,
    holdings,
    averageCost: holdings.map((holding) => ({ assetId: holding.assetId, averageCost: holding.averageCost })),
    weights: analytics.positions.map((position) => ({ assetId: position.assetId, weight: position.weight })),
    cash: analytics.cashValue,
    risk: {
      concentration: analytics.concentration,
      volatilityPercent: analytics.volatilityPercent,
      portfolioRiskScore: analytics.portfolioRiskScore,
    },
    correlation: analytics.correlation,
    holdingAnalysis: analytics.positions,
    scannerEvidence: extra.scannerEvidence,
    backtestEvidence: extra.backtestEvidence,
    marketContext: extra.marketContext,
    missing: [...new Set([...(analytics.missing ?? []), ...(extra.missing ?? [])])],
  });
}

export function buildPortfolioAdvisorEnvelope(
  context: PortfolioAdvisorContext,
  aiExplanationAvailable: boolean,
): AdvisorEnvelope<PortfolioAdvisorContext> {
  return {
    context: sanitizeAdvisorContext(context),
    deterministicAnalysisAvailable: true,
    aiExplanationAvailable,
    orderAuthority: 'none',
  };
}
