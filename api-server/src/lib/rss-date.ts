/**
 * Normalises an RSS/Atom date (RFC 822 such as "Fri, 17 Oct 2026 03:00:00 GMT",
 * or ISO 8601) to a UTC ISO 8601 string so clients can format it in KST and
 * sort it chronologically. Returns null for missing or unparseable values.
 */
export function rssDateToIso(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
