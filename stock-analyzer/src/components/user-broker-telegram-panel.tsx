import { useCallback, useEffect, useState } from 'react';

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
  | 'POSITION_REDUCED'
  | 'POSITION_CLOSED'
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
  POSITION_REDUCED: '부분 청산',
  POSITION_CLOSED: '포지션 종료',
  MANUAL_PORTFOLIO_ENTRY: '수동 포트폴리오 등록',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
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
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await api<IntegrationState>('/api/user-integrations');
      setState(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '연결 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
      setState((current) => current ? { ...current, preferences: result.preferences } : current);
    } catch (caught) {
      setState(previous);
      setError(caught instanceof Error ? caught.message : '알림 설정 저장에 실패했습니다.');
    }
  }

  if (loading && !state) return <section aria-busy="true">개인 연결 상태를 불러오는 중…</section>;

  return (
    <section aria-labelledby="user-integrations-title">
      <h2 id="user-integrations-title">개인 Broker · Telegram 연결</h2>
      <p>실주문 활성화 화면이 아닙니다. 기존 Risk Engine과 승인된 OrderPlan 계약은 그대로 유지됩니다.</p>

      {error ? <div role="alert">{error}</div> : null}

      <h3>Broker 연결 상태</h3>
      {state?.brokerConnections.length ? (
        <ul>
          {state.brokerConnections.map((connection) => (
            <li key={connection.exchange}>
              <strong>{connection.exchange.toUpperCase()}</strong>{' '}
              {connection.configured ? '연결 정보 있음' : '미연결'} · {connection.accountMode}
              {connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ''}
            </li>
          ))}
        </ul>
      ) : <p>등록된 Broker 연결이 없습니다.</p>}

      <h3>Telegram</h3>
      <p>{state?.telegram.connected ? '연결됨' : '연결 안 됨'}</p>
      {state?.telegram.connected ? (
        <button type="button" onClick={() => void revokeTelegram()}>Telegram 연결 해제</button>
      ) : (
        <button type="button" onClick={() => void createTelegramLink()}>Telegram 연결</button>
      )}
      {link ? (
        <p><a href={link} target="_blank" rel="noreferrer">Telegram에서 연결 완료</a></p>
      ) : null}

      <h3>알림 설정</h3>
      <div>
        {state ? (Object.keys(preferenceLabels) as PreferenceKey[]).map((key) => (
          <label key={key} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={state.preferences[key]}
              onChange={(event) => void togglePreference(key, event.currentTarget.checked)}
            />{' '}
            {preferenceLabels[key]}
          </label>
        )) : null}
      </div>

      <button type="button" onClick={() => void refresh()} disabled={loading}>
        {loading ? '새로고침 중…' : '연결 상태 새로고침'}
      </button>
    </section>
  );
}

export default UserBrokerTelegramPanel;
