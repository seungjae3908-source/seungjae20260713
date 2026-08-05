import { ShieldCheck, ShieldX } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import {
  TradeApprovalQueue,
  type TradeApprovalQueueItem,
} from '@/components/trade-approval-queue';
import {
  TradeAutomationSettings,
  type TradeAutomationStatus,
} from '@/components/trade-automation-settings';
import {
  TradeSignalAlerts,
  type TradeSignalAlertItem,
} from '@/components/trade-signal-alerts';

export default function AutoTradingPage({
  fixture,
  approvalFixture,
  alertFixture,
}: {
  fixture?: TradeAutomationStatus;
  approvalFixture?: TradeApprovalQueueItem[];
  alertFixture?: TradeSignalAlertItem[];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-card-border bg-background/90 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-xl font-extrabold">승인형 주문</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          AI 검색 신호가 유지될 때만 승인 버튼이 활성화되며, 확인 후 서버 최종검증을 통과해야 주문됩니다.
        </p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <section className="rounded-3xl border border-primary/30 bg-primary/5 p-4" aria-label="주문 안전 상태">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <h2 className="text-sm font-black">사용자 승인과 서버 재검증 필수</h2>
                <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
                  화면 버튼만으로 주문되지 않습니다. 승인 시 서버가 신호·가격·위험한도를 다시 확인하며 중복 요청은 차단합니다.
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[10px] font-black text-destructive">
                  <ShieldX className="h-3.5 w-3.5" />실전 계좌 주문 비활성
                </div>
              </div>
            </div>
          </section>
          <TradeApprovalQueue fixture={approvalFixture} />
          <TradeSignalAlerts fixture={alertFixture} />
          <TradeAutomationSettings fixture={fixture} />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
