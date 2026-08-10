import { expect, type Page } from '@playwright/test';

const forbiddenBuilderRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel|transfers?|withdrawals?)(?:[/?]|$)/i;

export async function expectUiBuilderStagingReadiness(
  page: Page,
  navigate: (route: string) => Promise<void>,
) {
  const forbiddenRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenBuilderRequest.test(path)) forbiddenRequests.push(`${request.method()} ${path}`);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await navigate('/admin/ui-layouts');
  const control = page.getByTestId('ui-builder-layout-control');
  const textarea = page.getByLabel('Layout JSON');
  const validation = page.getByTestId('ui-builder-validation-state');
  const history = page.getByTestId('ui-builder-version-history');
  const pageSelect = page.getByLabel('PageId');
  const deviceSelect = page.getByLabel('Device');
  await expect(control).toBeVisible();

  const pasted = JSON.parse(await textarea.inputValue());
  pasted.layoutId = 'staging-home-mobile-paste-v1';
  pasted.blocks[1].props.title = 'Staging JSON Paste Import PASS';
  await textarea.fill(JSON.stringify(pasted, null, 2));
  await expect(validation).toHaveText('VALID');
  await expect(page.getByTestId('ui-builder-safe-preview')).toContainText('Staging JSON Paste Import PASS');

  const imported = structuredClone(pasted);
  imported.layoutId = 'staging-home-mobile-file-v1';
  imported.blocks[1].props.title = 'Staging JSON File Import PASS';
  await page.getByTestId('ui-builder-json-file').setInputFiles({
    name: 'staging-home-mobile.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByText('파일 Import 완료: staging-home-mobile.json')).toBeVisible();
  await expect(validation).toHaveText('VALID');
  await expect(textarea).toContainText('Staging JSON File Import PASS');

  await page.getByRole('button', { name: 'Draft 저장', exact: true }).click();
  await expect(page.getByText('Draft 저장 완료')).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Preview 저장 완료')).toBeVisible();
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(page.getByText('Active Layout 적용 및 version 저장 완료')).toBeVisible();
  await expect(history).toContainText('v1');

  await page.reload();
  await expect(control).toBeVisible();
  await expect(history).toContainText('v1');

  await navigate('/');
  const homeRuntime = page.getByTestId('ui-builder-runtime-home');
  await expect(homeRuntime).toHaveAttribute('data-builder-layout-source', 'active');
  await expect(homeRuntime).toHaveAttribute('data-builder-layout-id', 'staging-home-mobile-file-v1');

  await navigate('/admin/ui-layouts');
  const second = JSON.parse(await textarea.inputValue());
  second.layoutId = 'staging-home-mobile-v2';
  second.blocks[1].props.title = 'Staging second active layout';
  await textarea.fill(JSON.stringify(second, null, 2));
  await expect(validation).toHaveText('VALID');
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(history).toContainText('v2');
  await history.getByRole('button', { name: 'Rollback', exact: true }).last().click();
  await expect(page.getByText(/새 published version으로 Rollback 완료/)).toBeVisible();
  await expect(history).toContainText('v3');

  await page.getByRole('button', { name: '기본값 복원', exact: true }).click();
  await expect(page.getByText('Frozen Builder 기본 Layout 복원 완료')).toBeVisible();
  await expect(history).toContainText('v4');
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(page.getByText(/safe fallback 사용/)).toBeVisible();
  await navigate('/');
  await expect(homeRuntime).toHaveAttribute('data-builder-layout-source', 'fallback');

  await navigate('/admin/ui-layouts');
  await deviceSelect.selectOption('desktop');
  await expect(history).not.toContainText(/v\d/);
  const desktop = JSON.parse(await textarea.inputValue());
  desktop.layoutId = 'staging-home-desktop-v1';
  await textarea.fill(JSON.stringify(desktop, null, 2));
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(history).toContainText('v1');
  await deviceSelect.selectOption('mobile');
  await expect(history).toContainText('v4');

  await pageSelect.selectOption('PORTFOLIO');
  await expect(history).not.toContainText(/v\d/);

  await pageSelect.selectOption('SIGNAL_SCANNER');
  await deviceSelect.selectOption('mobile');
  const scanner = JSON.parse(await textarea.inputValue());
  scanner.layoutId = 'staging-signal-scanner-mobile-v1';
  await textarea.fill(JSON.stringify(scanner, null, 2));
  await expect(validation).toHaveText('VALID');
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  const scannerBridge = await page.evaluate(() => {
    const raw = window.localStorage.getItem('stock-ui-builder:published-layout:SIGNAL_SCANNER:mobile');
    return raw ? JSON.parse(raw).layoutId : null;
  });
  expect(scannerBridge).toBe('staging-signal-scanner-mobile-v1');

  await pageSelect.selectOption('HOME');
  await deviceSelect.selectOption('mobile');
  const safeBase = JSON.parse(await textarea.inputValue());
  const rejectCases = [
    ['UNSUPPORTED_SCHEMA_VERSION', (value: any) => { value.schemaVersion = 999; }],
    ['UNKNOWN_COMPONENT', (value: any) => { value.blocks[1].type = 'UnknownBlock'; }],
    ['URL_API_BINDING_REJECTED', (value: any) => { value.blocks[1].props.subtitle = '/api/private/orders'; }],
    ['SECRET_TOKEN_REJECTED', (value: any) => { value.blocks[1].props.subtitle = 'Bearer super-secret-token-value'; }],
    ['ARBITRARY_HTML_REJECTED', (value: any) => { value.blocks[1].props.subtitle = '<div>unsafe</div>'; }],
    ['ARBITRARY_JS_REJECTED', (value: any) => { value.blocks[1].props.subtitle = 'fetch("/unsafe")'; }],
    ['CSS_SOURCE_REJECTED', (value: any) => { value.blocks[1].props.subtitle = '<style>body{display:none}</style>'; }],
    ['ARBITRARY_ACTION_REJECTED', (value: any) => { value.blocks[1].actionId = 'MUTATE_ANYTHING'; }],
  ] as const;

  for (const [code, mutate] of rejectCases) {
    const candidate = structuredClone(safeBase);
    mutate(candidate);
    await textarea.fill(JSON.stringify(candidate, null, 2));
    await expect(validation, code).toHaveText('INVALID');
    await page.getByRole('button', { name: 'Draft 저장', exact: true }).click();
    await expect(page.getByRole('alert'), code).toContainText(code);
    await expect(page.getByText('Draft 저장 완료')).toHaveCount(0);
  }

  expect(forbiddenRequests, 'UI Builder staging QA must not issue private/order/cancel/transfer/withdrawal requests').toEqual([]);
}
