import type {
  ScannerAssetClass,
  ScannerResponse,
  ScannerSignalDirection,
  ScannerTradeAction,
} from './scanner-signal.types';

export function resolveScannerTradeAction(
  assetClass: ScannerAssetClass,
  direction: ScannerSignalDirection,
): ScannerTradeAction {
  if (direction === 'NEUTRAL') return 'NONE';
  if (assetClass === 'coin_futures') return direction === 'LONG' ? 'LONG' : 'SHORT';
  return direction === 'LONG' ? 'BUY' : 'SELL';
}

export function isScannerRecommendationDirectionAllowed(
  assetClass: ScannerAssetClass,
  direction: ScannerSignalDirection,
): boolean {
  if (direction === 'NEUTRAL') return false;
  if (assetClass === 'coin_futures') return direction === 'LONG' || direction === 'SHORT';
  return direction === 'LONG';
}

export function withScannerCanonicalActions(response: ScannerResponse): ScannerResponse {
  const cards = response.cards
    .filter((card) => isScannerRecommendationDirectionAllowed(card.assetClass, card.direction))
    .map((card) => ({
      ...card,
      action: resolveScannerTradeAction(card.assetClass, card.direction),
    }));
  const alerts = response.alerts
    .filter((alert) => isScannerRecommendationDirectionAllowed(alert.assetClass, alert.direction))
    .map((alert) => ({
      ...alert,
      action: resolveScannerTradeAction(alert.assetClass, alert.direction),
    }));
  const removedCardCount = response.cards.length - cards.length;

  return {
    ...response,
    cards,
    alerts,
    execution: {
      ...response.execution,
      excludedCount: response.execution.excludedCount + removedCardCount,
      ...(response.execution.finalDisplayedCount === undefined
        ? {}
        : { finalDisplayedCount: cards.length }),
      ...(response.execution.sGradeCount === undefined
        ? {}
        : { sGradeCount: cards.filter((card) => card.signalGrade === 'S').length }),
      ...(response.execution.aGradeCount === undefined
        ? {}
        : { aGradeCount: cards.filter((card) => card.signalGrade === 'A').length }),
      ...(response.execution.bGradeCount === undefined
        ? {}
        : { bGradeCount: cards.filter((card) => card.signalGrade === 'B').length }),
    },
  };
}
