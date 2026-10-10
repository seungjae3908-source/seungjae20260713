import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStockDetailTab } from '../src/lib/stock-detail-route-tab';

const root = path.resolve(process.cwd(), 'src');
const detail = fs.readFileSync(path.join(root, 'pages/detail.tsx'), 'utf8');
const info = fs.readFileSync(path.join(root, 'pages/stock-info.tsx'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'components/stock-detail-analysis-panel.tsx'), 'utf8');
const aiTab = fs.readFileSync(path.join(root, 'components/tabs/ai-tab.tsx'), 'utf8');

test('canonical stock analysis route defaults to analysis, never silently displays summary', () => {
  expect(resolveStockDetailTab('/stock-info/analysis', null)).toBe('analysis');
  expect(resolveStockDetailTab('/stock-info/analysis/', null)).toBe('analysis');
  expect(resolveStockDetailTab('/stock-info/analysis', 'bad-tab')).toBe('analysis');
  expect(resolveStockDetailTab('/stock-info', null)).toBe('summary');
});
test('explicit summary, chart, news and analysis switches remain functional on the same route', () => {
  for (const value of ['summary', 'chart', 'news', 'analysis'] as const) {
    expect(resolveStockDetailTab('/stock-info/analysis', value)).toBe(value);
  }
});
test('source button keeps market/ticker identity and explicitly selects the analysis tab', () => {
  expect(info).toContain("params.set('tab', 'analysis');");
  expect(info).toContain('navigate(`/stock-info/analysis?${params.toString()}`);');
  expect(detail).toContain("resolveStockDetailTab(window.location.pathname, params.get('tab'))");
  expect(detail).toContain('<StockDetailAnalysisPanel ticker={ticker} market={market} />');
});
test('market or symbol change must remount prior AI result and abort its outstanding read', () => {
  expect(panel).toContain('key={`${market}:${ticker.trim().toUpperCase()}`}');
  expect(panel).toContain('<AiTab ticker={ticker} currency={currency} active />');
  expect(aiTab).toContain('controllerRef.current?.abort()');
  expect(aiTab).toContain('generation.current !== owner');
  expect(aiTab).toContain('setResult(null)');
  expect(aiTab).toContain("authorizedFetch('/api/ai/chat'");
  expect(aiTab).not.toContain('/trade-automation');
});

test('approved browser opens stock AI Analysis directly, calls provider only on click, and submits no orders', async ({ page }) => {
  const userId = '44444444-4444-4444-8444-444444444444';
  const now = '2026-10-10T00:00:00.000Z';
  const posts: Array<{ method: string; path: string; context: Record<string, unknown> }> = [];
  const privateRequests: string[] = [];

  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'stock-detail-ai-route-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId, aud: 'authenticated', role: 'authenticated',
        email: 'stock-ai-route@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'AI Route User' },
        identities: [], created_at: now,
      },
    }));
  }, { storageKey: 'sb-127-auth-token', userId, now });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const name = new URL(route.request().url()).pathname;
    const body = name.endsWith('/rest/v1/profiles')
      ? { id: userId, login_name: 'stock-ai-user', display_name: 'AI Route User',
          role: 'admin', status: 'approved', membership_level: 'admin',
          is_active: true, permissions_updated_at: now, updated_at: now }
      : name.endsWith('/auth/v1/user')
        ? { id: userId, aud: 'authenticated', role: 'authenticated',
            email: 'stock-ai-route@accounts.invalid',
            app_metadata: { provider: 'email', providers: ['email'] },
            user_metadata: { display_name: 'AI Route User' }, identities: [],
            created_at: now }
        : name.endsWith('/rest/v1/portfolio_holdings') ? [] : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (/\/(?:accounts?|balances?|positions?|orders?|cancel|amend|withdraw|transfer)(?:\/|$)/i.test(path)) {
      privateRequests.push(`${request.method()} ${path}`);
    }
    if (path === '/api/ai/chat') {
      const input = JSON.parse(request.postData() ?? '{}') as { context?: Record<string, unknown> };
      const context = input.context ?? {};
      posts.push({ method: request.method(), path, context });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, kind: 'answer',
          answer: 'AAPL 공개 시세와 기업 정보에 근거한 설명입니다.',
          provider: 'groq', model: 'fixture-model', fallbackUsed: false,
          selection: context,
          data: { status: 'partial', asOf: now, basis: 'server_collection_time',
            sources: ['공개 시세'], missing: ['선택 시간봉 1D OHLCV·기술지표'] },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/stock-info/analysis?asset=stock&market=US&ticker=AAPL');
  const analysis = page.getByTestId('stock-ai-analysis-readonly');
  await expect(analysis).toBeVisible();
  await expect(analysis).toHaveAttribute('data-symbol', 'AAPL');
  await expect(analysis).toHaveAttribute('data-market', 'US');
  await expect(page.getByTestId('stock-ai-request-analysis')).toBeVisible();
  expect(posts).toHaveLength(0);
  expect(privateRequests).toEqual([]);

  await page.getByTestId('stock-ai-request-analysis').click();
  await expect(page.getByTestId('stock-ai-grounded-answer')).toContainText('AAPL 공개 시세');
  await expect(page.getByTestId('stock-ai-evidence-result')).toContainText('일부 미연결');
  expect(posts).toHaveLength(1);
  expect(posts[0].method).toBe('POST');
  expect(posts[0].context.market).toBe('US');
  expect(posts[0].context.symbol).toBe('AAPL');
  expect(posts[0].context.ticker).toBe('AAPL');
  expect(posts[0].context.timeframe).toBe('1D');
  expect(posts[0].context.action).toBeNull();
  expect(privateRequests).toEqual([]);
});
