// 자동매매 UI 전용 전체 화면 — 실주문/자동 진입 로직은 전면 비활성화되어 있다.
// 어떤 주문 API도 호출하지 않으며, 모든 값은 로컬 상태로만 계산·표시한다.
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type OrderMarket = 'kr' | 'us' | 'spot' | 'futures';
type OrderSide = 'buy' | 'sell';
type OrderType = 'market' | 'limit';

const MARKET_TABS: Array<{ key: OrderMarket; label: string; currency: string }> = [
  { key: 'kr', label: '국내주식', currency: 'KRW' },
  { key: 'us', label: '해외주식', currency: 'USD' },
  { key: 'spot', label: '코인 현물', currency: 'KRW' },
  { key: 'futures', label: '코인 선물', currency: 'USDT' },
];

const POSITION_COLUMNS = [
  '종목',
  '시장',
  '방향',
  '수량',
  '진입가',
  '현재가',
  '평가손익',
  '수익률',
  '목표가',
  '손절가',
  '상태',
];

export default function AutoTradePage() {
  const [, navigate] = useLocation();

  const [market, setMarket] = useState<OrderMarket>('kr');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<OrderSide>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');

  const currency = MARKET_TABS.find((m) => m.key === market)?.currency ?? 'KRW';

  const estimatedAmount = useMemo(() => {
    const p = Number(price);
    const q = Number(quantity);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) {
      return null;
    }
    return p * q;
  }, [price, quantity]);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/tech')}
            aria-label="뒤로"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-center">
            <h1 className="text-lg font-extrabold">자동매매</h1>
            <p className="text-[11px] font-bold text-muted-foreground">주문창 · 포지션 현황</p>
          </div>
          <span className="h-9 w-9" />
        </header>

        <div className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-center text-xs font-black text-destructive">
          실주문 기능 준비 중 — 주문 실행은 비활성화되어 있습니다.
        </div>

        {/* 주문창 UI (로컬 상태만) */}
        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-sm font-black">주문창</h2>

          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-bold text-muted-foreground">시장 선택</p>
            <div className="grid grid-cols-2 gap-2">
              {MARKET_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setMarket(tab.key)}
                  className={cn(
                    'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
                    market === tab.key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-background text-muted-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <label className="mb-1.5 block text-[11px] font-bold text-muted-foreground">
              종목
            </label>
            <input
              type="text"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              placeholder="예: 005930, AAPL, BTC"
              className="w-full rounded-xl border border-card-border bg-background px-3 py-2.5 text-sm font-bold outline-none"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <p className="mb-1.5 text-[11px] font-bold text-muted-foreground">주문 방향</p>
              <div className="grid grid-cols-2 gap-2">
                <ToggleButton
                  active={side === 'buy'}
                  activeClass="border-positive bg-positive/10 text-positive"
                  onClick={() => setSide('buy')}
                >
                  매수
                </ToggleButton>
                <ToggleButton
                  active={side === 'sell'}
                  activeClass="border-destructive bg-destructive/10 text-destructive"
                  onClick={() => setSide('sell')}
                >
                  매도
                </ToggleButton>
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-bold text-muted-foreground">주문 유형</p>
              <div className="grid grid-cols-2 gap-2">
                <ToggleButton
                  active={orderType === 'market'}
                  onClick={() => setOrderType('market')}
                >
                  시장가
                </ToggleButton>
                <ToggleButton
                  active={orderType === 'limit'}
                  onClick={() => setOrderType('limit')}
                >
                  지정가
                </ToggleButton>
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1.5 block text-[11px] font-bold text-muted-foreground">
                가격 {orderType === 'market' && '(시장가)'}
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                disabled={orderType === 'market'}
                placeholder={orderType === 'market' ? '시장가' : '0'}
                className="w-full rounded-xl border border-card-border bg-background px-3 py-2.5 text-sm font-bold outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold text-muted-foreground">
                수량
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="0"
                className="w-full rounded-xl border border-card-border bg-background px-3 py-2.5 text-sm font-bold outline-none"
              />
            </div>
          </div>

          {/* 주문 확인 영역 */}
          <div className="mt-4 rounded-xl border border-card-border bg-background p-3">
            <p className="text-[11px] font-black text-muted-foreground">주문 확인</p>
            <div className="mt-2 space-y-1.5">
              <ConfirmRow label="예상 주문금액">
                {orderType === 'market'
                  ? '시장가 — 산출 불가'
                  : estimatedAmount != null
                    ? formatAppPrice(estimatedAmount, currency)
                    : '산출 불가'}
              </ConfirmRow>
              <ConfirmRow label="수수료 예상">
                {estimatedAmount != null && orderType === 'limit'
                  ? '수수료는 거래소 기준'
                  : '산출 불가'}
              </ConfirmRow>
            </div>
          </div>

          <button
            type="button"
            disabled
            aria-disabled="true"
            className="mt-3 w-full cursor-not-allowed rounded-2xl bg-secondary py-3 text-sm font-black text-muted-foreground opacity-70"
          >
            주문 실행 비활성화
          </button>
        </section>

        {/* 포지션 현황 UI */}
        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-sm font-black">포지션 현황</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {POSITION_COLUMNS.map((col) => (
              <span
                key={col}
                className="rounded-md bg-secondary px-2 py-1 text-[10px] font-bold text-muted-foreground"
              >
                {col}
              </span>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-card-border bg-background p-4 text-center text-xs font-bold text-muted-foreground">
            표시할 포지션이 없습니다. 실제 포지션 데이터가 연결되면 여기에 표시됩니다.
          </div>
        </section>

        <p className="mt-4 text-center text-[10px] font-bold text-muted-foreground">
          본 화면은 UI 미리보기입니다. 실제 주문·자동 진입은 동작하지 않습니다.
        </p>
      </div>
      <BottomNav />
    </div>
  );
}

function ToggleButton({
  active,
  activeClass,
  onClick,
  children,
}: {
  active: boolean;
  activeClass?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
        active
          ? activeClass ?? 'border-primary bg-primary text-primary-foreground'
          : 'border-card-border bg-background text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function ConfirmRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-bold text-muted-foreground">{label}</span>
      <span className="text-xs font-black">{children}</span>
    </div>
  );
}
