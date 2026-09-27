import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, LockKeyhole, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';

type Provider = 'toss' | 'kiwoom' | 'upbit' | 'bitget';

type TradeConnection = {
  exchange: Provider;
  accountMode: 'paper' | 'mock' | 'live';
  configured: boolean;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  credentialsExposed: false;
};

type LiveExecutionReadiness = {
  connectionConfigured: boolean;
  providerVerified: boolean;
  manualServerGateEnabled: boolean;
  automaticServerGateEnabled: boolean;
  readyForManualOrderEvaluation: boolean;
  readyForAutomaticOrderEvaluation: boolean;
  blockers: string[];
  orderTimeRiskRecheckRequired: true;
  orderSubmissionPerformedByStatusRequest: false;
};

type TradeConnectionStatus = {
  connections?: TradeConnection[];
  liveExecutionServerEnabled?: Partial<Record<Provider, boolean>>;
  liveAutomaticExecutionServerEnabled?: Partial<Record<Provider, boolean>>;
  liveExecutionReadiness?: Partial<Record<Provider, LiveExecutionReadiness>>;
  credentialVault?: { encryptionConfigured: boolean; keyValueExposed: false };
};

type Props = {
  canAccessSpot?: boolean;
  canAccessFutures?: boolean;
};

type SecretDraft = {
  first: string;
  second: string;
  third: string;
};

const PROVIDERS: Record<Provider, {
  title: string;
  subtitle: string;
  fields: [string, string, string?];
}> = {
  toss: {
    title: 'Toss · 주식',
    subtitle: '국내/미국주식 · 주문조회 + 주문',
    fields: ['Client ID', 'Client Secret', 'Account Seq'],
  },
  kiwoom: {
    title: 'Kiwoom · 주식',
    subtitle: '국내/미국주식 · 주문조회 + 주문',
    fields: ['App Key', 'Secret Key'],
  },
  upbit: {
    title: 'Upbit · 현물',
    subtitle: 'KRW 현물 · 주문조회 + 주문',
    fields: ['Access Key', 'Secret Key'],
  },
  bitget: {
    title: 'Bitget · 선물',
    subtitle: 'USDT 선물 · 주문조회 + 주문',
    fields: ['API Key', 'Secret Key', 'Passphrase'],
  },
};

const EMPTY: SecretDraft = { first: '', second: '', third: '' };

function providerCredentials(provider: Provider, draft: SecretDraft) {
  if (provider === 'toss') {
    return { clientId: draft.first.trim(), clientSecret: draft.second.trim(), accountSeq: draft.third.trim() };
  }
  if (provider === 'kiwoom') {
    return { appKey: draft.first.trim(), secretKey: draft.second.trim() };
  }
  if (provider === 'upbit') {
    return { accessKey: draft.first.trim(), secretKey: draft.second.trim() };
  }
  return { apiKey: draft.first.trim(), secretKey: draft.second.trim(), passphrase: draft.third.trim() };
}

export function TradeExecutionConnections({
  canAccessSpot = true,
  canAccessFutures = true,
}: Props) {
  const [status, setStatus] = useState<TradeConnectionStatus>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [secrets, setSecrets] = useState<SecretDraft>(EMPTY);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<Provider | null>(null);
  const [message, setMessage] = useState('');

  const visibleProviders = useMemo(
    () => (Object.keys(PROVIDERS) as Provider[]).filter((provider) => (
      provider !== 'upbit' || canAccessSpot
    ) && (
      provider !== 'bitget' || canAccessFutures
    )),
    [canAccessFutures, canAccessSpot],
  );

  async function load() {
    setLoading(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/status');
      const payload = await response.json() as TradeConnectionStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? '실주문 연결 상태를 불러오지 못했습니다.');
      setStatus(payload);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '실주문 연결 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const connections = Object.fromEntries(
    (status.connections ?? []).map((connection) => [connection.exchange, connection]),
  ) as Partial<Record<Provider, TradeConnection>>;

  function openSetup(provider: Provider) {
    setEditing(provider);
    setSecrets(EMPTY);
    setAcknowledged(false);
    setDisconnectConfirm(null);
    setMessage('');
  }

  function closeSetup() {
    setEditing(null);
    setSecrets(EMPTY);
    setAcknowledged(false);
  }

  async function saveConnection(provider: Provider) {
    if (!acknowledged) {
      setMessage('조회 + 주문 권한만 사용하고 출금/이체 권한은 주지 않는다는 확인이 필요합니다.');
      return;
    }
    const credentials = providerCredentials(provider, secrets);
    if (Object.values(credentials).some((value) => !String(value).trim())) {
      setMessage('필수 거래키 정보를 모두 입력해 주세요.');
      return;
    }
    setBusy(provider);
    try {
      const response = await authorizedFetch(`/api/trade-automation/connections/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountMode: 'live',
          purpose: 'live_execution',
          permissions: ['read', 'orders'],
          credentials,
        }),
      });
      const payload = await response.json() as {
        error?: string;
        configured?: boolean;
        credentialsReturned?: boolean;
        liveExecutionActivated?: boolean;
        providerMutationRequests?: number;
      };
      if (!response.ok || payload.configured !== true) {
        throw new Error(payload.error ?? '실주문 거래키 저장에 실패했습니다.');
      }
      if (payload.credentialsReturned !== false
        || payload.liveExecutionActivated !== false
        || payload.providerMutationRequests !== 0) {
        throw new Error('LIVE_CONNECTION_SAFETY_CONTRACT_FAILED');
      }
      closeSetup();
      await load();
      setMessage('거래키를 암호화 저장했습니다. 서버 실주문 게이트는 별도이며, 저장만으로 주문은 실행되지 않습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '실주문 거래키 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  }

  async function verifyConnection(provider: Provider) {
    setBusy(provider);
    try {
      const response = await authorizedFetch(`/api/trade-automation/connections/${provider}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const payload = await response.json() as {
        error?: string;
        verified?: boolean;
        credentialsReturned?: boolean;
        liveExecutionActivated?: boolean;
        automaticLiveExecutionActivated?: boolean;
        orderRequests?: number;
        cancelRequests?: number;
        amendRequests?: number;
        transferRequests?: number;
        withdrawalRequests?: number;
        realOrderSubmitted?: boolean;
      };
      if (!response.ok || payload.verified !== true) {
        throw new Error(payload.error ?? '실주문 provider 검증에 실패했습니다.');
      }
      if (payload.credentialsReturned !== false
        || payload.liveExecutionActivated !== false
        || payload.automaticLiveExecutionActivated !== false
        || payload.orderRequests !== 0
        || payload.cancelRequests !== 0
        || payload.amendRequests !== 0
        || payload.transferRequests !== 0
        || payload.withdrawalRequests !== 0
        || payload.realOrderSubmitted !== false) {
        throw new Error('LIVE_CONNECTION_VERIFICATION_SAFETY_CONTRACT_FAILED');
      }
      await load();
      setMessage('실제 provider 인증·계좌/주문가능 조회를 확인했습니다. 검증 중 실제 주문·취소·정정은 0건입니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '실주문 provider 검증에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: Provider) {
    setBusy(provider);
    try {
      const response = await authorizedFetch(`/api/trade-automation/connections/${provider}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const payload = await response.json() as {
        error?: string;
        configured?: boolean;
        providerMutationRequests?: number;
        existingProviderOrdersCanceled?: boolean;
      };
      if (!response.ok || payload.configured !== false) {
        throw new Error(payload.error ?? '거래 연결 해제에 실패했습니다.');
      }
      if (payload.providerMutationRequests !== 0 || payload.existingProviderOrdersCanceled !== false) {
        throw new Error('LIVE_DISCONNECT_SAFETY_CONTRACT_FAILED');
      }
      setDisconnectConfirm(null);
      await load();
      setMessage('거래키 연결을 해제했습니다. 거래소의 기존 주문을 자동 취소하지는 않았습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '거래 연결 해제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  }

  return <section className="mt-3 min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm sm:p-4" data-testid="trade-execution-connections">
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <KeyRound className="h-5 w-5 shrink-0 text-primary" />
        <h2 className="truncate text-base font-bold">실주문 연결</h2>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-bold text-warning">별도 권한</span>
      </div>
      <button
        type="button"
        onClick={() => void load()}
        aria-label="실주문 연결 새로고침"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
      {visibleProviders.map((provider) => {
        const connection = connections[provider];
        const connected = connection?.configured === true && connection.accountMode === 'live';
        const providerVerified = connected && Boolean(connection?.lastVerifiedAt) && !connection?.lastErrorCode;
        const serverEnabled = status.liveExecutionServerEnabled?.[provider] === true;
        const automaticServerEnabled = status.liveAutomaticExecutionServerEnabled?.[provider] === true;
        const readiness = status.liveExecutionReadiness?.[provider];
        return <article key={provider} className="min-w-0 rounded-xl border border-card-border bg-background p-3" data-testid={`live-connection-${provider}`}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="truncate text-sm font-bold">{PROVIDERS[provider].title}</p>
            {connected
              ? <CheckCircle2 className="h-4 w-4 shrink-0 text-positive" />
              : <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
            <StateChip label="거래키" value={connected ? '연결' : '미연결'} good={connected} />
            <StateChip label="검증" value={providerVerified ? '완료' : '대기'} good={providerVerified} />
            <StateChip label="수동" value={serverEnabled ? 'ON' : 'OFF'} good={serverEnabled} />
            <StateChip label="자동" value={automaticServerEnabled ? 'ON' : 'OFF'} good={automaticServerEnabled} />
          </div>

          <div className="mt-2 flex min-h-5 items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{connection?.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString('ko-KR') : '검증 기록 없음'}</span>
            {readiness?.blockers?.length ? <span className="shrink-0 font-semibold text-warning">미준비 {readiness.blockers.length}</span> : null}
          </div>

          {connection?.lastErrorCode ? <p className="mt-1 truncate text-[10px] font-semibold text-warning">연결 오류</p> : null}

          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {connected ? <button
              type="button"
              disabled={busy === provider}
              onClick={() => void verifyConnection(provider)}
              className="min-h-10 rounded-lg border border-positive/30 px-2 text-[11px] font-bold text-positive disabled:opacity-50"
            >
              {busy === provider ? '검증 중' : '실계좌 검증'}
            </button> : null}
            <button
              type="button"
              onClick={() => openSetup(provider)}
              className={`min-h-10 rounded-lg bg-primary px-2 text-[11px] font-bold text-primary-foreground ${connected ? '' : 'col-span-2'}`}
            >
              {connected ? '키 변경' : '거래키 연결'}
            </button>
            {connected && disconnectConfirm !== provider ? <button
              type="button"
              onClick={() => setDisconnectConfirm(provider)}
              className="col-span-2 min-h-9 rounded-lg border border-destructive/30 px-2 text-[11px] font-bold text-destructive"
            >
              연결 해제
            </button> : connected ? <button
              type="button"
              disabled={busy === provider}
              onClick={() => void disconnect(provider)}
              className="col-span-2 min-h-9 rounded-lg bg-destructive px-2 text-[11px] font-bold text-white disabled:opacity-50"
            >
              {busy === provider ? '해제 중' : '해제 확인'}
            </button> : null}
          </div>
          {disconnectConfirm === provider ? <button
            type="button"
            onClick={() => setDisconnectConfirm(null)}
            className="mt-1.5 flex min-h-9 w-full items-center justify-center gap-1 rounded-lg border border-card-border text-[11px] font-bold"
          >
            <X className="h-3.5 w-3.5" />취소
          </button> : null}
        </article>;
      })}
    </div>

    {message ? <p role="status" className="mt-2 break-words rounded-xl bg-secondary px-3 py-2 text-xs font-bold">{friendlyTradeMessage(message)}</p> : null}

    {editing && <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="실주문 거래키 연결">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black">{PROVIDERS[editing].title}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">거래키는 저장 후 화면에 다시 표시되지 않습니다.</p>
          </div>
          <button type="button" onClick={closeSetup} aria-label="닫기" className="flex h-10 w-10 items-center justify-center rounded-xl border border-card-border"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 space-y-3">
          <SecretField label={PROVIDERS[editing].fields[0]} value={secrets.first} onChange={(value) => setSecrets((current) => ({ ...current, first: value }))} />
          <SecretField label={PROVIDERS[editing].fields[1]} value={secrets.second} onChange={(value) => setSecrets((current) => ({ ...current, second: value }))} />
          {PROVIDERS[editing].fields[2] ? <SecretField label={PROVIDERS[editing].fields[2]!} value={secrets.third} onChange={(value) => setSecrets((current) => ({ ...current, third: value }))} /> : null}
        </div>
        <label className="mt-4 flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span>
            이 키에는 <strong>조회 + 주문 권한만</strong> 부여하고 출금/이체 권한은 부여하지 않습니다. 저장만으로 실주문 서버게이트가 켜지지 않는 것을 확인합니다.
          </span>
        </label>
        <button
          type="button"
          disabled={!acknowledged || busy === editing}
          onClick={() => void saveConnection(editing)}
          className="mt-4 min-h-12 w-full rounded-2xl bg-primary px-4 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
        >
          {busy === editing ? '암호화 저장 중...' : '실주문 거래키 저장'}
        </button>
      </div>
    </div>}
  </section>;
}

function friendlyTradeMessage(value: string) {
  if (value === 'TRADE_AUTOMATION_STORAGE_UNAVAILABLE') return '거래 연결 저장소 확인 필요';
  if (/SAFETY_CONTRACT_FAILED/.test(value)) return '안전 검증 실패';
  return value;
}

function StateChip({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className={`rounded-xl p-2 ${good ? 'bg-positive/10 text-positive' : 'bg-secondary text-muted-foreground'}`}>
    <p className="text-[10px] font-medium">{label}</p>
    <p className="mt-0.5 font-extrabold">{value}</p>
  </div>;
}

function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block text-xs font-extrabold">
    {label}
    <input
      type="password"
      autoComplete="new-password"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="mt-2 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm"
    />
  </label>;
}
