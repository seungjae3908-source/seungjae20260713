import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, WalletCards, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';

type Exchange = 'toss' | 'kiwoom' | 'upbit' | 'bitget';
type CredentialSource = 'vault' | 'none';

type Holding = {
  symbol?: string;
  name?: string;
  quantity?: number | null;
  averagePrice?: number | null;
  currentPrice?: number | null;
  evaluationAmount?: number | null;
  profitLoss?: number | null;
  profitRate?: number | null;
  currency?: string;
};

type ProviderBase = {
  configured: boolean;
  connected: boolean;
  credentialSource?: CredentialSource;
  vaultError?: string | null;
  error?: string | null;
};

type Snapshot = {
  ok: boolean;
  readOnly: boolean;
  mutationsAllowed: boolean;
  credentialsReturned?: boolean;
  checkedAt: string;
  providers?: {
    toss: ProviderBase & {
      connectionState?: string;
      holdingCount?: number;
      accounts?: Array<{ accountId: string; accountMasked: string | null; accountType: string }>;
      holdings?: Holding[];
    };
    kiwoom: ProviderBase & {
      accountMasked?: string | null;
      kr?: {
        ok: boolean;
        estimatedAssets?: number | null;
        totalEvaluationAmount?: number | null;
        totalProfitLoss?: number | null;
        totalProfitRate?: number | null;
        holdingCount: number;
        holdings: Holding[];
        error?: string | null;
      };
      us?: {
        ok: boolean;
        holdingCount: number;
        holdings: Holding[];
        error?: string | null;
      };
    };
    upbit: ProviderBase & {
      assetCount?: number;
      assets?: Array<{
        currency: string;
        balance: number | null;
        locked: number | null;
        averageBuyPrice: number | null;
        unitCurrency: string;
      }>;
    };
    bitget: ProviderBase & {
      accounts?: Array<{
        marginCoin: string;
        available: number | null;
        locked: number | null;
        accountEquity: number | null;
        unrealizedPL: number | null;
      }>;
      positions?: Array<{
        symbol: string;
        side: string;
        total: number | null;
        leverage: number | null;
        averageOpenPrice: number | null;
        markPrice: number | null;
        unrealizedPL: number | null;
        liquidationPrice: number | null;
      }>;
    };
  };
};

type CredentialDraft = {
  first: string;
  second: string;
  third: string;
};

const EMPTY_CREDENTIALS: CredentialDraft = { first: '', second: '', third: '' };

function amount(value: number | null | undefined, currency?: string) {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 6,
  }).format(value);
}

function Status({ configured, connected }: { configured: boolean; connected: boolean }) {
  const label = connected ? '연결됨' : configured ? '연결 확인 필요' : '키 미설정';
  const className = connected
    ? 'bg-positive/10 text-positive'
    : configured
      ? 'bg-warning/10 text-warning'
      : 'bg-secondary text-muted-foreground';
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${className}`}>{label}</span>;
}

function ErrorLine({ value }: { value?: string | null }) {
  if (!value) return null;
  return <p className="mt-2 break-words text-xs font-bold text-warning">{value}</p>;
}

function SourceLine({ source, vaultError }: { source?: CredentialSource; vaultError?: string | null }) {
  const label = source === 'vault' ? '회원별 암호화 저장소 사용' : '연결 키 없음';
  return <p className="mt-1 break-words text-[10px] text-muted-foreground">{label}{vaultError ? ` · Vault ${vaultError}` : ''}</p>;
}

export function BrokerageAccountConnections() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Exchange | null>(null);
  const [credentials, setCredentials] = useState<CredentialDraft>(EMPTY_CREDENTIALS);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await apiGet<Snapshot>('/trade-automation/account-connections/snapshot'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계좌 연결 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  function openSetup(exchange: Exchange) {
    setEditing(exchange);
    setCredentials(EMPTY_CREDENTIALS);
    setSaveMessage('');
  }

  async function saveConnection() {
    if (!editing || !credentials.first.trim() || !credentials.second.trim() || (editing === 'bitget' && !credentials.third.trim())) {
      setSaveMessage('필수 연결 키를 모두 입력해 주세요.');
      return;
    }
    const payload = editing === 'toss'
      ? { clientId: credentials.first.trim(), clientSecret: credentials.second.trim() }
      : editing === 'kiwoom'
        ? { appKey: credentials.first.trim(), secretKey: credentials.second.trim() }
        : editing === 'upbit'
          ? { accessKey: credentials.first.trim(), secretKey: credentials.second.trim() }
          : { apiKey: credentials.first.trim(), secretKey: credentials.second.trim(), passphrase: credentials.third.trim() };

    setSaving(true);
    setSaveMessage('');
    try {
      const response = await authorizedFetch(`/api/trade-automation/connections/${editing}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountMode: 'live',
          credentials: payload,
          permissions: ['read'],
        }),
      });
      const result = await response.json() as { configured?: boolean; credentialsReturned?: boolean; error?: string };
      if (!response.ok || result.configured !== true || result.credentialsReturned !== false) {
        throw new Error(result.error ?? '연결 정보를 안전하게 저장하지 못했습니다.');
      }
      setCredentials(EMPTY_CREDENTIALS);
      setEditing(null);
      setSaveMessage('연결 키를 암호화 저장했습니다. 조회 연결을 다시 확인합니다.');
      await refresh();
    } catch (cause) {
      setSaveMessage(cause instanceof Error ? cause.message : '연결 정보를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  const toss = snapshot?.providers?.toss;
  const kiwoom = snapshot?.providers?.kiwoom;
  const upbit = snapshot?.providers?.upbit;
  const bitget = snapshot?.providers?.bitget;

  return (
    <section data-testid="brokerage-account-connections" className="mt-4 min-w-0 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <WalletCards className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="text-sm font-extrabold">증권 · 거래소 계좌 연결</h2>
          </div>
          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
            잔고·보유·포지션 조회만 허용합니다. 연결 키는 서버에서 암호화하며 주문·취소·이체는 이 화면에서 실행되지 않습니다.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          className="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '확인 중' : '새로고침'}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-positive/10 p-3 text-xs font-bold text-positive">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">READ-ONLY · 주문/취소/이체 mutation 0건 · Secret 응답 0건</span>
      </div>

      {error ? <p className="mt-3 break-words rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p> : null}
      {saveMessage ? <p role="status" className="mt-3 break-words rounded-2xl bg-secondary p-3 text-xs font-bold">{saveMessage}</p> : null}

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-toss">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Toss Securities · 국내/미국주식</p><p className="mt-0.5 text-[11px] text-muted-foreground">주식 우선 연결 · 승인 전 안전 대기</p></div>
            <Status configured={Boolean(toss?.configured)} connected={Boolean(toss?.connected)} />
          </div>
          <SourceLine source={toss?.credentialSource} vaultError={toss?.vaultError} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="연결 계좌" value={`${toss?.accounts?.length ?? 0}개`} />
            <Metric label="보유 종목" value={`${toss?.holdingCount ?? 0}종목`} />
          </div>
          <HoldingList rows={(toss?.holdings ?? []).slice(0, 6)} />
          <SetupButton label="Toss Securities 연결 설정" onClick={() => openSetup('toss')} />
          {toss?.connectionState === 'WAITING_FOR_TOSS_API_ACCESS' ? <p className="mt-2 break-keep text-xs font-bold text-warning">Toss Open API 이용 승인이 필요합니다. 승인 전에는 연결됨으로 표시하지 않습니다.</p> : null}
          <ErrorLine value={toss?.error} />
        </article>

        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-kiwoom">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Kiwoom · 국내/미국주식</p><p className="mt-0.5 text-[11px] text-muted-foreground">{kiwoom?.accountMasked ? `계좌 ${kiwoom.accountMasked}` : '국내·미국 계좌 조회'}</p></div>
            <Status configured={Boolean(kiwoom?.configured)} connected={Boolean(kiwoom?.connected)} />
          </div>
          <SourceLine source={kiwoom?.credentialSource} vaultError={kiwoom?.vaultError} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="국내 추정자산" value={amount(kiwoom?.kr?.estimatedAssets, 'KRW')} />
            <Metric label="국내 평가손익" value={amount(kiwoom?.kr?.totalProfitLoss, 'KRW')} />
            <Metric label="국내 보유" value={`${kiwoom?.kr?.holdingCount ?? 0}종목`} />
            <Metric label="미국 보유" value={`${kiwoom?.us?.holdingCount ?? 0}종목`} />
          </div>
          <HoldingList rows={[...(kiwoom?.kr?.holdings ?? []), ...(kiwoom?.us?.holdings ?? [])].slice(0, 6)} />
          <SetupButton label="Kiwoom 연결 설정" onClick={() => openSetup('kiwoom')} />
          <ErrorLine value={kiwoom?.error ?? kiwoom?.kr?.error ?? kiwoom?.us?.error} />
        </article>

        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-upbit">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Upbit · 코인 현물</p><p className="mt-0.5 text-[11px] text-muted-foreground">자산조회 권한만 사용</p></div>
            <Status configured={Boolean(upbit?.configured)} connected={Boolean(upbit?.connected)} />
          </div>
          <SourceLine source={upbit?.credentialSource} vaultError={upbit?.vaultError} />
          <p className="mt-3 text-xs font-bold">보유 자산 {upbit?.assetCount ?? 0}개</p>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain">
            {(upbit?.assets ?? []).slice(0, 10).map((row) => (
              <div key={row.currency} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-extrabold">{row.currency}</span>
                <span className="shrink-0 tabular-nums">{amount(row.balance, row.unitCurrency)}</span>
              </div>
            ))}
          </div>
          <SetupButton label="Upbit 연결 설정" onClick={() => openSetup('upbit')} />
          <ErrorLine value={upbit?.error} />
        </article>

        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-bitget">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Bitget · 코인 선물</p><p className="mt-0.5 text-[11px] text-muted-foreground">계정·포지션 조회 전용</p></div>
            <Status configured={Boolean(bitget?.configured)} connected={Boolean(bitget?.connected)} />
          </div>
          <SourceLine source={bitget?.credentialSource} vaultError={bitget?.vaultError} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="선물 계정" value={`${bitget?.accounts?.length ?? 0}개`} />
            <Metric label="열린 포지션" value={`${(bitget?.positions ?? []).filter((row) => (row.total ?? 0) !== 0).length}개`} />
          </div>
          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">
            {(bitget?.positions ?? []).filter((row) => (row.total ?? 0) !== 0).slice(0, 8).map((row, index) => (
              <div key={`${row.symbol}-${row.side}-${index}`} className="rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 truncate font-extrabold">{row.symbol} · {row.side}</span><span className="shrink-0">{amount(row.total)}</span></div>
                <p className="mt-1 break-words text-[11px] text-muted-foreground">레버리지 {amount(row.leverage)}x · 미실현 {amount(row.unrealizedPL)}</p>
              </div>
            ))}
          </div>
          <SetupButton label="Bitget 연결 설정" onClick={() => openSetup('bitget')} />
          <ErrorLine value={bitget?.error} />
        </article>
      </div>

      {snapshot?.checkedAt ? <p className="mt-3 text-[11px] text-muted-foreground">최근 확인 {new Date(snapshot.checkedAt).toLocaleString('ko-KR')}</p> : null}

      {editing ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label={`${editing} 계좌 연결 설정`}>
          <div className="max-h-[88dvh] w-full max-w-md min-w-0 overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /><h3 className="text-base font-black">{editing === 'toss' ? 'Toss Securities' : editing === 'kiwoom' ? 'Kiwoom' : editing === 'upbit' ? 'Upbit' : 'Bitget'} 연결 설정</h3></div><p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">키는 AES-256-GCM 암호화 저장 후 서버 조회에만 사용하며 다시 화면에 표시하지 않습니다.</p></div>
              <button type="button" aria-label="연결 설정 닫기" onClick={() => { setEditing(null); setCredentials(EMPTY_CREDENTIALS); setSaveMessage(''); }} className="shrink-0 rounded-xl border border-card-border p-2"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-4 space-y-3">
              <SecretField label={editing === 'toss' ? 'Client ID' : editing === 'kiwoom' ? 'App Key' : editing === 'upbit' ? 'Access Key' : 'API Key'} value={credentials.first} onChange={(first) => setCredentials((value) => ({ ...value, first }))} testId={`${editing}-credential-primary`} />
              <SecretField label={editing === 'toss' ? 'Client Secret' : 'Secret Key'} value={credentials.second} onChange={(second) => setCredentials((value) => ({ ...value, second }))} testId={`${editing}-credential-secret`} />
              {editing === 'bitget' ? <SecretField label="Passphrase" value={credentials.third} onChange={(third) => setCredentials((value) => ({ ...value, third }))} testId="bitget-credential-passphrase" /> : null}
            </div>
            <div className="mt-4 rounded-2xl bg-warning/10 p-3 text-xs font-bold text-warning">API 키 권한은 조회(Read)만 허용하세요. 출금 권한이 포함된 키는 서버가 저장을 거부합니다.</div>
            <button type="button" disabled={saving} onClick={() => void saveConnection()} className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50" data-testid={`${editing}-save-connection`}>{saving ? '암호화 저장 중...' : '조회 전용 키 암호화 저장'}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SetupButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold"><KeyRound className="h-4 w-4" />{label}</button>;
}

function SecretField({ label, value, onChange, testId }: { label: string; value: string; onChange: (value: string) => void; testId: string }) {
  return <label className="block min-w-0 text-xs font-extrabold">{label}<input data-testid={testId} type="password" autoComplete="new-password" value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-11 w-full min-w-0 rounded-xl border border-card-border bg-background px-3 text-sm outline-none focus:border-primary" /></label>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-secondary/60 p-2.5"><p className="break-keep text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-extrabold tabular-nums">{value}</p></div>;
}

function HoldingList({ rows }: { rows: Holding[] }) {
  if (!rows.length) return null;
  return <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">{rows.map((row, index) => (
    <div key={`${row.symbol ?? row.name ?? 'holding'}-${index}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
      <span className="min-w-0 truncate font-extrabold">{row.name || row.symbol || '보유자산'}</span>
      <span className="shrink-0 tabular-nums">{amount(row.quantity)}</span>
    </div>
  ))}</div>;
}