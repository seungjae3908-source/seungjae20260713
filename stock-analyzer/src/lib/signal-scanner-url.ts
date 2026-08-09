import type { SignalScannerRequest } from './signal-scanner';

const STOCK_SCANNER_PATH = '/api/market/scan';
const SPOT_SCANNER_PATH = '/api/scanner/crypto/spot';
const FUTURES_SCANNER_PATH = '/api/scanner/crypto/futures';

export const SIGNAL_SCANNER_READ_PATHS = Object.freeze([
  STOCK_SCANNER_PATH,
  SPOT_SCANNER_PATH,
  FUTURES_SCANNER_PATH,
] as const);

export function buildSignalScannerRequestUrl(request: SignalScannerRequest): string {
  const path = request.assetClass === 'stock'
    ? STOCK_SCANNER_PATH
    : request.assetClass === 'coin_spot'
      ? SPOT_SCANNER_PATH
      : FUTURES_SCANNER_PATH;
  const params = new URLSearchParams({
    strategy: request.strategy,
    timeframe: request.timeframe,
    cursor: String(Math.max(0, request.cursor)),
    batchSize: String(request.batchSize),
    minimumScore: String(request.minimumScore),
    maximumRiskScore: String(request.maximumRiskScore),
  });
  if (request.assetClass === 'stock') {
    params.set('market', request.market === 'US' ? 'US' : 'KR');
    params.set('indicators', request.conditions.join(','));
  } else {
    params.set('condition', request.condition);
  }
  return `${path}?${params.toString()}`;
}
