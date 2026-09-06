import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, WalletCards, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { resolveEvidenceDisplay } from '@/lib/evidence-display';

type Provider = 'toss' | 'upbit' | 'bitget';
type CredentialProvider = Provider;
type AccountReadStatus = 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'STALE' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'UNAVAILABLE';

type CanonicalBalance = { currency: string; available: number | null; locked: number | null; total: number | null; estimatedKrwValue: number | null };
type CanonicalPosition = { market: string; symbol: string; quantity: number | null; availableQuantity: number | null; averageEntryPrice: number | null; currentPrice: number | null; marketValue: number | null; unrealizedPnl: number | null; unrealizedPnlPercent: number | null; leverage: number | null; liquidationPrice: number | null; marginMode: string | null; side: string | null };
type CanonicalAccount = { market: 'KR' | 'US' | 'UPBIT' | 'BITGET'; accountRef: string | null; currency: string | null; buyingPower: number | null };
type CanonicalAccountSnapshot = {
  provider: Provider; readOnly: true; connected: boolean; status: AccountReadStatus;
  accounts?: CanonicalAccount[] | null; balances?: CanonicalBalance[] | null; positions?: CanonicalPosition[] | null; openOrders?: Array<unknown> | null;
  checkedAt: string; lastGoodAt: string | null; stale: boolean; errorCode: string | null;
  orderRequests: 0; cancelRequests: 0; amendRequests: 0; transferRequests: 0; withdrawalRequests: 0;
  credentialsReturned: false; liveTradingEnabled: false; autoTradingEnabled: false;
};
type CredentialDraft = { first: string; second: string; third: string };
type Props = { canAccessSpot?: boolean; canAccessFutures?: boolean };

const EMPTY_CREDENTIALS: CredentialDraft = { first: '', second: '', third: '' };

function evidenceAvailable(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return true;
  return snapshot.status !== 'AUTH_FAILED' && snapshot.status !== 'RATE_LIMITED' && snapshot.status !== 'UNAVAILABLE';
}

function accountEvidence(
  snapshot: CanonicalAccountSnapshot | undefined,
  value: number | string | null | undefined,
  formatter?: (value: number | string) => string,
) {
  return resolveEvidenceDisplay({
    value: snapshot?.connected ? value : null,
    collected: snapshot?.connected === true,
    stale: snapshot?.stale === true || snapshot?.status === 'STALE',
    available: evidenceAvailable(snapshot),
    formatter,
  }).display;
}

function amount(snapshot: CanonicalAccountSnapshot | undefined, value: number | null | undefined, currency?: string | null, suffix = '') {
  return accountEvidence(snapshot, value, (observed) => `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: currency === 'KRW' ? 0 : 8 }).format(Number(observed))}${suffix}`);
}

function countMetric(snapshot: CanonicalAccountSnapshot | undefined, value: number | null, suffix: string) {
  return accountEvidence(snapshot, value, (observed) => `${observed}${suffix}`);
}

function knownNonZeroCount<T>(rows: T[], select: (row: T) => number | null) {
  const values = rows.map(select);
  if (values.some((value) => value == null || !Number.isFinite(value))) return null;
  return values.filter((value) => value !== 0).length;
}

function isKnownNonZero(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

function credentialKnownConfigured(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return false;
  return snapshot.connected === true
    || snapshot.status === 'CONFIGURED_UNVERIFIED'
    || snapshot.status === 'STALE'
    || snapshot.status === 'AUTH_FAILED'
    || snapshot.status === 'RATE_LIMITED';
}

function statusLabel(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return '확인 전';
  if (snapshot.connected) return snapshot.stale ? '이전 정상값' : '연결됨';
  const labels: Record<AccountReadStatus, string> = { CONNECTED: '연결됨', CONFIGURED_UNVERIFIED: '검증 필요', NOT_CONFIGURED: '미연결', STALE: '이전 정상값', AUTH_FAILED: '인증 오류', RATE_LIMITED: '조회 제한', UNAVAILABLE: '조회 불가' };
  return labels[snapshot.status];
}

function Status({ snapshot }: { snapshot?: CanonicalAccountSnapshot }) {
  const connected = Boolean(snapshot?.connected);
  const caution = snapshot?.stale || snapshot?.status === 'CONFIGURED_UNVERIFIED' || snapshot?.status === 'RATE_LIMITED';
  const className = connected && !snapshot?.stale ? 'bg-positive/10 text-positive' : caution ? 'bg-warning/10 text-warning' : 'bg-secondary text-muted-foreground';
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>{statusLabel(snapshot)}</span>;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
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

  const enabledProviders = useCallback((): Provider[] => [
    'toss',
    ...(canAccessSpot ? ['upbit' as const] : []),
    ...(canAccessFutures ? ['bitget' as const] : []),
  ], [canAccessFutures, canAccessSpot]);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true); setError('');
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
    setSnapshots((current) => { const next = { ...current }; for (const result of results) if (result.value) next[result.provider] = result.value; return next; });
    setError(results.filter((result) => result.error).map((result) => `${result.provider.toUpperCase()}: ${result.error}`).join(' · '));
    setLoading(false);
  }, [enabledProviders]);

  useEffect(() => {
    void refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('online', onOnline);
    return () => {
      requestSequence.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  function openSetup(provider: CredentialProvider) { setEditing(provider); setCredentials(EMPTY_CREDENTIALS); setSaveMessage(''); }

  async function saveConnection() {
    if (!editing || !credentials.first.trim() || !credentials.second.trim() || (editing === 'bitget' && !credentials.third.trim())) {
      setSaveMessage('필수 조회 키를 모두 입력해 주세요.'); return;
    }
    const payload = editing === 'toss'
      ? { clientId: credentials.first.trim(), clientSecret: credentials.second.trim(), ...(credentials.third.trim() ? { accountSeq: credentials.third.trim() } : {}) }
      : editing === 'upbit'
        ? { accessKey: credentials.first.trim(), secretKey: credentials.second.trim() }
        : { apiKey: credentials.first.trim(), secretKey: credentials.second.trim(), passphrase: credentials.third.trim() };
    setSaving(true); setSaveMessage('');
    try {
      const result = await jsonRequest<{ configured: boolean; credentialsReturned: false }>(`/api/accounts/read-only/credentials/${editing}`, { method: 'PUT', body: JSON.stringify({ purpose: 'read_only', permissions: ['read'], credentials: payload }) });
      if (result.configured !== true || result.credentialsReturned !== false) throw new Error('READONLY_CREDENTIAL_SAVE_FAILED');
      const providerLabel = editing === 'toss' ? 'Toss' : editing === 'upbit' ? 'Upbit' : 'Bitget';
      setCredentials(EMPTY_CREDENTIALS); setEditing(null); setSaveMessage(`저장 완료 · ${providerLabel} 조회 전용 키를 암호화 Vault에 저장했습니다.`); await refresh();
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : '조회 키를 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }

  const toss = snapshots.toss; const upbit = snapshots.upbit; const bitget = snapshots.bitget;
  const tossPositions = Array.isArray(toss?.positions) ? toss.positions : [];
  const upbitBalances = Array.isArray(upbit?.balances) ? upbit.balances : [];
  const bitgetPositions = Array.isArray(bitget?.positions) ? bitget.positions : [];
  const visibleTossPositions = tossPositions.filter((row) => isKnownNonZero(row.quantity));
  const visibleUpbitBalances = upbitBalances.filter((row) => isKnownNonZero(row.total));
  const visibleBitgetPositions = bitgetPositions.filter((row) => isKnownNonZero(row.quantity));
  const editingCredentialConfigured = editing ? credentialKnownConfigured(snapshots[editing]) : false;

  return <section data-testid="brokerage-account-connections" className="mt-4 min-w-0 rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
    <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
      <span aria-hidden className="h-11 w-11" />
      <div className="min-w-0 text-center">
        <div className="flex items-center justify-center gap-2"><WalletCards className="h-5 w-5 shrink-0 text-primary" /><h2 className="text-base font-bold">실계좌 조회 연결</h2></div>
        <p className="mt-1 text-xs font-medium text-muted-foreground">잔고·보유·포지션만 조회합니다.</p>
      </div>
      <button type="button" aria-label="계좌 연결 새로고침" disabled={loading} onClick={() => void refresh()} className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border text-muted-foreground disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
    </div>

    <div className="mt-3 flex items-center justify-center gap-2 rounded-2xl bg-positive/10 p-3 text-center text-xs font-semibold text-positive"><ShieldCheck className="h-4 w-4 shrink-0" /><span>조회 전용 · 주문·취소·이체·출금 없음</span></div>
    <details className="mt-2 rounded-xl border border-card-border bg-background px-3 py-2 text-xs text-muted-foreground" data-testid="account-readonly-safety-details">
      <summary className="min-h-8 cursor-pointer text-center font-semibold text-foreground">보안·권한 상세</summary>
      <div className="border-t border-card-border pt-2 text-left leading-5">
        <p>Toss · Upbit · Bitget의 조회 전용 키만 사용하며 잔고·보유·포지션을 읽습니다.</p>
        <p className="mt-1">실주문/취소/이체/출금 요청 0건 · Secret 원문 응답 0건을 유지합니다.</p>
      </div>
    </details>
    {error ? <p role="alert" className="mt-3 break-words rounded-2xl bg-destructive/10 p-3 text-center text-xs font-semibold text-destructive">{error}</p> : null}
    {saveMessage ? <p role="status" className="mt-3 break-words rounded-2xl bg-secondary p-3 text-center text-xs font-semibold">{saveMessage}</p> : null}

    <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-3">
      <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-toss"><div className="flex min-w-0 items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-semibold">Toss · 국내/미국주식</p><p className="mt-0.5 text-xs text-muted-foreground">국내·미국 보유자산 조회</p></div><Status snapshot={toss} /></div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="연결 계좌" value={countMetric(toss, Array.isArray(toss?.accounts) ? toss.accounts.length : null, '개 시장')} /><Metric label="보유 종목" value={countMetric(toss, Array.isArray(toss?.positions) ? knownNonZeroCount(tossPositions, (row) => row.quantity) : null, '종목')} /></div>
        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">{visibleTossPositions.slice(0, 8).map((row, index) => <div key={`${row.symbol}-${index}`} className="rounded-xl bg-secondary/60 px-3 py-2 text-xs"><div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 truncate font-semibold">{row.symbol} · {row.market}</span><span className="shrink-0">{amount(toss, row.quantity)}</span></div><p className="mt-1 text-xs text-muted-foreground">평가 {amount(toss, row.marketValue)} · 손익 {amount(toss, row.unrealizedPnl)}</p></div>)}</div>
        <SetupButton label="Toss 연결 설정" onClick={() => openSetup('toss')} /><ErrorLine value={toss?.errorCode} />
      </article>

      {canAccessSpot ? <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-upbit"><div className="flex min-w-0 items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-semibold">Upbit · 코인 현물</p><p className="mt-0.5 text-xs text-muted-foreground">현물 보유자산 조회</p></div><Status snapshot={upbit} /></div><p className="mt-3 text-xs font-semibold">보유 자산 {countMetric(upbit, Array.isArray(upbit?.balances) ? knownNonZeroCount(upbitBalances, (row) => row.total) : null, '개')}</p><div className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain">{visibleUpbitBalances.slice(0, 10).map((row) => <div key={row.currency} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs"><span className="min-w-0 truncate font-semibold">{row.currency}</span><span className="shrink-0 tabular-nums">{amount(upbit, row.total, row.currency)}</span></div>)}</div><SetupButton label="Upbit 연결 설정" onClick={() => openSetup('upbit')} /><ErrorLine value={upbit?.errorCode} /></article> : null}

      {canAccessFutures ? <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-bitget"><div className="flex min-w-0 items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-semibold">Bitget · 코인 선물</p><p className="mt-0.5 text-xs text-muted-foreground">선물 포지션 조회</p></div><Status snapshot={bitget} /></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="선물 계정" value={countMetric(bitget, Array.isArray(bitget?.accounts) ? bitget.accounts.length : null, '개')} /><Metric label="열린 포지션" value={countMetric(bitget, Array.isArray(bitget?.positions) ? knownNonZeroCount(bitgetPositions, (row) => row.quantity) : null, '개')} /></div><div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">{visibleBitgetPositions.slice(0, 8).map((row, index) => <div key={`${row.symbol}-${row.side}-${index}`} className="rounded-xl bg-secondary/60 px-3 py-2 text-xs"><div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 truncate font-semibold">{row.symbol} · {accountEvidence(bitget, row.side)}</span><span className="shrink-0">{amount(bitget, row.quantity)}</span></div><p className="mt-1 break-words text-xs text-muted-foreground">레버리지 {amount(bitget, row.leverage, null, 'x')} · 미실현 {amount(bitget, row.unrealizedPnl)}</p></div>)}</div><SetupButton label="Bitget 연결 설정" onClick={() => openSetup('bitget')} /><ErrorLine value={bitget?.errorCode} /></article> : null}
    </div>

    <p className="mt-3 text-center text-xs text-muted-foreground">최근 확인 {latestCheckedAt(enabledProviders().map((provider) => snapshots[provider]))}</p>
    {editing ? <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-3 sm:items-center sm:justify-center" role="presentation"><div role="dialog" aria-modal="true" aria-label={`${providerLabel(editing)} 조회 연결 설정`} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-card p-4 shadow-2xl"><div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2"><span aria-hidden className="h-11 w-11" /><div className="min-w-0 text-center"><h3 className="truncate text-base font-bold">{providerLabel(editing)} 조회 전용 연결</h3><p className="mt-1 text-xs text-muted-foreground">거래·출금 권한 없이 조회 키만 저장합니다.</p></div><button type="button" aria-label="연결 설정 닫기" onClick={() => setEditing(null)} className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border"><X className="h-4 w-4" /></button></div><div className="mt-4 space-y-3">
      <CredentialField testId={`${editing}-credential-primary`} label={editing === 'toss' ? 'Client ID' : editing === 'upbit' ? 'Access Key' : 'API Key'} value={credentials.first} onChange={(value) => setCredentials((current) => ({ ...current, first: value }))} configured={editingCredentialConfigured} />
      <CredentialField testId={`${editing}-credential-secret`} label={editing === 'toss' ? 'Client Secret' : 'Secret Key'} value={credentials.second} onChange={(value) => setCredentials((current) => ({ ...current, second: value }))} configured={editingCredentialConfigured} />
      {editing === 'toss' ? <CredentialField testId="toss-account-seq" label="Account Seq (계좌가 여러 개인 경우만)" value={credentials.third} onChange={(value) => setCredentials((current) => ({ ...current, third: value }))} optional /> : null}
      {editing === 'bitget' ? <CredentialField testId="bitget-credential-passphrase" label="Passphrase" value={credentials.third} onChange={(value) => setCredentials((current) => ({ ...current, third: value }))} configured={editingCredentialConfigured} /> : null}
    </div><div className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-secondary p-3 text-center text-xs text-muted-foreground"><KeyRound className="h-4 w-4 shrink-0" /><span>저장된 키 원문은 다시 표시하지 않습니다.</span></div><button data-testid={`${editing}-save-connection`} type="button" aria-busy={saving} disabled={saving} onClick={() => void saveConnection()} className="mt-4 min-h-12 w-full rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving ? '저장 중…' : '조회 전용 키 저장'}</button></div></div> : null}
  </section>;
}

function providerLabel(provider: CredentialProvider) { return provider === 'toss' ? 'Toss' : provider === 'upbit' ? 'Upbit' : 'Bitget'; }
function latestCheckedAt(values: Array<CanonicalAccountSnapshot | undefined>) { const timestamps = values.map((value) => value?.checkedAt).filter((value): value is string => Boolean(value)); if (!timestamps.length) return resolveEvidenceDisplay({ value: null }).display; return new Date(timestamps.sort().at(-1)!).toLocaleString('ko-KR'); }
function ErrorLine({ value }: { value?: string | null }) { if (!value || value === 'ACCOUNT_READ_DISABLED' || value === 'ACCOUNT_NOT_CONFIGURED') return null; return <p className="mt-2 break-words text-center text-xs font-semibold text-warning">{value}</p>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl bg-secondary/60 p-2 text-center"><p className="truncate text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-semibold">{value}</p></div>; }
function SetupButton({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="mt-3 min-h-11 w-full rounded-xl border border-card-border px-3 text-xs font-semibold">{label}</button>; }
function CredentialField({ testId, label, value, onChange, optional = false, configured = false }: { testId: string; label: string; value: string; onChange: (value: string) => void; optional?: boolean; configured?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const placeholder = configured ? '•••••••• 저장됨 · 변경 시 새 값 입력' : `${label} 입력`;
  return <label className="block"><span className="text-xs font-semibold text-muted-foreground">{label}{optional ? ' · 선택' : ''}</span><div className="relative mt-2"><input data-testid={testId} aria-label={label} type={revealed ? 'text' : 'password'} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(event) => onChange(event.currentTarget.value)} className="h-12 w-full rounded-2xl border border-card-border bg-background px-4 pr-12 text-sm font-medium outline-none placeholder:text-muted-foreground/70 focus:border-primary" /><button data-testid={`${testId}-visibility`} type="button" disabled={!value} aria-label={`${label} ${revealed ? '숨기기' : '보기'}`} onClick={() => setRevealed((current) => !current)} className="absolute inset-y-0 right-1 flex w-11 items-center justify-center rounded-xl text-muted-foreground disabled:opacity-35">{revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{value ? '입력됨 · 아직 저장 전입니다.' : configured ? '기존 키가 암호화 저장되어 있습니다. 원문은 다시 표시하지 않습니다.' : '조회 전용 키를 입력해 주세요.'}</span></label>;
}