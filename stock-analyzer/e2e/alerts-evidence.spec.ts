import { expect, test, type Page, type Route } from '@playwright/test';
import { alertRelativeTime, parseAlertFeed, parseNotificationHistory, parseNotificationRead, safeAlertUrl, type NotificationHistoryRow } from '../src/lib/alert-evidence';

const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';
const CREATED = '2026-01-01T00:00:00Z';
function notification(id = 'fixture-alert', title = '내 계정 알림'): NotificationHistoryRow {
  return { id, title, body: '저장된 알림 근거', notification_type: 'price', channel: 'in_app', url: null, created_at: CREATED, read_at: null };
}
function feedFixture() {
  return { positive: [{ id: 'KR:005930:movement', ticker: '005930', name: '삼성전자', market: 'KR', kind: 'positive',
    category: '시세 변동', title: '이전 시세 변동', importance: 'low', time: CREATED, url: null }], negative: [] };
}
function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
function token(id: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: id, role: 'authenticated', exp: 4_102_444_800 })}.e2e`;
}
function user(id: string) {
  return { id, aud: 'authenticated', role: 'authenticated', email: 'alerts@accounts.invalid', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [], created_at: CREATED };
}
async function installSession(page: Page) {
  await page.addInitScript(({ accessToken, member }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: accessToken, refresh_token: 'fixture-refresh',
      expires_at: 4_102_444_800, expires_in: 3600, token_type: 'bearer', user: member }));
  }, { accessToken: token(USER_A), member: user(USER_A) });
  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = route.request().headers().authorization?.includes(token(USER_B)) ? USER_B : USER_A;
    if (path.endsWith('/auth/v1/user')) return fulfill(route, user(id));
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, { id, login_name: 'alerts', display_name: '알림 검증', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, updated_at: CREATED });
    return fulfill(route, []);
  });
}
async function invalidateHistory(page: Page) {
  await page.clock.fastForward(31_000);
}

test('notification schemas reject coercion, unsafe URLs, foreign read acknowledgements and impossible time', () => {
  const row = notification();
  expect(parseNotificationHistory({ notifications: [row], count: 1 }).count).toBe(1);
  expect(parseNotificationHistory({ notifications: [], count: 0 }).count).toBe(0);
  for (const invalid of [{}, { notifications: [] }, { notifications: [], count: '0' }, { notifications: [row, row], count: 2 },
    ...[{ url: 'javascript:alert(1)' }, { url: '//evil.invalid' }, { created_at: '2026-02-30T00:00:00Z' },
      { created_at: '2099-01-01T00:00:00Z' }, { body: {} }, { read_at: '2025-01-01T00:00:00Z' }]
      .map((change) => ({ notifications: [{ ...row, ...change }], count: 1 }))]) expect(() => parseNotificationHistory(invalid)).toThrow();
  for (const url of ['javascript:alert(1)', 'data:text/html,', '//evil.invalid', '/\\evil.invalid', 'https://user:pass@example.com', 'https://example.com/\n']) expect(safeAlertUrl(url)).toBe(false);
  for (const url of [null, '/stocks/AAPL?market=US', 'https://example.com/source']) expect(safeAlertUrl(url)).toBe(true);
  expect(parseNotificationRead({ notification: { ...row, read_at: new Date().toISOString() } }, row.id).id).toBe(row.id);
  for (const reply of [{}, { notification: null }, { notification: row }, { notification: { ...row, id: 'other', read_at: new Date().toISOString() } }]) expect(() => parseNotificationRead(reply, row.id)).toThrow();
  expect(alertRelativeTime('2099-01-01T00:00:00Z')).toBe('시각 미확인');
  expect(alertRelativeTime('2026-02-30T00:00:00Z')).toBe('시각 미확인');
  expect(parseAlertFeed(feedFixture()).positive).toHaveLength(1);
  for (const change of [{ market: undefined }, { market: 'US' }, { importance: ['high'] }, { time: '2099-01-01T00:00:00Z' }, { url: 'javascript:alert(1)' }]) {
    expect(() => parseAlertFeed({ ...feedFixture(), positive: [{ ...feedFixture().positive[0], ...change }] })).toThrow();
  }
});

for (const [width, height] of [[1440, 900], [1024, 768], [320, 740], [360, 800], [390, 844], [412, 915], [430, 932]]) {
  test(`alerts hide invalid refreshed evidence and preserve historical source time ${width}`, async ({ page }, testInfo) => {
    await installSession(page);
    await page.clock.install();
    await page.setViewportSize({ width, height });
    let malformed = false;
    const errors: string[] = [];
    const http: number[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) http.push(response.status()); });
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/notifications/history') return fulfill(route, malformed ? { notifications: [], count: '0' } : { notifications: [notification()], count: 1 });
      if (path === '/api/market/alerts') return fulfill(route, feedFixture());
      return fulfill(route, { ok: true, exists: false, items: [] });
    });
    await page.goto('/alerts');
    await expect(page.getByTestId('notification-history-list')).toContainText('내 계정 알림');
    await expect(page.getByRole('button', { name: '내 알림 1', exact: true })).toBeVisible();
    malformed = true;
    await invalidateHistory(page);
    await expect(page.getByTestId('error-state')).toBeVisible();
    await expect(page.getByText('내 계정 알림', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '내 알림 미확인', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^시장 신호/ }).click();
    await expect(page.getByTestId('market-alert-list')).toContainText('ARCHIVED · 과거 신호');
    await expect(page.getByTestId('market-alert-list')).not.toContainText('호재 뉴스');
    for (const button of await page.getByTestId('alert-source-tabs').getByRole('button').all()) {
      const rect = await button.boundingBox();
      expect(rect?.height).toBeGreaterThanOrEqual(44);
      expect(rect?.height).toBeLessThanOrEqual(48);
    }
    await testInfo.attach(`alerts-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect(errors).toEqual([]);
    expect(http).toEqual([]);
  });
}

test('read action rejects unconfirmed success, prevents duplicate click and supports retry', async ({ page }) => {
  await installSession(page);
  let reads = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release: () => void = () => { throw new Error('read was not pending'); };
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const row = notification();
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/read')) {
      reads++;
      if (reads === 1) { await pending; return fulfill(route, { notification: null }); }
      row.read_at = new Date().toISOString();
      return fulfill(route, { notification: row });
    }
    if (path === '/api/notifications/history') return fulfill(route, { notifications: [row], count: 1 });
    return fulfill(route, { ok: true, exists: false, items: [] });
  });
  await page.goto('/alerts');
  const button = page.getByTestId('notification-history-list').getByRole('button');
  await button.evaluate((element) => { element.click(); element.click(); });
  await expect.poll(() => reads).toBe(1);
  await expect(button).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('이동하지 않았습니다');
  await expect(page).toHaveURL(/\/alerts$/);
  await button.click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(button).toHaveClass(/border-card-border/);
  expect(errors).toEqual([]);
});

test('account switch does not expose cached notifications or apply a late previous-member read', async ({ page }) => {
  await installSession(page);
  let historyB = 0;
  let readStarted = false;
  let release: () => void = () => { throw new Error('read was not pending'); };
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/read')) { readStarted = true; await pending; return fulfill(route, { notification: { ...notification(), url: '/account', read_at: new Date().toISOString() } }); }
    if (path === '/api/notifications/history') {
      const isB = route.request().headers().authorization?.includes(token(USER_B));
      if (isB) historyB++;
      return fulfill(route, { notifications: [{ ...notification(isB ? 'b-alert' : 'fixture-alert', isB ? '회원 B 알림' : '회원 A 비공개 알림'), url: '/account' }], count: 1 });
    }
    return fulfill(route, { ok: true, exists: false, items: [] });
  });
  await page.goto('/alerts');
  await page.getByRole('button', { name: /회원 A 비공개 알림/ }).click();
  await expect.poll(() => readStarted).toBe(true);
  await page.evaluate(async ({ accessToken }) => {
    const path = performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => new URL(url).pathname === '/src/lib/supabase.ts').at(-1);
    if (!path) throw new Error('Actual auth transport not loaded');
    const { getSupabase } = await import(path) as typeof import('../src/lib/supabase');
    await getSupabase().auth.setSession({ access_token: accessToken, refresh_token: 'fixture-b-refresh' });
  }, { accessToken: token(USER_B) });
  await expect.poll(() => historyB).toBeGreaterThan(0);
  await expect(page.getByText('회원 B 알림', { exact: true })).toBeVisible();
  release();
  await expect(page.getByText('회원 A 비공개 알림', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/alerts$/);
});
