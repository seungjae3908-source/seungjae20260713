export type ChartHistoryLogicalRange = Readonly<{ from: number; to: number }>;

/** Keep the same actual candles in view after genuine older bars are prepended.
 * Historical data may be sparse (exchange halts, holidays), so index by source
 * candle count, not by elapsed clock intervals or fabricated missing bars.
 */
export function retainLogicalViewportOnHistoryPrepend(
  previous: ChartHistoryLogicalRange | null,
  previouslyOldestTime: number | null,
  newTimes: readonly number[],
): ChartHistoryLogicalRange | null {
  if (!previous || previouslyOldestTime == null || !Number.isFinite(previouslyOldestTime)
    || !Number.isFinite(previous.from) || !Number.isFinite(previous.to) || newTimes.length === 0) {
    return previous;
  }
  // Candles are normalized ascending with unique time identity.
  let low = 0;
  let high = newTimes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (newTimes[mid] < previouslyOldestTime) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? previous : { from: previous.from + low, to: previous.to + low };
}
