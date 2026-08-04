import { BottomNav } from '@/components/bottom-nav';
import {
  TradeAutomationSettings,
  type TradeAutomationStatus,
} from '@/components/trade-automation-settings';
import {
  TradeApprovalQueue,
  type TradeApprovalPlan,
} from '@/components/trade-approval-queue';
import { TradeRecoveryControl } from '@/components/trade-recovery-control';

type AutoTradingFixture = TradeAutomationStatus & { plans?: TradeApprovalPlan[] };

export default function AutoTradingPage({ fixture }: { fixture?: AutoTradingFixture }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-card-border bg-background/90 px-4 pb-4 pt-5 text-center glass">
        <div
          data-testid="auto-trading-admin-only"
          className="mx-auto mb-2 w-fit rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-extrabold text-amber-700 dark:text-amber-300"
        >
          관리자 전용
        </div>
        <h1 className="text-xl font-extrabold">자동매매</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          승인형 주문과 자동매매를 분리하고 거래소별 위험 한도를 관리합니다.
        </p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24">
        <div className="mx-auto w-full max-w-3xl">
          <TradeAutomationSettings fixture={fixture} />
          <TradeRecoveryControl fixture={Boolean(fixture)} />
          <TradeApprovalQueue
            fixturePlans={fixture?.plans}
            emergencyStopped={fixture ? fixture.emergencyStopped : undefined}
          />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
