// Central place that reads provider API keys from the environment (Replit
// Secrets). Keys are never bundled or sent to the client.
import { ProviderError } from './errors';

export function getFinnhubKey(): string {
  const key = process.env['FINNHUB_API_KEY'];
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'finnhub');
  return key;
}

export function getAlphaVantageKey(): string {
  const key = process.env['ALPHA_VANTAGE_API_KEY'];
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'alphavantage');
  return key;
}

export function getDartKey(): string {
  const key = process.env['DART_API_KEY'];
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'dart');
  return key;
}

// SEC EDGAR requires a descriptive User-Agent with contact info (no API key).
// SEC requires "<name> <email>" format and blocks generic/absent UAs.
export const SEC_USER_AGENT =
  process.env['SEC_USER_AGENT'] ?? 'stock-analyzer support@example.com';

export function providerStatus() {
  return {
    finnhub: Boolean(process.env['FINNHUB_API_KEY']),
    alphavantage: Boolean(process.env['ALPHA_VANTAGE_API_KEY']),
    dart: Boolean(process.env['DART_API_KEY']),
    secEdgar: true, // free, no key required
  };
}
