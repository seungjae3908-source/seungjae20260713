import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_BUILDER_BLOCK_TYPES,
  UI_BUILDER_REGISTRY_MAPPING,
  UI_BUILDER_SCHEMA_VERSION,
  UI_BUILDER_STABLE_SHA,
  UI_BUILDER_STABLE_TREE,
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
  loadUiBuilderSignalScannerLayout,
  registryMappingCounts,
  scannerSurfacePlan,
  signalScannerLayoutHasUnsupportedRuntimeBlocks,
  signalScannerPublishedLayoutStorageKey,
  validateUiBuilderSignalScannerLayout,
} from './ui-builder-layout';

test('integration pins the immutable Builder contract and maps all 46 blocks', () => {
  assert.equal(UI_BUILDER_STABLE_SHA, 'c98915da80c57a02c7e037522f6ae7dabd07664d');
  assert.equal(UI_BUILDER_STABLE_TREE, '43cd3798164f709786281b7f85acd68b0c9d9095');
  assert.equal(UI_BUILDER_SCHEMA_VERSION, 1);
  assert.equal(UI_BUILDER_BLOCK_TYPES.length, 46);
  assert.equal(Object.keys(UI_BUILDER_REGISTRY_MAPPING).length, 46);

  const counts = registryMappingCounts();
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 46);
  assert.equal(counts.MOCK_ONLY, 0);
  assert.equal(counts.MISSING, 0);
  assert.equal(counts.FORBIDDEN_RUNTIME_BINDING, 0);
});

test('mobile and desktop integration layouts validate independently', () => {
  const mobile = validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile, 'mobile');
  const desktop = validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop, 'desktop');
  assert.equal(mobile.valid, true, JSON.stringify(mobile.issues));
  assert.equal(desktop.valid, true, JSON.stringify(desktop.issues));
  assert.notEqual(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile.layoutId, SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop.layoutId);
  assert.deepEqual(signalScannerLayoutHasUnsupportedRuntimeBlocks(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile), []);
  assert.deepEqual(signalScannerLayoutHasUnsupportedRuntimeBlocks(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop), []);
});

test('invalid JSON falls back without throwing', () => {
  const fallback = SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile;
  const result = loadUiBuilderSignalScannerLayout('{broken', 'mobile', fallback);
  assert.equal(result.source, 'fallback');
  assert.equal(result.layout.layoutId, fallback.layoutId);
  assert.ok(result.issues.some((issue) => issue.code === 'INVALID_JSON'));
});

test('unsupported schema and device mismatch are rejected', () => {
  const wrongSchema = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  wrongSchema.schemaVersion = 2;
  const schemaResult = validateUiBuilderSignalScannerLayout(wrongSchema, 'mobile');
  assert.equal(schemaResult.valid, false);
  assert.ok(schemaResult.issues.some((issue) => issue.code === 'UNSUPPORTED_SCHEMA_VERSION'));

  const deviceResult = validateUiBuilderSignalScannerLayout(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile, 'desktop');
  assert.equal(deviceResult.valid, false);
  assert.ok(deviceResult.issues.some((issue) => issue.code === 'DEVICE_CLASS_MISMATCH'));
});

test('unknown block and duplicate identifiers are rejected', () => {
  const unknown = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  unknown.blocks[1].type = 'ArbitraryHtml';
  const unknownResult = validateUiBuilderSignalScannerLayout(unknown, 'mobile');
  assert.equal(unknownResult.valid, false);
  assert.ok(unknownResult.issues.some((issue) => issue.code === 'UNKNOWN_COMPONENT'));

  const duplicate = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  duplicate.blocks[1].id = duplicate.blocks[0].id;
  const duplicateResult = validateUiBuilderSignalScannerLayout(duplicate, 'mobile');
  assert.equal(duplicateResult.valid, false);
  assert.ok(duplicateResult.issues.some((issue) => issue.code === 'DUPLICATE_BLOCK_ID'));
});

test('required PageHeader cannot be hidden or removed', () => {
  const hidden = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  hidden.blocks[0].visibility.hidden = true;
  const hiddenResult = validateUiBuilderSignalScannerLayout(hidden, 'mobile');
  assert.equal(hiddenResult.valid, false);
  assert.ok(hiddenResult.issues.some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING'));

  const removed = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  removed.blocks = removed.blocks.filter((block) => block.type !== 'PageHeader');
  const removedResult = validateUiBuilderSignalScannerLayout(removed, 'mobile');
  assert.equal(removedResult.valid, false);
  assert.ok(removedResult.issues.some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING'));
});

test('forbidden runtime props, URLs, API paths, and secret tokens are rejected', () => {
  const endpoint = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  endpoint.blocks[1].props.endpoint = '/api/private/orders';
  let result = validateUiBuilderSignalScannerLayout(endpoint, 'mobile');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'FORBIDDEN_RUNTIME_PROP'));

  const url = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  url.blocks[1].props.subtitle = 'https://broker.example/private';
  result = validateUiBuilderSignalScannerLayout(url, 'mobile');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'URL_API_BINDING_REJECTED'));

  const token = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  token.blocks[1].props.subtitle = 'Bearer super-secret-token-value';
  result = validateUiBuilderSignalScannerLayout(token, 'mobile');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'SECRET_TOKEN_REJECTED'));
});

test('safe trade action identifiers cannot be changed or added arbitrarily', () => {
  const changed = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  const review = changed.blocks.find((block) => block.type === 'TradeReviewButton');
  assert.ok(review);
  review.actionId = 'POST_ORDER_NOW';
  let result = validateUiBuilderSignalScannerLayout(changed, 'mobile');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'SAFE_ACTION_MUTATION_REJECTED'));

  const arbitrary = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  arbitrary.blocks[1].actionId = 'CUSTOM_CALLBACK';
  result = validateUiBuilderSignalScannerLayout(arbitrary, 'mobile');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'ARBITRARY_ACTION_REJECTED'));
});

test('layout loader returns clones so mobile edits cannot overwrite desktop state', () => {
  const mobile = loadUiBuilderSignalScannerLayout(
    JSON.stringify(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile),
    'mobile',
    SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile,
  );
  const desktop = loadUiBuilderSignalScannerLayout(
    JSON.stringify(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop),
    'desktop',
    SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop,
  );
  assert.equal(mobile.source, 'builder');
  assert.equal(desktop.source, 'builder');

  mobile.layout.blocks[0].props.title = '모바일 전용 변경';
  assert.notEqual(desktop.layout.blocks[0].props.title, '모바일 전용 변경');
  assert.equal(desktop.layout.deviceClass, 'desktop');
});

test('scanner surface plan reuses existing scanner/chart/position/trade-review composites', () => {
  const mobilePlan = scannerSurfacePlan(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile);
  assert.deepEqual(mobilePlan.map((item) => item.surface), ['scanner', 'position', 'trade-review']);
  assert.ok(mobilePlan.every((item) => item.colSpan === 12));

  const desktopPlan = scannerSurfacePlan(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop);
  assert.deepEqual(desktopPlan.map((item) => item.surface), ['scanner', 'chart', 'position', 'trade-review']);
  assert.equal(desktopPlan.find((item) => item.surface === 'scanner')?.colSpan, 4);
  assert.equal(desktopPlan.find((item) => item.surface === 'chart')?.colSpan, 5);
  assert.equal(desktopPlan.find((item) => item.surface === 'position')?.colSpan, 3);
  assert.equal(desktopPlan.find((item) => item.surface === 'trade-review')?.colSpan, 3);
});

test('published layout storage is device isolated and contains no endpoint', () => {
  const mobileKey = signalScannerPublishedLayoutStorageKey('mobile');
  const desktopKey = signalScannerPublishedLayoutStorageKey('desktop');
  assert.notEqual(mobileKey, desktopKey);
  assert.match(mobileKey, /SIGNAL_SCANNER:mobile$/);
  assert.doesNotMatch(mobileKey, /https?:|\/api\//);
});

test('Phase 1 mapping keeps scanner business logic and trade approval ownership in existing components', () => {
  const scannerTypes = ['MarketSelector', 'StrategySelector', 'TimeframeSelector', 'DirectionSelector', 'SignalSummary', 'SignalList'] as const;
  for (const type of scannerTypes) {
    assert.equal(UI_BUILDER_REGISTRY_MAPPING[type].scannerSurface, 'scanner');
    assert.match(UI_BUILDER_REGISTRY_MAPPING[type].target, /SignalScannerPage/);
  }
  assert.equal(UI_BUILDER_REGISTRY_MAPPING.AiChart.target, 'AiChartPage / UnifiedAnalysisChart');
  assert.equal(UI_BUILDER_REGISTRY_MAPPING.PositionSummary.target, 'getPortfolioChartOverlay / PortfolioPage');
  assert.equal(UI_BUILDER_REGISTRY_MAPPING.PositionSummary.scannerSurface, 'position');
  assert.equal(UI_BUILDER_REGISTRY_MAPPING.TradeReviewButton.target, 'ScannerApprovalComposer');
  assert.equal(UI_BUILDER_REGISTRY_MAPPING.TradeReviewButton.scannerSurface, 'trade-review');
});
