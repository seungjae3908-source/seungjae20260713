import {
  AI_CHART_MAX_PENDING_EVENTS,
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
type FrameHandle = number;

type WebSocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close'> & {
  binaryType?: BinaryType;
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
  requestAnimationFrameFn?: (callback: FrameRequestCallback) => FrameHandle;
  cancelAnimationFrameFn?: (handle: FrameHandle) => void;
  maxPendingEvents?: number;
  onStatus?: (status: AiChartPublicStreamStatus, reason: string) => void;
  onTrade?: (event: AiChartPublicTradeEvent) => void;
  onTrades?: (events: readonly AiChartPublicTradeEvent[]) => boolean | void;
  onDiagnostic?: (diagnostic: AiChartStreamDiagnostic) => void;
};

export type AiChartStreamDiagnostic = {
  status: AiChartPublicStreamStatus;
  reason: string;
  market: AiChartPublicStreamMarket;
  symbol: string;
  reconnectAttempts: number;
  connectedAtMs: number | null;
  lastEventAtMs: number | null;
  freshness: 'FRESH' | 'DELAYED' | 'STALE' | 'UNAVAILABLE';
  pendingEvents: number;
  maxPendingEvents: number;
  pendingRenderWork: 0 | 1;
};

export type AiChartPublicStreamClient = {
  start: () => void;
  stop: () => void;
  snapshot: () => AiChartStreamDiagnostic;
};

const MAX_RECONNECT_ATTEMPTS = 5;

function defaultSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === 'undefined') throw new Error('WEBSOCKET_UNAVAILABLE');
  return new WebSocket(url);
}

export function decodeAiChartWebSocketPayload(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return '';
}

export function createAiChartPublicStreamClient(
  options: AiChartPublicStreamClientOptions,
): AiChartPublicStreamClient {
  const subscription = buildAiChartPublicStreamSubscription({ market: options.market, symbol: options.symbol });
  const expectedSymbol = options.market === 'UPBIT'
    ? options.symbol.trim().toUpperCase().replace(/^KRW[-_:]?/, '')
    : options.symbol.trim().toUpperCase().replace(/[-_/]/g, '');
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const maxPendingEvents = Math.max(1, Math.min(
    AI_CHART_MAX_PENDING_EVENTS,
    Math.trunc(options.maxPendingEvents ?? AI_CHART_MAX_PENDING_EVENTS),
  ));
  const requestFrame = options.requestAnimationFrameFn
    ?? (typeof requestAnimationFrame === 'function'
      ? (callback: FrameRequestCallback) => requestAnimationFrame(callback)
      : (callback: FrameRequestCallback) => setTimeoutFn(() => callback(now()), 16) as unknown as FrameHandle);
  const cancelFrame = options.cancelAnimationFrameFn
    ?? (typeof cancelAnimationFrame === 'function'
      ? (handle: FrameHandle) => cancelAnimationFrame(handle)
      : (handle: FrameHandle) => clearTimeoutFn(handle as unknown as TimerHandle));

  let socket: WebSocketLike | null = null;
  let status: AiChartPublicStreamStatus = 'DISCONNECTED';
  let stopped = true;
  let reconnectAttempts = 0;
  let connectedAtMs: number | null = null;
  let lastEventAtMs: number | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;
  let connectTimer: TimerHandle | null = null;
  let pendingEvents: AiChartPublicTradeEvent[] = [];
  let flushFrame: FrameHandle | null = null;

  const snapshot = (): AiChartStreamDiagnostic => ({
    status,
    reason: status === 'FALLBACK_POLLING' ? 'PUBLIC_STREAM_UNAVAILABLE' : 'PUBLIC_STREAM',
    market: options.market,
    symbol: options.symbol,
    reconnectAttempts,
    connectedAtMs,
    lastEventAtMs,
    freshness: aiChartStreamFreshness({ status, lastEventAtMs, nowMs: now(), staleAfterMs: subscription.staleAfterMs }),
    pendingEvents: pendingEvents.length,
    maxPendingEvents,
    pendingRenderWork: flushFrame == null ? 0 : 1,
  });

  const publish = (nextStatus: AiChartPublicStreamStatus, reason: string) => {
    status = nextStatus;
    options.onStatus?.(nextStatus, reason);
    options.onDiagnostic?.({ ...snapshot(), reason });
  };
  const clearTimer = (handle: TimerHandle | null) => { if (handle != null) clearTimeoutFn(handle); };
  const clearRuntimeTimers = () => {
    clearTimer(connectTimer);
    clearTimer(heartbeatTimer);
    clearTimer(watchdogTimer);
    heartbeatTimer = null;
    watchdogTimer = null;
    connectTimer = null;
  };
  const clearPendingWork = () => {
    if (flushFrame != null) cancelFrame(flushFrame);
    flushFrame = null;
    pendingEvents = [];
  };
  const forceFallback = (reason: string) => {
    clearRuntimeTimers();
    clearPendingWork();
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    connectedAtMs = null;
    const active = socket;
    socket = null;
    try { active?.close(1000, 'polling-fallback'); } catch { /* fail closed */ }
    publish('FALLBACK_POLLING', reason);
  };
  const scheduleHeartbeat = () => {
    clearTimer(heartbeatTimer);
    heartbeatTimer = setTimeoutFn(() => {
      heartbeatTimer = null;
      if (
        stopped
        || !socket
        || connectedAtMs == null
        || status === 'DISCONNECTED'
        || status === 'FALLBACK_POLLING'
      ) return;
      try { socket.send(subscription.heartbeatPayload); }
      catch {
        try { socket.close(1011, 'heartbeat-send-failed'); }
        catch { forceFallback('HEARTBEAT_SEND_FAILED'); return; }
      }
      scheduleHeartbeat();
    }, subscription.heartbeatIntervalMs);
  };
  const scheduleWatchdog = () => {
    clearTimer(watchdogTimer);
    const cadence = Math.max(1_000, Math.min(5_000, subscription.staleAfterMs));
    watchdogTimer = setTimeoutFn(() => {
      watchdogTimer = null;
      if (stopped || (status !== 'WAITING_FIRST_EVENT' && status !== 'LIVE_STREAM')) return;
      const currentNow = now();
      const firstEventOverdue = lastEventAtMs == null
        && connectedAtMs != null
        && Math.max(0, currentNow - connectedAtMs) > subscription.staleAfterMs * 2;
      if (firstEventOverdue || shouldFallbackToPolling({
        status,
        lastEventAtMs,
        nowMs: currentNow,
        staleAfterMs: subscription.staleAfterMs,
        reconnectAttempts,
      })) {
        forceFallback(firstEventOverdue ? 'FIRST_EVENT_TIMEOUT' : 'STREAM_STALE');
        return;
      }
      const freshness = aiChartStreamFreshness({ status, lastEventAtMs, nowMs: currentNow, staleAfterMs: subscription.staleAfterMs });
      if (freshness === 'DELAYED') options.onDiagnostic?.({ ...snapshot(), reason: 'STREAM_DELAYED' });
      scheduleWatchdog();
    }, cadence);
  };


  const scheduleFlush = (expectedSocket: WebSocketLike) => {
    if (flushFrame != null) return;
    flushFrame = requestFrame(() => {
      flushFrame = null;
      if (stopped || socket !== expectedSocket || pendingEvents.length === 0) {
        pendingEvents = [];
        return;
      }

      const batch = pendingEvents;
      pendingEvents = [];
      let accepted = false;
      if (options.onTrades) {
        accepted = options.onTrades(batch) !== false;
      } else if (options.onTrade) {
        for (const event of batch) options.onTrade(event);
        accepted = true;
      }
      if (!accepted) {
        options.onDiagnostic?.({ ...snapshot(), reason: 'STREAM_BATCH_REJECTED' });
        return;
      }

      lastEventAtMs = Math.max(lastEventAtMs ?? 0, ...batch.map((event) => event.eventTimeMs));
      reconnectAttempts = 0;
      if (status !== 'LIVE_STREAM') publish('LIVE_STREAM', 'FIRST_VALID_EVENT_ACCEPTED');
      else options.onDiagnostic?.({ ...snapshot(), reason: 'PUBLIC_TRADE_BATCH' });
    });
  };

  const connect = () => {
    if (stopped || status === 'FALLBACK_POLLING') return;
    clearRuntimeTimers();
    clearPendingWork();
    connectedAtMs = null;
    publish(reconnectAttempts > 0 ? 'RECOVERING' : 'CONNECTING', reconnectAttempts > 0 ? 'RECONNECTING' : 'CONNECTING');

    let nextSocket: WebSocketLike;
    try { nextSocket = socketFactory(subscription.endpoint); }
    catch { forceFallback('WEBSOCKET_UNAVAILABLE'); return; }
    if ('binaryType' in nextSocket) nextSocket.binaryType = 'arraybuffer';
    socket = nextSocket;
    connectTimer = setTimeoutFn(() => {
      connectTimer = null;
      if (stopped || socket !== nextSocket || connectedAtMs != null) return;
      forceFallback('CONNECT_TIMEOUT');
    }, subscription.staleAfterMs);

    nextSocket.onopen = () => {
      if (stopped || socket !== nextSocket) return;
      clearTimer(connectTimer);
      connectTimer = null;
      try { nextSocket.send(subscription.subscribePayload); }
      catch { forceFallback('SUBSCRIBE_SEND_FAILED'); return; }
      connectedAtMs = now();
      publish('WAITING_FIRST_EVENT', 'PUBLIC_STREAM_CONNECTED_WAITING_FOR_DATA');
      scheduleHeartbeat();
      scheduleWatchdog();
    };

    nextSocket.onmessage = (message) => {
      if (stopped || socket !== nextSocket) return;
      const raw = decodeAiChartWebSocketPayload(message.data);
      if (!raw) {
        options.onDiagnostic?.({ ...snapshot(), reason: 'UNSUPPORTED_MESSAGE_PAYLOAD' });
        return;
      }
      const events = parseAiChartPublicStreamMessage(options.market, raw, now())
        .filter((event) => event.market === options.market && event.symbol === expectedSymbol);
      if (!events.length) return;
      if (pendingEvents.length + events.length > maxPendingEvents) {
        forceFallback('STREAM_BUFFER_OVERFLOW');
        return;
      }
      pendingEvents.push(...events);
      scheduleFlush(nextSocket);
    };

    nextSocket.onerror = () => {
      if (stopped || socket !== nextSocket) return;
      options.onDiagnostic?.({ ...snapshot(), reason: 'SOCKET_ERROR' });
    };
    nextSocket.onclose = () => {
      if (stopped || socket !== nextSocket) return;
      socket = null;
      clearRuntimeTimers();
      clearPendingWork();
      connectedAtMs = null;
      if (stopped || status === 'FALLBACK_POLLING') return;
      reconnectAttempts += 1;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { forceFallback('RECONNECT_LIMIT_REACHED'); return; }
      publish('RECOVERING', 'SOCKET_CLOSED');
      clearTimer(reconnectTimer);
      reconnectTimer = setTimeoutFn(() => { reconnectTimer = null; connect(); }, nextAiChartReconnectDelayMs(reconnectAttempts - 1));
    };
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      reconnectAttempts = 0;
      connectedAtMs = null;
      lastEventAtMs = null;
      status = 'DISCONNECTED';
      connect();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearRuntimeTimers();
      clearPendingWork();
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      connectedAtMs = null;
      const active = socket;
      socket = null;
      try { active?.close(1000, 'client-stop'); } catch { /* idempotent teardown */ }
      publish('DISCONNECTED', 'CLIENT_STOPPED');
    },
    snapshot,
  };
}
