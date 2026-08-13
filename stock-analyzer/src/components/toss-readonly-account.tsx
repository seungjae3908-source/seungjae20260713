import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, RefreshCw, ShieldCheck, Trash2, WalletCards } from 'lucide-react';

import { authorizedFetch } from '@/lib/auth-fetch';

type TossStatus = {
  ok: boolean;
  configured: boolean;
  updatedAt: string | null;
};

type TossHolding = {
  symbol: string;
  name: string | null;
  market: 'KR' | 'US' | 'UNKNOWN';
  currency: string | null;
  quantity: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  profitRatePercent: number | null;
};

type TossAccount = {
  accountRef: string;
  accountMasked: string;
  accountType: string | null;
  holdings: TossHolding[];
  buyingPower: { KRW: number | null; USD: number | null };
  summary: {
    marketValueKrw: number | null;
    marketValueUsd: number | null;
    unrealizedPnlKrw: number | null;
    unrealizedPnlUsd: number | null;
    profitRatePercent: number | null;
  };
  warnings: string[];
};

type TossSnapshot = {
  ok: boolean;
  connected: boolean;
  accounts: TossAccount[];
  checkedAt: string;
  orderRequests: 0;
  cancelRequests: 0;
  amendRequests: 0;
};

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP_${response.status}`);
  return value;
}

function money(value: number | null | undefined, currency: 'KRW' | 'USD') {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 2,
  }).format(value);
}

export function TossReadonlyAccount() {
  const [status, setStatus] = useState<TossStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TossSnapshot | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const response = await authorizedFetch('/api/account-connections/toss-readonly/status');
      setStatus(await json<TossStatus>(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Toss 연결 상태를 확인하지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function save() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Toss Open API Client ID와 Client Secret을 모두 입력해 주세요.');
      return;
    }
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await authorizedFetch('/api/account-connections/toss-readonly/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      await json(response);
      setClientId(''); setClientSecret(''); setShowSecret(false);
      setSnapshot(null);
      setMessage('Toss Open API 연결 정보를 암호화 저장했습니다. 계좌 조회를 눌러 실제 연결을 확인하세요.');
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Toss 연결 정보를 저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function loadSnapshot() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await authorizedFetch('/api/account-connections/toss-readonly/snapshot', {
        headers: { 'X-Toss-Readonly-Intent': 'account-snapshot' },
      });
      const value = await json<TossSnapshot>(response);
      setSnapshot(value);
      setMessage(`Toss 계좌 ${value.accounts.length}개를 읽기 전용으로 확인했습니다.`);
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : 'Toss 계좌 조회에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await authorizedFetch('/api/account-connections/toss-readonly/connection', { method: 'DELETE' });
      await json(response);
      setSnapshot(null);
      setStatus({ ok: true, configured: false, updatedAt: null });
      setMessage('저장된 Toss Open API 연결 정보를 삭제했습니다.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Toss 연결 정보를 삭제하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="toss-readonly-account" className="mt-4 min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-primary" /><h2 className="text-sm font-extrabold">Toss 증권 실계좌 조회</h2></div>
          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">실제 계좌·보유주식·매수가능금액만 조회합니다. 주문·취소·정정·이체·출금은 이 경로에서 지원하지 않습니다.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-[11px] font-extrabold ${status?.configured ? 'bg-positive/10 text-positive' : 'bg-secondary text-muted-foreground'}`}>{status?.configured ? '키 저장됨' : '미연결'}</span>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-2xl bg-positive/10 p-3 text-xs font-bold text-positive">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>READ-ONLY · 실주문 0 · 실취소 0 · 계좌번호/Secret 응답 0</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="min-w-0"><span className="text-xs font-extrabold text-muted-foreground">Toss Open API Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" className="mt-2 h-11 w-full rounded-2xl border border-card-border bg-background px-3 text-sm outline-none focus:border-primary" placeholder="Client ID" /></label>
        <label className="min-w-0"><span className="text-xs font-extrabold text-muted-foreground">Client Secret</span><div className="relative mt-2"><input type={showSecret ? 'text' : 'password'} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" className="h-11 w-full rounded-2xl border border-card-border bg-background px-3 pr-11 text-sm outline-none focus:border-primary" placeholder="Client Secret" /><button type="button" aria-label={showSecret ? 'Secret 숨기기' : 'Secret 보기'} onClick={() => setShowSecret((value) => !value)} className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-xl">{showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void save()} className="min-h-10 rounded-xl bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground disabled:opacity-50">연결 정보 저장</button>
        <button type="button" disabled={busy || !status?.configured} onClick={() => void loadSnapshot()} className="flex min-h-10 items-center gap-2 rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />계좌 조회</button>
        <button type="button" disabled={busy || !status?.configured} onClick={() => void remove()} className="flex min-h-10 items-center gap-2 rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold text-destructive disabled:opacity-50"><Trash2 className="h-4 w-4" />연결 삭제</button>
      </div>

      {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}
      {error ? <p role="alert" className="mt-3 break-words rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p> : null}

      {snapshot ? <div className="mt-4 space-y-3">
        {snapshot.accounts.map((account) => <article key={account.accountRef} className="rounded-2xl border border-card-border p-3" data-testid="toss-readonly-account-card">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-extrabold">계좌 {account.accountMasked}</p><span className="text-[11px] text-muted-foreground">{account.accountType ?? '계좌'}</span></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="KRW 매수가능" value={money(account.buyingPower.KRW, 'KRW')} />
            <Metric label="USD 매수가능" value={money(account.buyingPower.USD, 'USD')} />
            <Metric label="KRW 평가손익" value={money(account.summary.unrealizedPnlKrw, 'KRW')} />
            <Metric label="보유종목" value={`${account.holdings.length}개`} />
          </div>
          <div className="mt-3 max-h-52 space-y-1 overflow-y-auto overscroll-contain">
            {account.holdings.slice(0, 20).map((holding) => <div key={`${holding.market}-${holding.symbol}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs"><span className="min-w-0 truncate font-extrabold">{holding.name ?? holding.symbol} · {holding.symbol}</span><span className="shrink-0 tabular-nums">{holding.quantity ?? '-'}주 · {holding.currency === 'USD' ? '$' : '₩'}{holding.marketValue == null ? '-' : money(holding.marketValue, holding.currency === 'USD' ? 'USD' : 'KRW')}</span></div>)}
          </div>
          {account.warnings.length ? <p className="mt-2 break-words text-[11px] font-bold text-warning">일부 조회 제한: {account.warnings.join(', ')}</p> : null}
        </article>)}
        <p className="text-[11px] text-muted-foreground">최근 실제 조회 {new Date(snapshot.checkedAt).toLocaleString('ko-KR')}</p>
      </div> : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-secondary/60 p-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-extrabold tabular-nums">{value}</p></div>;
}
