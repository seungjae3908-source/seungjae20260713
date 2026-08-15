import type { ComponentProps } from 'react';
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
    <div className="rounded-2xl border border-card-border bg-card p-3">
      <p className="text-[11px] font-bold text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-1.5 text-sm font-black">
        {tone === 'safe' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <ShieldX className="h-4 w-4 text-destructive" />}
        {value}
      </div>
    </div>
  );
}

export default function AutoTradingPage({ fixture, approvalFixture, embedded = false }: AutoTradingPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-testid="auto-trading-page">
      {!embedded ? (
        <CenteredPageHeader
          title="자동매매"
          eyebrow="승인형 주문"
          infoTitle="주문 안전 안내"
          infoItems={[
            '화면 버튼만으로 실전 주문이 제출되지 않습니다.',
            '사용자 승인 이후에도 서버 Risk Engine이 신호·가격·위험한도·만료를 다시 검증합니다.',
            '불명확하거나 실패한 주문은 자동으로 재전송하지 않습니다.',
          ]}
        />
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24 sm:p-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <section aria-label="주문 안전 상태" className="rounded-3xl border border-primary/25 bg-primary/5 p-4" data-testid="auto-trading-safety-summary">
            <div className="flex items-center justify-center gap-2 text-center">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-base font-black">현재 주문 안전 상태</h2>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatusItem label="실전 주문" value="비활성" tone="off" />
              <StatusItem label="사용자 승인" value="필수" tone="safe" />
              <StatusItem label="Risk Engine" value="최종 검증" tone="safe" />
            </div>
          </section>

          <TradeApprovalQueue fixture={approvalFixture} />

          <details className="rounded-3xl border border-card-border bg-card" data-testid="auto-trading-advanced-settings">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-black [&::-webkit-details-marker]:hidden">
              안전설정 · 거래소 연결
              <span aria-hidden className="text-muted-foreground">⌄</span>
            </summary>
            <div className="border-t border-card-border p-3 sm:p-4">
              <TradeAutomationSettings fixture={fixture} />
            </div>
          </details>

          <details className="rounded-3xl border border-card-border bg-card" data-testid="auto-trading-notification-settings">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 text-sm font-black [&::-webkit-details-marker]:hidden">
              주문 알림 · 텔레그램
              <span aria-hidden className="text-muted-foreground">⌄</span>
            </summary>
            <div className="border-t border-card-border p-3 sm:p-4">
              <UserBrokerTelegramPanel />
            </div>
          </details>
        </div>
      </main>
      {!embedded ? <BottomNav /> : null}
    </div>
  );
}
