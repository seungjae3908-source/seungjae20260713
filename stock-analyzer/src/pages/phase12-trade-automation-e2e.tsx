import { useMemo, useState } from 'react';
import { ScannerSavedSearchManager } from '@/components/scanner-saved-search-manager';
import { TradeApprovalQueue, type ScannerApprovalWaitingItem } from '@/components/trade-approval-queue';
import { TradeSignalAlerts, type ScannerAlertCandidateView } from '@/components/trade-signal-alerts';

type QueueViewState = 'ready' | 'loading' | 'empty' | 'error' | 'auth-expired';

function item(
  id: string,
  state: ScannerApprovalWaitingItem['state'],
  overrides: Partial<ScannerApprovalWaitingItem> = {},
): ScannerApprovalWaitingItem {
  const now = Date.now();
  return {
    id,
    direction: 'BUY',
    market: 'KR',
    symbol: '005930',
    timeframe: '15m',
    signalAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    dataState: 'complete',
    confidence: 78,
    riskScore: 24,
    chaseRisk: 'LOW',
    state,
    blockReasons: state === 'READY_FOR_APPROVAL' ? [] : [`${state} 상태에서는 승인할 수 없습니다.`],
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

export default function Phase12TradeAutomationE2EPage() {
  const [viewState, setViewState] = useState<QueueViewState>('ready');
  const [readyState, setReadyState] = useState<ScannerApprovalWaitingItem['state']>('READY_FOR_APPROVAL');
  const items = useMemo(() => [
    item('ready', readyState, {
      blockReasons: readyState === 'READY_FOR_APPROVAL' ? [] : [`${readyState} 전환으로 승인 대기 정보가 잠겼습니다.`],
    }),
    item('partial', 'WATCHING', {
      market: 'UPBIT_KRW', symbol: 'BTC', direction: 'SELL', dataState: 'partial',
      chaseRisk: 'UNAVAILABLE', blockReasons: ['부분 데이터', '추격 위험 미확인', '보유 수량은 최종 확정이 아닙니다.'],
    }),
    item('invalid', 'INVALIDATED', {
      market: 'BITGET_USDT_FUTURES', symbol: 'BTCUSDT', direction: 'LONG', timeframe: '5m',
      riskScore: 61, chaseRisk: 'ELEVATED', blockReasons: ['핵심 조건 이탈', '급등 추격 위험'],
    }),
    item('expired', 'EXPIRED', {
      market: 'US', symbol: 'AAPL', expiresAt: new Date(Date.now() - 1_000).toISOString(),
      blockReasons: ['신호 만료'],
    }),
  ], [readyState]);

  const alerts = useMemo<ScannerAlertCandidateView[]>(() => [{
    id: 'ready-cycle-1',
    symbol: '005930',
    market: 'KR',
    timeframe: '15m',
    cycle: 1,
    state: 'READY_FOR_APPROVAL',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    score: 82,
    confidence: 78,
    riskScore: 24,
    chaseRisk: 'LOW',
    orderSubmitted: false,
    exchangeRequestSent: false,
  }], []);

  return (
    <main className="h-full overflow-y-auto bg-background p-3 pb-10" data-testid="pr52-readonly-fixture">
      <div className="mx-auto max-w-md space-y-4">
        <header className="rounded-2xl border border-card-border bg-card p-4">
          <h1 className="text-xl font-black">신호 승인 대기 · 읽기 전용</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">실제 주문·취소·거래소 요청 없이 생명주기, 알림 후보, 저장 검색과 모바일 표시만 검증합니다.</p>
        </header>

        <section aria-label="fixture 상태 선택" className="grid grid-cols-2 gap-2 rounded-2xl border border-card-border bg-card p-3">
          {(['ready', 'loading', 'empty', 'error', 'auth-expired'] as const).map((state) => (
            <button key={state} type="button" onClick={() => setViewState(state)} className="min-h-11 rounded-xl border border-card-border px-2 text-xs font-extrabold">{state}</button>
          ))}
        </section>

        <section aria-label="생명주기 전환 fixture" className="grid grid-cols-3 gap-2 rounded-2xl border border-card-border bg-card p-3">
          {(['WEAKENED', 'INVALIDATED', 'EXPIRED'] as const).map((state) => (
            <button key={state} type="button" onClick={() => setReadyState(state)} className="min-h-11 rounded-xl border border-card-border px-2 text-[11px] font-extrabold">{state}</button>
          ))}
        </section>

        <TradeSignalAlerts alerts={alerts} />
        <TradeApprovalQueue items={viewState === 'empty' ? [] : items} viewState={viewState} />
        <ScannerSavedSearchManager userId="fixture-member-pr52" />
      </div>
    </main>
  );
}
