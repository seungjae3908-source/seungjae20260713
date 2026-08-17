import {
  fetchScannerCardMarketIntelligence,
  scannerDirectionalAdjustment,
  type MarketIntelligenceSummary,
} from './market-intelligence-client.service';
import type { ScannerSignalCard } from './scanner-signal.types';

export type ScannerMarketIntelligenceCard = ScannerSignalCard & {
  marketIntelligence: MarketIntelligenceSummary & {
    directionalAdjustment: number;
    baseScore: number;
    adjustedScore: number;
  };
};

export type ScannerMarketIntelligenceRunner = (
  card: Pick<ScannerSignalCard, 'assetClass' | 'market' | 'symbol'>,
) => Promise<MarketIntelligenceSummary>;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function mapBounded<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function enrichScannerCardsWithMarketIntelligence(
  cards: ScannerSignalCard[],
  runner: ScannerMarketIntelligenceRunner = fetchScannerCardMarketIntelligence,
): Promise<ScannerMarketIntelligenceCard[]> {
  const enriched = await mapBounded(cards, 4, async (card) => {
    const intelligence = await runner(card);
    const directionalAdjustment = intelligence.status === 'READY'
      ? scannerDirectionalAdjustment(card, intelligence)
      : 0;
    const adjustedScore = clamp(card.score + directionalAdjustment, 0, 100);
    const blocked = intelligence.status === 'READY' && intelligence.autoTrading.mode === 'BLOCKED_RISK';
    const warnings = [...new Set([
      ...card.warnings,
      ...(intelligence.status === 'READY' ? intelligence.warnings.map((warning) => `MI:${warning}`) : [`MI:${intelligence.reason ?? 'NOT_AVAILABLE'}`]),
      ...(blocked ? [`MI_BLOCK:${intelligence.autoTrading.hardBlockReason ?? 'BLOCKED_RISK'}`] : []),
    ])];
    return {
      ...card,
      score: adjustedScore,
      strongSignalEligible: blocked ? false : card.strongSignalEligible,
      signalState: blocked ? 'WEAKENED' as const : card.signalState,
      warnings,
      marketIntelligence: {
        ...intelligence,
        directionalAdjustment,
        baseScore: card.score,
        adjustedScore,
      },
    };
  });

  return enriched.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.symbol.localeCompare(right.symbol);
  });
}
