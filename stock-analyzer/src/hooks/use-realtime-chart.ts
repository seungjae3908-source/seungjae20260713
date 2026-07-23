import { useEffect, useRef, useState } from 'react';
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

type RealtimeChartState = {
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
    symbol: String(value.symbol ?? ''),
    interval: String(value.interval ?? ''),
    provider: String(value.provider ?? 'unknown'),
    fetchedAt: String(value.fetchedAt ?? new Date().toISOString()),
    candles,
    signals: Array.isArray(value.signals) ? value.signals.filter(isRecord) : [],
    plan: isRecord(value.plan) ? value.plan : null,
  };
}

async function accessToken(): Promise<string> {
  if (!isSupabaseConfigured) throw new Error('AUTH_NOT_CONFIGURED');
  const result = await new Promise<Awaited<ReturnType<ReturnType<typeof getSupabase>['auth']['getSession']>> | null>(
    (resolve, reject) => {
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
    },
  );
  const token = result?.data.session?.access_token;
  if (!token) throw new Error('LOGIN_REQUIRED');
  return token;
}

export function useRealtimeChart({
  asset,
  symbol,
  interval,
  enabled,
}: UseRealtimeChartInput): RealtimeChartState {
  const [state, setState] = useState<RealtimeChartState>({
    status: 'idle',
    snapshot: null,
    provider: null,
    updatedAt: null,
    error: null,
  });
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = enabled && Boolean(symbol);
    let reconnectAllowed = true;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!active || !reconnectAllowed || reconnectTimerRef.current != null) return;
      reconnectAttempt += 1;
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt - 1, 4));
      setState((current) => ({ ...current, status: 'reconnecting' }));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (!active || typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
      const current = socketRef.current;
      if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) {
        return;
      }

      setState((previous) => ({
        ...previous,
        status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
        error: null,
      }));

      try {
        const token = await accessToken();
        if (!active) return;

        const socket = new WebSocket(realtimeUrl());
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active || socketRef.current !== socket) {
            socket.close(1000, 'STALE_CONNECTION');
            return;
          }
          setState((previous) => ({ ...previous, status: 'connected', error: null }));
          socket.send(JSON.stringify({
            type: 'subscribe',
            accessToken: token,
            asset,
            symbol,
            interval,
          }));
        };

        socket.onmessage = (event) => {
          if (!active || socketRef.current !== socket) return;
          try {
            const parsed: unknown = JSON.parse(String(event.data));
            if (!isRecord(parsed)) return;

            const snapshot = normalizeSnapshot(parsed);
            if (snapshot) {
              reconnectAttempt = 0;
              setState({
                status: 'live',
                snapshot,
                provider: snapshot.provider,
                updatedAt: snapshot.fetchedAt,
                error: null,
              });
              return;
            }

            if (parsed.type === 'status') {
              if (parsed.status === 'live') reconnectAttempt = 0;
              const provider = typeof parsed.provider === 'string' ? parsed.provider : null;
              const updatedAt = typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null;
              setState((previous) => ({
                ...previous,
                status: parsed.status === 'live' ? 'live' : 'connected',
                provider: provider ?? previous.provider,
                updatedAt: updatedAt ?? previous.updatedAt,
                error: null,
              }));
              return;
            }

            if (parsed.type === 'error') {
              const error = String(parsed.message ?? parsed.code ?? 'REALTIME_CONNECTION_ERROR');
              if (parsed.retryable === false) reconnectAllowed = false;
              setState((previous) => ({ ...previous, status: 'error', error }));
            }
          } catch {
            setState((previous) => ({
              ...previous,
              status: 'error',
              error: '실시간 데이터 응답 형식이 올바르지 않습니다.',
            }));
          }
        };

        socket.onerror = () => {
          if (!active || socketRef.current !== socket) return;
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: '실시간 연결에 실패했습니다.',
          }));
        };

        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
          scheduleReconnect();
        };
      } catch (cause) {
        if (!active) return;
        const error = cause instanceof Error ? cause.message : 'REALTIME_CONNECTION_ERROR';
        reconnectAllowed = error !== 'AUTH_NOT_CONFIGURED' && error !== 'LOGIN_REQUIRED';
        setState((previous) => ({ ...previous, status: 'error', error }));
        if (reconnectAllowed) scheduleReconnect();
      }
    };

    setState({
      status: active ? 'connecting' : 'idle',
      snapshot: null,
      provider: null,
      updatedAt: null,
      error: null,
    });
    if (active) void connect();

    return () => {
      active = false;
      reconnectAllowed = false;
      clearReconnectTimer();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'SUBSCRIPTION_CHANGED');
        }
      }
    };
  }, [asset, enabled, interval, symbol]);

  return state;
}
