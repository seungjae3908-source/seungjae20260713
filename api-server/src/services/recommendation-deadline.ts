export const RECOMMENDATION_ANALYSIS_BUDGET_MS = 3_200;

export async function withRecommendationDeadline<T>(
  operation: PromiseLike<T>,
  budgetMs = RECOMMENDATION_ANALYSIS_BUDGET_MS,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('RECOMMENDATION_ANALYSIS_BUDGET_INVALID');
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('RECOMMENDATION_PROVIDER_TIMEOUT')),
      budgetMs,
    );
  });

  try {
    return await Promise.race([Promise.resolve(operation), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
