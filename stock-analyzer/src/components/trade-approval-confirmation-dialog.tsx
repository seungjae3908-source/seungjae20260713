import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, Loader2, ShieldCheck, ShieldX, X } from 'lucide-react';
import type { TradeApprovalQueueItem } from '@/components/trade-approval-queue';
import {
  accountModeLabel,
  approvalCountdown,
  approvalMessage,
  orderTypeLabel,
  sideLabel,
} from '@/lib/trade-approval-ui';
import { cn } from '@/lib/utils';

const EXCHANGE_LABEL: Record<TradeApprovalQueueItem['exchange'], string> = {
  bitget: 'Bitget 선물',
  upbit: 'Upbit 현물',
  kiwoom: 'Kiwoom 국내주식',
};

function formatNumber(value: number | null | undefined, maximumFractionDigits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(Number(value));
}

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>([
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))].filter((element) => !element.hasAttribute('hidden'));
}

export function TradeApprovalConfirmationDialog({
  item,
  validating,
  submitting,
  validationMessage,
  onCancel,
  onConfirm,
  onRevalidate,
}: {
  item: TradeApprovalQueueItem;
  validating: boolean;
  submitting: boolean;
  validationMessage: string;
  onCancel: () => void;
  onConfirm: () => void;
  onRevalidate: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const countdown = approvalCountdown(item.approval.expiresAt, now);
  const liveBlocked = item.accountMode === 'live';
  const signalMaintained = item.signalState === 'READY_FOR_APPROVAL'
    && item.approval.signalState === 'READY_FOR_APPROVAL';
  const enabled = item.approval.approvalEnabled
    && item.approval.planState === 'APPROVAL_PENDING'
    && item.state === 'APPROVAL_PENDING'
    && signalMaintained
    && !countdown.expired
    && !liveBlocked
    && !validating
    && !submitting;
  const returnFocusTestId = `approve-plan-${item.id}`;

  const blockedReason = useMemo(() => {
    if (liveBlocked) return '실전 계좌 주문은 현재 활성화되지 않았습니다.';
    if (countdown.expired) return '승인 가능 시간이 지나 주문 요청을 보낼 수 없습니다.';
    if (!signalMaintained) return approvalMessage(item.approval.reasonCode, item.signalInvalidationReason);
    if (!item.approval.approvalEnabled || item.state !== 'APPROVAL_PENDING') {
      return approvalMessage(item.approval.reasonCode, item.signalInvalidationReason);
    }
    return validationMessage;
  }, [countdown.expired, item, liveBlocked, signalMaintained, validationMessage]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(onRevalidate, 5_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') onRevalidate();
    };
    window.addEventListener('focus', onRevalidate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onRevalidate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [onRevalidate]);

  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const initialFocusFrame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(initialFocusFrame);
      document.body.style.overflow = previousOverflow;
      const focusTarget = [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="approve-plan-"]')]
        .find((element) => element.dataset.testid === returnFocusTestId);
      window.requestAnimationFrame(() => {
        if (focusTarget?.isConnected && !focusTarget.disabled) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    };
  }, [returnFocusTestId]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const elements = focusableElements(dialogRef.current);
    if (!elements.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6"
      role="presentation"
      data-testid="trade-approval-dialog-layer"
    >
      <button
        type="button"
        aria-label="주문 확인창 닫기"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
        onClick={submitting ? undefined : onCancel}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-approval-dialog-title"
        aria-describedby="trade-approval-dialog-description"
        onKeyDown={onKeyDown}
        className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-card-border bg-card shadow-2xl sm:max-h-[min(90dvh,760px)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-card-border p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
              <h2 id="trade-approval-dialog-title" className="text-base font-black">주문 승인 최종 확인</h2>
              <span className={cn(
                'rounded-full border px-2 py-1 text-[10px] font-black',
                liveBlocked
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : item.accountMode === 'mock'
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : 'border-primary/30 bg-primary/10 text-primary',
              )}>
                {accountModeLabel(item.accountMode)}
              </span>
            </div>
            <p id="trade-approval-dialog-description" className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
              화면 정보 확인 후에도 서버가 신호·가격·유동성·위험한도를 다시 검사합니다.
            </p>
          </div>
          <button
            type="button"
            aria-label="주문 확인창 닫기"
            onClick={onCancel}
            disabled={submitting}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl hover:bg-secondary disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {liveBlocked ? (
            <div className="mb-3 flex items-start gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" role="alert">
              <ShieldX className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="font-extrabold">실전 주문은 차단 상태입니다. 이 확인창에서는 주문 API를 호출할 수 없습니다.</p>
            </div>
          ) : null}

          <div className="rounded-2xl border border-card-border bg-background p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold text-muted-foreground">종목·티커</p>
                <p className="mt-1 break-all text-lg font-black">{item.symbol}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-extrabold">{sideLabel(item.side)}</span>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-extrabold">{EXCHANGE_LABEL[item.exchange]}</span>
              </div>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <Detail label="예상 주문금액" value={`${formatNumber(item.estimatedKrw)}원`} />
            <Detail label="수량" value={item.quantity == null ? '서버 최종 계산' : formatNumber(item.quantity, 8)} />
            <Detail label="주문유형" value={`${orderTypeLabel(item.orderType)}${item.limitPrice == null ? '' : ` · ${formatNumber(item.limitPrice, 8)}`}`} />
            <Detail label="분할 진입" value={`${item.splitRatios.join('% / ')}%`} />
            <Detail label="손절가" value={formatNumber(item.stopPrice, 8)} />
            <Detail label="목표가" value={item.targetPrices.map((price) => formatNumber(price, 8)).join(' / ')} />
            <Detail label="레버리지" value={item.leverage == null ? '해당 없음' : `${formatNumber(item.leverage)}배`} />
            <Detail label="AI 점수·신뢰도" value={`${formatNumber(item.signalScore)}점 · ${formatNumber(item.signalConfidence)}%`} />
            <Detail label="예상 손익비" value={item.signalRiskReward == null ? '데이터 없음' : `${formatNumber(item.signalRiskReward, 2)} : 1`} />
          </dl>

          <div className={cn(
            'mt-3 flex items-start gap-2 rounded-2xl border p-3 text-xs',
            enabled
              ? 'border-positive/40 bg-positive/10'
              : countdown.warning || liveBlocked || !signalMaintained
                ? 'border-destructive/40 bg-destructive/10'
                : 'border-warning/40 bg-warning/10',
          )} aria-live="polite">
            {validating || submitting
              ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              : enabled
                ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
            <div className="min-w-0">
              <p className="font-black">
                {validating ? '서버에서 승인 조건 재검증 중' : submitting ? '승인 요청 처리 중' : countdown.label}
              </p>
              <p className="mt-1 break-keep leading-5 text-muted-foreground">
                {enabled ? '신호 유지가 확인됐습니다. 확인 시 서버가 한 번 더 최종 재검증합니다.' : blockedReason}
              </p>
            </div>
          </div>

          <details className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
            <summary className="cursor-pointer font-extrabold">AI 근거와 위험 경고 보기</summary>
            <div className="mt-3 space-y-3">
              <div>
                <p className="font-bold text-muted-foreground">신호 근거</p>
                <ul className="mt-1 space-y-1">
                  {item.signalReasons.length
                    ? item.signalReasons.map((reason) => <li key={reason}>· {reason}</li>)
                    : <li>· 제공된 근거 없음</li>}
                </ul>
              </div>
              <div>
                <p className="font-bold text-muted-foreground">위험 경고</p>
                <ul className="mt-1 space-y-1">
                  {item.signalWarnings.length
                    ? item.signalWarnings.map((warning) => <li key={warning}>· {warning}</li>)
                    : <li>· 추가 경고 없음</li>}
                </ul>
              </div>
            </div>
          </details>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-card-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-extrabold disabled:opacity-40"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!enabled}
            data-testid="confirm-trade-approval"
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {validating || submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {submitting ? '승인 처리 중' : liveBlocked ? '실전 주문 차단' : '서버 최종검증 후 승인'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-background p-2.5">
      <dt className="text-[10px] font-bold text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}
