import { expect, test } from '@playwright/test';

const widths = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920] as const;
const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

async function mountControl(page: import('@playwright/test').Page) {
  await page.goto('/__phase11-unified-search-e2e');
  await page.evaluate(async () => {
    window.localStorage.clear();
    const React = await import(/* @vite-ignore */ '/node_modules/.vite/deps/react.js');
    const ReactDom = await import(/* @vite-ignore */ '/node_modules/.vite/deps/react-dom_client.js');
    const pageModule = await import(/* @vite-ignore */ '/src/pages/ui-builder-layout-control.tsx');
    const existing = document.getElementById('root');
    if (existing) existing.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'ui-builder-control-e2e-root';
    host.style.height = '100dvh';
    document.body.appendChild(host);
    ReactDom.createRoot(host).render(React.createElement(pageModule.default));
  });
  await expect(page.getByTestId('ui-builder-layout-control')).toBeVisible();
}

test('actual control UI performs file import draft preview activate rollback restore and deactivate', async ({ page }) => {
  const forbidden: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenRequest.test(path)) forbidden.push(path);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await mountControl(page);

  const layout = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/lib/ui-builder-full-layout.ts') as any;
    const value = mod.makeFrozenUiBuilderTemplate('HOME', 'mobile');
    value.layoutId = 'control-ui-import-v1';
    value.blocks[1].props.title = '파일 UI Import 성공';
    return JSON.stringify(value);
  });

  await page.getByTestId('ui-builder-json-file').setInputFiles({
    name: 'home-mobile.json',
    mimeType: 'application/json',
    buffer: Buffer.from(layout),
  });
  await expect(page.getByTestId('ui-builder-validation-state')).toHaveText('VALID');
  await expect(page.getByLabel('Layout JSON')).toContainText('파일 UI Import 성공');

  await page.getByRole('button', { name: 'Draft 저장' }).click();
  await expect(page.getByText('Draft 저장 완료')).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Preview 저장 완료')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Active Layout 적용 및 version 저장 완료')).toBeVisible();
  await expect(page.getByTestId('ui-builder-version-history')).toContainText('v1');

  const second = JSON.parse(layout);
  second.layoutId = 'control-ui-import-v2';
  second.blocks[1].props.title = '두 번째 UI Layout';
  await page.getByLabel('Layout JSON').fill(JSON.stringify(second, null, 2));
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByTestId('ui-builder-version-history')).toContainText('v2');

  await page.getByTestId('ui-builder-version-history').getByRole('button', { name: 'Rollback' }).last().click();
  await expect(page.getByText(/새 published version으로 Rollback 완료/)).toBeVisible();
  await expect(page.getByTestId('ui-builder-version-history')).toContainText('v3');
  await expect(page.getByLabel('Layout JSON')).toContainText('파일 UI Import 성공');

  await page.getByRole('button', { name: '기본값 복원' }).click();
  await expect(page.getByText('Frozen Builder 기본 Layout 복원 완료')).toBeVisible();
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText(/safe fallback 사용/)).toBeVisible();

  const fallback = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/lib/ui-builder-full-layout.ts') as any;
    return mod.loadActiveUiBuilderLayout('HOME', 'mobile').source;
  });
  expect(fallback).toBe('fallback');
  expect(forbidden).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('control UI has no horizontal overflow at all required integration widths', async ({ page }) => {
  await mountControl(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId('ui-builder-layout-control')).toBeVisible();
    const metrics = await page.evaluate(() => ({
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    }));
    expect(metrics.documentScrollWidth, `document overflow at ${width}`).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
    expect(metrics.bodyScrollWidth, `body overflow at ${width}`).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  }
});
