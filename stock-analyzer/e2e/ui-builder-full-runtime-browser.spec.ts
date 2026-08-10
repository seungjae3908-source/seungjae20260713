import { expect, test } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

test('UI Builder full runtime flow is persistent, isolated, versioned and fail-closed', async ({ page }) => {
  const forbidden: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenRequest.test(path)) forbidden.push(path);
  });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/__phase11-unified-search-e2e');

  const first = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/lib/ui-builder-full-layout.ts') as any;
    const importer = await import(/* @vite-ignore */ '/src/lib/ui-builder-layout-import.ts') as any;
    const versions = await import(/* @vite-ignore */ '/src/lib/ui-builder-layout-versions.ts') as any;

    const mobile = mod.makeFrozenUiBuilderTemplate('HOME', 'mobile');
    mobile.layoutId = 'e2e-home-mobile-v1';
    mobile.blocks[1].props.title = '브라우저 파일 Import 검증';

    const file = new File([JSON.stringify(mobile)], 'home-mobile.json', { type: 'application/json' });
    const imported = await importer.importUiBuilderLayoutFile(file, 'HOME', 'mobile');
    if (!imported.valid || !imported.layout) throw new Error('valid HOME/mobile file import rejected');

    mod.writeUiBuilderStoredLayout('draft', imported.layout);
    mod.writeUiBuilderStoredLayout('preview', imported.layout);
    const v1 = versions.activateUiBuilderLayoutVersion(imported.layout);

    const v2Input = structuredClone(v1);
    v2Input.layoutId = 'e2e-home-mobile-v2';
    v2Input.blocks[1].props.title = '두 번째 활성 Layout';
    const v2 = versions.activateUiBuilderLayoutVersion(v2Input);
    const rolled = versions.rollbackUiBuilderLayoutVersion('HOME', 'mobile', v1.version);

    const activeMobile = mod.loadActiveUiBuilderLayout('HOME', 'mobile');
    const activeDesktopBefore = mod.loadActiveUiBuilderLayout('HOME', 'desktop');

    const desktop = mod.makeFrozenUiBuilderTemplate('HOME', 'desktop');
    desktop.layoutId = 'e2e-home-desktop';
    versions.activateUiBuilderLayoutVersion(desktop);
    const activeDesktopAfter = mod.loadActiveUiBuilderLayout('HOME', 'desktop');

    const invalidApi = structuredClone(mobile);
    invalidApi.layoutId = 'must-not-activate-api';
    invalidApi.blocks[1].props.subtitle = '/api/private/orders';
    let invalidApiRejected = false;
    try { versions.activateUiBuilderLayoutVersion(invalidApi); } catch { invalidApiRejected = true; }

    const invalidSecret = structuredClone(mobile);
    invalidSecret.layoutId = 'must-not-activate-secret';
    invalidSecret.blocks[1].props.subtitle = 'Bearer super-secret-token-value';
    let invalidSecretRejected = false;
    try { versions.activateUiBuilderLayoutVersion(invalidSecret); } catch { invalidSecretRejected = true; }

    const mobileAfterInvalid = mod.loadActiveUiBuilderLayout('HOME', 'mobile');

    const scanner = mod.makeFrozenUiBuilderTemplate('SIGNAL_SCANNER', 'mobile');
    scanner.layoutId = 'e2e-signal-scanner-mobile';
    versions.activateUiBuilderLayoutVersion(scanner);
    const phase1ScannerKey = 'stock-ui-builder:published-layout:SIGNAL_SCANNER:mobile';
    const genericScannerKey = mod.uiBuilderLayoutStorageKey('active', 'SIGNAL_SCANNER', 'mobile');
    const phase1ScannerValue = window.localStorage.getItem(phase1ScannerKey);
    const genericScannerValue = window.localStorage.getItem(genericScannerKey);
    mod.clearUiBuilderStoredLayout('active', 'SIGNAL_SCANNER', 'mobile');

    const restored = versions.restoreDefaultUiBuilderLayout('PORTFOLIO', 'mobile');
    const restoredActive = mod.loadActiveUiBuilderLayout('PORTFOLIO', 'mobile');
    mod.clearUiBuilderStoredLayout('active', 'PORTFOLIO', 'mobile');
    const fallbackAfterDeactivate = mod.loadActiveUiBuilderLayout('PORTFOLIO', 'mobile');

    const history = versions.readUiBuilderLayoutVersions('HOME', 'mobile');
    return {
      importedTitle: imported.layout.blocks[1].props.title,
      v1: v1.version,
      v2: v2.version,
      rolledVersion: rolled.version,
      rolledTitle: rolled.blocks[1].props.title,
      historyVersions: history.map((record: any) => record.version),
      draftStored: window.localStorage.getItem(mod.uiBuilderLayoutStorageKey('draft', 'HOME', 'mobile')) !== null,
      previewStored: window.localStorage.getItem(mod.uiBuilderLayoutStorageKey('preview', 'HOME', 'mobile')) !== null,
      activeMobileSource: activeMobile.source,
      activeMobileLayoutId: activeMobile.layout.layoutId,
      activeDesktopBeforeSource: activeDesktopBefore.source,
      activeDesktopAfterSource: activeDesktopAfter.source,
      activeDesktopLayoutId: activeDesktopAfter.layout.layoutId,
      invalidApiRejected,
      invalidSecretRejected,
      mobileLayoutAfterInvalid: mobileAfterInvalid.layout.layoutId,
      scannerPhase1Bridge: phase1ScannerValue ? JSON.parse(phase1ScannerValue).layoutId : null,
      scannerGenericBridge: genericScannerValue ? JSON.parse(genericScannerValue).layoutId : null,
      scannerPhase1Cleared: window.localStorage.getItem(phase1ScannerKey) === null,
      scannerGenericCleared: window.localStorage.getItem(genericScannerKey) === null,
      restoredVersion: restored.version,
      restoredActiveSource: restoredActive.source,
      fallbackAfterDeactivateSource: fallbackAfterDeactivate.source,
    };
  });

  expect(first.importedTitle).toBe('브라우저 파일 Import 검증');
  expect(first.v1).toBe(1);
  expect(first.v2).toBe(2);
  expect(first.rolledVersion).toBe(3);
  expect(first.rolledTitle).toBe('브라우저 파일 Import 검증');
  expect(first.historyVersions).toEqual([3, 2, 1]);
  expect(first.draftStored).toBe(true);
  expect(first.previewStored).toBe(true);
  expect(first.activeMobileSource).toBe('active');
  expect(first.activeMobileLayoutId).toContain('rollback');
  expect(first.activeDesktopBeforeSource).toBe('fallback');
  expect(first.activeDesktopAfterSource).toBe('active');
  expect(first.activeDesktopLayoutId).toBe('e2e-home-desktop');
  expect(first.invalidApiRejected).toBe(true);
  expect(first.invalidSecretRejected).toBe(true);
  expect(first.mobileLayoutAfterInvalid).toContain('rollback');
  expect(first.scannerPhase1Bridge).toBe('e2e-signal-scanner-mobile');
  expect(first.scannerGenericBridge).toBe('e2e-signal-scanner-mobile');
  expect(first.scannerPhase1Cleared).toBe(true);
  expect(first.scannerGenericCleared).toBe(true);
  expect(first.restoredVersion).toBe(1);
  expect(first.restoredActiveSource).toBe('active');
  expect(first.fallbackAfterDeactivateSource).toBe('fallback');

  await page.reload();
  const afterReload = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/lib/ui-builder-full-layout.ts') as any;
    const versions = await import(/* @vite-ignore */ '/src/lib/ui-builder-layout-versions.ts') as any;
    const mobile = mod.loadActiveUiBuilderLayout('HOME', 'mobile');
    const desktop = mod.loadActiveUiBuilderLayout('HOME', 'desktop');
    return {
      mobileSource: mobile.source,
      mobileTitle: mobile.layout.blocks[1].props.title,
      desktopSource: desktop.source,
      desktopLayoutId: desktop.layout.layoutId,
      history: versions.readUiBuilderLayoutVersions('HOME', 'mobile').map((record: any) => record.version),
    };
  });

  expect(afterReload.mobileSource).toBe('active');
  expect(afterReload.mobileTitle).toBe('브라우저 파일 Import 검증');
  expect(afterReload.desktopSource).toBe('active');
  expect(afterReload.desktopLayoutId).toBe('e2e-home-desktop');
  expect(afterReload.history).toEqual([3, 2, 1]);
  expect(forbidden).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
