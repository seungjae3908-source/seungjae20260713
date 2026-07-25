import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { PriceAlertCard } from '@/components/price-alert-card';

type InstrumentAlertButtonProps = {
  symbol?: string;
  name?: string;
  assetType?: string;
  market?: string;
  currency?: string;
  currentPrice?: number | null;
  className?: string;
  instrument?: {
    ticker: string;
    name?: string;
    market?: string;
    assetType?: string;
    currency?: string;
    currentPrice?: number | null;
  };
};

function apiAssetType(
  assetType: string | undefined,
): 'stock' | 'coin_spot' | 'coin_futures' {
  if (assetType === 'coinSpot' || assetType === 'coin_spot') return 'coin_spot';
  if (assetType === 'coinFutures' || assetType === 'coin_futures') {
    return 'coin_futures';
  }
  return 'stock';
}

export function InstrumentAlertButton({
  symbol,
  name,
  assetType,
  market,
  currency,
  currentPrice,
  className = '',
  instrument,
}: InstrumentAlertButtonProps) {
  const [open, setOpen] = useState(false);
  const resolvedSymbol = instrument?.ticker ?? symbol;
  const resolvedName = instrument?.name ?? name;
  const resolvedAssetType = instrument?.assetType ?? assetType;
  const resolvedMarket = instrument?.market ?? market;
  const resolvedCurrency = instrument?.currency ?? currency;
  const resolvedCurrentPrice = instrument?.currentPrice ?? currentPrice;

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className={className}
        aria-label="가격 알림"
        title="가격 알림"
      >
        <Bell className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${resolvedName || resolvedSymbol || '종목'} 가격 알림`}
            className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-background p-3 shadow-2xl"
          >
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <div>
                <p className="text-sm font-black">{resolvedName || resolvedSymbol || '종목'} 알림</p>
                <p className="text-[10px] font-bold text-muted-foreground">
                  {String(resolvedSymbol ?? '').toUpperCase()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="알림 창 닫기"
                className="rounded-full border border-card-border p-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <PriceAlertCard
              assetType={apiAssetType(resolvedAssetType)}
              market={
                resolvedMarket ??
                (resolvedAssetType === 'coinSpot' || resolvedAssetType === 'coin_spot'
                  ? 'UPBIT'
                  : resolvedAssetType === 'coinFutures' || resolvedAssetType === 'coin_futures'
                    ? 'BITGET'
                    : 'KR')
              }
              symbol={String(resolvedSymbol ?? '').toUpperCase()}
              currentPrice={resolvedCurrentPrice ?? null}
              currency={
                resolvedCurrency ??
                (resolvedAssetType === 'coinSpot' || resolvedAssetType === 'coin_spot'
                  ? 'KRW'
                  : resolvedAssetType === 'coinFutures' || resolvedAssetType === 'coin_futures'
                    ? 'USDT'
                    : 'KRW')
              }
            />
          </div>
        </div>
      )}
    </>
  );
}
