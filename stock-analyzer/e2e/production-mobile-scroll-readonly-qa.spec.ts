import { expect, test, type Page, type Request } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionQaEnabled = Boolean(
  baseUrl
  && qaLogin
  && qaPassword
  && process.env.PRODUCTION_READONLY_E2E === 'true',
);
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';

const ROUTES = [
  '/',
  '/stocks',
  '/scanner',
  '/ai-chart',
  '/paper-trading',
  '/portfolio',
  '/account',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
] as const;

const PROJECTS = new Set([
  'prod-desktop-1440',
  'prod-mobile-320',
  'prod-mobile-360',
  'prod-mobile-390',
  'prod-mobile-412',
  'prod-mobile-430',
]);

type Finding = {
  route: string;
  finalUrl: string;
  horizontalOverflowPx: number;
  documentScrollable: boolean;
  documentScrollMoved: boolean;
  undersizedInteractiveCount: number;
  navigationError: string | null;
};

type Diagnostic = { kind: string; path: string; detail: string };

function requestPath(rawUrl: string) {
  try { return new URL(rawUrl).pathname; } catch { return 'unknown'; }
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function waitForNavigationSettle(page: Page) {
  let lastUrl = page.url();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForLoadState('domcontentloaded', { timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(250);
    const nextUrl = page.url();
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;
  }
}

async function auditDocumentScroll(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1
        && rect.height > 1
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0.01;
    };
    const root = document.scrollingElement ?? document.documentElement;
    const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
    const before = window.scrollY;
    window.scrollTo(0, Math.min(maxY, Math.max(96, Math.floor(window.innerHeight / 2))));
    const after = window.scrollY;
    window.scrollTo(0, before);
    const interactive = Array.from(document.querySelectorAll(
      'button,a[href],input,select,textarea,[role="button"],[role="tab"]',
    )).filter(visible) as HTMLElement[];
    const undersizedInteractiveCount = interactive.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width < 28 || rect.height < 28;
    }).length;
    const rootOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    return {
      horizontalOverflowPx: Math.max(0, Math.round(rootOverflow)),
      documentScrollable: maxY > 8,
      documentScrollMoved: maxY <= 8 || after > before + 1,
      undersizedInteractiveCount,
    };
  });
}

async function auditDocumentScrollStable(page: Page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await auditDocumentScroll(page);
    } catch (error) {
      const message = String(error);
      if (attempt > 0 || !message.includes('Execution context was destroyed')) throw error;
      await waitForNavigationSettle(page);
    }
  }
  throw new Error('unreachable navigation-stability audit state');
}

test.describe('Production root scroll and mobile geometry read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('critical pages preserve root scrolling and viewport geometry', async ({ page }, testInfo) => {
    test.skip(!PROJECTS.has(testInfo.project.name));
    test.setTimeout(3 * 60_000);

    const blocked: Diagnostic[] = [];
    const diagnostics: Diagnostic[] = [];
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push({ kind: 'blocked-mutation', path: requestPath(request.url()), detail: `${reason}: ${request.method()}` });
    });
    page.on('pageerror', (error) => diagnostics.push({ kind: 'pageerror', path: page.url(), detail: error.message.slice(0, 400) }));
    page.on('requestfailed', (request: Request) => {
      const failure = request.failure()?.errorText ?? 'request failed';
      if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
      diagnostics.push({ kind: 'requestfailed', path: requestPath(request.url()), detail: `${request.method()} ${failure}` });
    });

    await login(page);
    const findings: Finding[] = [];
    for (const route of ROUTES) {
      let navigationError: string | null = null;
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch((error) => {
        navigationError = String(error).split('\n')[0].slice(0, 220);
      });
      await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
      await waitForNavigationSettle(page);
      const audit = await auditDocumentScrollStable(page);
      findings.push({ route, finalUrl: page.url(), navigationError, ...audit });
    }

    expect(blocked, 'Production scroll QA attempted a blocked mutation').toEqual([]);
    expect(findings.filter((item) => item.navigationError), 'critical route navigation failed').toEqual([]);
    expect(findings.filter((item) => item.horizontalOverflowPx > 2), 'critical route horizontal overflow detected').toEqual([]);
    expect(findings.filter((item) => item.documentScrollable && !item.documentScrollMoved), 'document should scroll but root scroll did not move').toEqual([]);
    if (testInfo.project.name.startsWith('prod-mobile-')) {
      expect(findings.filter((item) => item.undersizedInteractiveCount > 0), 'mobile interactive controls below 28px detected').toEqual([]);
    }
    expect(diagnostics, 'browser/runtime failures detected during root-scroll audit').toEqual([]);
  });
});
