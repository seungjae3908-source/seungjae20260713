import { expect, test } from '@playwright/test';
import {
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
  UI_BUILDER_BLOCK_TYPES,
  UI_BUILDER_REGISTRY_MAPPING,
  UI_BUILDER_STABLE_SHA,
  UI_BUILDER_STABLE_TREE,
  loadUiBuilderSignalScannerLayout,
  registryMappingCounts,
  scannerSurfacePlan,
  validateUiBuilderSignalScannerLayout,
} from '../src/lib/ui-builder-layout';

test('UI Builder integration contract pins frozen baseline and maps all 46 blocks', () => {
  expect(UI_BUILDER_STABLE_SHA).toBe('c98915da80c57a02c7e037522f6ae7dabd07664d');
  expect(UI_BUILDER_STABLE_TREE).toBe('43cd3798164f709786281b7f85acd68b0c9d9095');
  expect(UI_BUILDER_BLOCK_TYPES).toHaveLength(46);
  expect(Object.keys(UI_BUILDER_REGISTRY_MAPPING)).toHaveLength(46);

  const counts = registryMappingCounts();
  expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(46);
  expect(counts.MOCK_ONLY).toBe(0);
  expect(counts.MISSING).toBe(0);
  expect(counts.FORBIDDEN_RUNTIME_BINDING).toBe(0);
});

test('valid mobile and desktop layouts stay device-isolated and reuse existing surfaces', () => {
  const mobile = validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile, 'mobile');
  const desktop = validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop, 'desktop');
  expect(mobile.valid).toBe(true);
  expect(desktop.valid).toBe(true);

  expect(scannerSurfacePlan(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile).map((item) => item.surface))
    .toEqual(['scanner', 'position', 'trade-review']);
  expect(scannerSurfacePlan(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop).map((item) => item.surface))
    .toEqual(['scanner', 'chart', 'position', 'trade-review']);

  const mobileLoaded = loadUiBuilderSignalScannerLayout(
    JSON.stringify(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile),
    'mobile',
    SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile,
  );
  const desktopLoaded = loadUiBuilderSignalScannerLayout(
    JSON.stringify(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop),
    'desktop',
    SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop,
  );
  expect(mobileLoaded.source).toBe('builder');
  expect(desktopLoaded.source).toBe('builder');
  mobileLoaded.layout.blocks[0].props.title = '모바일 전용 변경';
  expect(desktopLoaded.layout.blocks[0].props.title).not.toBe('모바일 전용 변경');
});

test('invalid JSON, unsupported schema, unknown blocks, and device mismatch fail closed', () => {
  const fallback = loadUiBuilderSignalScannerLayout(
    '{broken',
    'mobile',
    SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile,
  );
  expect(fallback.source).toBe('fallback');
  expect(fallback.issues.some((issue) => issue.code === 'INVALID_JSON')).toBe(true);

  const unsupported = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  unsupported.schemaVersion = 2;
  expect(validateUiBuilderSignalScannerLayout(unsupported, 'mobile').issues
    .some((issue) => issue.code === 'UNSUPPORTED_SCHEMA_VERSION')).toBe(true);

  const unknown = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  unknown.blocks[1].type = 'ArbitraryHtml';
  expect(validateUiBuilderSignalScannerLayout(unknown, 'mobile').issues
    .some((issue) => issue.code === 'UNKNOWN_COMPONENT')).toBe(true);

  expect(validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile, 'desktop').issues
    .some((issue) => issue.code === 'DEVICE_CLASS_MISMATCH')).toBe(true);
});

test('required safety block protection rejects hidden or removed PageHeader', () => {
  const hidden = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  hidden.blocks[0].visibility.hidden = true;
  expect(validateUiBuilderSignalScannerLayout(hidden, 'mobile').issues
    .some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING')).toBe(true);

  const removed = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  removed.blocks = removed.blocks.filter((block) => block.type !== 'PageHeader');
  expect(validateUiBuilderSignalScannerLayout(removed, 'mobile').issues
    .some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING')).toBe(true);
});

test('forbidden runtime props, URLs, private API paths, and secret tokens are rejected', () => {
  const endpoint = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  endpoint.blocks[1].props.endpoint = '/api/private/orders';
  expect(validateUiBuilderSignalScannerLayout(endpoint, 'mobile').issues
    .some((issue) => issue.code === 'FORBIDDEN_RUNTIME_PROP')).toBe(true);

  const url = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  url.blocks[1].props.subtitle = 'https://broker.example/private';
  expect(validateUiBuilderSignalScannerLayout(url, 'mobile').issues
    .some((issue) => issue.code === 'URL_API_BINDING_REJECTED')).toBe(true);

  const apiPath = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  apiPath.blocks[1].props.subtitle = '/api/private/orders';
  expect(validateUiBuilderSignalScannerLayout(apiPath, 'mobile').issues
    .some((issue) => issue.code === 'URL_API_BINDING_REJECTED')).toBe(true);

  const secret = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  secret.blocks[1].props.subtitle = 'Bearer super-secret-token-value';
  expect(validateUiBuilderSignalScannerLayout(secret, 'mobile').issues
    .some((issue) => issue.code === 'SECRET_TOKEN_REJECTED')).toBe(true);
});

test('trade review action cannot be mutated and scanner logic remains owned by existing surfaces', () => {
  const mutated = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  const review = mutated.blocks.find((block) => block.type === 'TradeReviewButton');
  expect(review).toBeTruthy();
  review!.actionId = 'POST_ORDER_NOW';
  expect(validateUiBuilderSignalScannerLayout(mutated, 'mobile').issues
    .some((issue) => issue.code === 'SAFE_ACTION_MUTATION_REJECTED')).toBe(true);

  for (const type of ['MarketSelector', 'StrategySelector', 'TimeframeSelector', 'DirectionSelector', 'SignalSummary', 'SignalList'] as const) {
    expect(UI_BUILDER_REGISTRY_MAPPING[type].scannerSurface).toBe('scanner');
    expect(UI_BUILDER_REGISTRY_MAPPING[type].target).toContain('SignalScannerPage');
  }
  expect(UI_BUILDER_REGISTRY_MAPPING.TradeReviewButton.target).toBe('ScannerApprovalComposer');
  expect(UI_BUILDER_REGISTRY_MAPPING.TradeReviewButton.scannerSurface).toBe('trade-review');
});
