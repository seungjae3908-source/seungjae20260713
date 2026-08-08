import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAVIGATION } from '../src/lib/app-navigation';
import { permissionsFor } from '../../packages/member-access/src/index.js';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');

function technicalItem(id: string) {
  const group = APP_NAVIGATION.find((item) => item.id === 'technical');
  const item = group?.menu?.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing technical menu item: ${id}`);
  return item;
}

test('associate scanner access is isolated from Risk, futures, and order capabilities', () => {
  const associate = permissionsFor('associate');
  expect(associate.canAccessBasicInfo).toBe(true);
  expect(associate.canAccessFutures).toBe(false);
  expect(associate.canAccessRiskPreview).toBe(false);
  expect(associate.canPlaceOrders).toBe(false);

  expect(technicalItem('scanner').capability).toBe('canAccessBasicInfo');
  expect(technicalItem('ai-chart').capability).toBe('canAccessRiskPreview');
  expect(technicalItem('auto-trading').capability).toBe('canPlaceOrders');

  expect(appSource).toContain("function ScannerAccess() { return gated('canAccessBasicInfo', <TechnicalWorkspacePage />); }");
  expect(appSource).toContain("function AiChartAccess() { return gated('canAccessRiskPreview', <AiChartPage />); }");
  expect(appSource).toContain("function AutoTradingAccess() { return gated('canPlaceOrders', <AutoTradingPage />); }");
});
