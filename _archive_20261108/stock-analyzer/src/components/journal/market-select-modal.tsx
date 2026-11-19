import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

export type JournalMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

const MARKET_LABELS: Record<JournalMarket, string> = {
  KR_STOCK: '국내주식',
  US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인 현물',
  CRYPTO_FUTURES: '코인 선물',
};
const ALL_MARKETS: JournalMarket[] = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];

type Props = {
  open: boolean;
  title: string;
  initial: JournalMarket[];
  onApply: (markets: JournalMarket[]) => void;
  onClose: () => void;
};

export function JournalMarketSelectModal({ open, title, initial, onApply, onClose }: Props) {
  const [selected, setSelected] = useState<JournalMarket[]>(initial);
  useEffect(() => { if (open) setSelected(initial); }, [open, initial]);
  if (!open) return null;

  const allChecked = selected.length === ALL_MARKETS.length;
  const toggle = (m: JournalMarket) =>
    setSelected(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  const toggleAll = () => setSelected(allChecked ? [] : [...ALL_MARKETS]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-80 rounded-lg bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="닫기"><X className="h-4 w-4" /></button>
        </div>
        <label className="mb-2 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={allChecked}
            ref={el => { if (el) el.indeterminate = selected.length > 0 && !allChecked; }}
            onChange={toggleAll}
          />
          전체 선택
        </label>
        <hr className="my-2" />
        <div className="space-y-2">
          {ALL_MARKETS.map(m => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)} />
              {MARKET_LABELS[m]}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-3 py-1.5 text-sm">취소</button>
          <button
            onClick={() => onApply(selected)}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
          >
            적용 ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}
