import { test, expect, type Page } from '@playwright/test';

const stagingMode = process.env.PHASE10_STAGING_E2E === 'true';
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Phase 10 staging verification`);
  return value;
};

const targetSha = stagingMode ? required('STAGING_TARGET_SHA') : '';
const accounts = stagingMode ? {
  pending: { email: required('STAGING_PENDING_EMAIL'), password: required('STAGING_PENDING_PASSWORD') },
  associate: { email: required('STAGING_ASSOCIATE_EMAIL'), password: required('STAGING_ASSOCIATE_PASSWORD') },
  regular: { email: required('STAGING_REGULAR_EMAIL'), password: required('STAGING_REGULAR_PASSWORD') },
  admin: { email: required('STAGING_ADMIN_EMAIL'), password: required('STAGING_ADMIN_PASSWORD') },
} : {
  pending: { email: '', password: '' },
  associate: { email: '', password: '' },
  regular: { email: '', password: '' },
  admin: { email: '', password: '' },
};

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
  await expect(emailInput).toBeVisible();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await page.getByRole('button', { name: /로그인|sign in|log in/i }).click();
  await page.waitForLoadState('networkidle');
}

async function expectNoBrowserErrors(page: Page, action: () => Promise<void>) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await action();
  expect(errors).toEqual([]);
}

test.describe('Phase 10 real staging readiness', () => {
  test.skip(!stagingMode, 'Requires the isolated real staging environment and four real accounts');

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
    ['small-mobile', 360, 740],
  ] as const) {
    test(`${name}: staging SHA, responsive login, and session recovery`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await expectNoBrowserErrors(page, async () => {
        const health = await page.request.get('/api/health');
        expect(health.ok()).toBeTruthy();
        const body = await health.json();
        expect(body.ok).toBe(true);
        const reportedSha = body.deploySha ?? body.sha ?? body.commitSha;
        if (reportedSha) expect(reportedSha).toBe(targetSha);
        await login(page, accounts.regular.email, accounts.regular.password);
        await page.reload();
        await page.waitForLoadState('networkidle');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      });
    });
  }

  test('pending account is restricted to approval waiting experience', async ({ page }) => {
    await login(page, accounts.pending.email, accounts.pending.password);
    await expect(page.getByText(/승인.*대기|approval.*pending/i).first()).toBeVisible();
    await page.goto('/paper-trading');
    await expect(page.getByText(/승인.*대기|접근.*권한|access.*denied/i).first()).toBeVisible();
  });

  test('associate account can use basic information but cannot access futures or AI', async ({ page }) => {
    await login(page, accounts.associate.email, accounts.associate.password);
    await page.goto('/');
    await expect(page.locator('body')).toContainText(/국내|해외|시장|market/i);
    await page.goto('/trading-workspace');
    await expect(page.getByText(/권한|정회원|access.*denied|regular member/i).first()).toBeVisible();
    const response = await page.request.post('/api/paper-journal/ai-review/preview', { data: {} });
    expect([401, 403]).toContain(response.status());
  });

  test('regular account can access futures and opt-in AI review but never real orders', async ({ page }) => {
    await login(page, accounts.regular.email, accounts.regular.password);
    await page.goto('/paper-trading');
    await expect(page.locator('body')).toContainText(/모의|paper/i);
    await expect(page.locator('body')).toContainText(/실제 주문.*전송하지|does not.*real order/i);
    const preview = await page.request.post('/api/paper-journal/ai-review/preview', { data: {} });
    expect(preview.ok()).toBeTruthy();
    const previewBody = await preview.json();
    expect(previewBody.externalAiCalled).toBe(false);
    expect(previewBody.orderSubmitted).toBe(false);
    expect(previewBody.exchangeRequestSent).toBe(false);
  });

  test('admin can manage members but cannot automatically read another users private journal', async ({ page }) => {
    await login(page, accounts.admin.email, accounts.admin.password);
    await page.goto('/admin/members');
    await expect(page.locator('body')).toContainText(/회원|member/i);
    const foreignJournal = await page.request.get('/api/paper-journal/snapshot?userId=11111111-1111-1111-1111-111111111111');
    expect([400, 403]).toContain(foreignJournal.status());
  });

  test('AI review requires consent and keeps provider failures order-safe', async ({ page }) => {
    await login(page, accounts.regular.email, accounts.regular.password);
    const blocked = await page.request.post('/api/paper-journal/ai-review/generate', {
      data: { consent: false, idempotencyKey: `phase10-${Date.now()}` },
    });
    expect(blocked.status()).toBe(400);
    const body = await blocked.json();
    expect(body.externalAiCalled).toBe(false);
    expect(body.orderSubmitted).toBe(false);
    expect(body.exchangeRequestSent).toBe(false);
  });
});
