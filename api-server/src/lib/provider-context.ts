import { AsyncLocalStorage } from 'node:async_hooks';

interface ProviderContext {
  signal: AbortSignal;
  reportFallback?: (code: string) => void;
}

const providerContext = new AsyncLocalStorage<ProviderContext>();

export function currentProviderSignal(): AbortSignal | undefined {
  return providerContext.getStore()?.signal;
}

export function runWithProviderSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  reportFallback?: (code: string) => void,
): Promise<T> {
  return providerContext.run({ signal, reportFallback }, operation);
}

export function reportProviderFallback(code: string): void {
  providerContext.getStore()?.reportFallback?.(code);
}
