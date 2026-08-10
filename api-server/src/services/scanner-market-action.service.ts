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

export function withScannerCanonicalActions(response: ScannerResponse): ScannerResponse {
  return {
    ...response,
    cards: response.cards.map((card) => ({
      ...card,
      action: resolveScannerTradeAction(card.assetClass, card.direction),
    })),
    alerts: response.alerts.map((alert) => ({
      ...alert,
      action: resolveScannerTradeAction(alert.assetClass, alert.direction),
    })),
  };
}
