import { sanitizeAdvisorContext } from './advisor-context.ts';
import type { PortfolioProviderAggregationV2 } from './provider-snapshot-v2.ts';

export type PortfolioMentorRole = 'user' | 'assistant';

export type PortfolioMentorMessage = {
  role: PortfolioMentorRole;
  content: string;
  createdAt?: string | null;
};

export type PortfolioMentorV2Context = {
  mode: 'portfolio-mentor-v2';
  generatedAt: string;
  portfolio: PortfolioProviderAggregationV2;
  conversation: PortfolioMentorMessage[];
  userPrompt: string | null;
  limitations: string[];
  safety: {
    simulatedOnly: true;
    liveTrading: false;
    liveOrderAllowed: false;
    privateTradingRequestAllowed: false;
    orderAuthority: 'none';
    externalAiCalled: false;
  };
};

const DEFAULT_MAX_MESSAGES = 8;
const DEFAULT_MAX_MESSAGE_CHARS = 2_000;
const DEFAULT_MAX_TOTAL_CHARS = 8_000;

function clampPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(value!, maximum);
}

function trimMessage(content: string, maxChars: number): string {
  return content.trim().slice(0, maxChars);
}

export function boundPortfolioMentorConversation(
  messages: readonly PortfolioMentorMessage[],
  options: { maxMessages?: number; maxMessageChars?: number; maxTotalChars?: number } = {},
): PortfolioMentorMessage[] {
  const maxMessages = clampPositiveInteger(options.maxMessages, DEFAULT_MAX_MESSAGES, 20);
  const maxMessageChars = clampPositiveInteger(options.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS, 8_000);
  const maxTotalChars = clampPositiveInteger(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, 24_000);
  const newest = messages.slice(-maxMessages);
  const bounded: PortfolioMentorMessage[] = [];
  let remaining = maxTotalChars;

  for (let index = newest.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = newest[index];
    const content = trimMessage(message.content, Math.min(maxMessageChars, remaining));
    if (!content) continue;
    bounded.push({
      role: message.role,
      content,
      createdAt: message.createdAt ?? null,
    });
    remaining -= content.length;
  }

  bounded.reverse();
  return sanitizeAdvisorContext(bounded);
}

export function buildPortfolioMentorV2Context(input: {
  portfolio: PortfolioProviderAggregationV2;
  conversation?: readonly PortfolioMentorMessage[];
  userPrompt?: string | null;
  now?: Date;
  bounds?: { maxMessages?: number; maxMessageChars?: number; maxTotalChars?: number };
}): PortfolioMentorV2Context {
  const now = input.now ?? new Date();
  const conversation = boundPortfolioMentorConversation(input.conversation ?? [], input.bounds);
  const prompt = input.userPrompt == null ? null : trimMessage(input.userPrompt, DEFAULT_MAX_MESSAGE_CHARS) || null;
  const limitations = [
    'NO_FABRICATED_FUTURE_RETURN',
    'NO_ORDER_AUTHORITY',
    ...(input.portfolio.status !== 'READY' ? ['PORTFOLIO_DATA_PARTIAL_OR_UNAVAILABLE'] : []),
    ...(input.portfolio.assets.totalNormalizedKRWAmount == null ? ['TOTAL_PORTFOLIO_VALUE_UNAVAILABLE'] : []),
  ];

  return sanitizeAdvisorContext({
    mode: 'portfolio-mentor-v2',
    generatedAt: now.toISOString(),
    portfolio: input.portfolio,
    conversation,
    userPrompt: prompt,
    limitations: [...new Set(limitations)],
    safety: {
      simulatedOnly: true,
      liveTrading: false,
      liveOrderAllowed: false,
      privateTradingRequestAllowed: false,
      orderAuthority: 'none',
      externalAiCalled: false,
    },
  });
}

export function buildPortfolioMentorSummaryContext(input: {
  portfolio: unknown;
  conversation?: readonly PortfolioMentorMessage[];
  userPrompt?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const conversation = boundPortfolioMentorConversation(input.conversation ?? [], {
    maxMessages: 16,
    maxMessageChars: 1_500,
    maxTotalChars: 12_000,
  });
  const prompt = input.userPrompt == null ? null : trimMessage(input.userPrompt, 2_000) || null;
  return sanitizeAdvisorContext({
    mode: 'portfolio-mentor-v2',
    generatedAt: now.toISOString(),
    portfolio: input.portfolio,
    conversation,
    userPrompt: prompt,
    limitations: ['NO_FABRICATED_FUTURE_RETURN', 'NO_ORDER_AUTHORITY', 'PORTFOLIO_CONTEXT_MINIMIZED'],
    safety: {
      simulatedOnly: true,
      liveTrading: false,
      liveOrderAllowed: false,
      privateTradingRequestAllowed: false,
      orderAuthority: 'none',
      externalAiCalled: false,
    },
  });
}
