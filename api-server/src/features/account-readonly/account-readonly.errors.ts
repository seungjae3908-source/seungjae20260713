export class AccountReadonlyError extends Error {
  constructor(public readonly code: string, public readonly retryable = false, public readonly retryAfterMs: number | null = null) { super(code); }
}

export function classifyProviderError(value: unknown): AccountReadonlyError {
  if (value instanceof AccountReadonlyError) return value;
  const message = value instanceof Error ? value.message : String(value ?? '');
  if (/401|invalid-token|expired-token|auth/i.test(message)) return new AccountReadonlyError('AUTH_FAILED');
  if (/429|rate/i.test(message)) return new AccountReadonlyError('RATE_LIMITED', true);
  if (/abort|timeout/i.test(message)) return new AccountReadonlyError('PROVIDER_TIMEOUT', true);
  return new AccountReadonlyError('PROVIDER_UNAVAILABLE', false);
}
