import {
  aiChartStreamFreshness,
  buildAiChartPublicStreamSubscription,
  nextAiChartReconnectDelayMs,
  parseAiChartPublicStreamMessage,
  shouldFallbackToPolling,
  type AiChartPublicStreamMarket,
  type AiChartPublicStreamStatus,
  type AiChartPublicTradeEvent,
} from './ai-chart-public-stream';

type TimerHandle = ReturnType<typeof setTimeout>;

type WebSocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close'> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

export type AiChartPublicStreamClientOptions = {
  market: AiChartPublicStreamMarket;
  symbol: string;
  socketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  onStatus?: (status: AiChartPublicStreamStatus, reason: string) => void;
  onTrade?: (event: AiChartPublicTradeEvent) => void;
  onDiagnostic?: (diagnostic: AiChartStreamDiagnostic) => void;
};

export type AiChartStreamDiagnostic = {
  status: AiChartPublicStreamStatus;
  reason: string;
  market: AiChartPublicStreamMarket;
  symbol: string;
  reconnectAttempts: number;
  lastEventAtMs: number | null;
  freshness: 'FRESH' | 'DELAYED' | 'STALE' | 'UNAVAILABLE';
};

export type AiChartPublicStreamClient = {
  start: () => void;
  stop: () => void;
  snapshot: () => AiChartStreamDiagnostic;
};

const MAX_RECONNECT_ATTEMPTS = 5;

function defaultSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WEBSOCKET_UNAVAILABLE');
  }
  return new WebSocket(url);
}

export function createAiChartPublicStreamClient(
  options: AiChartPublicStreamClientOptions,
): AiChartPublicStreamClient {
  const subscription = buildAiChartPublicStreamSubscription({
    market: options.market,
    symbol: options.symbol,
  });
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const socketFactory = options.socketFactory ?? defaultSocketFactory;

  let socket: WebSocketLike | null = null;
  let status: AiChartPublicStreamStatus = 'DISCONNECTED';
  let stopped = true;
  let reconnectAttempts = 0;
  let lastEventAtMs: number | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;

  const snapshot = (): AiChartStreamDiagnostic => ({
    status,
    reason: status === 'FALLBACK_POLLING' ? 'PUBLIC_STREAM_UNAVAILABLE' : 'PUBLIC_STREAM',
    market: options.market,
    symbol: options.symbol,
    reconnectAttempts,
    lastEventAtMs,
    freshness: aiChartStreamFreshness({
      status,
      lastEventAtMs,
      nowMs: now(),
      staleAfterMs: subscription.staleAfterMs,
    }),
  });

  const publish = (nextStatus: AiChartPublicStreamStatus, reason: string) => {
    status = nextStatus;
    options.onStatus?.(nextStatus, reason);
    options.onDiagnostic?.({ ...snapshot(), reason });
  };

  const clearTimer = (handle: TimerHandle | null) => {
    if (handle != null) clearTimeoutFn(handle);
  };

  const clearRuntimeTimers = () => {
    clearTimer(heartbeatTimer);
    clearTimer(watchdogTimer);
    heartbeatTimer = null;
    watchdogTimer = null;
  };

  const forceFallback = (reason: string) => {
    clearRuntimeTimers();
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    const active = socket;
    socket = null;
    try {
      active?.close(1000, 'polling-fallback');
    } catch {
      // Closing a broken public market-data socket must not prevent fail-closed fallback.
    }
    publish('FALLBACK_POLLING', reason);
  };

  const scheduleHeartbeat = () => {
    clearTimer(heartbeatTimer);
    heartbeatTimer = setTimeoutFn(() => {
      heartbeatTimer = null;
      if (stopped || status !== 'LIVE_STREAM' || !socket) return;
      try {
        socket.send(subscription.heartbeatPayload);
      } catch {
        try {
          socket.close(1011, 'heartbeat-send-failed');
        } catch {
          forceFallback('HEARTBEAT_SEND_FAILED');
          return;
        }
      }
      scheduleHeartbeat();
    }, subscription.heartbeatIntervalMs);
  };

  const scheduleWatchdog = () => {
    clearTimer(watchdogTimer);
    const cadence = Math.max(1_000, Math.min(5_000, subscription.staleAfterMs));
    watchdogTimer = setTimeoutFn(() => {
      watchdogTimer = null;
      if (stopped || status !== 'LIVE_STREAM') return;
      if (shouldFallbackToPolling({
        status,
        lastEventAtMs,
        nowMs: now(),
        staleAfterMs: subscription.staleAfterMs,
        reconnectAttempts,
      })) {
        forceFallback('STREAM_STALE');
        return;
      }
      const freshness = aiChartStreamFreshness({
        status,
        lastEventAtMs,
        nowMs: now(),
        staleAfterMs: subscription.staleAfterMs,
      });
      if (freshness === 'DELAYED') options.onDiagnostic?.({ ...snapshot(), reason: 'STREAM_DELAYED' });
      scheduleWatchdog();
    }, cadence);
  };

  const connect = () => {
    if (stopped || status === 'FALLBACK_POLLING') return;
    clearRuntimeTimers();
    publish(reconnectAttempts > 0 ? 'RECOVERING' : 'CONNECTING', reconnectAttempts > 0 ? 'RECONNECTING' : 'CONNECTING');

    let nextSocket: WebSocketLike;
    try {
      nextSocket = socketFactory(subscription.endpoint);
    } catch {
      forceFallback('WEBSOCKET_UNAVAILABLE');
      return;
    }
    socket = nextSocket;

    nextSocket.onopen = () => {
      if (stopped || socket !== nextSocket) return;
      try {
        nextSocket.send(subscription.subscribePayload);
      } catch {
        forceFallback('SUBSCRIBE_SEND_FAILED');
        return;
      }
      publish('LIVE_STREAM', 'PUBLIC_STREAM_CONNECTED');
      scheduleHeartbeat();
      scheduleWatchdog();
    };

    nextSocket.onmessage = (message) => {
      if (stopped || socket !== nextSocket) return;
      const raw = typeof message.data === 'string' ? message.data : '';
      const events = parseAiChartPublicStreamMessage(options.market, raw, now());
      if (!events.length) return;
      lastEventAtMs = Math.max(lastEventAtMs ?? 0, ...events.map((event) => event.eventTimeMs));
      reconnectAttempts = 0;
      for (const event of events) options.onTrade?.(event);
      options.onDiagnostic?.({ ...snapshot(), reason: 'PUBLIC_TRADE_EVENT' });
    };

    nextSocket.onerror = () => {
      if (stopped || socket !== nextSocket) return;
      options.onDiagnostic?.({ ...snapshot(), reason: 'SOCKET_ERROR' });
    };

    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null;
      clearRuntimeTimers();
      if (stopped || status === 'FALLBACK_POLLING') return;
      reconnectAttempts += 1;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        forceFallback('RECONNECT_LIMIT_REACHED');
        return;
      }
      publish('RECOVERING', 'SOCKET_CLOSED');
      clearTimer(reconnectTimer);
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        connect();
      }, nextAiChartReconnectDelayMs(reconnectAttempts - 1));
    };
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      reconnectAttempts = 0;
      lastEventAtMs = null;
      status = 'DISCONNECTED';
      connect();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearRuntimeTimers();
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      const active = socket;
      socket = null;
      try {
        active?.close(1000, 'client-stop');
      } catch {
        // Stop is idempotent; a broken public socket cannot block teardown.
      }
      publish('DISCONNECTED', 'CLIENT_STOPPED');
    },
    snapshot,
  };
}
