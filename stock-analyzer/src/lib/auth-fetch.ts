import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

/**
 * Calls an app API with the current Supabase access token.
 * Public/external URLs should continue to use the browser fetch directly.
 */
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (isSupabaseConfigured && !headers.has('Authorization')) {
    // getSession()이 내부 잠금 문제로 영원히 대기하는 상황을 방지하기 위해
    // 5초 안에 토큰을 못 얻으면 토큰 없이 요청합니다(서버가 401을 돌려주어
    // 화면이 무한 로딩 대신 오류/재시도 상태로 전환됩니다).
    try {
      const result = await Promise.race([
        getSupabase().auth.getSession(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      const token = result?.data.session?.access_token;
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } catch {
      // 토큰 조회 실패 시에도 요청 자체는 진행 (서버가 상태코드로 알려줌)
    }
  }

  return fetch(input, { ...init, headers });
}
