const DEFAULT_EMPTY_CANDLE_RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A successful public candle response must contain genuine provider rows.
 * Retry one transient empty success against the same provider, then fail
 * closed instead of publishing HTTP 200 with an invented empty market state.
 */
export async function fetchNonEmptyPublicCandleRows<T>(
  fetchRows: () => Promise<T[]>,
  waitBeforeRetry: () => Promise<void> = () => delay(DEFAULT_EMPTY_CANDLE_RETRY_DELAY_MS),
): Promise<T[]> {
  const first = await fetchRows();
  if (!Array.isArray(first)) throw new Error('PUBLIC_CANDLE_ROWS_INVALID');
  if (first.length > 0) return first;

  await waitBeforeRetry();
  const second = await fetchRows();
  if (!Array.isArray(second)) throw new Error('PUBLIC_CANDLE_ROWS_INVALID');
  if (second.length === 0) throw new Error('PUBLIC_CANDLE_ROWS_EMPTY');
  return second;
}
