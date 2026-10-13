export type TradingProviderHttpId = 'BITGET' | 'UPBIT' | 'KIWOOM' | 'TOSS' | 'EXCHANGE';

export function tradingProviderFromBaseUrl(baseUrl: string): TradingProviderHttpId {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes('bitget.com')) return 'BITGET';
  if (normalized.includes('upbit.com')) return 'UPBIT';
  if (normalized.includes('kiwoom.com')) return 'KIWOOM';
  if (normalized.includes('tossinvest.com')) return 'TOSS';
  return 'EXCHANGE';
}

export function tradingProviderHttpErrorCode(baseUrl: string, status: number) {
  const provider = tradingProviderFromBaseUrl(baseUrl);
  if (status === 401) return `${provider}_AUTH_FAILED`;
  if (status === 403) return `${provider}_AUTH_OR_IP_REJECTED`;
  if (status === 408) return `${provider}_TIMEOUT`;
  if (status === 409) return `${provider}_CONFLICT`;
  if (status === 429) return `${provider}_RATE_LIMITED`;
  if (status >= 500) return `${provider}_UNAVAILABLE`;
  return `${provider}_HTTP_${status}`;
}

export function tradingProviderTimeoutCode(baseUrl: string) {
  return `${tradingProviderFromBaseUrl(baseUrl)}_TIMEOUT`;
}

export function tradingProviderNetworkErrorCode(baseUrl: string) {
  return `${tradingProviderFromBaseUrl(baseUrl)}_NETWORK_ERROR`;
}

export function isTransientTradingProviderError(code: string) {
  return code.endsWith('_TIMEOUT')
    || code.endsWith('_NETWORK_ERROR')
    || code.endsWith('_RATE_LIMITED')
    || code.endsWith('_UNAVAILABLE')
    || /_HTTP_5\d\d$/.test(code)
    || code.endsWith('_ORDER_LOOKUP_EMPTY')
    || code.endsWith('_ORDER_LOOKUP_FAILED')
    || code.endsWith('_INVALID_RESPONSE');
}
