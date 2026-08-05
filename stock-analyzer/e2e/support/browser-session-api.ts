import type { APIResponse, Page } from '@playwright/test';

type BrowserSessionRequestOptions = {
  method?: 'GET' | 'POST';
  data?: Record<string, unknown>;
};

async function readBrowserBearer(page: Page): Promise<string> {
  const bearer = await page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !/^sb-[a-z0-9]+-auth-token$/i.test(key)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const stored = JSON.parse(raw) as {
          access_token?: unknown;
          currentSession?: { access_token?: unknown };
          session?: { access_token?: unknown };
        };
        const candidate = stored.access_token
          ?? stored.currentSession?.access_token
          ?? stored.session?.access_token;
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      } catch {
        // Ignore unrelated or malformed localStorage values without copying them.
      }
    }
    return null;
  });

  if (!bearer) {
    throw new Error('Authenticated browser session bearer is unavailable');
  }
  return bearer;
}

/**
 * Uses the access token already held by the authenticated browser session.
 * The bearer is never logged, attached, serialized into artifacts, or returned.
 */
export async function requestWithBrowserSession(
  page: Page,
  requestPath: string,
  options: BrowserSessionRequestOptions = {},
): Promise<APIResponse> {
  if (!requestPath.startsWith('/api/')) {
    throw new Error('Browser-session API requests are restricted to app API paths');
  }

  const bearer = await readBrowserBearer(page);
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
  };
  if (options.data !== undefined) headers['Content-Type'] = 'application/json';

  return page.request.fetch(requestPath, {
    method,
    headers,
    data: options.data,
  });
}
