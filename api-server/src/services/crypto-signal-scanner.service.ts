import {
  CryptoSignalScannerService as BaseCryptoSignalScannerService,
  CryptoScannerProviderError,
  createCryptoSignalScannerService,
} from './crypto-signal-scanner.base.service';
import type {
  CryptoCandle,
  CryptoScannerProviders,
  CryptoSignalScanRequest,
  CryptoSignalScanner,
  CryptoTicker,
  CryptoTimeframe,
  CryptoUniverse,
} from './crypto-signal-scanner.base.service';
import { deliverScannerTelegramAlerts } from './scanner-telegram-delivery.service';

export type {
  CryptoCandle,
  CryptoScannerProviders,
  CryptoSignalScanRequest,
  CryptoSignalScanner,
  CryptoTicker,
  CryptoTimeframe,
  CryptoUniverse,
};
export { CryptoScannerProviderError, createCryptoSignalScannerService };

export const CryptoSignalScannerService: CryptoSignalScanner = {
  async scan(request: CryptoSignalScanRequest) {
    const result = await BaseCryptoSignalScannerService.scan(request);
    void deliverScannerTelegramAlerts(result.alerts);
    return result;
  },
  clearCache() {
    BaseCryptoSignalScannerService.clearCache();
  },
};

export function clearCryptoScannerCacheForTests(): void {
  BaseCryptoSignalScannerService.clearCache();
}
