import { ProviderError } from './errors';

const notConfiguredLogged = new Set<string>();

/**
 * Logs a provider failure. A provider that is simply not configured (for
 * example DART without its API key) fails the same way for every symbol of a
 * scan, so it is logged once per process instead of once per symbol with a full
 * stack trace. With source maps enabled, thousands of stack traces per scan
 * block the event loop long enough to delay market scan responses.
 * Every other failure is still logged exactly as before.
 */
export function logProviderFailure(message: string, error: unknown): void {
  if (error instanceof ProviderError && error.code === 'NOT_CONFIGURED') {
    const key = `${error.provider}:${error.code}`;
    if (notConfiguredLogged.has(key)) return;
    notConfiguredLogged.add(key);
    console.error(`${message} (provider ${error.provider} is not configured; further identical failures are not logged)`);
    return;
  }
  console.error(message, error);
}

export function resetProviderFailureLogForTest(): void {
  notConfiguredLogged.clear();
}
