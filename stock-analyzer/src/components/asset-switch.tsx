import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';

const MARKET_OPTIONS = [
  { key: 'stock-kr', label: '국내주식', detail: 'KRX' },
  { key: 'stock-us', label: '해외주식', detail: 'US' },
  { key: 'coin-spot', label: '코인 현물', detail: 'UPBIT' },
  { key: 'coin-futures', label: '코인 선물', detail: 'BITGET' },
] as const;

export function AssetSwitch({ className }: { className?: string }) {
  const mode = useAssetMode();

  const selected =
    mode.asset === 'stock'
      ? mode.stockMarket === 'US'
        ? 'stock-us'
        : 'stock-kr'
      : mode.coinMarket === 'futures'
        ? 'coin-futures'
        : 'coin-spot';

  const selectMarket = (key: (typeof MARKET_OPTIONS)[number]['key']) => {
    if (key === 'stock-kr' || key === 'stock-us') {
      mode.setStockMarket(key === 'stock-us' ? 'US' : 'KR');
      mode.setAsset('stock');
      return;
    }
    mode.setCoinMarket(key === 'coin-futures' ? 'futures' : 'spot');
    mode.setAsset('coin');
  };

  return (
    <div
      data-asset-switch="direct-market"
      className={cn('grid grid-cols-2 gap-2', className)}
      aria-label="시장 선택"
    >
      {MARKET_OPTIONS.map((item) => {
        const active = selected === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => selectMarket(item.key)}
            aria-pressed={active}
            className={cn(
              'min-h-[52px] rounded-2xl border px-3 py-2.5 text-center transition-colors',
              active
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : 'border-card-border bg-card text-muted-foreground',
            )}
          >
            <span className="block text-xs font-black">{item.label}</span>
            <span
              className={cn(
                'mt-0.5 block text-[9px] font-bold tracking-wide',
                active
                  ? 'text-primary-foreground/75'
                  : 'text-muted-foreground/70',
              )}
            >
              {item.detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}
