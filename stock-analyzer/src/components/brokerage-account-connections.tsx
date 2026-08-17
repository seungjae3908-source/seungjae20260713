import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, WalletCards, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';

type Provider = 'toss' | 'upbit' | 'bitget';
type CredentialProvider = 'upbit' | 'bitget';
type AccountReadStatus = 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'STALE' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'UNAVAILABLE';

type CanonicalBalance = {
  currency: string;
  available: number | null;
  locked: number | null;
  total: number | null;
  estimatedKrwValue: number | null;
};

type CanonicalPosition = {
  market: string;
  symbol: string;
  quantity: number | null;
  availableQuantity: number | null;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  marginMode: string | null;
  side: string | null;
};

type CanonicalAccount = {
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  accountRef: string | null;
  currency: string | null;
  buyingPower: number | null;
};

type CanonicalAccountSnapshot = {
  provider: Provider;
  readOnly: true;
  connected: boolean;
  status: AccountReadStatus;
  accounts: CanonicalAccount[];
  balances: CanonicalBalance[];
  positions: CanonicalPosition[];
  openOrders: Array<unknown>;
  checkedAt: string;
  lastGoodAt: string | null;
  stale: boolean;
  errorCode: string | null;
  orderRequests: 0;
  cancelRequests: 0;
  amendRequests: 0;
  transferRequests: 0;
  withdrawalRequests: 0;
  credentialsReturned: false;
  liveTradingEnabled: false;
  autoTradingEnabled: false;
};

type CredentialDraft = { first: string; second: string; third: string };
type Props = { canAccessSpot?: boolean; canAccessFutures?: boolean };

const EMPTY_CREDENTIALS: CredentialDraft = { first: '', second: '', third: '' };

function amount(value: number | null | undefined, currency?: string | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 8,
  }).format(value);
}

function statusLabel(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return '확인 전';
  if (snapshot.connected) return snapshot.stale ? '이전 정상값' : '연결됨';
  const labels: Record<AccountReadStatus, string> = {
    CONNECTED: '연결됨',
    CONFIGURED_UNVERIFIED: '검증 필요',
    NOT_CONFIGURED: '미연결',
    STALE: '이전 정상값',
    AUTH_FAILED: '인증 오류',
    RATE_LIMITED: '조회 제한',
    UNAVAILABLE: '조회 불가',
  };
  return labels[snapshot.status];
}

function Status({ snapshot }: { snapshot?: CanonicalAccountSnapshot }) {
  const connected = Boolean(snapshot?.connected);
  const caution = snapshot?.stale || snapshot?.status === 'CONFIGURED_UNVERIFIED' || snapshot?.status === 'RATE_LIMITED';
  const className = connected && !snapshot?.stale
    ? 'bg-positive/10 text-positive'
    : caution
      ? 'bg-warning/10 text-warning'
      : 'bg-secondary text-muted-foreground';
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${className}`}>{statusLabel(snapshot)}</span>;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as T & { error?: string; errorCode?: string };
  if (!response.ok) throw new Error(payload.errorCode ?? payload.error ?? `HTTP_${response.status}`);
  return payload;
}

export function BrokerageAccountConnections({ canAccessSpot = true, canAccessFutures = true }: Props) {
  const [snapshots, setSnapshots] = useState<Partial<Record<Provider, CanonicalAccountSnapshot>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CredentialProvider | null>(null);
  const [credentials, setCredentials] = useState<CredentialDraft>(EMPTY_CREDENTIALS);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const enabledProviders = useCallback(() => [
    'toss' as const,
    ...(canAccessSpot ? ['upbit' as const] : []),
    ...(canAccessFutures ? ['bitget' as const] : []),
  ], [canAccessFutures, canAccessSpot]);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');

    const results = await Promise.all(enabledProviders().map(async (provider) => {
      try {
        const value = await jsonRequest<CanonicalAccountSnapshot>(`/api/accounts/read-only/${provider}`, { signal: controller.signal });
        return { provider, value, error: null as string | null };
      } catch (cause) {
        if (controller.signal.aborted) return { provider, value: null, error: null };
        return { provider, value: null, error: cause instanceof Error ? cause.message : 'ACCOUNT_READ_FAILED' };
      }
    }));

    if (controller.signal.aborted || sequence !== requestSequence.current) return;
    setSnapshots((current) => {
      const next = { ...current };
      for (const result of results) if (result.value) next[result.provider] = result.value;
      return next;
    });
    const failures = results.filter((result) => result.error).map((result) => `${result.provider.toUpperCase()}: ${result.error}`);
    setError(failures.join(' · '));
    setLoading(false);
  }, [enabledProviders]);

  useEffect(() => {
    void refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      controllerRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  function openSetup(provider: CredentialProvider) {
    setEditing(provider);
    setCredentials(EMPTY_CREDENTIALS);
    setSaveMessage('');
  }

  async function saveConnection() {
    if (!editing || !credentials.first.trim() || !credentials.second.trim() || (editing === 'bitget' && !credentials.third.trim())) {
      setSaveMessage('필수 조회 키를 모두 입력해 주세요.');
      return;
    }
    const payload = editing === 'upbit'
      ? { accessKey: credentials.first.trim(), secretKey: credentials.second.trim() }
      : { apiKey: credentials.first.trim(), secretKey: credentials.second.trim(), passphrase: credentials.third.trim() };

    setSaving(true);
    setSaveMessage('');
    try {
      const result = await jsonRequest<{ configured: boolean; credentialsReturned: false }>(`/api/accounts/read-only/credentials/${editing}`, {
        method: 'PUT',
        body: JSON.stringify({
          purpose: 'read_only',
          permissions: ['read'],
          credentials: payload,
        }),
      });
      if (result.configured !== true || result.credentialsReturned !== false) throw new Error('READONLY_CREDENTIAL_SAVE_FAILED');
      const providerLabel = editing === 'upbit' ? 'Upbit' : 'Bitget';
      setCredentials(EMPTY_CREDENTIALS);
      setEditing(null);
      setSaveMessage(`${providerLabel} 조회 전용 키를 암호화 저장했습니다.`);
      await refresh();
    } catch (cause) {
      setSaveMessage(cause instanceof Error ? cause.message : '조회 키를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  const toss = snapshots.toss;
  const upbit = snapshots.upbit;
  const bitget = snapshots.bitget;

  return (
    <section data-testid="brokerage-account-connections" className="mt-4 min-w-0 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <WalletCards className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="text-sm font-extrabold">내 계좌 · READ-ONLY 연결</h2>
          </div>
          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
            내 계정의 암호화 Vault만 사용해 잔고·보유·포지션을 조회합니다. 주문·취소·이체·출금은 실행하지 않습니다.
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void refresh()} className="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '확인 중' : '새로고침'}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-positive/10 p-3 text-xs font-bold text-positive">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">READ-ONLY · 실주문/취소/이체/출금 0건 · Secret 원문 응답 0건</span>
      </div>

      {error ? <p role="alert" className="mt-3 break-words rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p> : null}
      {saveMessage ? <p role="status" className="mt-3 break-words rounded-2xl bg-secondary p-3 text-xs font-bold">{saveMessage}</p> : null}

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-3">
        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-toss">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Toss · 국내/미국주식</p><p className="mt-0.5 text-[11px] text-muted-foreground">계좌 조회 계약 준비 중</p></div>
            <Status snapshot={toss} />
          </div>
          <p className="mt-3 rounded-xl bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
            Toss private 계좌 조회는 별도 credential/runtime 계약 검증 전까지 fail-closed 상태입니다. 가짜 잔고는 표시하지 않습니다.
          </p>
          <ErrorLine value={toss?.errorCode} />
        </article>

        {canAccessSpot ? <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-upbit">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Upbit · 코인 현물</p><p className="mt-0.5 text-[11px] text-muted-foreground">내 Vault + GET /v1/accounts</p></div>
            <Status snapshot={upbit} />
          </div>
          <p className="mt-3 text-xs font-bold">보유 자산 {upbit?.balances.filter((row) => (row.total ?? 0) !== 0).length ?? 0}개</p>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain">
            {(upbit?.balances ?? []).filter((row) => (row.total ?? 0) !== 0).slice(0, 10).map((row) => (
              <div key={row.currency} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-extrabold">{row.currency}</span>
                <span className="shrink-0 tabular-nums">{amount(row.total, row.currency)}</span>
              </div>
            ))}
          </div>
          <SetupButton label="Upbit 조회 연결 설정" onClick={() => openSetup('upbit')} />
          <ErrorLine value={upbit?.errorCode} />
        </article> : null}

        {canAccessFutures ? <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-bitget">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Bitget · 코인 선물</p><p className="mt-0.5 text-[11px] text-muted-foreground">내 Vault + allowlisted GET 2종</p></div>
            <Status snapshot={bitget} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="선물 계정" value={`${bitget?.accounts.length ?? 0}개`} />
            <Metric label="열린 포지션" value={`${(bitget?.positions ?? []).filter((row) => (row.quantity ?? 0) !== 0).length}개`} />
          </div>
          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">
            {(bitget?.positions ?? []).filter((row) => (row.quantity ?? 0) !== 0).slice(0, 8).map((row, index) => (
              <div key={`${row.symbol}-${row.side}-${index}`} className="rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 truncate font-extrabold">{row.symbol} · {row.side ?? '-'}</span><span className="shrink-0">{amount(row.quantity)}</span></div>
                <p className="mt-1 break-words text-[11px] text-muted-foreground">레버리지 {amount(row.leverage)}x · 미실현 {amount(row.unrealizedPnl)}</p>
              </div>
            ))}
          </div>
          <SetupButton label="Bitget 조회 연결 설정" onClick={() => openSetup('bitget')} />
          <ErrorLine value={bitget?.errorCode} />
        </article> : null}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">최근 확인 {latestCheckedAt(enabledProviders().map((provider) => snapshots[provider]))}</p>

      {editing ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-3 sm:items-center sm:justify-center" role="presentation">
          <div role="dialog" aria-modal="true" aria-label={`${editing === 'upbit' ? 'Upbit' : 'Bitget'} 조회 연결 설정`} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-card p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0"><h3 className="truncate text-base font-extrabold">{editing === 'upbit' ? 'Upbit' : 'Bitget'} 조회 전용 연결</h3><p className="mt-1 text-xs text-muted-foreground">API 권한은 반드시 조회 전용으로 발급하고 거래·출금 권한은 켜지 마세요.</p></div>
              <button type="button" aria-label="연결 설정 닫기" onClick={() => setEditing(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-card-border"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-4 space-y-3">
              <CredentialField testId={`${editing}-credential-primary`} label={editing === 'upbit' ? 'Access Key' : 'API Key'} value={credentials.first} onChange={(value) => setCredentials((current) => ({ ...current, first: value }))} />
              <CredentialField testId={`${editing}-credential-secret`} label="Secret Key" value={credentials.second} onChange={(value) => setCredentials((current) => ({ ...current, second: value }))} />
              {editing === 'bitget' ? <CredentialField testId="bitget-credential-passphrase" label="Passphrase" value={credentials.third} onChange={(value) => setCredentials((current) => ({ ...current, third: value }))} /> : null}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-2xl bg-secondary p-3 text-xs text-muted-foreground"><KeyRound className="h-4 w-4 shrink-0" /><span>입력값은 사용자별 암호화 Vault에 저장되며 화면/API 응답으로 다시 노출하지 않습니다.</span></div>
            <button data-testid={`${editing}-save-connection`} type="button" disabled={saving} onClick={() => void saveConnection()} className="mt-4 min-h-12 w-full rounded-2xl bg-primary px-4 text-sm font-extrabold text-primary-foreground disabled:opacity-50">{saving ? '저장 중…' : '조회 전용으로 암호화 저장'}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function latestCheckedAt(values: Array<CanonicalAccountSnapshot | undefined>) {
  const timestamps = values.map((value) => value?.checkedAt).filter((value): value is string => Boolean(value));
  if (!timestamps.length) return '-';
  return new Date(timestamps.sort().at(-1)!).toLocaleString('ko-KR');
}

function ErrorLine({ value }: { value?: string | null }) {
  if (!value || value === 'ACCOUNT_READ_DISABLED' || value === 'ACCOUNT_NOT_CONFIGURED') return null;
  return <p className="mt-2 break-words text-xs font-bold text-warning">{value}</p>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-secondary/60 p-2"><p className="truncate text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-extrabold">{value}</p></div>;
}

function SetupButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="mt-3 min-h-11 w-full rounded-xl border border-card-border px-3 text-xs font-extrabold">{label}</button>;
}

function CredentialField({ testId, label, value, onChange }: { testId: string; label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="text-xs font-extrabold text-muted-foreground">{label}</span><input data-testid={testId} type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.currentTarget.value)} className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary" /></label>;
}
