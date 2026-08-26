import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAdaptiveViewport,
  isDesktopWorkspaceWidth,
  uiBuilderDeviceForWidth,
} from './adaptive-layout';

test('adaptive viewport classes cover phone, fold, tablet, and desktop widths without gaps', () => {
  assert.equal(classifyAdaptiveViewport(320), 'compact');
  assert.equal(classifyAdaptiveViewport(359), 'compact');
  assert.equal(classifyAdaptiveViewport(360), 'phone');
  assert.equal(classifyAdaptiveViewport(599), 'phone');
  assert.equal(classifyAdaptiveViewport(600), 'medium');
  assert.equal(classifyAdaptiveViewport(899), 'medium');
  assert.equal(classifyAdaptiveViewport(900), 'tablet');
  assert.equal(classifyAdaptiveViewport(1199), 'tablet');
  assert.equal(classifyAdaptiveViewport(1200), 'desktop');
  assert.equal(classifyAdaptiveViewport(1440), 'desktop');
});

test('fold-open and tablet widths keep the touch UI Builder snapshot', () => {
  for (const width of [600, 720, 768, 800, 900, 1024, 1180, 1199]) {
    assert.equal(uiBuilderDeviceForWidth(width), 'mobile');
    assert.equal(isDesktopWorkspaceWidth(width), false);
  }
  assert.equal(uiBuilderDeviceForWidth(1200), 'desktop');
  assert.equal(isDesktopWorkspaceWidth(1200), true);
});

test('invalid widths fail safely into the most compact layout', () => {
  assert.equal(classifyAdaptiveViewport(Number.NaN), 'compact');
  assert.equal(classifyAdaptiveViewport(-1), 'compact');
});
