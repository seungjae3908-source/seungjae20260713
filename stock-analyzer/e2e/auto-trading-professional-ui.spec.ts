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
  expect(settings).toContain('Paper 자동 · 초기 운용금');
  expect(settings).toContain("data-testid={'strategy-rule-pack-' + strategy.strategyId}");
  expect(settings).toContain('50만원 소액 실전 검증 프로필입니다.');
});


test('rule-pack pilot profile is visible and keeps live order confirmation explicit', () => {
  const settings = source('src/components/trade-automation-settings.tsx');
  expect(settings).toContain('data-testid="strategy-pilot-risk-summary"');
  expect(settings).toContain('최대 진입은 현재 운용금과 함께 증가');
  expect(settings).toContain('손절거리 Risk Size가 더 작으면 자동 축소');
  expect(settings).toContain('거래당 위험은 운용금의 최대 0.5%');
  expect(settings).toContain('조건이 좋으면 하루 진입 횟수 제한 없음');
  expect(settings).toContain('하루 손실거래 5회 중지');
  expect(settings).toContain('연속 3회 손실 시 중지');
  expect(settings).toContain('동일 종목 손실 후 30분 + 새 신호 필요');
  expect(settings).toContain('비상 일손실 2.5만원');
  expect(settings).toContain('선물 3배(위험예산 증액 금지)');
  expect(settings).toContain('Paper 동시 기록');
  expect(settings).toContain('실계좌 주문은 최종 확인 필요');
});


test('pilot capital cards expose dynamic operating capital reserve and HWM', () => {
  const settings = source('src/components/trade-automation-settings.tsx');
  expect(settings).toContain('data-testid="strategy-pilot-capital-state"');
  expect(settings).toContain('현재 운용금');
  expect(settings).toContain('최대 진입 상한');
  expect(settings).toContain('Reserve');
  expect(settings).toContain('High-Water Mark');
  expect(settings).toContain('Reserve 자동출금 금지');
});
