type BotRuntime = {
  status: string;
  totalPnl?: number;
  totalPnlPct?: number;
  tradeCount?: number;
};
type Props = { bots: Record<'up'|'side'|'down', BotRuntime | null> };
const KRW = 1450;
const fmtUsd = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const fmtKrw = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * KRW).toLocaleString()}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export function GridBot3WayStats({ bots }: Props) {
  const arr = [bots.up, bots.side, bots.down];
  const running = arr.filter(b => b?.status === 'running').length;
  const totalPnl = arr.reduce((s, b) => s + (b?.totalPnl ?? 0), 0);
  const totalPct = arr.reduce((s, b) => s + (b?.totalPnlPct ?? 0), 0);
  const totalTrades = arr.reduce((s, b) => s + (b?.tradeCount ?? 0), 0);
  return (
    <div className="rounded-lg border border-card-border bg-background/60 p-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">전체 요약</span>
        <span className="text-xs font-bold">{running}/3 작동중</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><div className="text-[10px] text-muted-foreground">누적 수익금</div><div className={`font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtUsd(totalPnl)} USD</div><div className="text-[10px] text-muted-foreground">({fmtKrw(totalPnl)}원)</div></div>
        <div><div className="text-[10px] text-muted-foreground">누적 수익률</div><div className={`font-bold ${totalPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtPct(totalPct)}</div></div>
        <div><div className="text-[10px] text-muted-foreground">총 거래</div><div className="font-bold">{totalTrades}회</div></div>
      </div>
    </div>
  );
}
