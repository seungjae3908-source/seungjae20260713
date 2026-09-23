export type EvidenceProvider = 'toss' | 'upbit' | 'bitget';
export type ProviderRequestObservation = {
  provider: EvidenceProvider;
  operation: 'OAUTH_TOKEN' | 'READONLY_GET';
  httpStatus: number | null;
  transport: 'HTTP_RESPONSE' | 'TIMEOUT' | 'TLS_ERROR' | 'NETWORK_ERROR';
};

/** Retain only fixed categories and HTTP status, never URLs, bodies or error text. */
export async function observeProviderRequest(
  observations: ProviderRequestObservation[],
  provider: EvidenceProvider,
  operation: ProviderRequestObservation['operation'],
  request: () => Promise<Response>,
): Promise<Response> {
  try {
    const response = await request();
    observations.push({ provider, operation, httpStatus: response.status, transport: 'HTTP_RESPONSE' });
    return response;
  } catch (error) {
    const value = error as { name?: unknown; code?: unknown } | null;
    const code = String(value?.code ?? '');
    const timeout = value?.name === 'AbortError' || value?.name === 'TimeoutError' || code === 'ETIMEDOUT';
    const tls = ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code);
    observations.push({ provider, operation, httpStatus: null,
      transport: timeout ? 'TIMEOUT' : tls ? 'TLS_ERROR' : 'NETWORK_ERROR' });
    throw error;
  }
}

export type ProviderEvidenceResult<T> =
  | { provider: EvidenceProvider; verdict: 'PASS'; summary: T }
  | { provider: EvidenceProvider; verdict: 'FAIL'; errorCode: 'PROVIDER_READ_OR_INVARIANT_FAILED' };

/** Exactly one read per provider; an earlier failure must not erase later diagnostics. */
export async function collectProviderEvidence<T>(
  read: (provider: EvidenceProvider) => Promise<T>,
): Promise<ProviderEvidenceResult<T>[]> {
  const results: ProviderEvidenceResult<T>[] = [];
  for (const provider of ['toss', 'upbit', 'bitget'] as const) {
    try {
      results.push({ provider, verdict: 'PASS', summary: await read(provider) });
    } catch {
      results.push({ provider, verdict: 'FAIL', errorCode: 'PROVIDER_READ_OR_INVARIANT_FAILED' });
    }
  }
  return results;
}
