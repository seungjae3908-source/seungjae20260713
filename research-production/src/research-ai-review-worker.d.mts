export interface ResearchFreePolicy {
  provider: 'gemini' | 'groq' | null;
  model: string | null;
  apiKey: string | null;
  reason: string;
}
export function resolveResearchFreeAiPolicy(env?: Record<string, string | undefined>): Readonly<ResearchFreePolicy>;
export function invokeResearchFreeAi(input: {
  policy: Readonly<ResearchFreePolicy>;
  prompt: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Readonly<{ answer: string; model: string; provider: 'gemini' | 'groq' }>>;
