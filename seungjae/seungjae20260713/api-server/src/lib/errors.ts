// Typed provider error so routes can translate failures into honest HTTP
// responses (never fake data).
export type ProviderErrorCode =
  | 'NOT_CONFIGURED' // API key/env for this provider is missing
  | 'RATE_LIMITED' // upstream free-tier quota exceeded
  | 'UNAVAILABLE' // upstream has no data for this symbol/market
  | 'UPSTREAM_ERROR'; // upstream returned an error / network failure

export class ProviderError extends Error {
  code: ProviderErrorCode;
  provider: string;

  constructor(code: ProviderErrorCode, provider: string, message?: string) {
    super(message ?? `${provider}: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
  }
}

export function httpStatusForCode(code: ProviderErrorCode): number {
  switch (code) {
    case 'NOT_CONFIGURED':
      return 503;
    case 'RATE_LIMITED':
      return 429;
    case 'UNAVAILABLE':
      return 404;
    case 'UPSTREAM_ERROR':
    default:
      return 502;
  }
}
