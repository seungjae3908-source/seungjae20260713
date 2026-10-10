/** Bounded, genuine-source historical pages, never fabricated candles.
 * Recent mode retains latest bars beside the current chart. Archive mode
 * moves the window backward by dropping newer bars, not the newly fetched
 * older bars. Both avoid unbounded client memory.
 */
export function mergeBoundedChartHistory<T extends { time: number }>(
  existing: readonly T[],
  older: readonly T[],
  archiveMode: boolean,
  limit = 1_800,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('HISTORY_WINDOW_LIMIT_INVALID');
  const rows = new Map<number, T>();
  for (const item of existing) if (Number.isFinite(item.time)) rows.set(item.time, item);
  for (const item of older) if (Number.isFinite(item.time)) rows.set(item.time, item);
  const ordered = [...rows.values()].sort((a, b) => a.time - b.time);
  return archiveMode ? ordered.slice(0, limit) : ordered.slice(-limit);
}

/** Always page from the oldest *fetched* candle, not the oldest currently
 * visible bar. The 2,000-bar recent window may hide legitimate older bars.
 * Inputs come from sorted, normalized provider snapshots / history merges.
 */
export function historyCursorBeforeTime<T extends { time: number }>(
  rendered: readonly T[],
  fetchedHistory: readonly T[],
): number | null {
  const candidate = fetchedHistory[0] ?? rendered[0];
  return candidate && Number.isSafeInteger(candidate.time) && candidate.time > 0
    ? candidate.time
    : null;
}
