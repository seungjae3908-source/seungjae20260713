import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('trading shell exposes auto and paper as first-class modes while preserving navigation names', () => {
  const page = source('src/pages/auto-trading.tsx');
  const paper = source('src/pages/paper-trading.tsx');
  const workspace = source('src/pages/technical-workspace.tsx');
  const navigation = source('src/lib/app-navigation.ts');

  expect(page).toContain("title={initialMode === 'paper' ? '모의매매' : '자동매매'}");
  expect(page).toContain('data-testid="trading-mode-tabs"');
  expect(page).toContain('자동매매</SegmentedButton>');
  expect(page).toContain('모의매매</SegmentedButton>');
  expect(paper).toContain('<AutoTradingPage initialMode="paper" />');
  expect(workspace).toContain("{ value: 'trade', label: '자동매매' }");
  expect(workspace).toContain("trade: '자동매매'");
  expect(navigation).toContain("label: '자동매매'");
  expect(navigation).toContain("label: '모의매매'");
  expect(navigation).not.toContain("label: '승인형 주문'");
});

test('trading shell keeps professional typography and standing-authorization safety contract', () => {
  const page = source('src/pages/auto-trading.tsx');

  expect(page).toContain('data-testid="auto-trading-safety-summary"');
  expect(page).toContain('자동매매 실행 방식');
  expect(page).toContain('주문별 승인');
  expect(page).toContain('불필요');
  expect(page).toContain('위험검사');
  expect(page).toContain('data-testid="trading-market-tabs"');
  expect(page).toContain('data-testid="trading-section-tabs"');
  expect(page).not.toContain('forcedSource={mode === \'auto\' ? \'APP_AUTO\' : \'APP_PAPER\'}');
  expect(page).toContain('title="매매일지"');
  expect(page).toContain('직접매매/자동매매/자동모의매매');
  expect(page).not.toContain('text-[10px]');
  expect(page).not.toContain('text-[11px]');
  expect(page).not.toContain('font-black');
  expect(page).not.toContain('TradeApprovalQueue');
  expect(page).not.toContain('approvalFixture');
  expect(page).toContain('<TradeAutomationSettings fixture={fixture} selectedMarket={market} />');
  expect(page).toContain('<UserBrokerTelegramPanel />');
});


test('automatic trading settings surface six Paper-only rule packs without live promotion', () => {
  const settings = source('src/components/trade-automation-settings.tsx');

  expect(settings).toContain('data-testid="strategy-rule-pack-cards"');
  expect(settings).toContain('수식·파동·보조지표·AI 룰팩');
  expect(settings).toContain('Paper 연구 가능 · 실자동 승격 차단');
  expect(settings).toContain("data-testid={'strategy-rule-pack-' + strategy.strategyId}");
  expect(settings).toContain('이 6개 전략은 이 단계에서 실자동매매로 승격되지 않습니다.');
});
