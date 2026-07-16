import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';

export function AssetSwitch({ className }: { className?: string }) {
  const mode = useAssetMode();
  return (
    <div className={cn('space-y-2', className)}>
      <div className="grid grid-cols-2 gap-2">
        <SwitchButton active={mode.asset === 'stock'} onClick={() => mode.setAsset('stock')}>주식</SwitchButton>
        <SwitchButton active={mode.asset === 'coin'} onClick={() => mode.setAsset('coin')}>코인</SwitchButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {mode.asset === 'stock' ? (
          <>
            <SwitchButton active={mode.stockMarket === 'KR'} onClick={() => mode.setStockMarket('KR')}>국내</SwitchButton>
            <SwitchButton active={mode.stockMarket === 'US'} onClick={() => mode.setStockMarket('US')}>미국</SwitchButton>
          </>
        ) : (
          <>
            <SwitchButton active={mode.coinMarket === 'spot'} onClick={() => mode.setCoinMarket('spot')}>현물</SwitchButton>
            <SwitchButton active={mode.coinMarket === 'futures'} onClick={() => mode.setCoinMarket('futures')}>선물</SwitchButton>
          </>
        )}
      </div>
    </div>
  );
}

function SwitchButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded-xl border px-3 py-2 text-xs font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>
      {children}
    </button>
  );
}
