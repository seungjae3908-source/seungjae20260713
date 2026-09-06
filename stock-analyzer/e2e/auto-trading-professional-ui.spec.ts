import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('auto trading keeps the user-facing name 자동매매 everywhere in its shell', () => {
  const page = source('src/pages/auto-trading.tsx');
  const workspace = source('src/pages/technical-workspace.tsx');
  const navigation = source('src/lib/app-navigation.ts');

  expect(page).toContain('<CenteredPageHeader title="자동매매" />');
  expect(page).not.toContain('eyebrow="승인형 주문"');
  expect(workspace).toContain("{ value: 'trade', label: '자동매매' }");
  expect(workspace).toContain("trade: '자동매매'");
  expect(navigation).toContain("label: '자동매매'");
  expect(navigation).toContain("title: '자동매매'");
  expect(navigation).not.toContain("label: '승인형 주문'");
});

test('auto trading shell keeps the professional typography and safety summary without altering approval components', () => {
  const page = source('src/pages/auto-trading.tsx');

  expect(page).toContain('data-testid="auto-trading-safety-summary"');
  expect(page).toContain('자동매매 안전 상태');
  expect(page).toContain('실전 주문');
  expect(page).toContain('비활성');
  expect(page).toContain('사용자 승인');
  expect(page).toContain('위험검사');
  expect(page).not.toContain('text-[10px]');
  expect(page).not.toContain('text-[11px]');
  expect(page).not.toContain('font-black');
  expect(page).toContain('<TradeApprovalQueue fixture={approvalFixture} />');
  expect(page).toContain('<TradeAutomationSettings fixture={fixture} />');
  expect(page).toContain('<UserBrokerTelegramPanel />');
});
