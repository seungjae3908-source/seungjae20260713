import { useCallback, useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';

type BrokerConnection = {
  exchange: string;
  accountMode: string;
  configured: boolean;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  credentialsExposed: false;
};

type PreferenceKey =
  | 'ORDER_SUBMITTED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'POSITION_OPENED'
  | 'POSITION_INCREASED'
  | 'POSITION_REDUCED'
  | 'POSITION_CLOSED'
  | 'TAKE_PROFIT_FILLED'
  | 'STOP_FILLED'
  | 'MANUAL_PORTFOLIO_ENTRY';

type IntegrationState = {
  brokerConnections: BrokerConnection[];
  telegram: { connected: boolean; status: string; connectedAt: string | null };
  preferences: Record<PreferenceKey, boolean>;
};

const preferenceLabels: Record<PreferenceKey, string> = {
  ORDER_SUBMITTED: '주문 제출',
  ORDER_PARTIALLY_FILLED: '부분 체결',
  ORDER_FILLED: '전체 체결',
  ORDER_CANCELLED: '주문 취소',
  ORDER_REJECTED: '주문 거절',
  POSITION_OPENED: '포지션 시작',
  POSITION_INCREASED: '포지션 추가',
  POSITION_REDUCED: '부분 청산',
  POSITION_CLOSED: '포지션 종료',
  TAKE_PROFIT_FILLED: '익절 체결',
  STOP_FILLED: '손절 체결',
  MANUAL_PORTFOLIO_ENTRY: '수동 포트폴리오 등록',
};

const preferenceKeys = Object.keys(preferenceLabels) as PreferenceKey[];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeIntegrationState(value: unknown): IntegrationState {
  const root = record(value) ?? {};
  const telegram = record(root.telegram) ?? {};
  const preferences = record(root.preferences) ?? {};
  const brokerConnections = Array.isArray(root.brokerConnections)
    ? root.brokerConnections.flatMap((item): BrokerConnection[] => {
      const connection = record(item);
      if (!connection || typeof connection.exchange !== 'string') return [];
      return [{
        exchange: connection.exchange,
        accountMode: typeof connection.accountMode === 'string' ? connection.accountMode : 'disabled',
        configured: connection.configured === true,
        lastVerifiedAt: typeof connection.lastVerifiedAt === 'string' ? connection.lastVerifiedAt : null,
        lastErrorCode: typeof connection.lastErrorCode === 'string' ? connection.lastErrorCode : null,
        credentialsExposed: false,
      }];
    })
    : [];

  return {
    brokerConnections,
    telegram: {
      connected: telegram.connected === true,
      status: typeof telegram.status === 'string' ? telegram.status : 'DISCONNECTED',
      connectedAt: typeof telegram.connectedAt === 'string' ? telegram.connectedAt : null,
    },
    preferences: Object.fromEntries(
      preferenceKeys.map((key) => [key, preferences[key] === true]),
    ) as Record<PreferenceKey, boolean>,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

export function UserBrokerTelegramPanel() {
  const [state, setState] = useState<IntegrationState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await api<unknown>('/api/user-integrations');
      setState(normalizeIntegrationState(value));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '연결 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function syncExecutionState() {
    setSyncing(true);
    setError(null);
    setSyncNotice(null);
    try {
      const sync = await api<{ inserted: number; portfolioSynced?: number; deliveryQueued: number }>('/api/user-integrations/execution/sync', { method: 'POST' });
      setSyncNotice(sync.inserted > 0 ? `실행 이벤트 ${sync.inserted}건 동기화` : '새로 동기화할 실행 이벤트가 없습니다.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '주문 결과 동기화에 실패했습니다.');
    } finally {
      setSyncing(false);
    }
  }

  async function createTelegramLink() {
    setError(null);
    try {
      const result = await api<{ deepLink: string | null }>('/api/user-integrations/telegram/link', { method: 'POST' });
      if (!result.deepLink) throw new Error('TELEGRAM_BOT_USERNAME_NOT_CONFIGURED');
      setLink(result.deepLink);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Telegram 연결 링크를 만들지 못했습니다.');
    }
  }

  async function revokeTelegram() {
    setError(null);
    try {
      await api('/api/user-integrations/telegram', { method: 'DELETE' });
      setLink(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Telegram 연결을 해제하지 못했습니다.');
    }
  }

  async function togglePreference(key: PreferenceKey, value: boolean) {
    if (!state) return;
    const previous = state;
    setState({ ...state, preferences: { ...state.preferences, [key]: value } });
    try {
      const result = await api<{ preferences: IntegrationState['preferences'] }>('/api/user-integrations/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
      setState((current) => current ? { ...current, preferences: normalizeIntegrationState({ preferences: result.preferences }).preferences } : current);
    } catch (caught) {
      setState(previous);
      setError(caught instanceof Error ? caught.message : '알림 설정 저장에 실패했습니다.');
    }
  }

  if (loading && !state) return <section aria-busy="true" className="rounded-3xl border border-card-border bg-card p-4">개인 연결 상태를 불러오는 중…</section>;

  return (
    <section aria-labelledby="user-integrations-title" className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="user-broker-telegram-panel">
      <h2 id="user-integrations-title" className="text-sm font-extrabold">개인 Broker · Telegram 연결</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">실주문 활성화 화면이 아닙니다. 기존 Risk Engine과 승인된 OrderPlan 계약은 그대로 유지됩니다.</p>

      {error ? <div role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">{error}</div> : null}
      {syncNotice ? <p role="status" className="mt-3 rounded-xl bg-secondary p-3 text-xs font-bold">{syncNotice}</p> : null}

      <h3 className="mt-4 text-xs font-extrabold">Broker 연결 상태</h3>
      {state?.brokerConnections.length ? (
        <ul className="mt-2 space-y-2">
          {state.brokerConnections.map((connection) => (
            <li key={connection.exchange} className="rounded-xl border border-card-border bg-background p-3 text-xs">
              <strong>{connection.exchange.toUpperCase()}</strong>{' '}
              {connection.configured ? '연결 정보 있음' : '미연결'} · {connection.accountMode}
              {connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ''}
              <span className="mt-1 block text-[10px] text-muted-foreground">계좌·Secret 원문은 표시하지 않습니다.</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-xs text-muted-foreground">등록된 Broker 연결이 없습니다.</p>}

      <h3 className="mt-4 text-xs font-extrabold">Telegram</h3>
      <p className="mt-1 text-xs">{state?.telegram.connected ? '연결됨' : '연결 안 됨'}</p>
      {state?.telegram.connected ? (
        <button className="mt-2 min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold" type="button" onClick={() => void revokeTelegram()}>Telegram 연결 해제</button>
      ) : (
        <button className="mt-2 min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold" type="button" onClick={() => void createTelegramLink()}>Telegram 연결</button>
      )}
      {link ? <p className="mt-2 text-xs"><a className="underline" href={link} target="_blank" rel="noreferrer">Telegram에서 연결 완료</a></p> : null}

      <h3 className="mt-4 text-xs font-extrabold">알림 설정</h3>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {state ? preferenceKeys.map((key) => (
          <label key={key} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border bg-background px-3 text-xs">
            <input type="checkbox" checked={state.preferences[key]} onChange={(event) => void togglePreference(key, event.currentTarget.checked)} />
            {preferenceLabels[key]}
          </label>
        )) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void refresh()} disabled={loading} className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50">
          {loading ? '새로고침 중…' : '연결 상태 새로고침'}
        </button>
        <button type="button" onClick={() => void syncExecutionState()} disabled={syncing} className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50">
          {syncing ? '동기화 중…' : '주문 결과 동기화'}
        </button>
      </div>
    </section>
  );
}

export default UserBrokerTelegramPanel;
