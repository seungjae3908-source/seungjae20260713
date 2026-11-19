import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { TradePagination } from './trade-pagination';

export type SymbolTrade = {
  id: string;
  symbol: string;
  side?: string;
  openedAt: string;
  closedAt?: string | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pnl?: number | null;
  review?: any;
};

type Props = {
  open: boolean;
  symbol: string | null;
  trades: SymbolTrade[];
  onClose: () => void;
};

export function SymbolTradesModal({ open, symbol, trades, onClose }: Props) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [symbol, open]);
  if (!open || !symbol) return null;

  const PAGE_SIZE = 10;
  const totalPages = Math.ceil(trades.length / PAGE_SIZE);
  const pageTrades = trades.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="max-h-[80vh] w-[90%] max-w-4xl overflow-y-auto rounded-lg bg-card p-5 shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{symbol} 거래내역 ({trades.length}건)</h3>
          <button onClick={onClose} aria-label="닫기"><X className="h-5 w-5" /></button>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-2">진입</th>
              <th>청산</th>
              <th>방향</th>
              <th className="text-right">진입가</th>
              <th className="text-right">청산가</th>
              <th className="text-right">손익</th>
              <th className="text-right">수익률</th>
            </tr>
          </thead>
          <tbody>
            {pageTrades.map(t => {
              const pnl = t.review?.netPnl ?? t.pnl ?? 0;
              const ret = t.review?.returnPercent;
              return (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="py-2 text-xs">{new Date(t.openedAt).toLocaleString('ko-KR')}</td>
                  <td className="text-xs">{t.closedAt ? new Date(t.closedAt).toLocaleString('ko-KR') : '-'}</td>
                  <td className="text-xs">{t.side ?? '-'}</td>
                  <td className="text-right tabular-nums text-xs">{t.entryPrice ?? '-'}</td>
                  <td className="text-right tabular-nums text-xs">{t.exitPrice ?? '-'}</td>
                  <td className={`text-right tabular-nums text-xs ${pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                  </td>
                  <td className="text-right tabular-nums text-xs">
                    {ret == null ? '-' : `${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <TradePagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
