import { useState, type ComponentProps } from 'react';
import { CheckCircle2, ShieldCheck, ShieldX } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import {
  TradeApprovalQueue,
  type TradeApprovalQueueItem,
} from '@/components/trade-approval-queue';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';

type TradeAutomationFixture = ComponentProps<typeof TradeAutomationSettings>['fixture'];

type AutoTradingPageProps = {
  fixture?: TradeAutomationFixture;
  approvalFixture?: TradeApprovalQueueItem[];
  embedded?: boolean;
};

function StatusItem({ label, value, tone }: { label: string; value: string; tone: 'safe' | 'off' }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card p-3 text-center">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex min-w-0 items-center justify-center gap-1.5 text-sm font-semibold">
        {tone === 'safe' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <ShieldX className="h-4 w-4 shrink-0 text-destructive" />}
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

export default function AutoTradingPage({ fixture, approvalFixture, embedded = false }: AutoTradingPageProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);

  const safety = (
    <section aria-label="자동매매 안전 상태" className="rounded-2xl border border-primary/25 bg-primary/5 p-4" data-testid="auto-trading-safety-summary">
      <div className="flex items-center justify-center gap-2 text-center">
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 className="text-base font-bold">자동매매 안전 상태</h2>
      </div>
      <p className="mx-auto mt-2 max-w-xl break-keep text-center text-xs font-medium leading-5 text-muted-foreground">
        현재 실전 주문은 비활성 상태이며 자동매매 기능은 사용자 승인과 최종 위험검사를 거칩니다.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <StatusItem label="실전 주문" value="비활성" tone="off" />
        <StatusItem label="사용자 승인" value="필수" tone="safe" />
        <StatusItem label="위험검사" value="최종 확인" tone="safe" />
      </div>
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
          <span>안전설정 · 거래소</span>
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
        <div className="mx-auto grid w-full max-w-6xl gap-4 min-[1200px]:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] min-[1200px]:items-start" data-testid="auto-trading-responsive-layout">
          <div className="min-w-0 space-y-4">
            {safety}
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
