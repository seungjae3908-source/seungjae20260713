// Supabase browser client (stock-analyzer frontend).
//
// Uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, injected by Vite at
// build/dev time. The anon (publishable) key is designed to be public; data
// access is protected by Supabase Row Level Security policies.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS } from '@/lib/auth-bootstrap';
import { validatePortfolioHoldingRows } from '@/lib/portfolio-holding-truth';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  return String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function requestUrl(input: RequestInfo | URL): URL | null {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

function isPortfolioHoldingsRead(input: RequestInfo | URL, init: RequestInit): boolean {
  if (requestMethod(input, init) !== 'GET') return false;
  const parsed = requestUrl(input);
  return parsed?.pathname.replace(/\/+$/u, '') === '/rest/v1/portfolio_holdings';
}

function portfolioHoldingDataErrorResponse(response: Response, code: string, rowIndex: number | null): Response {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({
    code: 'PORTFOLIO_HOLDING_DATA_INVALID',
    message: '포트폴리오 원본 데이터의 시장·통화·수량·평단 중 누락되거나 잘못된 값이 있어 계산을 중단했습니다.',
    details: rowIndex == null ? code : `${code}:ROW_${rowIndex}`,
    hint: '원본 보유자산 데이터를 확인한 뒤 다시 시도해 주세요.',
  }), {
    status: 422,
    statusText: 'Unprocessable Entity',
    headers,
  });
}

async function enforcePortfolioHoldingTruth(
  input: RequestInfo | URL,
  init: RequestInit,
  response: Response,
): Promise<Response> {
  if (!response.ok || !isPortfolioHoldingsRead(input, init)) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json() as unknown;
  } catch {
    return portfolioHoldingDataErrorResponse(response, 'INVALID_RESPONSE_SHAPE', null);
  }

  const validation = validatePortfolioHoldingRows(payload);
  if (validation.ok) return response;
  return portfolioHoldingDataErrorResponse(response, validation.code, validation.rowIndex);
}

async function boundedSupabaseFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const parentSignal = init.signal;
  if (parentSignal?.aborted) throw abortReason(parentSignal);

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal ? abortReason(parentSignal) : undefined);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = globalThis.setTimeout(
    () => controller.abort(new DOMException('Supabase request timed out.', 'TimeoutError')),
    AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS,
  );

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await enforcePortfolioHoldingTruth(input, init, response);
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Returns the shared Supabase client. Throws an honest error when the
 * environment is not configured instead of returning a broken client.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase가 설정되지 않았습니다: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 필요합니다.',
    );
  }

  client = createClient(url, anonKey, {
    global: { fetch: boundedSupabaseFetch },
  });
  return client;
}
