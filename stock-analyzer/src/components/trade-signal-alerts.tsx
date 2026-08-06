export type ScannerAlertCandidateView = {
  id: string;
  symbol: string;
  market: string;
  timeframe: string;
  cycle: number;
  state: 'READY_FOR_APPROVAL';
  createdAt: string;
  expiresAt: string;
  score: number;
  confidence: number;
  riskScore: number;
  chaseRisk: 'LOW' | 'ELEVATED' | 'UNAVAILABLE';
  orderSubmitted: false;
  exchangeRequestSent: false;
};

function validDate(value: string) {
  return Number.isFinite(Date.parse(value));
}

export function TradeSignalAlerts({ alerts }: { alerts: ScannerAlertCandidateView[] }) {
  const visible = alerts.filter((alert) => (
    alert.state === 'READY_FOR_APPROVAL'
    && validDate(alert.createdAt)
    && validDate(alert.expiresAt)
    && Date.parse(alert.expiresAt) > Date.now()
  ));
  return (
    <section aria-labelledby="scanner-alert-heading" className="rounded-2xl border border-card-border bg-card p-4" data-testid="trade-signal-alerts">
      <h2 id="scanner-alert-heading" className="text-sm font-black">알림 후보</h2>
      <p className="mt-1 text-xs text-muted-foreground">운영 worker는 실행하지 않으며 현재 화면은 fixture·로컬 검증 전용입니다.</p>
      <div className="mt-3 space-y-2">
        {visible.length === 0 ? <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">현재 전송 가능한 알림 후보가 없습니다.</p> : null}
        {visible.map((alert) => (
          <article key={alert.id} className="rounded-xl border border-card-border p-3" data-testid={`signal-alert-${alert.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-extrabold">{alert.symbol} 승인 대기 조건 확인</p>
                <p className="mt-1 text-xs text-muted-foreground">{alert.market} · {alert.timeframe} · cycle {alert.cycle}</p>
              </div>
              <span className="rounded-full bg-positive/10 px-2 py-1 text-[11px] font-bold text-positive">READY</span>
            </div>
            <p className="mt-2 text-xs">점수 {alert.score} · 신뢰도 {alert.confidence}% · 위험 {alert.riskScore} · 추격 {alert.chaseRisk}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">주문 생성 {String(alert.orderSubmitted)} · 거래소 요청 {String(alert.exchangeRequestSent)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
