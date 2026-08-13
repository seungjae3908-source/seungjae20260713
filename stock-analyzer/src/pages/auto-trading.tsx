import type { ComponentProps } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import {
  TradeApprovalQueue,
  type TradeApprovalQueueItem,
} from '@/components/trade-approval-queue';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import { AutoTradingV2Panel, type AutoTradingV2Fixture } from '@/components/auto-trading-v2-panel';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';

type TradeAutomationFixture = ComponentProps<typeof TradeAutomationSettings>['fixture'];

export default function AutoTradingPage({
  fixture,
  approvalFixture,
  v2Fixture,
}: {
  fixture?: TradeAutomationFixture;
  approvalFixture?: TradeApprovalQueueItem[];
  v2Fixture?: AutoTradingV2Fixture;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-card-border bg-background/90 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-xl font-extrabold">Auto Trading</h1>
        <p className="mt-1 text-xs font-bold text-muted-foreground">Auto Trading 2.0 Paper · Shadow + 기존 사용자 승인형 주문</p>
        <p className="mt-1 text-xs text-muted-foreground">
          실거래는 잠겨 있으며, Paper/Shadow도 신호·Risk Engine·보호 상태·Reconciliation을 통과한 경우에만 가상 실행됩니다.
        </p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <section className="rounded-3xl border border-primary/30 bg-primary/5 p-4" aria-label="주문 안전 상태">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <h2 className="text-sm font-black">PAPER / SHADOW 우선 · LIVE 서버 차단</h2>
                <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
                  Auto Trading 2.0은 실제 공개 시장 데이터를 사용하지만 첫 Production 릴리스에서는 거래소 사설 주문 API를 호출하지 않습니다. 기존 승인형 주문도 별도 안전 계층을 그대로 유지합니다.
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[10px] font-black text-destructive">
                  <ShieldX className="h-3.5 w-3.5" />LIVE_TRADING=false · 실전 주문 비활성
                </div>
              </div>
            </div>
          </section>
          <AutoTradingV2Panel fixture={v2Fixture} />
          <section className="space-y-4" aria-labelledby="approval-trading-heading">
            <div className="px-1">
              <h2 id="approval-trading-heading" className="text-sm font-black">승인형 주문</h2>
              <p className="mt-1 text-xs text-muted-foreground">기존 사용자 승인 + Risk Envelope 주문 계층</p>
            </div>
            <TradeApprovalQueue fixture={approvalFixture} />
            <TradeAutomationSettings fixture={fixture} />
          </section>
          <UserBrokerTelegramPanel />
        </div>
      </main>
      <BottomNav />
    </div>
  );
}