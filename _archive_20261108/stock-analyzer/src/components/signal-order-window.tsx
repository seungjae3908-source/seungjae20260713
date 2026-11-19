import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { evaluateEntryGuard, type EntryGuardDirection, type EntryGuardResult } from '@/lib/signal-entry-guard';
import { useLivePrice, type LivePriceMarket } from '@/lib/signal-live-price';

export type SignalOrderWindowProps = {
  market: LivePriceMarket;
  symbol: string;
  name?: string | null;
  action: EntryGuardDirection;
  pricePlan: {
    entryZone?: { from: number; to: number } | null;
    stopLoss?: number | null;
    targets?: Array<number | null | undefined>;
  };
  onGuardChange?: (guard: EntryGuardResult) => void;
};

const SELL_WEIGHTS = [0.3, 0.3, 0.4];

function fmt(value: number | null | undefined, market: LivePriceMarket): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (market === 'KR' || market === 'UPBIT') {
    return value >= 100 ? Math.round(value).toLocaleString('ko-KR') : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 2 : 6 });
}

function ageLabel(ageMs: number | null): string {
  if (ageMs == null) return '시세 불러오는 중';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}초 전 갱신`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}분 전 시세` : `${Math.floor(minutes / 60)}시간 전 시세`;
}

/**
 * Live order window: refreshes the price (crypto 2s, stocks 5s) and applies the
 * owner's entry guard. It never sends an order itself; the parent passes the
 * guard result to the order buttons, and the server re-checks at submit time.
 */
export function SignalOrderWindow({ market, symbol, name, action, pricePlan, onGuardChange }: SignalOrderWindowProps) {
  const live = useLivePrice(market, symbol);
  const [budgetInput, setBudgetInput] = useState('');
  const budget = Number(budgetInput.replace(/,/g, '').trim());
  const targets = useMemo(() => (pricePlan.targets ?? []).filter((t): t is number => typeof t === 'number' && t > 0).slice(0, 3), [pricePlan.targets]);

  const guard = useMemo(() => evaluateEntryGuard({
    direction: action,
    price: live.price,
    priceAgeMs: live.ageMs,
    entryZone: pricePlan.entryZone ?? null,
    stopLoss: pricePlan.stopLoss ?? null,
    targets,
    budget: Number.isFinite(budget) && budget > 0 ? budget : null,
  }), [action, live.price, live.ageMs, pricePlan.entryZone, pricePlan.stopLoss, targets, budget]);

  useEffect(() => { onGuardChange?.(guard); }, [guard, onGuardChange]);

  const tone = guard.tone === 'ok' ? 'border-positive/30 bg-positive/10 text-positive'
    : guard.tone === 'warn' ? 'border-warning/30 bg-warning/10 text-warning'
      : 'border-destructive/30 bg-destructive/10 text-destructive';
  const ToneIcon = guard.tone === 'ok' ? CheckCircle2 : guard.tone === 'warn' ? AlertTriangle : Ban;
  const sellLabel = action === 'SHORT' ? '숏 정리' : '매도';
  const buyLabel = action === 'SHORT' ? '숏 진입' : '매수';
  const sellWeights = SELL_WEIGHTS.slice(0, targets.length);
  const sellTotal = sellWeights.reduce((sum, w) => sum + w, 0);

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="signal-order-window" data-guard-state={guard.state}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-base font-black">{name ? `${name} · ${symbol}` : symbol}</p>
          <p className="mt-1 text-[11px] font-bold text-muted-foreground">주문창 · 가격 자동 갱신</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black" data-testid="signal-order-live-price">{fmt(live.price, market)}</p>
          <p className="flex items-center justify-end gap-1 text-[10px] font-bold text-muted-foreground">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />{ageLabel(live.ageMs)}
          </p>
        </div>
      </div>

      <div role={guard.allowed ? 'status' : 'alert'} data-testid="signal-order-guard" className={cn('mt-3 flex items-start gap-2 rounded-2xl border p-3 text-xs font-bold leading-5', tone)}>
        <ToneIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="break-keep">{guard.message}{guard.rewardRisk != null && guard.allowed ? ` (손익비 1 : ${guard.rewardRisk.toFixed(2)})` : ''}</p>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">진입 구간</p><p className="font-black">{pricePlan.entryZone ? `${fmt(Math.min(pricePlan.entryZone.from, pricePlan.entryZone.to), market)}~${fmt(Math.max(pricePlan.entryZone.from, pricePlan.entryZone.to), market)}` : '-'}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">손절(이탈가)</p><p className="font-black text-destructive">{fmt(pricePlan.stopLoss ?? null, market)}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">1차 목표</p><p className="font-black">{fmt(targets[0] ?? null, market)}</p></div>
      </div>

      <label className="mt-3 block text-[11px] font-black text-muted-foreground">
        주문 금액
        <input
          data-testid="signal-order-budget"
          inputMode="decimal"
          type="number"
          min="0"
          step="any"
          value={budgetInput}
          onChange={(event) => setBudgetInput(event.target.value)}
          placeholder="1000000"
          className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black text-foreground outline-none focus:border-primary"
        />
      </label>

      <div className="mt-3 overflow-hidden rounded-2xl border border-card-border text-xs" data-testid="signal-order-tranches">
        <div className="grid grid-cols-4 bg-background px-3 py-2 text-[10px] font-black text-muted-foreground">
          <span>{buyLabel}</span><span>가격</span><span>비중·금액</span><span className="text-right">상태</span>
        </div>
        {guard.tranches.map((row) => (
          <div key={row.label} className="grid grid-cols-4 border-t border-card-border px-3 py-2 font-bold">
            <span>{row.label}</span>
            <span>{fmt(row.orderPrice, market)}{row.orderPrice !== row.planPrice ? <span className="block text-[9px] text-muted-foreground line-through">{fmt(row.planPrice, market)}</span> : null}</span>
            <span>{Math.round(row.weight * 100)}%{row.amount != null ? ` · ${row.amount.toLocaleString('ko-KR')}` : ''}</span>
            <span className={cn('text-right', !guard.allowed ? 'text-destructive' : row.fillsNow ? 'text-positive' : 'text-muted-foreground')}>
              {!guard.allowed ? '막힘' : row.fillsNow ? '즉시 체결' : '대기'}
            </span>
          </div>
        ))}
      </div>

      {targets.length ? (
        <p className="mt-2 break-keep text-[11px] font-bold leading-5 text-muted-foreground">
          {sellLabel} {targets.map((t, i) => `${i + 1}차 ${fmt(t, market)} (${Math.round((sellWeights[i] / sellTotal) * 100)}%)`).join(' → ')} · 손절 {fmt(pricePlan.stopLoss ?? null, market)}에서 전량 · 1차 목표가 먼저 닿으면 남은 {buyLabel} 주문 취소
        </p>
      ) : null}

      <div className="mt-2 flex justify-between text-xs font-bold">
        <span className="text-muted-foreground">손절 시 최대 손실(예상)</span>
        <span className="text-destructive" data-testid="signal-order-max-loss">{guard.maxLossAmount != null && guard.allowed ? `-${guard.maxLossAmount.toLocaleString('ko-KR')}` : '-'}</span>
      </div>

      <p className="mt-3 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
        이 화면은 주문을 보내지 않아요. 아래 주문 버튼은 이 판정이 막힘이면 눌리지 않고, 서버도 제출 순간 다시 확인해요. 실제 주문은 거래소별 수동 실거래 스위치를 켠 뒤 열려요.
      </p>
    </section>
  );
}
