import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAVIGATION } from '../src/lib/app-navigation';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const technicalWorkspaceSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/technical-workspace.tsx'),
  'utf8',
);
const responsiveTabsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/responsive-tabs.tsx'),
  'utf8',
);
const memberAccessSource = fs.readFileSync(
  path.resolve(process.cwd(), '../packages/member-access/src/index.js'),
  'utf8',
);

function technicalItem(id: string) {
  const group = APP_NAVIGATION.find((item) => item.id === 'technical');
  const item = group?.menu?.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing technical menu item: ${id}`);
  return item;
}

test('associate scanner access uses the unified workspace while advanced capabilities stay fail closed', () => {
  const associateBlock = memberAccessSource.match(/const ASSOCIATE = Object\.freeze\(\{([\s\S]*?)\}\);\nconst REGULAR/)?.[1] ?? '';
  expect(associateBlock).toContain('canAccessBasicInfo: true');
  expect(associateBlock).toContain('canAccessSpot: true');
  expect(associateBlock).not.toContain('canAccessFutures: true');
  expect(associateBlock).not.toContain('canAccessRiskPreview: true');
  expect(associateBlock).not.toContain('canPlaceOrders: true');

  expect(technicalItem('scanner').capability).toBe('canAccessBasicInfo');
  expect(technicalItem('ai-chart').capability).toBe('canAccessRiskPreview');
  expect(technicalItem('auto-trading').capability).toBe('canPlaceOrders');

  expect(appSource).toContain("return gated('canAccessBasicInfo', <TechnicalWorkspacePage />);");
  expect(appSource).not.toContain('function BasicScannerWorkspace()');
  expect(appSource).not.toContain('scanner-workspace-basic');

  expect(technicalWorkspaceSource).toContain("const canAccessRiskPreview = phase11FullCapabilityFixture || auth.can('canAccessRiskPreview')");
  expect(technicalWorkspaceSource).toContain("const canAccessBacktests = phase11FullCapabilityFixture || auth.can('canAccessBacktests')");
  expect(technicalWorkspaceSource).toContain("const canPlaceOrders = phase11FullCapabilityFixture || auth.can('canPlaceOrders')");
  expect(technicalWorkspaceSource).toContain('if (!canAccessRiskPreview)');
  expect(technicalWorkspaceSource).toContain("import.meta.env.VITE_PHASE11_E2E === 'true'");
  expect(technicalWorkspaceSource).toContain("location.startsWith('/__phase11-technical-workspace-e2e')");

  expect(responsiveTabsSource).toContain('aria-disabled={option.disabled || undefined}');
  expect(responsiveTabsSource).toContain('disabled={option.disabled}');
  expect(responsiveTabsSource).toContain("{option.label}{option.disabled ? ' · 잠김' : ''}");

  const aiChartAccess = appSource.match(/function AiChartAccess\(\) \{([^\n]+)\}/)?.[1] ?? '';
  expect(aiChartAccess).toContain("gated('canAccessRiskPreview'");
  expect(aiChartAccess).toContain("builder('AI_CHART', <AiChartPage />)");

  const autoTradingAccess = appSource.match(/function AutoTradingAccess\(\) \{([^\n]+)\}/)?.[1] ?? '';
  expect(autoTradingAccess).toContain("gated('canPlaceOrders'");
  expect(autoTradingAccess).toContain("builder('AUTO_TRADING', <AutoTradingPage />)");
});
