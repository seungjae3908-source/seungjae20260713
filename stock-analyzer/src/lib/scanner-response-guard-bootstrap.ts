import { api } from './api';

type ScanMethod = typeof api.scan;
let installed = false;

export function installDeferredScannerResponseGuard(): void {
  if (installed) return;
  const originalScan: ScanMethod = api.scan;

  api.scan = (async (...args: Parameters<ScanMethod>) => {
    const value = await originalScan(...args);
    const { validateScannerResponse } = await import('./scanner-response-guard');
    return validateScannerResponse(value, {
      selected: args[0],
      market: args[1],
      timeframe: args[2]?.timeframe,
    });
  }) as ScanMethod;

  installed = true;
}
