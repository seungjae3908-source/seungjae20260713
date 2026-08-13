import { answerAiChat, validateChatMessage, type AiChatContext, type AiChatResult } from './ai-chat.service.ts';
import { buildPortfolioMentorSummaryContext, type PortfolioMentorMessage } from '../modules/portfolio/mentor-v2.ts';

type PortfolioIntelligenceForMentor = {
  status?: unknown;
  asOf?: unknown;
  totalAssets?: unknown;
  valuationPnl?: unknown;
  cash?: unknown;
  investableCash?: unknown;
  allocation?: unknown;
  top5Concentration?: unknown;
  correlation?: unknown;
  riskClassification?: unknown;
  allocationPolicy?: unknown;
  missingSources?: unknown;
  topHoldings?: Array<{ ticker?: unknown; name?: unknown; market?: unknown }>;
  safety?: unknown;
};

function cleanSelection(portfolio: PortfolioIntelligenceForMentor, selected?: AiChatContext): AiChatContext | undefined {
  if (selected?.market && selected.symbol) return selected;
  const holding = portfolio.topHoldings?.[0];
  const market = holding?.market === 'US' ? 'US' : holding?.market === 'KR' ? 'KR' : undefined;
  const symbol = typeof holding?.ticker === 'string' ? holding.ticker.trim().toUpperCase() : '';
  if (!market || !symbol) return undefined;
  return {
    market,
    symbol,
    displayName: typeof holding?.name === 'string' ? holding.name.slice(0, 120) : symbol,
  };
}

function minimizePortfolio(portfolio: PortfolioIntelligenceForMentor) {
  return {
    status: portfolio.status,
    asOf: portfolio.asOf,
    totalAssets: portfolio.totalAssets,
    valuationPnl: portfolio.valuationPnl,
    cash: portfolio.cash,
    investableCash: portfolio.investableCash,
    allocation: portfolio.allocation,
    top5Concentration: portfolio.top5Concentration,
    correlation: portfolio.correlation,
    riskClassification: portfolio.riskClassification,
    allocationPolicy: portfolio.allocationPolicy,
    missingSources: Array.isArray(portfolio.missingSources) ? portfolio.missingSources.slice(0, 12) : [],
    safety: portfolio.safety,
  };
}

export async function answerPortfolioMentor(input: {
  message: unknown;
  portfolio: PortfolioIntelligenceForMentor;
  conversation?: readonly PortfolioMentorMessage[];
  selectedContext?: AiChatContext;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AiChatResult> {
  const message = validateChatMessage(input.message);
  const mentor = buildPortfolioMentorSummaryContext({
    portfolio: minimizePortfolio(input.portfolio),
    conversation: input.conversation,
    userPrompt: message,
  });
  const compactContext = JSON.stringify({
    portfolio: mentor.portfolio,
    conversation: mentor.conversation.slice(-10),
    limitations: mentor.limitations,
    safety: mentor.safety,
  });
  const available = Math.max(0, 1_900 - message.length);
  const composedMessage = `${message}\n\nSERVER_PORTFOLIO_CONTEXT=${compactContext.slice(0, available)}`;
  return await answerAiChat(
    { message: composedMessage, context: cleanSelection(input.portfolio, input.selectedContext) },
    input.fetchImpl ?? fetch,
    input.signal,
  );
}
