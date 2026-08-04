import { useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type RecoveryScanResponse = {
  ok?: boolean;
  resolved?: number;
  unresolved?: number;
  queriesSent?: number;
  orderResubmitted?: boolean;
  exchangeOrdersSubmitted?: boolean;
  exchangeCancelsSubmitted?: boolean;
  error?: string;
};

export function TradeRecoveryControl({ fixture = false }: { fixture?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function scan() {
    if (busy) return;
    setBusy(true);
    try {
      if (fixture) {
        setMessage('테스트 조회 완료 · 해결 0건 · 미해결 0건 · 재주문 0건');
        return;
      }
      const response = await authorizedFetch('/api/trade-automation/recovery/scan', {
        method: 'POST',
      });
      const payload = await response.json() as RecoveryScanResponse;
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? '복구 상태를 조회하지 못했습니다.');
      }
      if (payload.orderResubmitted !== false
        || payload.exchangeOrdersSubmitted !== false
        || payload.exchangeCancelsSubmitted !== false) {
        throw new Error('RECOVERY_SAFETY_CONTRACT_VIOLATED');
      }
      setMessage(
        `조회 ${payload.queriesSent ?? 0}건 · 해결 ${payload.resolved ?? 0}건 · `
        + `미해결 ${payload.unresolved ?? 0}건 · 재주문 0건`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '복구 상태를 조회하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="trade-recovery-control"
      className="mb-4 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-extrabold">불명확 주문 재조정·복구</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            timeout·네트워크·5xx 이후에는 같은 주문을 재주문하지 않고 client order ID로 상태만 조회합니다.
            확인되지 않으면 RECOVERY_REQUIRED 상태로 멈춥니다.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void scan()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm font-extrabold text-primary disabled:opacity-50"
      >
        <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
        거래소 상태 조회·복구
      </button>
      <p className="mt-2 text-[10px] font-bold text-muted-foreground">
        이 작업은 주문 생성·재전송·취소를 수행하지 않습니다.
      </p>
      {message && (
        <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">
          {message}
        </p>
      )}
    </section>
  );
}
