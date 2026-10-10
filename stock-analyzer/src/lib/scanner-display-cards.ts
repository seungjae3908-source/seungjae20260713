/** Scanner display policy: same spot/stock symbol is one result, but a
 * futures LONG and SHORT are two independent candidate identities.
 * This function only filters duplicate source rows; it never promotes grades
 * or invents a new trade action/signal. First ranked source row wins.
 */
export type ScannerDisplayIdentity = {
  signalId: string;
  symbol: string;
  name: string;
  assetClass: string;
  direction: string;
};

export function uniqueScannerDisplayCards<T extends ScannerDisplayIdentity>(
  cards: readonly T[],
): T[] {
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const result: T[] = [];
  for (const card of cards) {
    if (!card || typeof card.signalId !== 'string' || !card.signalId.trim()
      || typeof card.symbol !== 'string' || !card.symbol.trim()
      || typeof card.name !== 'string' || !card.name.trim()) continue;
    const symbol = card.symbol.trim().toUpperCase();
    const key = card.assetClass === 'coin_futures'
      ? JSON.stringify([card.assetClass, symbol, card.direction])
      : JSON.stringify([card.assetClass, symbol]);
    // A repeated signalId must never become two React cards or two
    // separate approval targets, even if its source direction is malformed.
    if (seenKeys.has(key) || seenIds.has(card.signalId)) continue;
    seenKeys.add(key);
    seenIds.add(card.signalId);
    result.push(card);
  }
  return result;
}
