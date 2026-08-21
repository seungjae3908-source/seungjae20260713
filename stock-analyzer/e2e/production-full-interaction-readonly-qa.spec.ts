import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
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

const ARTIFACT_DIR = path.resolve('production-comprehensive-artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const FULL_INTERACTION_ROUTES = [
  '/', '/home', '/stocks', '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures',
  '/market-overview', '/market-rankings', '/market-browser', '/search', '/scanner', '/ai-chart',
  '/ai-chat', '/themes', '/news-information', '/learn', '/watchlist', '/alerts', '/assets',
  '/portfolio', '/position', '/strategy-promotion', '/recommendations', '/backtests', '/paper-trading',
  '/account', '/more', '/settings', '/auto-trading', '/research-center', '/admin', '/admin/ui-layouts',
  '/install',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
  '/stock-info/analysis?asset=stock&market=US&ticker=AAPL',
  '/stock-info?asset=coin&coinMarket=spot&symbol=BTC',
  '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT',
] as const;

const RESPONSIVE_INTERACTION_ROUTES = [
  '/', '/stocks', '/stocks/kr', '/stocks/us', '/scanner', '/ai-chart', '/paper-trading',
  '/account', '/auto-trading', '/admin', '/install',
] as const;

const LEGACY_REDIRECTS = [
  { from: '/crypto', to: '/home' },
  { from: '/crypto/search', to: '/stocks' },
  { from: '/stock/005930?back=/stocks', to: '/stock-info/analysis' },
  { from: '/stock/AAPL?back=/stocks', to: '/stock-info/analysis' },
  { from: '/crypto/BTC?back=/stocks', to: '/stock-info' },
] as const;

const EXPLICIT_SAFE_PATTERN = /(?:새로고침|재시도|다시\s*시도|닫기|열기|펼치기|접기|이전|다음|더보기|상세|보기|호가|refresh|retry|reload|close|open|expand|collapse|previous|next|details?)/i;
const UNSAFE_PATTERN = /(?:매수|매도|주문|거래|청산|취소|정정|출금|입금|이체|송금|전송|승인|승격|삭제|제거|저장|적용|생성|추가|등록|연결|해제|로그아웃|실행|시작|중지|활성|비활성|질문|전송|구매|판매|buy|sell|order|trade|liquidat|cancel|amend|withdraw|deposit|transfer|approve|promote|delete|remove|save|apply|create|add|register|connect|disconnect|logout|execute|start|stop|enable|disable|send|submit)/i;

type Diagnostic = { kind: string; path: string; detail: string; status?: number };
type ControlInventory = {
  tag: string;
  role: string;
  label: string;
  disabled: boolean;
  expanded: string | null;
  type: string;
  href: string | null;
};
type SafeClick = {
  label: string;
  role: string;
  tag: string;
  durationMs: number;
  finalUrl: string;
};
type RouteInteractionAudit = {
  route: string;
  finalUrl: string;
  loadMs: number;
  fallbackTimedOut: boolean;
  busyAfter5s: number;
  horizontalOverflowPx: number;
  controls: number;
  buttons: number;
  tabs: number;
  links: number;
  inputs: number;
  forms: number;
  safeClicks: SafeClick[];
  unsafeControls: string[];
  unlabeledControls: string[];
  clickFailures: string[];
  focusFailures: string[];
  numericInputs: Array<{ label: string; min: string | null; max: string | null; step: string | null; required: boolean; readOnly: boolean }>;
  diagnostics: Diagnostic[];
};

function slug(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

function writeJson(name: string, value: unknown) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(value, null, 2), 'utf8');
}

function currentPath(page: Page) {
  try { return new URL(page.url()).pathname; } catch { return 'unknown'; }
}

function requestPath(rawUrl: string) {
  try { return new URL(rawUrl).pathname; } catch { return 'unknown'; }
}

function attachDiagnostics(page: Page, diagnostics: Diagnostic[]) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    diagnostics.push({ kind: 'console', path: currentPath(page), detail: message.text().slice(0, 600) });
  });
  page.on('pageerror', (error) => {
    diagnostics.push({ kind: 'pageerror', path: currentPath(page), detail: error.message.slice(0, 600) });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== productionOrigin) return;
    if (response.status() === 404 && /\/(?:manifest|favicon)/i.test(url.pathname)) return;
    diagnostics.push({
      kind: 'http',
      path: `${url.pathname}${url.search}`.slice(0, 500),
      status: response.status(),
      detail: `${response.request().method()} ${response.status()} ${response.statusText()}`,
    });
  });
  page.on('requestfailed', (request: Request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
    diagnostics.push({ kind: 'requestfailed', path: requestPath(request.url()), detail: `${request.method()} ${failure}` });
  });
}

async function installSafety(page: Page, blocked: Diagnostic[]) {
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    blocked.push({ kind: 'blocked-mutation', path: requestPath(request.url()), detail: `${reason}: ${request.method()}` });
  });
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function waitForTerminal(page: Page) {
  let fallbackTimedOut = false;
  try {
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });
  } catch {
    fallbackTimedOut = true;
  }
  const busy = page.locator('[aria-busy="true"]:visible');
  if (await busy.count()) {
    await expect(busy).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
  }
  return { fallbackTimedOut, busyAfter5s: await busy.count().catch(() => -1) };
}

async function collectInventory(page: Page): Promise<ControlInventory[]> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1
        && rect.height > 1
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0.01;
    };
    const labelFor = (element: HTMLElement) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        : '';
      return normalize(
        element.getAttribute('aria-label')
        || labelledText
        || element.getAttribute('title')
        || element.getAttribute('placeholder')
        || element.textContent,
      ).slice(0, 160);
    };
    const selectors = [
      'button', '[role="button"]', '[role="tab"]', '[aria-expanded]', 'summary',
      'input', 'textarea', 'select', 'a[href]',
    ].join(',');
    const seen = new Set<Element>();
    const rows: Array<{
      tag: string; role: string; label: string; disabled: boolean; expanded: string | null; type: string; href: string | null;
    }> = [];
    for (const element of Array.from(document.querySelectorAll(selectors))) {
      if (seen.has(element) || !visible(element)) continue;
      seen.add(element);
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      const disabled = 'disabled' in input && Boolean(input.disabled);
      rows.push({
        tag: element.tagName,
        role: normalize(element.getAttribute('role')) || (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY' ? 'button' : element.tagName === 'A' ? 'link' : ''),
        label: labelFor(html),
        disabled,
        expanded: element.getAttribute('aria-expanded'),
        type: normalize(input.type),
        href: element instanceof HTMLAnchorElement ? element.href : null,
      });
    }
    return rows;
  });
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => ({
    horizontalOverflowPx: Math.max(
      0,
      Math.round(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth),
    ),
    forms: document.querySelectorAll('form').length,
  }));
}

function isSafeControl(control: ControlInventory) {
  if (control.disabled || !control.label) return false;
  if (control.role === 'tab') return true;
  if (control.tag === 'SUMMARY' || control.expanded != null) return !UNSAFE_PATTERN.test(control.label);
  if (EXPLICIT_SAFE_PATTERN.test(control.label)) return true;
  if (UNSAFE_PATTERN.test(control.label)) return false;
  return false;
}

function isUnsafeControl(control: ControlInventory) {
  return Boolean(control.label) && UNSAFE_PATTERN.test(control.label) && control.role !== 'tab';
}

async function clickControl(page: Page, control: ControlInventory) {
  if (control.role === 'tab') {
    await page.getByRole('tab', { name: control.label, exact: true }).first().click({ timeout: 2_500 });
    return;
  }
  if (control.tag === 'SUMMARY') {
    const summary = page.locator('summary').filter({ hasText: control.label }).first();
    await summary.click({ timeout: 2_500 });
    return;
  }
  await page.getByRole('button', { name: control.label, exact: true }).first().click({ timeout: 2_500 });
}

async function focusVisibleInputs(page: Page) {
  const failures: string[] = [];
  const locator = page.locator('input:visible,textarea:visible,select:visible');
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const input = locator.nth(index);
    const type = String(await input.getAttribute('type').catch(() => '') ?? '').toLowerCase();
    if (['hidden', 'password', 'file'].includes(type)) continue;
    const disabled = await input.isDisabled().catch(() => true);
    if (disabled) continue;
    const label = String(
      await input.getAttribute('aria-label').catch(() => null)
      ?? await input.getAttribute('placeholder').catch(() => null)
      ?? `${type || 'input'}-${index}`,
    ).trim();
    await input.focus({ timeout: 1_500 }).catch((error) => {
      failures.push(`${label}: ${String(error).split('\n')[0].slice(0, 180)}`);
    });
  }
  return failures;
}

async function numericInputContracts(page: Page) {
  return page.locator('input[type="number"]:visible').evaluateAll((nodes) => nodes.map((node, index) => {
    const input = node as HTMLInputElement;
    const label = String(input.getAttribute('aria-label') || input.getAttribute('placeholder') || `number-${index}`).trim();
    return {
      label,
      min: input.getAttribute('min'),
      max: input.getAttribute('max'),
      step: input.getAttribute('step'),
      required: input.required,
      readOnly: input.readOnly,
    };
  }));
}

async function restoreRoute(page: Page, route: string) {
  const expected = new URL(route, baseUrl).pathname;
  const actual = new URL(page.url()).pathname;
  if (actual === expected) return;
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await waitForTerminal(page);
}

async function exerciseSafeControls(page: Page, route: string) {
  const safeClicks: SafeClick[] = [];
  const clickFailures: string[] = [];
  const unsafe = new Set<string>();
  const unlabeled = new Set<string>();
  const clicked = new Set<string>();

  for (let pass = 0; pass < 2; pass += 1) {
    const inventory = await collectInventory(page);
    for (const control of inventory) {
      if ((control.tag === 'BUTTON' || control.role === 'button' || control.role === 'tab' || control.tag === 'SUMMARY') && !control.label) {
        unlabeled.add(`${control.tag}/${control.role || 'none'}`);
        continue;
      }
      if (isUnsafeControl(control)) {
        unsafe.add(control.label);
        continue;
      }
      if (!isSafeControl(control)) continue;
      const key = `${control.tag}|${control.role}|${control.label}`;
      if (clicked.has(key)) continue;
      clicked.add(key);
      const started = Date.now();
      try {
        await clickControl(page, control);
        await page.waitForTimeout(120);
        safeClicks.push({
          label: control.label,
          role: control.role,
          tag: control.tag,
          durationMs: Date.now() - started,
          finalUrl: page.url(),
        });
      } catch (error) {
        clickFailures.push(`${control.label}: ${String(error).split('\n')[0].slice(0, 220)}`);
      }
      if (!page.isClosed()) await restoreRoute(page, route).catch(() => undefined);
      if (page.isClosed()) break;
    }
    if (page.isClosed()) break;
  }

  return {
    safeClicks,
    unsafeControls: Array.from(unsafe).sort(),
    unlabeledControls: Array.from(unlabeled).sort(),
    clickFailures,
  };
}

async function auditRoute(page: Page, route: string, diagnostics: Diagnostic[]): Promise<RouteInteractionAudit> {
  const diagnosticStart = diagnostics.length;
  const started = Date.now();
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const terminal = await waitForTerminal(page);
  const loadMs = Date.now() - started;
  const inventory = await collectInventory(page);
  const metrics = await layoutMetrics(page);
  const focusFailures = await focusVisibleInputs(page);
  const numericInputs = await numericInputContracts(page);
  const interaction = await exerciseSafeControls(page, route);
  return {
    route,
    finalUrl: page.url(),
    loadMs,
    fallbackTimedOut: terminal.fallbackTimedOut,
    busyAfter5s: terminal.busyAfter5s,
    horizontalOverflowPx: metrics.horizontalOverflowPx,
    controls: inventory.length,
    buttons: inventory.filter((item) => item.tag === 'BUTTON' || item.role === 'button').length,
    tabs: inventory.filter((item) => item.role === 'tab').length,
    links: inventory.filter((item) => item.tag === 'A' || item.role === 'link').length,
    inputs: inventory.filter((item) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(item.tag)).length,
    forms: metrics.forms,
    safeClicks: interaction.safeClicks,
    unsafeControls: interaction.unsafeControls,
    unlabeledControls: interaction.unlabeledControls,
    clickFailures: interaction.clickFailures,
    focusFailures,
    numericInputs,
    diagnostics: diagnostics.slice(diagnosticStart),
  };
}

function fullProject(testInfo: TestInfo) {
  return testInfo.project.name === 'prod-desktop-1440' || testInfo.project.name === 'prod-mobile-390';
}

const SAFE_CONTROL_FIXTURE: ControlInventory = {
  tag: 'BUTTON',
  role: 'button',
  label: '',
  disabled: false,
  expanded: null,
  type: 'button',
  href: null,
};

test('Production read-only safe-control classifier fails closed for unknown buttons', () => {
  expect(isSafeControl({ ...SAFE_CONTROL_FIXTURE, label: '새로고침' })).toBe(true);
  expect(isSafeControl({ ...SAFE_CONTROL_FIXTURE, label: '상세 보기' })).toBe(true);
  expect(isSafeControl({ ...SAFE_CONTROL_FIXTURE, label: '알 수 없는 동작' })).toBe(false);
  expect(isSafeControl({ ...SAFE_CONTROL_FIXTURE, label: '모의 평가' })).toBe(false);
});

test.describe('Production full interaction read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('all routes inventory and every safe visible control are exercised', async ({ page }, testInfo) => {
    const full = fullProject(testInfo);
    test.setTimeout(full ? 18 * 60_000 : 8 * 60_000);
    const diagnostics: Diagnostic[] = [];
    const blocked: Diagnostic[] = [];
    attachDiagnostics(page, diagnostics);
    await installSafety(page, blocked);
    await login(page);

    const routes = full ? FULL_INTERACTION_ROUTES : RESPONSIVE_INTERACTION_ROUTES;
    const audits: RouteInteractionAudit[] = [];
    const filename = `${slug(testInfo.project.name)}-full-interaction.json`;
    for (const route of routes) {
      const audit = await auditRoute(page, route, diagnostics);
      audits.push(audit);
      writeJson(filename, { project: testInfo.project.name, audits, blocked, complete: false });
    }
    writeJson(filename, { project: testInfo.project.name, audits, blocked, complete: true });

    expect(blocked, 'Full-interaction QA attempted a Production mutation/private-provider request').toEqual([]);
    expect(audits.filter((item) => item.fallbackTimedOut), 'route fallback exceeded 5s').toEqual([]);
    expect(audits.filter((item) => item.busyAfter5s > 0), 'route remained aria-busy after 5s').toEqual([]);
    expect(audits.filter((item) => item.horizontalOverflowPx > 2), 'horizontal overflow detected').toEqual([]);
    expect(audits.flatMap((item) => item.clickFailures.map((failure) => `${item.route}: ${failure}`)), 'safe control click failed').toEqual([]);
    expect(audits.flatMap((item) => item.focusFailures.map((failure) => `${item.route}: ${failure}`)), 'visible form control could not receive focus').toEqual([]);
    expect(audits.flatMap((item) => item.unlabeledControls.map((failure) => `${item.route}: ${failure}`)), 'visible interactive control has no accessible label').toEqual([]);
    expect(
      audits.flatMap((item) => item.diagnostics.filter((entry) => entry.kind === 'pageerror' || entry.kind === 'requestfailed')),
      'browser/runtime failures detected during safe interactions',
    ).toEqual([]);
  });

  test('legacy stock and crypto routes resolve to canonical destinations', async ({ page }, testInfo) => {
    test.skip(!fullProject(testInfo));
    test.setTimeout(2 * 60_000);
    const blocked: Diagnostic[] = [];
    await installSafety(page, blocked);
    await login(page);
    const audits: Array<{ from: string; expected: string; actual: string; durationMs: number }> = [];
    for (const item of LEGACY_REDIRECTS) {
      const started = Date.now();
      await page.goto(item.from, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 6_000 }).toBe(item.to);
      audits.push({ from: item.from, expected: item.to, actual: new URL(page.url()).pathname, durationMs: Date.now() - started });
    }
    writeJson(`${slug(testInfo.project.name)}-legacy-redirects.json`, { project: testInfo.project.name, audits, blocked });
    expect(blocked).toEqual([]);
  });

  test('offline banner appears and reconnect clears it without mutation', async ({ page, context }, testInfo) => {
    test.skip(!fullProject(testInfo));
    test.setTimeout(60_000);
    const blocked: Diagnostic[] = [];
    await installSafety(page, blocked);
    await login(page);
    await page.goto('/home', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForTerminal(page);

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('오프라인 상태입니다 · 마지막으로 불러온 데이터를 표시합니다', { exact: true })).toBeVisible({ timeout: 3_000 });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('오프라인 상태입니다 · 마지막으로 불러온 데이터를 표시합니다', { exact: true })).toHaveCount(0, { timeout: 3_000 });
    expect(blocked).toEqual([]);
  });

  test('AI draft, Paper inputs, Account read-only shell, and PWA surface stay non-mutating', async ({ page }, testInfo) => {
    test.skip(!fullProject(testInfo));
    test.setTimeout(2 * 60_000);
    const blocked: Diagnostic[] = [];
    await installSafety(page, blocked);
    await login(page);

    await page.goto('/ai-chat', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForTerminal(page);
    const textarea = page.locator('textarea:visible').first();
    if (await textarea.count()) {
      await textarea.fill('READ_ONLY_QA_DRAFT_DO_NOT_SEND');
      await expect(textarea).toHaveValue('READ_ONLY_QA_DRAFT_DO_NOT_SEND');
      await textarea.fill('');
    }

    await page.goto('/paper-trading', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForTerminal(page);
    const paperNumberInputs = await numericInputContracts(page);

    await page.goto('/account', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForTerminal(page);
    const accountText = String(await page.locator('body').innerText()).slice(0, 4_000);

    await page.goto('/install', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForTerminal(page);
    const install = await page.evaluate(() => ({
      manifestHref: document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? null,
      installButtons: Array.from(document.querySelectorAll('button')).filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      }).map((button) => String(button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    }));

    writeJson(`${slug(testInfo.project.name)}-readonly-form-contracts.json`, {
      project: testInfo.project.name,
      aiDraftOnly: true,
      paperNumberInputs,
      accountReadOnlyTextObserved: /읽기\s*전용|read.?only/i.test(accountText),
      install,
      blocked,
    });

    expect(blocked, 'Draft/form/PWA audit attempted a Production mutation').toEqual([]);
  });
});
