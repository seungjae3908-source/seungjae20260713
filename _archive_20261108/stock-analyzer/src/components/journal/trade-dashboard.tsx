type Props = {
  totalTrades: number;
  totalPnl: number;
  currency: string;
  winRate: number | null;
  openTrades: number;
  closedTrades: number;
};

export function TradeDashboard({ totalTrades, totalPnl, currency, winRate, openTrades, closedTrades }: Props) {
  const pnlClass = totalPnl >= 0 ? 'text-green-600' : 'text-red-600';
  const cards = [
    { label: '누적 손익', value: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} ${currency}`, cls: pnlClass },
    { label: '총 거래건수', value: `${totalTrades}건`, cls: '' },
    { label: '승률', value: winRate == null ? '-' : `${winRate.toFixed(1)}%`, cls: '' },
    { label: '진행중 / 완료', value: `${openTrades} / ${closedTrades}`, cls: '' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="trade-dashboard">
      {cards.map(c => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-3">
          <div className="text-[10px] font-semibold text-muted-foreground">{c.label}</div>
          <div className={`mt-1 text-base font-extrabold tabular-nums ${c.cls}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
