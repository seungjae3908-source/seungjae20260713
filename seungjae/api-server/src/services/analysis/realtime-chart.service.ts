import type { Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { getSupabase, getUserSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { normalizeMembershipRole } from '../../middleware/auth';
import type { Timeframe } from '../../sample/types';
import { MarketDataService } from '../market-data.service';
import { fetchBitgetCandles, fetchUpbitCandles } from './crypto-source';
import { toBars, type Bar } from './candle-math';
import { getChartSignals } from './chart-signals.service';
import { getAiChartPlan } from './ai-chart-plan.service';
import {
  deliverMemberNotification,
  type NotificationType,
} from '../notification.service';

type RealtimeAsset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';

type SubscriptionSpec = {
  asset: RealtimeAsset;
  symbol: string;
  interval: string;
};

type SubscribeMessage = SubscriptionSpec & {
  type: 'subscribe';
  accessToken: string;
};

type AuthorizedMember = {
  id: string;
  role: 'pending' | 'associate' | 'full' | 'master' | 'admin';
};

type RealtimeSocket = WebSocket & {
  alive?: boolean;
  authorization?: AuthorizedMember;
  subscriptionKey?: string;
  subscribing?: boolean;
};

type SharedFeed = {
  key: string;
  spec: SubscriptionSpec;
  clients: Set<RealtimeSocket>;
  timer: NodeJS.Timeout | null;
  loading: boolean;
  lastSignature: string | null;
  lastSignalIds: Set<string> | null;
  lastPlan: { view: string; target: number | null; stop: number | null } | null;
};

const STOCK_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']);
const SPOT_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']);
const FUTURES_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']);
const feeds = new Map<string, SharedFeed>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AUTH_UPSTREAM_TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSubscribeMessage(raw: RawData): SubscribeMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (!isRecord(parsed) || parsed.type !== 'subscribe') return null;

    const asset = String(parsed.asset ?? '') as RealtimeAsset;
    if (!['stockKR', 'stockUS', 'coinSpot', 'coinFutures'].includes(asset)) return null;

    const symbol = String(parsed.symbol ?? '').trim().toUpperCase();
    const interval = String(parsed.interval ?? '').trim();
    const accessToken = String(parsed.accessToken ?? '').trim();
    if (!symbol || !/^[A-Z0-9.\-]{1,24}$/.test(symbol) || !interval || !accessToken) return null;

    const allowed = asset === 'coinSpot'
      ? SPOT_INTERVALS
      : asset === 'coinFutures'
        ? FUTURES_INTERVALS
        : STOCK_INTERVALS;
    if (!allowed.has(interval)) return null;

    return { type: 'subscribe', asset, symbol, interval, accessToken };
  } catch {
    return null;
  }
}

async function authorize(accessToken: string): Promise<AuthorizedMember> {
  if (!isSupabaseConfigured()) throw new Error('AUTH_NOT_CONFIGURED');

  const { data: auth, error: authError } = await withTimeout(
    getSupabase().auth.getUser(accessToken),
    10_000,
  );
  if (authError || !auth.user) throw new Error('INVALID_SESSION');

  const { data: profile, error: profileError } = await withTimeout(
    Promise.resolve(
      getUserSupabase(accessToken)
        .from('profiles')
        .select('role,status')
        .eq('id', auth.user.id)
        .single(),
    ),
    10_000,
  );
  if (profileError || !profile || profile.status !== 'approved') {
    throw new Error('MEMBER_NOT_APPROVED');
  }

  return { id: auth.user.id, role: normalizeMembershipRole(profile.role) };
}

function send(socket: RealtimeSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendError(
  socket: RealtimeSocket,
  code: string,
  message: string,
  retryable: boolean,
): void {
  send(socket, { type: 'error', code, message, retryable, at: new Date().toISOString() });
}

function candleTime(value: Bar['time']): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBars(rows: Bar[]): Bar[] {
  const sorted = toBars(rows).sort((a, b) => candleTime(a.time) - candleTime(b.time));
  return [...new Map(sorted.map((row) => [candleTime(row.time), row])).values()].slice(-500);
}

async function loadSnapshot(spec: SubscriptionSpec): Promise<{
  candles: Bar[];
  provider: string;
  fetchedAt: string;
}> {
  if (spec.asset === 'stockKR' || spec.asset === 'stockUS') {
    const meta = await MarketDataService.getLiveCandlesMeta(
      spec.symbol,
      spec.interval as Timeframe,
    );
    return {
      candles: normalizeBars(meta.candles),
      provider: meta.provider,
      fetchedAt: meta.fetchedAt,
    };
  }

  if (spec.asset === 'coinSpot') {
    const timeframe =
      spec.interval === '1H'
        ? '60m'
        : spec.interval === '4H'
          ? '240m'
          : spec.interval;
    const candles = await fetchUpbitCandles(spec.symbol.replace(/^KRW-/, ''), 200, timeframe);
    return { candles: normalizeBars(candles), provider: 'upbit', fetchedAt: new Date().toISOString() };
  }

  const symbol = spec.symbol.endsWith('USDT') ? spec.symbol : `${spec.symbol}USDT`;
  const candles = await fetchBitgetCandles(symbol, 200, spec.interval);
  return { candles: normalizeBars(candles), provider: 'bitget', fetchedAt: new Date().toISOString() };
}

function snapshotSignature(candles: Bar[]): string {
  const latest = candles[candles.length - 1];
  return latest
    ? [latest.time, latest.open, latest.high, latest.low, latest.close, latest.volume].join(':')
    : 'empty';
}

function notificationTypeForSignal(name: string): NotificationType {
  return /매도|하락|약세|이탈|손절/.test(name)
    ? 'ai_sell_signal'
    : 'ai_buy_signal';
}

function notifyFeedMembers(
  feed: SharedFeed,
  input: {
    type: NotificationType;
    title: string;
    body: string;
    signalId: string;
    importance: string;
  },
): void {
  const memberIds = new Set(
    [...feed.clients]
      .map((client) => client.authorization?.id)
      .filter((id): id is string => Boolean(id)),
  );
  for (const memberId of memberIds) {
    void deliverMemberNotification({
      memberId,
      type: input.type,
      title: input.title,
      body: input.body,
      url: `/tech/chart-relay?asset=${encodeURIComponent(feed.spec.asset)}&symbol=${encodeURIComponent(feed.spec.symbol)}&interval=${encodeURIComponent(feed.spec.interval)}`,
      app: true,
      push: false,
      metadata: {
        assetType: feed.spec.asset,
        symbol: feed.spec.symbol,
        signalId: input.signalId,
        importance: input.importance,
      },
    }).catch((error) => {
      console.error('[realtime-chart] notification error:', error);
    });
  }
}

async function refreshFeed(feed: SharedFeed): Promise<void> {
  if (feed.loading || feed.clients.size === 0) return;
  feed.loading = true;

  try {
    const snapshot = await loadSnapshot(feed.spec);
    if (snapshot.candles.length < 2) throw new Error('REALTIME_CANDLES_EMPTY');

    const signature = snapshotSignature(snapshot.candles);
    let payload: Record<string, unknown>;
    if (signature === feed.lastSignature) {
      payload = {
          type: 'status',
          status: 'live',
          provider: snapshot.provider,
          fetchedAt: snapshot.fetchedAt,
        };
    } else {
      const analysisAsset = feed.spec.asset === 'stockKR' || feed.spec.asset === 'stockUS'
        ? 'stock'
        : 'coin';
      const coinMarket = feed.spec.asset === 'coinFutures' ? 'futures' : 'spot';
      const allowFutures = feed.spec.asset === 'coinFutures';
      const [signalResult, plan] = await Promise.all([
        getChartSignals(
          analysisAsset,
          coinMarket,
          feed.spec.symbol,
          feed.spec.interval,
          { allowFutures },
          snapshot.candles,
        ),
        getAiChartPlan(
          analysisAsset,
          coinMarket,
          feed.spec.symbol,
          feed.spec.interval,
          { allowFutures },
          snapshot.candles,
        ),
      ]);
      const currentSignalIds = new Set(signalResult.signals.map((signal) => signal.id));
      const currentPlan = {
        view: plan.view,
        target: plan.target,
        stop: plan.stop,
      };
      if (feed.lastSignalIds) {
        for (const signal of signalResult.signals) {
          if (feed.lastSignalIds.has(signal.id)) continue;
          notifyFeedMembers(feed, {
            type: notificationTypeForSignal(signal.name),
            title: `${signal.name} · ${feed.spec.symbol}`,
            body: signal.meaningHere || signal.meaningGeneral,
            signalId: signal.id,
            importance: signal.importance || 'medium',
          });
        }
      }
      if (feed.lastPlan) {
        if (feed.lastPlan.view !== currentPlan.view) {
          notifyFeedMembers(feed, {
            type:
              currentPlan.view === '매도'
                ? 'ai_sell_signal'
                : 'ai_buy_signal',
            title: `AI 관점 변경 · ${feed.spec.symbol}`,
            body: `${feed.lastPlan.view} → ${currentPlan.view}`,
            signalId: `plan-view:${feed.key}:${snapshot.fetchedAt}:${currentPlan.view}`,
            importance: 'high',
          });
        }
        if (feed.lastPlan.target !== currentPlan.target) {
          notifyFeedMembers(feed, {
            type: 'target_change',
            title: `목표가 변경 · ${feed.spec.symbol}`,
            body: `${feed.lastPlan.target ?? '산출 불가'} → ${currentPlan.target ?? '산출 불가'}`,
            signalId: `plan-target:${feed.key}:${snapshot.fetchedAt}:${currentPlan.target ?? 'none'}`,
            importance: 'medium',
          });
        }
        if (feed.lastPlan.stop !== currentPlan.stop) {
          notifyFeedMembers(feed, {
            type: 'stop_change',
            title: `손절가 변경 · ${feed.spec.symbol}`,
            body: `${feed.lastPlan.stop ?? '산출 불가'} → ${currentPlan.stop ?? '산출 불가'}`,
            signalId: `plan-stop:${feed.key}:${snapshot.fetchedAt}:${currentPlan.stop ?? 'none'}`,
            importance: 'high',
          });
        }
      }
      feed.lastSignalIds = currentSignalIds;
      feed.lastPlan = currentPlan;
      payload = {
          type: 'snapshot',
          ...feed.spec,
          provider: snapshot.provider,
          fetchedAt: snapshot.fetchedAt,
          candles: snapshot.candles,
          signals: signalResult.signals,
          plan,
        };
    }
    feed.lastSignature = signature;

    for (const client of feed.clients) send(client, payload);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'REALTIME_SOURCE_UNAVAILABLE';
    for (const client of feed.clients) {
      sendError(
        client,
        'REALTIME_SOURCE_UNAVAILABLE',
        `실시간 데이터 제공처 응답을 받지 못했습니다. (${detail})`,
        true,
      );
    }
  } finally {
    feed.loading = false;
  }
}

function feedPollMs(asset: RealtimeAsset): number {
  return asset === 'coinSpot' || asset === 'coinFutures' ? 8_000 : 15_000;
}

function removeSubscription(socket: RealtimeSocket): void {
  const key = socket.subscriptionKey;
  socket.subscriptionKey = undefined;
  if (!key) return;

  const feed = feeds.get(key);
  if (!feed) return;
  feed.clients.delete(socket);
  if (feed.clients.size === 0) {
    if (feed.timer) clearInterval(feed.timer);
    feeds.delete(key);
  }
}

function subscribe(socket: RealtimeSocket, spec: SubscriptionSpec): void {
  removeSubscription(socket);
  const key = `${spec.asset}:${spec.symbol}:${spec.interval}`;
  let feed = feeds.get(key);

  if (!feed) {
    const created: SharedFeed = {
      key,
      spec,
      clients: new Set<RealtimeSocket>(),
      timer: null,
      loading: false,
      lastSignature: null,
      lastSignalIds: null,
      lastPlan: null,
    };
    created.timer = setInterval(() => void refreshFeed(created), feedPollMs(spec.asset));
    created.timer.unref?.();
    feeds.set(key, created);
    feed = created;
  }

  feed.clients.add(socket);
  socket.subscriptionKey = key;
  send(socket, { type: 'status', status: 'subscribed', ...spec, at: new Date().toISOString() });
  void refreshFeed(feed);
}

export function attachRealtimeChartServer(server: Server): void {
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/realtime/chart') {
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });

  webSocketServer.on('connection', (client) => {
    const socket = client as RealtimeSocket;
    socket.alive = true;
    send(socket, { type: 'status', status: 'connected', at: new Date().toISOString() });

    const subscribeTimeout = setTimeout(() => {
      sendError(socket, 'SUBSCRIPTION_TIMEOUT', '실시간 구독 요청이 없어 연결을 종료합니다.', true);
      socket.close(1008, 'SUBSCRIPTION_TIMEOUT');
    }, 15_000);
    subscribeTimeout.unref?.();

    socket.on('pong', () => {
      socket.alive = true;
    });

    socket.on('message', async (raw) => {
      const message = parseSubscribeMessage(raw);
      if (!message) {
        sendError(socket, 'INVALID_SUBSCRIPTION', '종목 또는 시간봉 구독 정보가 올바르지 않습니다.', false);
        return;
      }
      if (socket.subscribing) return;

      socket.subscribing = true;
      try {
        socket.authorization ??= await authorize(message.accessToken);
        if (message.asset === 'coinFutures' && socket.authorization.role === 'associate') {
          sendError(socket, 'FULL_MEMBER_REQUIRED', '코인 선물은 정회원 이상만 이용할 수 있습니다.', false);
          return;
        }

        clearTimeout(subscribeTimeout);
        subscribe(socket, message);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : 'AUTH_UPSTREAM_ERROR';
        sendError(socket, code, '실시간 연결 인증에 실패했습니다.', code === 'AUTH_UPSTREAM_TIMEOUT');
        socket.close(1008, code.slice(0, 100));
      } finally {
        socket.subscribing = false;
      }
    });

    socket.on('close', () => {
      clearTimeout(subscribeTimeout);
      removeSubscription(socket);
    });

    socket.on('error', () => {
      removeSubscription(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of webSocketServer.clients) {
      const socket = client as RealtimeSocket;
      if (socket.alive === false) {
        socket.terminate();
        continue;
      }
      socket.alive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const feed of feeds.values()) {
      if (feed.timer) clearInterval(feed.timer);
    }
    feeds.clear();
    webSocketServer.close();
  });
}
