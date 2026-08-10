import {
  StockSignalScannerService as BaseStockSignalScannerService,
} from './stock-signal-scanner.base.service';
import type { StockSignalScanRequest } from './stock-signal-scanner.base.service';
import { deliverScannerTelegramAlerts } from './scanner-telegram-delivery.service';

export type { StockSignalScanRequest };
export { aggregateUsSessionCandles } from './stock-signal-scanner.base.service';

export const StockSignalScannerService = {
  async scan(request: StockSignalScanRequest) {
    const result = await BaseStockSignalScannerService.scan(request);
    void deliverScannerTelegramAlerts(result.alerts);
    return result;
  },
};
