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


test('trading shell exposes selected-market read-only activity without creating execution authority', () => {
  const page = source('src/pages/auto-trading.tsx');
  const route = source('../api-server/src/routes/trade-automation.ts');

  expect(page).toContain('data-testid="auto-trading-market-activity"');
  expect(page).toContain('미결 주문');
  expect(page).toContain('복구 필요');
  expect(page).toContain('오늘 주문');
  expect(page).toContain('오늘 체결');
  expect(page).toContain('runtimeStatus?.marketActivityByMarket?.[market]');

  expect(route).toContain('marketActivityByMarket');
  expect(route).toContain('PENDING_ORDER_STATES');
  expect(route).toContain('actualOrderSubmittedByStatusRequest: false');
  expect(page).toContain('readyForAutomaticOrderEvaluation');
  expect(page).toContain('automaticServerGateEnabled');
  expect(page).toContain("auth.can('canPlaceOrders')");
  expect(page).toContain('계정 주문 권한 없음');
  expect(page).toContain('자동 실거래 준비됨');
  expect(page).not.toContain('value="서버 Gate 필요"');

  const settings = source('src/components/trade-automation-settings.tsx');
  expect(settings).toContain('liveAutomaticExecutionServerEnabled');
  expect(settings).toContain('readyForAutomaticOrderEvaluation');
  expect(settings).toContain('자동게이트 준비');
  expect(settings).toContain('refreshInFlight');
  expect(settings).toContain('load({ syncDraft: false })');
  expect(settings).toContain('if (syncDraft) {');
  expect(settings).toContain('newEntriesStopped');
  expect(settings).toContain('MEMBER_TRADING_RESUME');
  expect(settings).toContain("confirmation: 'RESUME_MEMBER_TRADING'");
  expect(settings).toContain('data-testid="member-trading-resume"');
  expect(settings).toContain('재개 준비 완료: 자동매매는 OFF입니다.');
  expect(settings).toContain('disabled={memberStopped}');
  expect(settings).not.toContain('window.setInterval(() => { void load(); }, 15_000)');
  expect(settings).not.toContain("status?.liveExecutionServerEnabled?.[exchange] ? '서버게이트 ON'");
});
