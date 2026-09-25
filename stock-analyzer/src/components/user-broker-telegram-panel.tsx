import { useCallback, useEffect, useRef, useState } from 'react';
import { authorizedFetch, type AuthorizedFetchOptions } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { userIntegrationsRequestLifecycle } from '@/lib/user-integrations-request-lifecycle';
import { USER_MARKET_KO, USER_SIGNAL_KO, userFacingCodeLabel } from '@/lib/labels';

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

type TelegramRuntimeState = {
  deliveryReady: boolean;
  linkingReady: boolean;
  webhookConfigured: boolean;
  botUsernameConfigured: boolean;
  stockRoomReady: boolean;
  cryptoRoomReady: boolean;
  richSignalEnabled: boolean;
  aiExplanationEnabled: boolean;
  signalFollowupEnabled: boolean;
  memberHoldingsEnabled: boolean;
  marketBriefEnabled: boolean;
  orderAuthority: 'NONE';
  privateTradingApiAllowed: false;
  realOrderAllowed: false;
};

type IntegrationState = {
  brokerConnections: BrokerConnection[];
  telegram: { connected: boolean; status: string; connectedAt: string | null };
  preferences: Record<PreferenceKey, boolean>;
  alertPolicy: TelegramAlertPolicy;
  alertPolicySource: string;
  alertPolicyStorageAvailable: boolean;
  telegramRuntime: TelegramRuntimeState;
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

const marketLabels: Record<TelegramPolicyMarket, string> = Object.fromEntries(
  (['KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const).map((market) => [market, userFacingCodeLabel(market, USER_MARKET_KO)]),
) as Record<TelegramPolicyMarket, string>;

const signalLabels: Record<TelegramPolicySignalType, string> = Object.fromEntries(
  (['BUY', 'LONG', 'SHORT', 'NO_TRADE', 'PRICE_TARGET', 'STRATEGY_HEALTH', 'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR'] as const)
    .map((signal) => [signal, userFacingCodeLabel(signal, USER_SIGNAL_KO)]),
) as Record<TelegramPolicySignalType, string>;

const priorityLabels: Record<TelegramPolicyPriority, string> = {
  CRITICAL: '긴급',
  IMPORTANT: '중요',
  INFO: '일반',
};

const preferenceKeys = Object.keys(preferenceLabels) as PreferenceKey[];
const essentialExecutionPreferenceKeys: PreferenceKey[] = [
  'ORDER_FILLED',
  'ORDER_REJECTED',
  'POSITION_CLOSED',
  'TAKE_PROFIT_FILLED',
  'STOP_FILLED',
];
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

function normalizeTelegramRuntime(value: unknown): TelegramRuntimeState {
  const runtime = record(value) ?? {};
  return {
    deliveryReady: runtime.deliveryReady === true,
    linkingReady: runtime.linkingReady === true,
    webhookConfigured: runtime.webhookConfigured === true,
    botUsernameConfigured: runtime.botUsernameConfigured === true,
    stockRoomReady: runtime.stockRoomReady === true,
    cryptoRoomReady: runtime.cryptoRoomReady === true,
    richSignalEnabled: runtime.richSignalEnabled === true,
    aiExplanationEnabled: runtime.aiExplanationEnabled === true,
    signalFollowupEnabled: runtime.signalFollowupEnabled === true,
    memberHoldingsEnabled: runtime.memberHoldingsEnabled === true,
    marketBriefEnabled: runtime.marketBriefEnabled === true,
    orderAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
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
    telegramRuntime: normalizeTelegramRuntime(root.telegramRuntime),
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
  const [testSending, setTestSending] = useState(false);  const [error, setError] = useState<string | null>(null);

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
      setError(caught instanceof Error ? caught.message : '텔레그램 연결 링크를 만들지 못했습니다.');
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
      setError(caught instanceof Error ? caught.message : '텔레그램 연결을 해제하지 못했습니다.');
    }
  }

  async function sendTelegramTest() {
    if (!state?.telegram.connected || !state.telegramRuntime.deliveryReady || testSending) return;
    setTestSending(true);
    setError(null);
    setSyncNotice(null);
    try {
      const result = await api<{ status: string; attempts: number }>('/api/user-integrations/telegram/test', { method: 'POST' });
      setSyncNotice(`텔레그램 테스트 메시지 전송 완료 · ${result.attempts}회 시도`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '텔레그램 테스트 메시지 전송에 실패했습니다.');
    } finally {
      setTestSending(false);
    }
  }

  async function saveNotificationPreferences(patch: Partial<Record<PreferenceKey, boolean>>) {
    if (!state) return;
    const previous = state;
    setState({ ...state, preferences: { ...state.preferences, ...patch } });
    try {
      const result = await api<{ preferences: IntegrationState['preferences'] }>('/api/user-integrations/notifications', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setState((current) => current ? {
        ...current,
        preferences: normalizeIntegrationState({ preferences: result.preferences }).preferences,
      } : current);
    } catch (caught) {
      setState(previous);
      setError(caught instanceof Error ? caught.message : '알림 설정 저장에 실패했습니다.');
    }
  }

  async function togglePreference(key: PreferenceKey, value: boolean) {
    await saveNotificationPreferences({ [key]: value });
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
      setError(caught instanceof Error ? caught.message : '텔레그램 투자 알림 설정 저장에 실패했습니다.');
    } finally {
      setPolicySaving(false);
    }
  }

  if (loading && !state) return <section aria-busy="true" className="rounded-3xl border border-card-border bg-card p-4" data-testid="user-broker-telegram-panel" data-user-integrations-request-state={requestState}>개인 연결 상태를 불러오는 중…</section>;

  const policyDisabled = policySaving || state?.alertPolicyStorageAvailable === false;
  const stockAlertsOn = Boolean(state?.alertPolicy.markets.includes('KR') && state.alertPolicy.markets.includes('US'));
  const cryptoAlertsOn = Boolean(state?.alertPolicy.markets.includes('CRYPTO_SPOT') && state.alertPolicy.markets.includes('CRYPTO_FUTURES'));
  const holdingAlertsOn = Boolean(state?.alertPolicy.signalTypes.includes('PRICE_TARGET'));
  const executionAlertsOn = Boolean(state && essentialExecutionPreferenceKeys.every((key) => state.preferences[key]));
  const telegramHealthy = Boolean(state?.telegram.connected && state.telegramRuntime.deliveryReady);

  const toggleMarketGroup = async (markets: TelegramPolicyMarket[], value: boolean) => {
    if (!state) return;
    let next = [...state.alertPolicy.markets];
    for (const market of markets) next = toggleListValue(next, market, value);
    await saveAlertPolicy({ markets: next, ...(value ? { enabled: true } : {}) });
  };

  const toggleHoldingAlerts = async (value: boolean) => {
    if (!state) return;
    await saveAlertPolicy({
      signalTypes: toggleListValue(state.alertPolicy.signalTypes, 'PRICE_TARGET', value),
      ...(value ? { enabled: true } : {}),
    });
  };

  const toggleExecutionAlerts = async (value: boolean) => {
    const patch = Object.fromEntries(
      essentialExecutionPreferenceKeys.map((key) => [key, value]),
    ) as Partial<Record<PreferenceKey, boolean>>;
    await saveNotificationPreferences(patch);
  };

  return (
    <section
      aria-labelledby="user-integrations-title"
      className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm"
      data-testid="user-broker-telegram-panel"
      data-user-integrations-request-state={requestState}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="user-integrations-title" className="text-base font-black">텔레그램</h2>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${
          telegramHealthy ? 'bg-positive/10 text-positive' : 'bg-warning/10 text-warning'
        }`}>
          {telegramHealthy ? '정상' : state?.telegram.connected ? '확인 필요' : '연결 필요'}
        </span>
      </div>

      {error ? <div role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">{error}</div> : null}
      {syncNotice ? <p role="status" className="mt-3 rounded-xl bg-secondary p-3 text-xs font-bold">{syncNotice}</p> : null}

      {state ? <>
        <div className="mt-4 flex flex-wrap gap-2">
          {state.telegram.connected ? (
            <button className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold" type="button" onClick={() => void revokeTelegram()}>
              연결 해제
            </button>
          ) : (
            <button className="min-h-11 rounded-xl bg-primary px-4 text-xs font-black text-primary-foreground" type="button" onClick={() => void createTelegramLink()}>
              텔레그램 연결
            </button>
          )}
          <button
            type="button"
            className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50"
            disabled={!state.telegram.connected || !state.telegramRuntime.deliveryReady || testSending}
            onClick={() => void sendTelegramTest()}
          >
            {testSending ? '전송 중…' : '테스트 메시지'}
          </button>
        </div>
        {link ? <p className="mt-2 text-xs"><a className="font-bold underline" href={link} target="_blank" rel="noreferrer">텔레그램에서 연결 완료</a></p> : null}

        <div className="mt-4 divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-background" data-testid="telegram-simple-settings">
          <ToggleRow
            label="개인 투자 알림"
            checked={state.alertPolicy.enabled}
            disabled={policyDisabled}
            onChange={(value) => void saveAlertPolicy({ enabled: value })}
          />
          <ToggleRow
            label="주식 알림"
            checked={stockAlertsOn}
            disabled={policyDisabled}
            onChange={(value) => void toggleMarketGroup(['KR', 'US'], value)}
          />
          <ToggleRow
            label="코인 알림"
            checked={cryptoAlertsOn}
            disabled={policyDisabled}
            onChange={(value) => void toggleMarketGroup(['CRYPTO_SPOT', 'CRYPTO_FUTURES'], value)}
          />
          <ToggleRow
            label="내 보유종목"
            checked={holdingAlertsOn}
            disabled={policyDisabled || !state.telegramRuntime.memberHoldingsEnabled}
            onChange={(value) => void toggleHoldingAlerts(value)}
          />
          <ToggleRow
            label="자동매매 핵심 체결"
            checked={executionAlertsOn}
            onChange={(value) => void toggleExecutionAlerts(value)}
          />
          <div className="flex min-h-12 items-center justify-between gap-3 px-3 text-sm font-bold">
            <span>장전 리포트</span>
            <span className={state.telegramRuntime.marketBriefEnabled ? 'text-positive' : 'text-muted-foreground'}>
              {state.telegramRuntime.marketBriefEnabled ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        {state.alertPolicyStorageAvailable === false ? (
          <div role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
            알림 설정을 저장할 수 없습니다.
          </div>
        ) : null}

        <details className="mt-4 rounded-2xl border border-card-border bg-background p-3" data-testid="telegram-alert-policy-center">
          <summary className="cursor-pointer text-sm font-black">세부 설정</summary>

          <h3 className="mt-4 text-xs font-black">중요도</h3>
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

          <h3 className="mt-4 text-xs font-black">조용한 시간</h3>
          <label className="mt-2 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-card-border px-3 text-xs font-bold">
            <span>야간 일반 알림 끄기</span>
            <input
              type="checkbox"
              checked={state.alertPolicy.quietHours.enabled}
              disabled={policyDisabled}
              onChange={(event) => void saveAlertPolicy({ quietHours: { enabled: event.currentTarget.checked } })}
            />
          </label>
          {state.alertPolicy.quietHours.enabled ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
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
            </div>
          ) : null}

          <h3 className="mt-4 text-xs font-black">전송 방식</h3>
          <select
            aria-label="알림 방식"
            className="mt-2 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-xs text-foreground"
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

          {state.alertPolicy.deliveryMode === 'BATCHED' ? (
            <label className="mt-2 block text-[11px] text-muted-foreground">모아보기 간격(분)
              <input
                className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-2 text-xs text-foreground"
                type="number"
                min={1}
                max={1440}
                value={Math.max(1, minutes(state.alertPolicy.digest.windowMs))}
                disabled={policyDisabled}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (Number.isFinite(value) && value >= 1) void saveAlertPolicy({ digest: { enabled: true, windowMs: value * 60_000 } });
                }}
              />
            </label>
          ) : null}

          <details className="mt-3 rounded-xl border border-card-border p-3">
            <summary className="cursor-pointer text-xs font-bold">알림 종류</summary>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
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
          </details>

          <details className="mt-3 rounded-xl border border-card-border p-3">
            <summary className="cursor-pointer text-xs font-bold">체결 세부 알림</summary>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {preferenceKeys.map((key) => (
                <label key={key} className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border px-3 text-xs">
                  <input type="checkbox" checked={state.preferences[key]} onChange={(event) => void togglePreference(key, event.currentTarget.checked)} />
                  {preferenceLabels[key]}
                </label>
              ))}
            </div>
          </details>

          <details className="mt-3 rounded-xl border border-card-border p-3">
            <summary className="cursor-pointer text-xs font-bold">고급 설정</summary>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-[11px] text-muted-foreground">쿨다운(분)
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
              <label className="text-[11px] text-muted-foreground">중복 차단(분)
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
              <label className="text-[11px] text-muted-foreground">최대 반복
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
        </details>

        <details className="mt-3 rounded-2xl border border-card-border bg-background p-3">
          <summary className="cursor-pointer text-sm font-black">계좌 연결 상태</summary>
          {state.brokerConnections.length ? (
            <ul className="mt-3 space-y-2">
              {state.brokerConnections.map((connection) => (
                <li key={connection.exchange} className="flex items-center justify-between gap-3 rounded-xl border border-card-border px-3 py-2 text-xs">
                  <strong>{connection.exchange.toUpperCase()}</strong>
                  <span>{connection.configured ? '연결됨' : '미연결'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-xs text-muted-foreground">연결된 계좌 없음</p>}
          <button
            type="button"
            onClick={() => void syncExecutionState()}
            disabled={syncing || !state}
            className="mt-3 min-h-11 w-full rounded-xl border border-card-border px-3 text-xs font-bold disabled:opacity-50"
          >
            {syncing ? '동기화 중…' : '주문 결과 동기화'}
          </button>
        </details>

        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={loading}
          className="mt-3 min-h-11 rounded-xl px-3 text-xs font-bold text-muted-foreground disabled:opacity-50"
        >
          {loading ? '새로고침 중…' : '새로고침'}
        </button>
      </> : null}
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 px-3 text-sm font-bold">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}


export default UserBrokerTelegramPanel;
