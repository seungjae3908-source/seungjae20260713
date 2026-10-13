/** Bound decoded response bytes while reading, not after response.text() has
 * allocated the complete body. Shared by execution ACKs and read-only recovery.
 * Never expose provider JSON, credentials or decoder exception text in errors. */
export async function readBoundedTradingProviderJson(response: Response, input: {
  maxBytes?: number; signal: AbortSignal; invalidCode: string; boundCode: string;
}): Promise<unknown> {
  const maxBytes = input.maxBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000
    || ![input.invalidCode, input.boundCode].every((code) => /^[A-Z][A-Z0-9_]{0,120}$/u.test(code))) {
    throw new Error('TRADING_PROVIDER_RESPONSE_CONFIG_INVALID');
  }
  const abort = () => new DOMException('TRADING_PROVIDER_RESPONSE_ABORTED', 'AbortError');
  if (input.signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw abort();
  }
  if (!response.body) throw new Error(input.invalidCode);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared))
    || Number(declared) > maxBytes)) {
    void response.body.cancel().catch(() => {});
    throw new Error(input.boundCode);
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  input.signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let raw = '';
  let complete = false;
  try {
    while (true) {
      if (input.signal.aborted) throw abort();
      const chunk = await reader.read();
      if (input.signal.aborted) throw abort();
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new Error(input.invalidCode);
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(input.boundCode);
      try { raw += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new Error(input.invalidCode); }
    }
    try { raw += decoder.decode(); }
    catch { throw new Error(input.invalidCode); }
    if (!raw.trim()) throw new Error(input.invalidCode);
    try { return JSON.parse(raw) as unknown; }
    catch { throw new Error(input.invalidCode); }
  } catch (error) {
    if (input.signal.aborted) throw abort();
    // A stream can reject with socket errors, raw provider text, or even a
    // non-Error value. Only our two bounded classifications may escape.
    if (error instanceof Error && [input.invalidCode, input.boundCode].includes(error.message)) throw error;
    throw new Error(input.invalidCode);
  } finally {
    input.signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
