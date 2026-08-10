import { expect, test } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

test('UI Builder Import Preview Activate is device-isolated and fail-closed in browser runtime', async ({ page }) => {
  const forbidden: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenRequest.test(path)) forbidden.push(path);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/__phase11-unified-search-e2e');

  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/ui-builder-full-layout.ts';
    const mod = await import(/* @vite-ignore */ modulePath) as any;

    const mobile = mod.makeFrozenUiBuilderTemplate('HOME', 'mobile');
    mobile.layoutId = 'e2e-home-mobile';
    mobile.blocks[1].props.title = '브라우저 Import 검증';

    const imported = mod.parseAndValidateUiBuilderLayout(JSON.stringify(mobile), 'HOME', 'mobile');
    if (!imported.valid || !imported.layout) throw new Error('valid HOME/mobile import rejected');

    mod.writeUiBuilderStoredLayout('draft', imported.layout);
    mod.writeUiBuilderStoredLayout('preview', imported.layout);
    mod.activateUiBuilderLayout(imported.layout);

    const draftKey = mod.uiBuilderLayoutStorageKey('draft', 'HOME', 'mobile');
    const previewKey = mod.uiBuilderLayoutStorageKey('preview', 'HOME', 'mobile');
    const activeMobileKey = mod.uiBuilderLayoutStorageKey('active', 'HOME', 'mobile');
    const activeDesktopKey = mod.uiBuilderLayoutStorageKey('active', 'HOME', 'desktop');
    const activeMobile = mod.loadActiveUiBuilderLayout('HOME', 'mobile');
    const activeDesktopBefore = mod.loadActiveUiBuilderLayout('HOME', 'desktop');

    const desktop = mod.makeFrozenUiBuilderTemplate('HOME', 'desktop');
    desktop.layoutId = 'e2e-home-desktop';
    mod.activateUiBuilderLayout(desktop);
    const activeDesktopAfter = mod.loadActiveUiBuilderLayout('HOME', 'desktop');

    const invalid = structuredClone(mobile);
    invalid.layoutId = 'must-not-activate';
    invalid.blocks[1].props.subtitle = '/api/private/orders';
    let invalidRejected = false;
    try {
      mod.activateUiBuilderLayout(invalid);
    } catch {
      invalidRejected = true;
    }
    const mobileAfterInvalid = mod.loadActiveUiBuilderLayout('HOME', 'mobile');

    const scanner = mod.makeFrozenUiBuilderTemplate('SIGNAL_SCANNER', 'mobile');
    scanner.layoutId = 'e2e-signal-scanner-mobile';
    mod.activateUiBuilderLayout(scanner);
    const phase1ScannerKey = 'stock-ui-builder:published-layout:SIGNAL_SCANNER:mobile';
    const phase1ScannerValue = window.localStorage.getItem(phase1ScannerKey);
    const genericScannerKey = mod.uiBuilderLayoutStorageKey('active', 'SIGNAL_SCANNER', 'mobile');
    const genericScannerValue = window.localStorage.getItem(genericScannerKey);
    mod.clearUiBuilderStoredLayout('active', 'SIGNAL_SCANNER', 'mobile');

    return {
      draftStored: window.localStorage.getItem(draftKey) !== null,
      previewStored: window.localStorage.getItem(previewKey) !== null,
      activeMobileStored: window.localStorage.getItem(activeMobileKey) !== null,
      activeDesktopStored: window.localStorage.getItem(activeDesktopKey) !== null,
      activeMobileSource: activeMobile.source,
      activeMobileLayoutId: activeMobile.layout.layoutId,
      activeDesktopBeforeSource: activeDesktopBefore.source,
      activeDesktopAfterSource: activeDesktopAfter.source,
      activeDesktopLayoutId: activeDesktopAfter.layout.layoutId,
      invalidRejected,
      mobileLayoutAfterInvalid: mobileAfterInvalid.layout.layoutId,
      scannerPhase1Bridge: phase1ScannerValue ? JSON.parse(phase1ScannerValue).layoutId : null,
      scannerGenericBridge: genericScannerValue ? JSON.parse(genericScannerValue).layoutId : null,
      scannerPhase1Cleared: window.localStorage.getItem(phase1ScannerKey) === null,
      scannerGenericCleared: window.localStorage.getItem(genericScannerKey) === null,
    };
  });

  expect(result.draftStored).toBe(true);
  expect(result.previewStored).toBe(true);
  expect(result.activeMobileStored).toBe(true);
  expect(result.activeMobileSource).toBe('active');
  expect(result.activeMobileLayoutId).toBe('e2e-home-mobile');
  expect(result.activeDesktopBeforeSource).toBe('fallback');
  expect(result.activeDesktopStored).toBe(true);
  expect(result.activeDesktopAfterSource).toBe('active');
  expect(result.activeDesktopLayoutId).toBe('e2e-home-desktop');
  expect(result.invalidRejected).toBe(true);
  expect(result.mobileLayoutAfterInvalid).toBe('e2e-home-mobile');
  expect(result.scannerPhase1Bridge).toBe('e2e-signal-scanner-mobile');
  expect(result.scannerGenericBridge).toBe('e2e-signal-scanner-mobile');
  expect(result.scannerPhase1Cleared).toBe(true);
  expect(result.scannerGenericCleared).toBe(true);
  expect(forbidden).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
