import { useState, type ComponentProps } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import { TradeApprovalQueue } from '@/components/trade-approval-queue';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';

type TradeAutomationFixture = ComponentProps<typeof TradeAutomationSettings>['fixture'];
type TradeApprovalFixture = ComponentProps<typeof TradeApprovalQueue>['fixture'];

type AutoTradingPageProps = {
  fixture?: TradeAutomationFixture;
  approvalFixture?: TradeApprovalFixture;
  embedded?: boolean;
};

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card p-3 text-center">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex min-w-0 items-center justify-center gap-1.5 text-sm font-semibold">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

export default function AutoTradingPage({ fixture, approvalFixture, embedded = false }: AutoTradingPageProps) {
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [notificationOpen, setNotificationOpen] = useState(false);

  const safety = (
    <section aria-label="자동매매 실행 상태" className="rounded-2xl border border-primary/25 bg-primary/5 p-4" data-testid="auto-trading-safety-summary">
      <div className="flex items-center justify-center gap-2 text-center">
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 className="text-base font-bold">자동매매 실행 방식</h2>
      </div>
      <p className="mx-auto mt-2 max-w-xl break-keep text-center text-xs font-medium leading-5 text-muted-foreground">
        주문마다 승인을 요청하지 않습니다. 자동매매와 해당 시장이 ON이면 새 신호를 다시 검증하고, 비용·유동성·손실한도·Risk Gate를 통과한 경우에만 자동 실행합니다.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <StatusItem label="주문별 승인" value="불필요" />
        <StatusItem label="시장 제어" value="4시장 개별 ON/OFF" />
        <StatusItem label="위험검사" value="매 주문 재검증" />
      </div>
    </section>
  );

  const runtimeSummary = (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="auto-trading-runtime-summary">
      <h2 className="text-sm font-bold">실행 범위</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-xl bg-background p-3"><p className="font-bold">국내주식</p><p className="mt-1 text-muted-foreground">모의 + 연결된 실전</p></div>
        <div className="rounded-xl bg-background p-3"><p className="font-bold">미국주식</p><p className="mt-1 text-muted-foreground">모의 + 연결된 실전</p></div>
        <div className="rounded-xl bg-background p-3"><p className="font-bold">코인현물</p><p className="mt-1 text-muted-foreground">모의 + 연결된 실전</p></div>
        <div className="rounded-xl bg-background p-3"><p className="font-bold">코인선물</p><p className="mt-1 text-muted-foreground">모의 + LONG/SHORT</p></div>
      </div>
      <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
        미국주식 실전 자동주문도 거래키·실주문 4중 서버게이트·provider 게이트·주문 직전 위험검사를 모두 통과해야 합니다. 하나라도 충족하지 않으면 실제 주문은 전송되지 않습니다.
      </p>
    </section>
  );

  const settings = (
    <div className="space-y-3" data-testid="auto-trading-settings-column">
      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="rounded-2xl border border-card-border bg-card"
        data-testid="auto-trading-advanced-settings"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span>자동매매 · 시장별 설정</span>
          <span aria-hidden className="text-muted-foreground">⌄</span>
        </summary>
        {advancedOpen ? (
          <div className="border-t border-card-border p-3 sm:p-4">
            <TradeAutomationSettings fixture={fixture} />
          </div>
        ) : null}
      </details>

      <details
        open={notificationOpen}
        onToggle={(event) => setNotificationOpen(event.currentTarget.open)}
        className="rounded-2xl border border-card-border bg-card"
        data-testid="auto-trading-notification-settings"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span>알림 · 텔레그램</span>
          <span aria-hidden className="text-muted-foreground">⌄</span>
        </summary>
        {notificationOpen ? (
          <div className="border-t border-card-border p-3 sm:p-4">
            <UserBrokerTelegramPanel />
          </div>
        ) : null}
      </details>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground" data-testid="auto-trading-page">
      {!embedded ? <CenteredPageHeader title="자동매매" /> : null}

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24 sm:p-4">
        <div className="mx-auto grid w-full max-w-6xl gap-4 min-[1200px]:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] min-[1200px]:items-start" data-testid="auto-trading-responsive-layout">
          <div className="min-w-0 space-y-4">
            {safety}
            {runtimeSummary}
            <TradeApprovalQueue fixture={approvalFixture} />
          </div>
          <aside className="min-w-0 min-[1200px]:sticky min-[1200px]:top-4">
            {settings}
          </aside>
        </div>
      </main>
      {!embedded ? <BottomNav /> : null}
    </div>
  );
}
