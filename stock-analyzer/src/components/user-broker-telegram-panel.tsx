import { useCallback, useEffect, useRef, useState } from 'react';
import { authorizedFetch, type AuthorizedFetchOptions } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { userIntegrationsRequestLifecycle } from '@/lib/user-integrations-request-lifecycle';

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

type TelegramPolicyMarket = 'KR' | 'US' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
type TelegramPolicySignalType =
  | 'BUY'
  | 'LONG'
  | 'SHORT'
  | 'NO_TRADE'
  | 'PRICE_TARGET'
  | 'STRATEGY_HEALTH'
  | 'CHAMPION'
  | 'RESEARCH'
  | 'SETTLEMENT'
  | 'PROVIDER_SERVER_ERROR';
type TelegramPolicyPriority = 'CRITICAL' | 'IMPORTANT' | 'INFO';
type TelegramPolicyDeliveryMode = 'IMMEDIATE' | 'BATCHED';

type TelegramAlertPolicy = {
  userId: string;
  enabled: boolean;
  markets: TelegramPolicyMarket[];
  signalTypes: TelegramPolicySignalType[];
  priorities: TelegramPolicyPriority[];
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
    timeZone: string;
    criticalBypass: boolean;
  };
  cooldownMs: number;
  sameEventDedupeMs: number;
  sameSymbolWindowMs: number;
  sameSymbolRepeatLimit: number;
  deliveryMode: TelegramPolicyDeliveryMode;
  digest: {
    enabled: boolean;
    windowMs: number;
  };
};

type IntegrationState = {
  brokerConnections: BrokerConnection[];
  telegram: { connected: boolean; status: string; connectedAt: string | null };
  preferences: Record<PreferenceKey, boolean>;
  alertPolicy: TelegramAlertPolicy;
  alertPolicySource: string;
  alertPolicyStorageAvailable: boolean;
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

const marketLabels: Record<TelegramPolicyMarket, string> = {
  KR: '국내주식',
  US: '미국주식',
  CRYPTO_SPOT: '코인 현물',
  CRYPTO_FUTURES: '코인 선물',
};

const signalLabels: Record<TelegramPolicySignalType, string> = {
  BUY: 'BUY',
  LONG: '선물 LONG',
  SHORT: '선물 SHORT',
  NO_TRADE: 'NO TRADE',
  PRICE_TARGET: '목표가',
  STRATEGY_HEALTH: '전략 상태',
  CHAMPION: 'Champion',
  RESEARCH: 'Research',
  SETTLEMENT: '정산 결과',
  PROVIDER_SERVER_ERROR: '데이터·서버 오류',
};

const priorityLabels: Record<TelegramPolicyPriority, string> = {
  CRITICAL: '긴급',
  IMPORTANT: '중요',
  INFO: '일반',
};

const preferenceKeys = Object.keys(preferenceLabels) as PreferenceKey[];
const policyMarkets = Object.keys(marketLabels) as TelegramPolicyMarket[];
const policySignalTypes = Object.keys(signalLabels) as TelegramPolicySignalType[];
const policyPriorities = Object.keys(priorityLabels) as TelegramPolicyPriority[];
const VISIBLE_ACCOUNT_EXCHANGES = new Set(['toss', 'upbit', 'bitget']);
const DEFAULT_POLICY_WINDOW_MS = 5 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function knownArray<T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.filter((item): item is T => typeof item === 'string' && allowed.includes(item as T));
  if (normalized.length !== value.length || new Set(normalized).size !== normalized.length) return [...fallback];
  return normalized;
}

function normalizeAlertPolicy(value: unknown): TelegramAlertPolicy {
  const policy = record(value) ?? {};
  const quietHours = record(policy.quietHours) ?? {};
  const digest = record(policy.digest) ?? {};
  const deliveryMode = policy.deliveryMode === 'BATCHED' ? 'BATCHED' : 'IMMEDIATE';
  return {
    userId: typeof policy.userId === 'string' ? policy.userId : '',
    enabled: policy.enabled === true,
    markets: knownArray(policy.markets, policyMarkets, policyMarkets),
    signalTypes: knownArray(policy.signalTypes, policySignalTypes, policySignalTypes),
    priorities: knownArray(policy.priorities, policyPriorities, policyPriorities),
    quietHours: {
      enabled: quietHours.enabled === true,
      start: typeof quietHours.start === 'string' ? quietHours.start : '22:00',
      end: typeof quietHours.end === 'string' ? quietHours.end : '07:00',
      timeZone: typeof quietHours.timeZone === 'string' ? quietHours.timeZone : 'Asia/Seoul',
      criticalBypass: quietHours.criticalBypass === true,
    },
    cooldownMs: finiteNonNegative(policy.cooldownMs, DEFAULT_POLICY_WINDOW_MS),
    sameEventDedupeMs: finiteNonNegative(policy.sameEventDedupeMs, 24 * 60 * 60 * 1000),
    sameSymbolWindowMs: finiteNonNegative(policy.sameSymbolWindowMs, 60 * 60 * 1000),
    sameSymbolRepeatLimit: finiteNonNegative(policy.sameSymbolRepeatLimit, 3),
    deliveryMode,
    digest: {
      enabled: digest.enabled === true,
      windowMs: finiteNonNegative(digest.windowMs, 30 * 60 * 1000),
    },
  };
}

function normalizeIntegrationState(value: unknown): IntegrationState {
  const root = record(value) ?? {};
  const telegram = record(root.telegram) ?? {};
  const preferences = record(root.preferences) ?? {};
  const brokerConnections = Array.isArray(root.brokerConnections)
    ? root.brokerConnections.flatMap((item): BrokerConnection[] => {
      const connection = record(item);
      if (!connection || typeof connection.exchange !== 'string') return [];
      const exchange = connection.exchange.trim().toLowerCase();
      if (!VISIBLE_ACCOUNT_EXCHANGES.has(exchange)) return [];
      return [{
        exchange,
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
    alertPolicy: normalizeAlertPolicy(root.alertPolicy),
    alertPolicySource: typeof root.alertPolicySource === 'string' ? root.alertPolicySource : 'DEFAULT_MISSING',
    alertPolicyStorageAvailable: root.alertPolicyStorageAvailable !== false,
  };
}

function toggleListValue<T extends string>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((item) => item !== value);
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

async function api<T>(
  path: string,
  init?: RequestInit,
  fetchOptions?: AuthorizedFetchOptions,
): Promise<T> {
  const response = await authorizedFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  }, fetchOptions);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

export function UserBrokerTelegramPanel() {
  const auth = useAuth();
  const [state, setState] = useState<IntegrationState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<'pending' | 'success' | 'failure'>('pending');
  const mountedRef = useRef(false);
  const renderGenerationRef = useRef(0);
  const identity = auth.user?.id ?? null;
  const requestKey = auth.session ? `${auth.session.user.id}:${auth.session.access_token}` : null;

  const refresh = useCallback(async (force = true) => {
    if (!identity || !requestKey) return;
    const renderGeneration = ++renderGenerationRef.current;
    setLoading(true);
    setRequestState('pending');
    setError(null);
    const result = await userIntegrationsRequestLifecycle.request({
      identity,
      requestKey,
      force,
      load: (signal) => api<unknown>('/api/user-integrations', { signal }, { timeoutMs: null }),
    });
    if (
      !mountedRef.current
      || renderGenerationRef.current !== renderGeneration
      || !userIntegrationsRequestLifecycle.isCurrent(result)
    ) {
      return;
    }
    if (result.status === 'success') {
      setState(normalizeIntegrationState(result.value));
      setRequestState('success');
    } else {
      setError(result.error instanceof Error ? result.error.message : '연결 상태를 불러오지 못했습니다.');
      setRequestState('failure');
    }
    setLoading(false);
  }, [identity, requestKey]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh(false);
    return () => {
      mountedRef.current = false;
      renderGenerationRef.current += 1;
    };
  }, [refresh]);

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
      userIntegrationsRequestLifecycle.invalidate();
      await refresh(true);
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

  async function saveAlertPolicy(patch: Record<string, unknown>) {
    if (!state || state.alertPolicyStorageAvailable === false || policySaving) return;
    setPolicySaving(true);
    setError(null);
    try {
      const result = await api<{ alertPolicy: unknown; alertPolicySource?: string }>('/api/user-integrations/telegram-policy', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setState((current) => current ? {
        ...current,
        alertPolicy: normalizeAlertPolicy(result.alertPolicy),
        alertPolicySource: typeof result.alertPolicySource === 'string' ? result.alertPolicySource : current.alertPolicySource,
      } : current);
      userIntegrationsRequestLifecycle.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Telegram 투자 알림 설정 저장에 실패했습니다.');
    } finally {
      setPolicySaving(false);
    }
  }

  if (loading && !state) return <section aria-busy="true" className="rounded-3xl border border-card-border bg-card p-4" data-testid="user-broker-telegram-panel" data-user-integrations-request-state={requestState}>개인 연결 상태를 불러오는 중…</section>;

  const policyDisabled = policySaving || state?.alertPolicyStorageAvailable === false;

  return (
    <section aria-labelledby="user-integrations-title" className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="user-broker-telegram-panel" data-user-integrations-request-state={requestState}>
      <h2 id="user-integrations-title" className="text-sm font-extrabold">개인 Broker · Telegram 연결</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">실주문 활성화 화면이 아닙니다. 기존 Risk Engine과 승인된 OrderPlan 계약은 그대로 유지됩니다.</p>

      {error ? <div role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">{error}</div> : null}
      {syncNotice ? <p role="status" className="mt-3 rounded-xl bg-secondary p-3 text-xs font-bold">{syncNotice}</p> : null}

      {state ? <>
        <h3 className="mt-4 text-xs font-extrabold">Broker 연결 상태</h3>
        {state.brokerConnections.length ? (
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
        <p className="mt-1 text-xs">{state.telegram.connected ? '연결됨' : '연결 안 됨'} · {state.telegram.status}</p>
        {state.telegram.connected ? (
          <button className="mt-2 min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold" type="button" onClick={() => void revokeTelegram()}>Telegram 연결 해제</button>
        ) : (
          <button className="mt-2 min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold" type="button" onClick={() => void createTelegramLink()}>Telegram 연결</button>
        )}
        {link ? <p className="mt-2 text-xs"><a className="underline" href={link} target="_blank" rel="noreferrer">Telegram에서 연결 완료</a></p> : null}

        <div className="mt-4 rounded-2xl border border-card-border bg-background p-3" data-testid="telegram-alert-policy-center" aria-busy={policySaving}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-extrabold">Telegram 투자 알림센터</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">시장·신호·우선순위와 알림 빈도를 개인별로 설정합니다. 이 설정은 거래 판단이나 주문 권한을 바꾸지 않습니다.</p>
            </div>
            <span className="rounded-full border border-card-border px-2 py-1 text-[10px] font-bold">{policySaving ? '저장 중…' : state.alertPolicySource}</span>
          </div>

          {state.alertPolicyStorageAvailable === false ? (
            <div role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">Telegram 개인 알림 저장소를 사용할 수 없어 설정 변경을 차단했습니다.</div>
          ) : null}

          <label className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-card-border px-3 text-xs font-bold">
            <span>투자 알림 전체</span>
            <input
              type="checkbox"
              checked={state.alertPolicy.enabled}
              disabled={policyDisabled}
              onChange={(event) => void saveAlertPolicy({ enabled: event.currentTarget.checked })}
            />
          </label>

          <h4 className="mt-4 text-[11px] font-extrabold">시장</h4>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {policyMarkets.map((market) => (
              <label key={market} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border px-3 text-xs">
                <input
                  type="checkbox"
                  checked={state.alertPolicy.markets.includes(market)}
                  disabled={policyDisabled}
                  onChange={(event) => void saveAlertPolicy({
                    markets: toggleListValue(state.alertPolicy.markets, market, event.currentTarget.checked),
                  })}
                />
                {marketLabels[market]}
              </label>
            ))}
          </div>

          <h4 className="mt-4 text-[11px] font-extrabold">신호 종류</h4>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {policySignalTypes.map((signalType) => (
              <label key={signalType} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border px-3 text-xs">
                <input
                  type="checkbox"
                  checked={state.alertPolicy.signalTypes.includes(signalType)}
                  disabled={policyDisabled}
                  onChange={(event) => void saveAlertPolicy({
                    signalTypes: toggleListValue(state.alertPolicy.signalTypes, signalType, event.currentTarget.checked),
                  })}
                />
                {signalLabels[signalType]}
              </label>
            ))}
          </div>

          <h4 className="mt-4 text-[11px] font-extrabold">우선순위</h4>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {policyPriorities.map((priority) => (
              <label key={priority} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border px-3 text-xs">
                <input
                  type="checkbox"
                  checked={state.alertPolicy.priorities.includes(priority)}
                  disabled={policyDisabled}
                  onChange={(event) => void saveAlertPolicy({
                    priorities: toggleListValue(state.alertPolicy.priorities, priority, event.currentTarget.checked),
                  })}
                />
                {priorityLabels[priority]}
              </label>
            ))}
          </div>

          <h4 className="mt-4 text-[11px] font-extrabold">조용한 시간</h4>
          <label className="mt-2 flex min-h-11 items-center gap-2 rounded-xl border border-card-border px-3 text-xs">
            <input
              type="checkbox"
              checked={state.alertPolicy.quietHours.enabled}
              disabled={policyDisabled}
              onChange={(event) => void saveAlertPolicy({ quietHours: { enabled: event.currentTarget.checked } })}
            />
            지정 시간에는 일반 알림 끄기
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="text-[11px] text-muted-foreground">시작
              <input
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                type="time"
                value={state.alertPolicy.quietHours.start}
                disabled={policyDisabled}
                onChange={(event) => void saveAlertPolicy({ quietHours: { start: event.currentTarget.value } })}
              />
            </label>
            <label className="text-[11px] text-muted-foreground">종료
              <input
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                type="time"
                value={state.alertPolicy.quietHours.end}
                disabled={policyDisabled}
                onChange={(event) => void saveAlertPolicy({ quietHours: { end: event.currentTarget.value } })}
              />
            </label>
            <label className="text-[11px] text-muted-foreground">시간대
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                value={state.alertPolicy.quietHours.timeZone}
                disabled={policyDisabled}
                onChange={(event) => void saveAlertPolicy({ quietHours: { timeZone: event.currentTarget.value } })}
              >
                <option value="Asia/Seoul">서울</option>
                <option value="America/New_York">뉴욕</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end rounded-xl border border-card-border px-3 text-xs">
              <input
                type="checkbox"
                checked={state.alertPolicy.quietHours.criticalBypass}
                disabled={policyDisabled}
                onChange={(event) => void saveAlertPolicy({ quietHours: { criticalBypass: event.currentTarget.checked } })}
              />
              긴급은 허용
            </label>
          </div>

          <h4 className="mt-4 text-[11px] font-extrabold">전송 방식</h4>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-muted-foreground">알림 방식
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                value={state.alertPolicy.deliveryMode}
                disabled={policyDisabled}
                onChange={(event) => {
                  const deliveryMode = event.currentTarget.value as TelegramPolicyDeliveryMode;
                  void saveAlertPolicy(deliveryMode === 'BATCHED'
                    ? { deliveryMode, digest: { enabled: true, windowMs: Math.max(state.alertPolicy.digest.windowMs, 60_000) } }
                    : { deliveryMode });
                }}
              >
                <option value="IMMEDIATE">즉시 받기</option>
                <option value="BATCHED">모아서 받기</option>
              </select>
            </label>
            <label className="text-[11px] text-muted-foreground">모아보기 간격(분)
              <input
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                type="number"
                min={1}
                max={1440}
                value={Math.max(1, minutes(state.alertPolicy.digest.windowMs))}
                disabled={policyDisabled || state.alertPolicy.deliveryMode !== 'BATCHED'}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (Number.isFinite(value) && value >= 1) void saveAlertPolicy({ digest: { enabled: true, windowMs: value * 60_000 } });
                }}
              />
            </label>
          </div>

          <details className="mt-3 rounded-xl border border-card-border p-3">
            <summary className="cursor-pointer text-xs font-bold">고급 중복·빈도 설정</summary>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-[11px] text-muted-foreground">같은 대상 쿨다운(분)
                <input
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                  type="number"
                  min={0}
                  max={10080}
                  value={minutes(state.alertPolicy.cooldownMs)}
                  disabled={policyDisabled}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value) && value >= 0) void saveAlertPolicy({ cooldownMs: value * 60_000 });
                  }}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">같은 이벤트 차단(분)
                <input
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                  type="number"
                  min={0}
                  max={10080}
                  value={minutes(state.alertPolicy.sameEventDedupeMs)}
                  disabled={policyDisabled}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value) && value >= 0) void saveAlertPolicy({ sameEventDedupeMs: value * 60_000 });
                  }}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">같은 종목 창(분)
                <input
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                  type="number"
                  min={0}
                  max={10080}
                  value={minutes(state.alertPolicy.sameSymbolWindowMs)}
                  disabled={policyDisabled}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value) && value >= 0) void saveAlertPolicy({ sameSymbolWindowMs: value * 60_000 });
                  }}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">같은 종목 최대 횟수
                <input
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                  type="number"
                  min={0}
                  max={100}
                  value={state.alertPolicy.sameSymbolRepeatLimit}
                  disabled={policyDisabled}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isInteger(value) && value >= 0 && value <= 100) void saveAlertPolicy({ sameSymbolRepeatLimit: value });
                  }}
                />
              </label>
            </div>
          </details>
        </div>

        <h3 className="mt-4 text-xs font-extrabold">주문·포지션 이벤트 알림</h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {preferenceKeys.map((key) => (
            <label key={key} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border bg-background px-3 text-xs">
              <input type="checkbox" checked={state.preferences[key]} onChange={(event) => void togglePreference(key, event.currentTarget.checked)} />
              {preferenceLabels[key]}
            </label>
          ))}
        </div>
      </> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void refresh(true)} disabled={loading} className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50">
          {loading ? '새로고침 중…' : '연결 상태 새로고침'}
        </button>
        <button type="button" onClick={() => void syncExecutionState()} disabled={syncing || !state} className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50">
          {syncing ? '동기화 중…' : '주문 결과 동기화'}
        </button>
      </div>
    </section>
  );
}

export default UserBrokerTelegramPanel;
