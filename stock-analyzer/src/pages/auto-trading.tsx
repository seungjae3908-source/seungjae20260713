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
    <div className="min-w-0 rounded-2xl border border-card-border bg-card p-2.5 sm:p-3">
      <p className="truncate text-[10px] font-bold text-muted-foreground sm:text-[11px]">{label}</p>
      <div className="mt-1 flex min-w-0 items-center gap-1 text-xs font-black sm:gap-1.5 sm:text-sm">
        {tone === 'safe' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500 sm:h-4 sm:w-4" /> : <ShieldX className="h-3.5 w-3.5 shrink-0 text-destructive sm:h-4 sm:w-4" />}
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

export default function AutoTradingPage({ fixture, approvalFixture, embedded = false }: AutoTradingPageProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);

  const safety = (
    <section aria-label="주문 안전 상태" className="rounded-3xl border border-primary/25 bg-primary/5 p-3 sm:p-4" data-testid="auto-trading-safety-summary">
      <div className="flex items-center justify-center gap-2 text-center">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h2 className="text-sm font-black sm:text-base">주문 안전 상태</h2>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:mt-4">
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
        className="rounded-3xl border border-card-border bg-card"
        data-testid="auto-trading-advanced-settings"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-black [&::-webkit-details-marker]:hidden">
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
        className="rounded-3xl border border-card-border bg-card"
        data-testid="auto-trading-notification-settings"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-black [&::-webkit-details-marker]:hidden">
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
      {!embedded ? <CenteredPageHeader title="자동매매" eyebrow="승인형 주문" /> : null}

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24 sm:p-4">
        <div className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] lg:items-start" data-testid="auto-trading-responsive-layout">
          <div className="min-w-0 space-y-4">
            {safety}
            <TradeApprovalQueue fixture={approvalFixture} />
          </div>
          <aside className="min-w-0 lg:sticky lg:top-4">
            {settings}
          </aside>
        </div>
      </main>
      {!embedded ? <BottomNav /> : null}
    </div>
  );
}
