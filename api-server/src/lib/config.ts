// Central place that reads provider API keys from the environment (Replit
// Secrets). Keys are never bundled or sent to the client.
import { ProviderError } from './errors';

function readSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function isFinnhubConfigured(): boolean {
  return Boolean(readSecret('FINNHUB_API_KEY'));
}

export function getFinnhubKey(): string {
  const key = readSecret('FINNHUB_API_KEY');
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'finnhub');
  return key;
}

export function getAlphaVantageKey(): string {
  const key = readSecret('ALPHA_VANTAGE_API_KEY');
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'alphavantage');
  return key;
}

export function getDartKey(): string {
  const key = readSecret('DART_API_KEY');
  if (!key) throw new ProviderError('NOT_CONFIGURED', 'dart');
  return key;
}

// SEC EDGAR requires a descriptive User-Agent with contact information.
// Example: "Seungjae Stock App contact@example.com"
const SEC_CONTACT_EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export const SEC_USER_AGENT = readSecret('SEC_USER_AGENT') ?? '';

export function isSecUserAgentConfigured(): boolean {
  return (
    SEC_USER_AGENT.length >= 15 &&
    SEC_CONTACT_EMAIL_PATTERN.test(SEC_USER_AGENT)
  );
}

export function assertSecUserAgentConfigured(): void {
  if (isSecUserAgentConfigured()) return;

  throw new ProviderError(
    'NOT_CONFIGURED',
    'sec-edgar',
    'SEC_USER_AGENT must include an application name and a reachable contact email',
  );
}

export function providerStatus() {
  return {
    finnhub: isFinnhubConfigured(),
    alphavantage: Boolean(readSecret('ALPHA_VANTAGE_API_KEY')),
    dart: Boolean(readSecret('DART_API_KEY')),
    secEdgar: isSecUserAgentConfigured(),
  };
}
