import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';
import { useLocation } from 'wouter';

export function AssetSwitch({ className }: { className?: string }) {
  const mode = useAssetMode();
  const [, navigate] = useLocation();
  return (
	<div className={cn('space-y-1.5', className)}>
	  <div className="grid grid-cols-4 gap-1">
		<SwitchButton active={mode.asset === 'stock'} onClick={() => mode.setAsset('stock')}>주식</SwitchButton>
		<SwitchButton active={mode.asset === 'coin' && mode.coinMarket === 'spot'} onClick={() => { mode.setAsset('coin'); mode.setCoinMarket('spot'); }}>코인</SwitchButton>
		<SwitchButton active={mode.asset === 'coin' && mode.coinMarket === 'futures'} onClick={() => { mode.setAsset('coin'); mode.setCoinMarket('futures'); }}>선물</SwitchButton>
		<SwitchButton active={false} onClick={() => navigate('/account')}>회원</SwitchButton>
	  </div>
	  {mode.asset === 'stock' && <div className="grid grid-cols-2 gap-1">
		  <>
			<SwitchButton active={mode.stockMarket === 'KR'} onClick={() => mode.setStockMarket('KR')}>국내</SwitchButton>
			<SwitchButton active={mode.stockMarket === 'US'} onClick={() => mode.setStockMarket('US')}>해외</SwitchButton>
		  </>
	  </div>}
    </div>
  );
}

function SwitchButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl border px-3 py-2 text-xs font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>
      {children}
    </button>
  );
}
