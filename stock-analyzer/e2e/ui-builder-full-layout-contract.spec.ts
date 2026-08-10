import { expect, test } from '@playwright/test';
import {
  UI_BUILDER_PAGE_IDS,
  UI_BUILDER_STABLE_SHA,
  UI_BUILDER_STABLE_TREE,
  makeFrozenUiBuilderTemplate,
  parseAndValidateUiBuilderLayout,
  uiBuilderLayoutStorageKey,
  uiBuilderTemplateCoverage,
  validateUiBuilderFullLayout,
} from '../src/lib/ui-builder-full-layout';

test('full integration pins frozen Builder baseline and all 14 PageIds', () => {
  expect(UI_BUILDER_STABLE_SHA).toBe('c98915da80c57a02c7e037522f6ae7dabd07664d');
  expect(UI_BUILDER_STABLE_TREE).toBe('43cd3798164f709786281b7f85acd68b0c9d9095');
  expect(UI_BUILDER_PAGE_IDS).toHaveLength(14);
  expect(uiBuilderTemplateCoverage()).toHaveLength(14);
});

test('every frozen mobile and desktop template validates fail-closed', () => {
  for (const pageId of UI_BUILDER_PAGE_IDS) {
    for (const device of ['mobile', 'desktop'] as const) {
      const layout = makeFrozenUiBuilderTemplate(pageId, device);
      const result = validateUiBuilderFullLayout(layout, pageId, device);
      expect(result.valid, `${pageId}/${device}: ${JSON.stringify(result.issues)}`).toBe(true);
      expect(layout.pageId).toBe(pageId);
      expect(layout.deviceClass).toBe(device);
      expect(layout.blocks.some((block) => block.type === 'PageHeader')).toBe(true);
    }
  }
});

test('Draft Preview Active storage namespaces are page and device isolated', () => {
  const keys = new Set<string>();
  for (const status of ['draft', 'preview', 'active'] as const) {
    for (const pageId of UI_BUILDER_PAGE_IDS) {
      for (const device of ['mobile', 'desktop'] as const) {
        const key = uiBuilderLayoutStorageKey(status, pageId, device);
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(key).toContain(pageId);
        expect(key).toContain(device);
        expect(key).not.toMatch(/https?:|\/api\//);
      }
    }
  }
  expect(keys.size).toBe(14 * 2 * 3);
});

test('invalid JSON schema page device and unknown components are rejected', () => {
  const invalidJson = parseAndValidateUiBuilderLayout('{broken', 'HOME', 'mobile');
  expect(invalidJson.valid).toBe(false);
  expect(invalidJson.issues.some((issue) => issue.code === 'INVALID_JSON')).toBe(true);

  const wrongSchema = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
  wrongSchema.schemaVersion = 2;
  expect(validateUiBuilderFullLayout(wrongSchema, 'HOME', 'mobile').issues.some((issue) => issue.code === 'UNSUPPORTED_SCHEMA_VERSION')).toBe(true);

  const wrongPage = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
  wrongPage.pageId = 'PORTFOLIO';
  expect(validateUiBuilderFullLayout(wrongPage, 'HOME', 'mobile').issues.some((issue) => issue.code === 'PAGE_ID_MISMATCH')).toBe(true);

  expect(validateUiBuilderFullLayout(makeFrozenUiBuilderTemplate('HOME', 'mobile'), 'HOME', 'desktop').issues.some((issue) => issue.code === 'DEVICE_CLASS_MISMATCH')).toBe(true);

  const unknown = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
  unknown.blocks[1].type = 'ArbitraryRuntimeWidget';
  expect(validateUiBuilderFullLayout(unknown, 'HOME', 'mobile').issues.some((issue) => issue.code === 'UNKNOWN_COMPONENT')).toBe(true);
});

test('forbidden runtime binding URL API script secret and arbitrary actions are rejected', () => {
  const prop = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
  prop.blocks[1].props.endpoint = '/api/private/orders';
  expect(validateUiBuilderFullLayout(prop, 'HOME', 'mobile').issues.some((issue) => issue.code === 'FORBIDDEN_RUNTIME_PROP')).toBe(true);

  for (const value of ['https://broker.example/private', '/api/private/orders', 'javascript:alert(1)', 'Bearer super-secret-token-value']) {
    const layout = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
    layout.blocks[1].props.subtitle = value;
    const result = validateUiBuilderFullLayout(layout, 'HOME', 'mobile');
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => ['URL_API_BINDING_REJECTED', 'SECRET_TOKEN_REJECTED'].includes(issue.code))).toBe(true);
  }

  const arbitrary = structuredClone(makeFrozenUiBuilderTemplate('HOME', 'mobile')) as any;
  arbitrary.blocks[1].actionId = 'POST_ORDER_NOW';
  expect(validateUiBuilderFullLayout(arbitrary, 'HOME', 'mobile').issues.some((issue) => issue.code === 'ARBITRARY_ACTION_REJECTED')).toBe(true);
});

test('required headers and AUTO_TRADING EmergencyStop cannot be removed or hidden', () => {
  for (const pageId of UI_BUILDER_PAGE_IDS) {
    const removed = structuredClone(makeFrozenUiBuilderTemplate(pageId, 'mobile'));
    removed.blocks = removed.blocks.filter((block) => block.type !== 'PageHeader');
    expect(validateUiBuilderFullLayout(removed, pageId, 'mobile').issues.some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING')).toBe(true);
  }

  const automation = structuredClone(makeFrozenUiBuilderTemplate('AUTO_TRADING', 'mobile'));
  const emergency = automation.blocks.find((block) => block.type === 'EmergencyStop');
  expect(emergency).toBeTruthy();
  emergency!.visibility.hidden = true;
  expect(validateUiBuilderFullLayout(automation, 'AUTO_TRADING', 'mobile').issues.some((issue) => issue.code === 'REQUIRED_BLOCK_MISSING')).toBe(true);
});

test('fixed trade-review action cannot be changed', () => {
  const detail = structuredClone(makeFrozenUiBuilderTemplate('ASSET_DETAIL', 'mobile'));
  const trade = detail.blocks.find((block) => block.type === 'TradeReviewButton');
  expect(trade).toBeTruthy();
  trade!.actionId = 'LIVE_ORDER';
  expect(validateUiBuilderFullLayout(detail, 'ASSET_DETAIL', 'mobile').issues.some((issue) => issue.code === 'SAFE_ACTION_MUTATION_REJECTED')).toBe(true);
});
