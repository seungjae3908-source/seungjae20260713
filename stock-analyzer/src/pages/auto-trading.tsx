import { BottomNav } from '@/components/bottom-nav';
import { CapabilityGate } from '@/components/capability-gate';
import {
  TradeAutomationSettings,
  type TradeAutomationStatus,
} from '@/components/trade-automation-settings';

export default function AutoTradingPage({ fixture }: { fixture?: TradeAutomationStatus }) {
  const content = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-card-border bg-background/90 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-xl font-extrabold">자동매매</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          승인형 주문과 자동매매를 분리하고 거래소별 위험 한도를 관리합니다.
        </p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24">
        <div className="mx-auto w-full max-w-3xl">
          <TradeAutomationSettings fixture={fixture} />
        </div>
      </main>
      <BottomNav />
    </div>
  );

  // Test fixtures exercise the isolated component without a real account.
  // Every real user route remains protected by the administrator-only gate.
  if (fixture) return content;
  return <CapabilityGate capability="canPlaceOrders">{content}</CapabilityGate>;
}
