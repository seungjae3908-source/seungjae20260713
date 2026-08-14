import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAVIGATION } from '../src/lib/app-navigation';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
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

test('associate scanner access stays isolated while preserving canonical scanner navigation', () => {
  const associateBlock = memberAccessSource.match(/const ASSOCIATE = Object\.freeze\(\{([\s\S]*?)\}\);\nconst REGULAR/)?.[1] ?? '';
  expect(associateBlock).toContain('canAccessBasicInfo: true');
  expect(associateBlock).toContain('canAccessSpot: true');
  expect(associateBlock).not.toContain('canAccessFutures: true');
  expect(associateBlock).not.toContain('canAccessRiskPreview: true');
  expect(associateBlock).not.toContain('canPlaceOrders: true');

  expect(technicalItem('scanner').capability).toBe('canAccessBasicInfo');
  expect(technicalItem('ai-chart').capability).toBe('canAccessRiskPreview');
  expect(technicalItem('auto-trading').capability).toBe('canPlaceOrders');

  expect(appSource).toContain("const SignalScannerPage = lazy(() => import('@/pages/signal-scanner')); ".trim());
  expect(appSource).toContain('function BasicScannerWorkspace()');
  expect(appSource).toContain('data-testid="scanner-workspace-basic"');
  expect(appSource).toContain('<SignalScannerPage />');
  expect(appSource).toContain('<BottomNav />');
  expect(appSource).toContain("auth.can('canAccessRiskPreview') ? <TechnicalWorkspacePage /> : <BasicScannerWorkspace />");
  expect(cssSource).toContain("[data-testid='scanner-workspace-basic'] section[aria-label='검색 시장'] > button:nth-child(4)");
  expect(cssSource).toMatch(/scanner-workspace-basic[^}]+button:nth-child\(4\)[^{]*\{\s*display:\s*none;/s);

  const aiChartAccess = appSource.match(/function AiChartAccess\(\) \{([^\n]+)\}/)?.[1] ?? '';
  expect(aiChartAccess).toContain("gated('canAccessRiskPreview'");
  expect(aiChartAccess).toContain("builder('AI_CHART', <AiChartPage />)");

  const autoTradingAccess = appSource.match(/function AutoTradingAccess\(\) \{([^\n]+)\}/)?.[1] ?? '';
  expect(autoTradingAccess).toContain("gated('canPlaceOrders'");
  expect(autoTradingAccess).toContain("builder('AUTO_TRADING', <AutoTradingPage />)");
});
