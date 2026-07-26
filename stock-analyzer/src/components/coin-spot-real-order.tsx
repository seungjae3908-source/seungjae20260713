import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AppModal } from '@/components/app-modal';
import { authorizedFetch } from '@/lib/auth-fetch';
import { formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type Side = 'BUY' | 'SELL';
type AnyObj = Record<string, any>;

export function CoinSpotRealOrder({
  symbol,
  currentPrice,
  availableAsset,
  onExecuted,
}: {
  symbol: string;
  currentPrice: number | null;
  availableAsset: number;
  onExecuted?: () => void;
}) {
  const [side, setSide] = useState<Side>('BUY');
  const [amountKRW, setAmountKRW] = useState('');
  const [volume, setVolume] = useState('');
  const [executionKey, setExecutionKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [approval, setApproval] = useState<AnyObj | null>(null);
  const [result, setResult] = useState<AnyObj | null>(null);

  const estimated = useMemo(() => {
    const price = Number(currentPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (side === 'BUY') {
      const amount = Number(amountKRW);
      return Number.isFinite(amount) && amount > 0 ? amount / price : null;
    }
    const quantity = Number(volume);
    return Number.isFinite(quantity) && quantity > 0 ? quantity * price : null;
  }, [amountKRW, currentPrice, side, volume]);

  const requestPlan = async () => {
    if (loading) return;
    setLoading(true);
    setMessage('주문 가능 잔액과 현재가를 확인하는 중입니다.');
    setResult(null);
    try {
      const response = await authorizedFetch('/api/crypto/spot/auto/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Crypto-Auto-Trade-Key': executionKey,
        },
        body: JSON.stringify({
          symbol,
          side,
          amountKRW: side === 'BUY' ? Number(amountKRW) : undefined,
          volume: side === 'SELL' ? Number(volume) : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? '주문계획 생성 실패');
      setApproval(payload);
      setMessage('주문 내용을 확인한 뒤 실제 주문 실행을 누르세요.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '주문계획 생성에 실패했습니다.',
      );
    } finally {
      setLoading(false);
    }
  };

  const execute = async () => {
    if (!approval?.approvalToken || loading) return;
    const confirmed = window.confirm(
      `${symbol} 현물 ${side === 'BUY' ? '매수' : '매도'} 실제 주문을 전송합니다. 계속하시겠습니까?`,
    );
    if (!confirmed) return;

    setLoading(true);
    setMessage('업비트에 실제 주문을 전송하는 중입니다.');
    try {
      const response = await authorizedFetch('/api/crypto/spot/auto/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Crypto-Auto-Trade-Key': executionKey,
        },
        body: JSON.stringify({ approvalToken: approval.approvalToken }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? '실제 주문 실패');
      setResult(payload);
      setApproval(null);
      setMessage(payload?.message ?? '실제 주문을 전송했습니다.');
      onExecuted?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '실제 주문에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-black">코인 현물 실제 주문</h3>
            <p className="mt-1 text-[10px] font-bold leading-4 text-muted-foreground">
              주문계획 확인 후 실제 주문 실행 버튼을 직접 눌러야 업비트에 전송됩니다.
            </p>
          </div>
          <ShieldCheck className="h-5 w-5 shrink-0 text-destructive" />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {(['BUY', 'SELL'] as Side[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setSide(item);
                setApproval(null);
              }}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-black',
                side === item
                  ? item === 'BUY'
                    ? 'border-positive bg-positive/10 text-positive'
                    : 'border-destructive bg-destructive/10 text-destructive'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              {item === 'BUY' ? '시장가 매수' : '시장가 매도'}
            </button>
          ))}
        </div>

        <label className="mt-2 block rounded-xl border border-card-border bg-background p-3">
          <span className="text-[10px] font-black text-muted-foreground">
            {side === 'BUY' ? '매수금액' : '매도수량'}
          </span>
          <div className="mt-1 flex items-center gap-1">
            <input
              value={side === 'BUY' ? amountKRW : volume}
              onChange={(event) =>
                side === 'BUY'
                  ? setAmountKRW(event.target.value)
                  : setVolume(event.target.value)
              }
              inputMode="decimal"
              placeholder="0"
              className="min-w-0 flex-1 bg-transparent text-right text-sm font-black outline-none"
            />
            <span className="text-[10px] font-black">
              {side === 'BUY' ? '원' : symbol}
            </span>
          </div>
        </label>

        <div className="mt-2 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-background p-2">
            <p className="text-[9px] font-bold text-muted-foreground">현재가</p>
            <p className="mt-1 text-xs font-black">{formatAppPrice(currentPrice, 'KRW')}</p>
          </div>
          <div className="rounded-xl bg-background p-2">
            <p className="text-[9px] font-bold text-muted-foreground">
              {side === 'BUY' ? '예상 수량' : '예상 금액'}
            </p>
            <p className="mt-1 text-xs font-black">
              {estimated == null
                ? '-'
                : side === 'BUY'
                  ? `${estimated.toLocaleString('ko-KR', { maximumFractionDigits: 8 })} ${symbol}`
                  : formatAppPrice(estimated, 'KRW')}
            </p>
          </div>
        </div>

        {side === 'SELL' && (
          <p className="mt-2 text-center text-[9px] font-bold text-muted-foreground">
            주문 가능 수량 {availableAsset.toLocaleString('ko-KR', {
              maximumFractionDigits: 8,
            })} {symbol}
          </p>
        )}

        <label className="mt-2 block rounded-xl border border-card-border bg-background p-3">
          <span className="text-[10px] font-black text-muted-foreground">
            실제 주문 실행키
          </span>
          <input
            type="password"
            value={executionKey}
            onChange={(event) => setExecutionKey(event.target.value)}
            autoComplete="off"
            placeholder="관리자 실행키 입력"
            className="mt-1 w-full bg-transparent text-sm font-black outline-none"
          />
        </label>

        <button
          type="button"
          onClick={() => void requestPlan()}
          disabled={loading || !executionKey.trim()}
          className="mt-3 h-11 w-full rounded-xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-50"
        >
          {loading ? '확인 중' : '주문계획 확인'}
        </button>
        {message && (
          <p className="mt-2 rounded-xl bg-background p-2 text-center text-[10px] font-bold leading-4 text-muted-foreground">
            {message}
          </p>
        )}
      </section>

      <AppModal
        open={Boolean(approval)}
        onClose={() => setApproval(null)}
        title="코인 현물 실제 주문 확인"
        footer={
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setApproval(null)}
              className="h-11 rounded-xl border border-card-border bg-secondary text-sm font-black"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void execute()}
              disabled={loading}
              className="h-11 rounded-xl bg-destructive text-sm font-black text-destructive-foreground disabled:opacity-50"
            >
              실제 주문 실행
            </button>
          </div>
        }
      >
        {approval?.plan && (
          <div className="space-y-2 text-center">
            <p className="text-lg font-black">
              {approval.plan.symbol} · {approval.plan.side === 'BUY' ? '매수' : '매도'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Info label="현재가" value={formatAppPrice(approval.plan.currentPrice, 'KRW')} />
              <Info
                label={approval.plan.side === 'BUY' ? '매수금액' : '예상 매도금액'}
                value={formatAppPrice(
                  approval.plan.amountKRW ?? approval.plan.estimatedAmountKRW,
                  'KRW',
                )}
              />
              <Info
                label="예상 수량"
                value={`${Number(
                  approval.plan.estimatedVolume ?? approval.plan.volume ?? 0,
                ).toLocaleString('ko-KR', { maximumFractionDigits: 8 })} ${approval.plan.symbol}`}
              />
              <Info
                label="승인 만료"
                value={new Date(approval.expiresAt).toLocaleTimeString('ko-KR')}
              />
            </div>
            <p className="rounded-xl bg-destructive/10 p-3 text-[10px] font-bold leading-4 text-destructive">
              실제 주문 실행을 누르면 업비트 실계좌에 시장가 주문이 전송됩니다.
            </p>
          </div>
        )}
      </AppModal>

      <AppModal
        open={Boolean(result)}
        onClose={() => setResult(null)}
        title="실제 주문 전송 결과"
      >
        <div className="space-y-2 text-center">
          <p className="text-sm font-black">{result?.message}</p>
          <Info label="주문번호" value={String(result?.order?.uuid || '확인 중')} />
          <Info label="주문 상태" value={String(result?.order?.state || '전송됨')} />
        </div>
      </AppModal>
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary p-3 text-center">
      <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-xs font-black">{value}</p>
    </div>
  );
}
