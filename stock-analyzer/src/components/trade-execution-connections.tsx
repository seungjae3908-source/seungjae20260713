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

type TradeConnectionStatus = {
  connections?: TradeConnection[];
  liveExecutionServerEnabled?: Partial<Record<Provider, boolean>>;
  liveAutomaticExecutionServerEnabled?: Partial<Record<Provider, boolean>>;
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
    title: 'Toss · 주식 실주문',
    subtitle: '국내/미국주식 · 주문조회 + 주문',
    fields: ['Client ID', 'Client Secret', 'Account Seq'],
  },
  kiwoom: {
    title: 'Kiwoom · 주식 실주문',
    subtitle: '국내/미국주식 · 주문조회 + 주문',
    fields: ['App Key', 'Secret Key'],
  },
  upbit: {
    title: 'Upbit · 현물 실주문',
    subtitle: 'KRW 현물 · 주문조회 + 주문',
    fields: ['Access Key', 'Secret Key'],
  },
  bitget: {
    title: 'Bitget · 선물 실주문',
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

  return <section className="mt-4 min-w-0 rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5" data-testid="trade-execution-connections">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 shrink-0 text-primary" />
          <h2 className="text-sm font-extrabold">실주문 거래 연결</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          조회 전용 연결과 별도입니다. 거래키는 계좌조회·주문조회·주문 권한만 사용하며 출금·이체 권한은 허용하지 않습니다.
        </p>
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

    <div className="mt-3 flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        거래키 저장 ≠ 실주문 활성화입니다. REAL ORDER·Private API·전체 활성화 승인·provider 게이트가 모두 ON이고 주문 직전 Risk 검사를 통과해야만 전송됩니다. 자동 실주문은 LIVE_AUTOMATIC_TRADING_ENABLED가 추가로 ON이어야 합니다.
      </p>
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {visibleProviders.map((provider) => {
        const connection = connections[provider];
        const connected = connection?.configured === true && connection.accountMode === 'live';
        const serverEnabled = status.liveExecutionServerEnabled?.[provider] === true;
        const automaticServerEnabled = status.liveAutomaticExecutionServerEnabled?.[provider] === true;
        return <article key={provider} className="min-w-0 rounded-2xl border border-card-border bg-background p-3" data-testid={`live-connection-${provider}`}>
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold">{PROVIDERS[provider].title}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{PROVIDERS[provider].subtitle}</p>
            </div>
            {connected
              ? <CheckCircle2 className="h-5 w-5 shrink-0 text-positive" />
              : <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <StateChip label="거래키" value={connected ? '저장됨' : '미연결'} good={connected} />
            <StateChip label="실주문" value={serverEnabled ? 'ON' : 'OFF'} good={serverEnabled} />
            <StateChip label="자동실주문" value={automaticServerEnabled ? 'ON' : 'OFF'} good={automaticServerEnabled} />
          </div>
          <p className="mt-2 break-words text-[10px] leading-4 text-muted-foreground">
            {connection?.lastVerifiedAt ? `마지막 확인 ${new Date(connection.lastVerifiedAt).toLocaleString('ko-KR')}` : '실주문 provider 검증 증거 없음'}
            {connection?.lastErrorCode ? ` · ${connection.lastErrorCode}` : ''}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {connected && <button
              type="button"
              disabled={busy === provider}
              onClick={() => void verifyConnection(provider)}
              className="min-h-10 rounded-xl border border-positive/30 px-2 text-[11px] font-extrabold text-positive disabled:opacity-50"
            >
              {busy === provider ? '검증 중' : '실계좌 검증'}
            </button>}
            <button
              type="button"
              onClick={() => openSetup(provider)}
              className={`min-h-10 rounded-xl bg-primary px-2 text-[11px] font-extrabold text-primary-foreground ${connected ? '' : 'col-span-3'}`}
            >
              {connected ? '거래키 교체' : '거래키 연결'}
            </button>
            {connected && disconnectConfirm !== provider ? <button
              type="button"
              onClick={() => setDisconnectConfirm(provider)}
              className="min-h-10 rounded-xl border border-destructive/30 px-2 text-[11px] font-extrabold text-destructive"
            >
              연결 해제
            </button> : connected ? <button
              type="button"
              disabled={busy === provider}
              onClick={() => void disconnect(provider)}
              className="min-h-10 rounded-xl bg-destructive px-2 text-[11px] font-extrabold text-white disabled:opacity-50"
            >
              {busy === provider ? '해제 중' : '해제 확인'}
            </button> : null}
          </div>
          {disconnectConfirm === provider && <button
            type="button"
            onClick={() => setDisconnectConfirm(null)}
            className="mt-2 flex min-h-9 w-full items-center justify-center gap-1 rounded-xl border border-card-border text-[11px] font-bold"
          >
            <X className="h-3.5 w-3.5" />해제 취소
          </button>}
        </article>;
      })}
    </div>

    <div className="mt-3 flex items-center gap-2 rounded-xl bg-secondary/60 p-2 text-[11px] text-muted-foreground">
      <LockKeyhole className="h-4 w-4 shrink-0" />
      <span>Secret 원문은 다시 표시하지 않으며 서버 암호화 Vault에만 저장합니다.</span>
    </div>

    {message && <p role="status" className="mt-3 break-words rounded-xl bg-secondary p-3 text-xs font-bold">{message}</p>}

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
