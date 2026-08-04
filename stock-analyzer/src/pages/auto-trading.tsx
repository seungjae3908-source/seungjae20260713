import { BottomNav } from '@/components/bottom-nav';
import { TradeApprovalQueue } from '@/components/trade-approval-queue';
import {
  TradeAutomationSettings,
  type TradeAutomationStatus,
} from '@/components/trade-automation-settings';

export default function AutoTradingPage({ fixture }: { fixture?: TradeAutomationStatus }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-card-border bg-background/90 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-xl font-extrabold">승인형 주문</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          AI 검색 신호가 유지될 때만 승인 버튼이 활성화되며, 클릭 후 서버 최종검증을 통과해야 주문됩니다.
        </p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <TradeApprovalQueue />
          <TradeAutomationSettings fixture={fixture} />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
