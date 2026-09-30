import type { BitgetReadonlyDiagnostic } from '../../services/trade-exchange-adapters.service';

export class AccountReadonlyError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null,
    public readonly bitgetDiagnostic: BitgetReadonlyDiagnostic | null = null,
  ) { super(code); }
}

export function serializeBitgetReadonlyDiagnostic(diagnostic: BitgetReadonlyDiagnostic) {
  return JSON.stringify({
    provider: 'bitget',
    requestMethod: 'GET',
    requestPath: diagnostic.requestPath,
    endpointFamily: diagnostic.endpointFamily,
    probe: diagnostic.probe,
    httpStatus: diagnostic.httpStatus,
    applicationCode: diagnostic.applicationCode,
    sanitizedClassification: diagnostic.sanitizedClassification,
    fallbackAttempted: diagnostic.fallbackAttempted,
    timestampRejected: diagnostic.timestampRejected,
    productionHost: diagnostic.productionHost,
    credentialPresence: {
      key: diagnostic.credentialPresence.key,
      secret: diagnostic.credentialPresence.secret,
      passphrase: diagnostic.credentialPresence.passphrase,
    },
  });
}

const CREDENTIAL_ACCESS_FAILURES = new Set([
  'AUTH_FAILED',
  'TOSS_AUTH_FAILED',
  'TOSS_IP_NOT_ALLOWED',
  'UPBIT_AUTH_FAILED',
  'UPBIT_IP_NOT_ALLOWED',
  'UPBIT_PERMISSION_DENIED',
  'KIWOOM_AUTH_OR_IP_REJECTED',
  'BITGET_AUTH_FAILED',
  'BITGET_IP_NOT_ALLOWED',
  'BITGET_PERMISSION_DENIED',
]);

export function isAccountReadonlyCredentialAccessError(code: string) {
  return CREDENTIAL_ACCESS_FAILURES.has(code);
}

export function classifyProviderError(value: unknown): AccountReadonlyError {
  if (value instanceof AccountReadonlyError) return value;
  const message = value instanceof Error ? value.message : String(value ?? '');
  if (/401|invalid-token|expired-token|auth/i.test(message)) return new AccountReadonlyError('AUTH_FAILED');
  if (/429|rate/i.test(message)) return new AccountReadonlyError('RATE_LIMITED', true);
  if (/abort|timeout/i.test(message)) return new AccountReadonlyError('PROVIDER_TIMEOUT', true);
  return new AccountReadonlyError('PROVIDER_UNAVAILABLE', false);
}
