import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';

export function AssetSwitch({ className }: { className?: string }) {
  const mode = useAssetMode();

  const openStock = () => {
    mode.setAsset('stock');
  };

  const openCoin = () => {
    // 메인·종목 화면에서 코인을 처음 누르면 항상 업비트 현물부터 연다.
    // 이전에 비트겟 선물을 봤더라도 일반 코인 진입 기본값은 현물이다.
    mode.setCoinMarket('spot');
    mode.setAsset('coin');
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="grid grid-cols-2 gap-2">
        <SwitchButton
          active={mode.asset === 'stock'}
          onClick={openStock}
        >
          주식
        </SwitchButton>

        <SwitchButton
          active={mode.asset === 'coin'}
          onClick={openCoin}
        >
          코인
        </SwitchButton>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {mode.asset === 'stock' ? (
          <>
            <SwitchButton
              active={mode.stockMarket === 'KR'}
              onClick={() => mode.setStockMarket('KR')}
            >
              국내
            </SwitchButton>

            <SwitchButton
              active={mode.stockMarket === 'US'}
              onClick={() => mode.setStockMarket('US')}
            >
              해외
            </SwitchButton>
          </>
        ) : (
          <>
            <SwitchButton
              active={mode.coinMarket === 'spot'}
              onClick={() => mode.setCoinMarket('spot')}
            >
              현물 · 업비트
            </SwitchButton>

            <SwitchButton
              active={mode.coinMarket === 'futures'}
              onClick={() => mode.setCoinMarket('futures')}
            >
              선물 · 비트겟
            </SwitchButton>
          </>
        )}
      </div>
    </div>
  );
}

function SwitchButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center break-keep rounded-xl border px-3 py-2 text-center text-xs font-black leading-tight',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}