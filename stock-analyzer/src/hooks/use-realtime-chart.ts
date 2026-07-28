import { useEffect, useState } from 'react';
import { normalizeRealtimeTimeframe } from '@/lib/chart-preferences';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

export type RealtimeChartAsset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
export type RealtimeChartStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'live'
  | 'reconnecting'
  | 'error';

export type RealtimeCandle = {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RealtimeChartSnapshot = {
  asset: RealtimeChartAsset;
  symbol: string;
  interval: string;
  provider: string;
  fetchedAt: string;
  candles: RealtimeCandle[];
  signals: Record<string, unknown>[];
  plan: Record<string, unknown> | null;
};

export type RealtimeChartState = {
  status: RealtimeChartStatus;
  snapshot: RealtimeChartSnapshot | null;
  provider: string | null;
  updatedAt: string | null;
  error: string | null;
};

type UseRealtimeChartInput = {
  asset: RealtimeChartAsset;
  symbol: string;
  interval: string;
  enabled: boolean;
};

type Listener = (state: RealtimeChartState) => void;

type SharedChannel = {
  key: string;
  asset: RealtimeChartAsset;
  symbol: string;
  interval: string;
  listeners: Set<Listener>;
  state: RealtimeChartState;
  socket: WebSocket | null;
  reconnectTimer: number | null;
  disposeTimer: number | null;
  reconnectAttempt: number;
  reconnectAllowed: boolean;
  generation: number;
};

const channels = new Map<string, SharedChannel>();
const EMPTY_STATE: RealtimeChartState = {
  status: 'idle',
  snapshot: null,
  provider: null,
  updatedAt: null,
  error: null,
};

function realtimeUrl(): string {
  const apiBase = String(import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');
  const url = new URL(
    `${apiBase}/realtime/chart`,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSnapshot(value: Record<string, unknown>): RealtimeChartSnapshot | null {
  if (value.type !== 'snapshot' || !Array.isArray(value.candles)) return null;
  const asset = String(value.asset ?? '') as RealtimeChartAsset;
  if (!['stockKR', 'stockUS', 'coinSpot', 'coinFutures'].includes(asset)) return null;

  const candles: RealtimeCandle[] = [];
  for (const row of value.candles) {
    if (!isRecord(row)) continue;
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume ?? 0);
    if (
      row.time == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    candles.push({
      time: typeof row.time === 'number' ? row.time : String(row.time),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? Math.max(0, volume) : 0,
    });
  }
  if (candles.length < 2) return null;

  return {
    asset,
    symbol: String(value.symbol ?? '').trim().toUpperCase(),
    interval: normalizeRealtimeTimeframe(value.interval) ?? String(value.interval ?? ''),
    provider: String(value.provider ?? 'unknown'),
    fetchedAt: String(value.fetchedAt ?? new Date().toISOString()),
    candles,
    signals: Array.isArray(value.signals) ? value.signals.filter(isRecord) : [],
    plan: isRecord(value.plan) ? value.plan : null,
  };
}

async function accessToken(): Promise<string> {
  if (!isSupabaseConfigured) throw new Error('AUTH_NOT_CONFIGURED');
  const result = await new Promise<
    Awaited<ReturnType<ReturnType<typeof getSupabase>['auth']['getSession']>> | null
  >((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(null), 5_000);
    getSupabase().auth.getSession().then(
      (session) => {
        window.clearTimeout(timer);
        resolve(session);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
  const token = result?.data.session?.access_token;
  if (!token) throw new Error('LOGIN_REQUIRED');
  return token;
}

function emit(channel: SharedChannel, changes: Partial<RealtimeChartState>): void {
  channel.state = { ...channel.state, ...changes };
  for (const listener of channel.listeners) listener(channel.state);
}

function clearReconnect(channel: SharedChannel): void {
  if (channel.reconnectTimer != null) {
    window.clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
  }
}

function scheduleReconnect(channel: SharedChannel): void {
  if (
    channel.listeners.size === 0 ||
    !channel.reconnectAllowed ||
    channel.reconnectTimer != null
  ) {
    return;
  }
  channel.reconnectAttempt += 1;
  const delay = Math.min(
    15_000,
    1_000 * 2 ** Math.min(channel.reconnectAttempt - 1, 4),
  );
  emit(channel, { status: 'reconnecting' });
  channel.reconnectTimer = window.setTimeout(() => {
    channel.reconnectTimer = null;
    void connectChannel(channel);
  }, delay);
}

async function connectChannel(channel: SharedChannel): Promise<void> {
  if (channel.listeners.size === 0 || typeof WebSocket === 'undefined') return;
  if (
    channel.socket &&
    (channel.socket.readyState === WebSocket.CONNECTING ||
      channel.socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  const generation = ++channel.generation;
  emit(channel, {
    status: channel.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
    error: null,
  });

  try {
    const token = await accessToken();
    if (channel.listeners.size === 0 || channel.generation !== generation) return;

    const socket = new WebSocket(realtimeUrl());
    channel.socket = socket;

    socket.onopen = () => {
      if (channel.generation !== generation || channel.listeners.size === 0) {
        socket.close(1000, 'STALE_CONNECTION');
        return;
      }
      emit(channel, { status: 'connected', error: null });
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          accessToken: token,
          asset: channel.asset,
          symbol: channel.symbol,
          interval: channel.interval,
        }),
      );
    };

    socket.onmessage = (event) => {
      if (channel.generation !== generation || channel.socket !== socket) return;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isRecord(parsed)) return;

        const snapshot = normalizeSnapshot(parsed);
        if (snapshot) {
          if (
            snapshot.asset !== channel.asset ||
            snapshot.symbol !== channel.symbol ||
            snapshot.interval !== channel.interval
          ) {
            return;
          }
          channel.reconnectAttempt = 0;
          emit(channel, {
            status: 'live',
            snapshot,
            provider: snapshot.provider,
            updatedAt: snapshot.fetchedAt,
            error: null,
          });
          return;
        }

        if (parsed.type === 'status') {
          if (parsed.status === 'live') channel.reconnectAttempt = 0;
          emit(channel, {
            status: parsed.status === 'live' ? 'live' : 'connected',
            provider:
              typeof parsed.provider === 'string'
                ? parsed.provider
                : channel.state.provider,
            updatedAt:
              typeof parsed.fetchedAt === 'string'
                ? parsed.fetchedAt
                : channel.state.updatedAt,
            error: null,
          });
          return;
        }

        if (parsed.type === 'error') {
          const error = String(
            parsed.message ?? parsed.code ?? 'REALTIME_CONNECTION_ERROR',
          );
          if (parsed.retryable === false) channel.reconnectAllowed = false;
          emit(channel, { status: 'error', error });
        }
      } catch {
        emit(channel, {
          status: 'error',
          error: '실시간 데이터 응답 형식이 올바르지 않습니다.',
        });
      }
    };

    socket.onerror = () => {
      if (channel.generation !== generation || channel.socket !== socket) return;
      emit(channel, {
        status: 'error',
        error: '실시간 연결에 실패했습니다.',
      });
    };

    socket.onclose = () => {
      if (channel.socket === socket) channel.socket = null;
      if (channel.generation === generation) scheduleReconnect(channel);
    };
  } catch (cause) {
    if (channel.generation !== generation || channel.listeners.size === 0) return;
    const error =
      cause instanceof Error ? cause.message : 'REALTIME_CONNECTION_ERROR';
    channel.reconnectAllowed =
      error !== 'AUTH_NOT_CONFIGURED' && error !== 'LOGIN_REQUIRED';
    emit(channel, { status: 'error', error });
    if (channel.reconnectAllowed) scheduleReconnect(channel);
  }
}

function channelFor(
  asset: RealtimeChartAsset,
  symbol: string,
  interval: string,
): SharedChannel {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedInterval = normalizeRealtimeTimeframe(interval) ?? interval;
  const key = `${asset}:${normalizedSymbol}:${normalizedInterval}`;
  const existing = channels.get(key);
  if (existing) return existing;

  const channel: SharedChannel = {
    key,
    asset,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    listeners: new Set(),
    // 첫 렌더에서는 REST fallback이 즉시 시작될 수 있도록 idle로 둔다.
    // 실제 연결 시도 직전에 connectChannel이 connecting으로 전환한다.
    state: { ...EMPTY_STATE },
    socket: null,
    reconnectTimer: null,
    disposeTimer: null,
    reconnectAttempt: 0,
    reconnectAllowed: true,
    generation: 0,
  };
  channels.set(key, channel);
  return channel;
}

function subscribe(channel: SharedChannel, listener: Listener): () => void {
  if (channel.disposeTimer != null) {
    window.clearTimeout(channel.disposeTimer);
    channel.disposeTimer = null;
  }
  channel.listeners.add(listener);
  listener(channel.state);
  void connectChannel(channel);

  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size > 0 || channel.disposeTimer != null) return;

    // 화면 간 이동 시 같은 구독을 재사용할 수 있도록 짧은 유예를 둔다.
    channel.disposeTimer = window.setTimeout(() => {
      channel.disposeTimer = null;
      if (channel.listeners.size > 0) return;
      channel.reconnectAllowed = false;
      channel.generation += 1;
      clearReconnect(channel);
      const socket = channel.socket;
      channel.socket = null;
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close(1000, 'NO_SUBSCRIBERS');
      }
      channels.delete(channel.key);
    }, 1_500);
  };
}

export function useRealtimeChart({
  asset,
  symbol,
  interval,
  enabled,
}: UseRealtimeChartInput): RealtimeChartState {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedInterval = normalizeRealtimeTimeframe(interval) ?? interval;
  const key = `${asset}:${normalizedSymbol}:${normalizedInterval}`;
  const [state, setState] = useState<RealtimeChartState>(() =>
    enabled && normalizedSymbol
      ? channelFor(asset, normalizedSymbol, normalizedInterval).state
      : EMPTY_STATE,
  );

  useEffect(() => {
    if (!enabled || !normalizedSymbol) {
      setState(EMPTY_STATE);
      return;
    }
    const channel = channelFor(asset, normalizedSymbol, normalizedInterval);
    return subscribe(channel, setState);
  }, [asset, enabled, key, normalizedInterval, normalizedSymbol]);

  return state;
}
