// Scanner S/A is never inferred from a technical score alone. The existing
// Forward Observer immutable quality artifact is the one trusted evidence owner.
import {
  readForwardObserverScannerQualityArtifact,
  selectForwardObserverScannerBacktests,
} from './forward-observer-scanner-quality-consumer.service';
import { FORWARD_OBSERVER_LANES } from './forward-recommendation-observer-runtime.service';
import { resolveScannerTradeAction } from './scanner-market-action.service';
import type { ScannerSignalCard, ScannerBacktestQualitySummary, ScannerStrategyMode } from './scanner-signal.types';
import { scannerBacktestLookupKey } from './forward-observer-scanner-quality-consumer.service';
import { rankScannerCandidates, type ScannerCandidateRankingInput, type ScannerCandidateRankingResult } from './scanner-candidate-ranking.service';

type ScannerMarket = 'KR' | 'US' | 'spot' | 'futures';
const SHA40 = /^[a-f0-9]{40}$/iu;
const CANONICAL_MARKET: Record<ScannerMarket, string> = {
  KR: 'KR_STOCK', US: 'US_STOCK', spot: 'CRYPTO_SPOT', futures: 'CRYPTO_FUTURES',
};

/**
 * Optional read-only bridge. Unconfigured, stale, malformed or wrong-identity
 * artifacts yield no S/A promotions; no fallback sample/profit is invented.
 * Only the exact SWING Forward Observer lanes currently have a consumer.
 */
export async function readScannerVerifiedGradeBacktests(input: {
  market: ScannerMarket;
  strategyMode: ScannerStrategyMode;
  timeframe: string;
  cards: readonly ScannerSignalCard[];
  signal?: AbortSignal;
  artifactRoot?: string;
  researchCodeSha?: string;
}): Promise<Readonly<Record<string, ScannerBacktestQualitySummary>>> {
  if (input.signal?.aborted || input.cards.length === 0 || input.strategyMode !== 'swing') return {};
  const root = (input.artifactRoot ?? process.env.SCANNER_VERIFIED_OOS_ARTIFACT_ROOT ?? '').trim();
  const researchCodeSha = (input.researchCodeSha ?? process.env.SCANNER_VERIFIED_OOS_RESEARCH_SHA ?? '').trim().toLowerCase();
  if (!root || !SHA40.test(researchCodeSha)) return {};

  const lane = FORWARD_OBSERVER_LANES.find((candidate) =>
    candidate.market === CANONICAL_MARKET[input.market]
    && candidate.timeframe === input.timeframe);
  if (!lane) return {};

  // The selection owner requires an explicit, permissible trade action.
  // It independently rejects wrong direction, identity, dataset and costs.
  const cards = input.cards.map((card) => ({
    ...card,
    action: resolveScannerTradeAction(card.assetClass, card.direction),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const artifact = await Promise.race([
      readForwardObserverScannerQualityArtifact({ artifactRoot: root, researchCodeSha }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SCANNER_OOS_READ_DEADLINE')), 350);
      }),
    ]);
    if (input.signal?.aborted) return {};
    const quality = selectForwardObserverScannerBacktests({
      artifact,
      cards,
      lane,
      researchCodeSha,
    });
    return quality.status === 'READY' || quality.status === 'PARTIAL'
      ? quality.backtests
      : {};
  } catch (error) {
    // Expected missing/stale artifacts are diagnostic, not fake good signals.
    // Never log private path, artifact contents, or credentials.
    console.warn('scanner canonical OOS evidence not usable', {
      reason: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN',
      market: input.market,
      timeframe: input.timeframe,
    });
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Scanner-only, read-only, exact-side ranking bridge. The shared canonical
 * Paper ranker remains byte-identical to main and never gains a new runtime
 * dependency. Futures LONG/SHORT quality is lowered into separate ranking
 * pools, never borrowed from the opposite direction or raw symbol-only key.
 */
export function rankVerifiedScannerCandidates(input: ScannerCandidateRankingInput): ScannerCandidateRankingResult {
  if (input.market !== 'futures' && input.market !== 'CRYPTO_FUTURES') {
    return rankScannerCandidates(input);
  }
  const groups = [
    input.cards.filter(card => card.assetClass === 'coin_futures' && card.direction === 'LONG'),
    input.cards.filter(card => card.assetClass === 'coin_futures' && card.direction === 'SHORT'),
    input.cards.filter(card => card.assetClass !== 'coin_futures' || card.direction === 'NEUTRAL'),
  ];
  const results = groups.map(cards => {
    const scoped: Record<string, ScannerBacktestQualitySummary | undefined> = {};
    for (const card of cards) {
      const key = scannerBacktestLookupKey(card);
      if (key !== null && input.backtests?.[key] != null) scoped[card.symbol] = input.backtests[key];
    }
    return rankScannerCandidates({ ...input, cards, backtests: scoped, limit: 10 });
  });
  const gradeOrder: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const sorted = results.flatMap(result => result.cards).sort((left, right) =>
    (gradeOrder[right.signalGrade ?? 'B'] ?? 0) - (gradeOrder[left.signalGrade ?? 'B'] ?? 0)
    || (right.candidateRanking?.score ?? 0) - (left.candidateRanking?.score ?? 0)
    || right.score - left.score
    || right.confidence - left.confidence
    || left.symbol.localeCompare(right.symbol)
    || left.direction.localeCompare(right.direction));
  const limit = Math.max(1, Math.min(10, input.limit ?? 10));
  const cards = sorted.slice(0, limit).map((card, index) => ({
    ...card,
    candidateRanking: card.candidateRanking
      ? { ...card.candidateRanking, rank: index + 1 } : undefined,
  }));
  return {
    cards,
    diagnostics: {
      inputCount: input.cards.length,
      hardFilterPassCount: results.reduce((n, x) => n + x.diagnostics.hardFilterPassCount, 0),
      hardFilterRejectedCount: results.reduce((n, x) => n + x.diagnostics.hardFilterRejectedCount, 0),
      softCandidateCount: results.reduce((n, x) => n + x.diagnostics.softCandidateCount, 0),
      finalDisplayedCount: cards.length,
      sGradeCount: cards.filter(x => x.signalGrade === 'S').length,
      aGradeCount: cards.filter(x => x.signalGrade === 'A').length,
      bGradeCount: cards.filter(x => x.signalGrade === 'B').length,
      backtestMissingCount: results.reduce((n, x) => n + x.diagnostics.backtestMissingCount, 0),
    },
  };
}
