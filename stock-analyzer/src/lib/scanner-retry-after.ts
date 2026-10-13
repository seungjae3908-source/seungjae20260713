/**
 * Absent Retry-After is NOT zero: Number(null) incorrectly shadowed the
 * server's retryAfterSeconds JSON body and triggered early 429 retries.
 * Accept only explicit non-negative numeric seconds; clamp malformed long
 * values so a bogus provider response cannot strand scanner refreshes.
 */
export function parseSignalScannerRetryAfter(header: string | null, body: unknown): number | null {
  const parseSeconds = (value: unknown): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(3_600, Math.ceil(parsed)) : null;
  };
  return parseSeconds(header) ?? parseSeconds(body);
}

