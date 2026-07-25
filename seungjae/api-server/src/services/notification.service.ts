import webPush, { type PushSubscription } from 'web-push';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { MarketDataService } from './market-data.service';

export const DEFAULT_NOTIFICATION_TYPES = [
  'news_positive',
  'news_negative',
  'disclosure_positive',
  'disclosure_negative',
  'ai_buy_signal',
  'ai_strong_buy',
  'ai_sell_signal',
  'target_change',
  'stop_change',
  'risk_increase',
  'realtime_error',
  'golden_cross',
  'volume_surge',
  'capital_event',
  'price_target',
  'auto_trade',
  'system',
] as const;

export type NotificationType = (typeof DEFAULT_NOTIFICATION_TYPES)[number];

type NotificationPreferences = {
  member_id: string;
  enabled_types: string[] | null;
  app_enabled: boolean | null;
  push_enabled: boolean | null;
};

type DeliverNotificationInput = {
  memberId: string;
  type: NotificationType;
  title: string;
  body: string;
  url?: string | null;
  app?: boolean;
  push?: boolean;
  metadata?: Record<string, unknown>;
};

type PriceAlertRow = {
  id: string;
  member_id: string;
  asset_type: 'stock' | 'coin_spot' | 'coin_futures';
  market: string;
  symbol: string;
  direction: 'above' | 'below';
  target_price: number | string;
  condition_type?:
    | 'price_above'
    | 'price_below'
    | 'change_above'
    | 'change_below';
  target_value?: number | string;
  repeat_enabled: boolean;
  app_enabled: boolean;
  push_enabled: boolean;
  enabled: boolean;
  expires_at: string | null;
  last_triggered_at: string | null;
  condition_met?: boolean | null;
};

let vapidInitialized = false;
let priceMonitorRunning = false;
let priceMonitorTimer: NodeJS.Timeout | null = null;

export function isVapidReady(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT,
  );
}

function initializeVapid(): void {
  if (vapidInitialized || !isVapidReady()) return;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT as string,
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  );
  vapidInitialized = true;
}

export async function ensureNotificationPreferences(
  memberId: string,
  client?: ReturnType<typeof getSupabase>,
): Promise<NotificationPreferences> {
  const supabase = client ?? getSupabase();
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('member_id', memberId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as NotificationPreferences;

  const { data: created, error: createError } = await supabase
    .from('notification_preferences')
    .insert({ member_id: memberId, enabled_types: DEFAULT_NOTIFICATION_TYPES })
    .select('*')
    .single();
  if (createError) throw createError;
  return created as NotificationPreferences;
}

export async function deliverMemberNotification(
  input: DeliverNotificationInput,
): Promise<{ appStored: boolean; pushSent: number; skipped?: string }> {
  const preferences = await ensureNotificationPreferences(input.memberId);
  const enabledTypes = Array.isArray(preferences.enabled_types)
    ? preferences.enabled_types
    : [...DEFAULT_NOTIFICATION_TYPES];

  if (!enabledTypes.includes(input.type)) {
    return { appStored: false, pushSent: 0, skipped: 'TYPE_DISABLED' };
  }

  const signalId =
    typeof input.metadata?.signalId === 'string' &&
    input.metadata.signalId.trim().length > 0
      ? input.metadata.signalId.trim().slice(0, 200)
      : null;
  if (signalId) {
    const { data: duplicate, error: duplicateError } = await getSupabase()
      .from('notification_history')
      .select('id')
      .eq('member_id', input.memberId)
      .eq('signal_id', signalId)
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      return { appStored: false, pushSent: 0, skipped: 'DUPLICATE_SIGNAL' };
    }
  }

  const appAllowed = input.app !== false && preferences.app_enabled !== false;
  const pushAllowed =
    input.push !== false && preferences.push_enabled === true && isVapidReady();

  let pushSent = 0;
  if (pushAllowed) {
    initializeVapid();
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id,endpoint,subscription')
      .eq('member_id', input.memberId);
    if (error) throw error;

    const invalidEndpoints: string[] = [];
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? '/alerts',
      type: input.type,
      metadata: input.metadata ?? {},
    });

    await Promise.all(
      (data ?? []).map(async (row: any) => {
        try {
          await webPush.sendNotification(
            row.subscription as PushSubscription,
            payload,
          );
          pushSent += 1;
        } catch {
          invalidEndpoints.push(String(row.endpoint));
        }
      }),
    );

    if (invalidEndpoints.length > 0) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .eq('member_id', input.memberId)
        .in('endpoint', invalidEndpoints);
    }
  }

  let appStored = false;
  if (appAllowed) {
    const { error } = await getSupabase().from('notification_history').insert({
      member_id: input.memberId,
      notification_type: input.type,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      channel: pushSent > 0 ? 'both' : 'app',
      asset_type:
        typeof input.metadata?.assetType === 'string'
          ? input.metadata.assetType
          : null,
      symbol:
        typeof input.metadata?.symbol === 'string'
          ? input.metadata.symbol
          : null,
      signal_id: signalId,
      importance:
        typeof input.metadata?.importance === 'string'
          ? input.metadata.importance
          : null,
      metadata: input.metadata ?? {},
    });
    if (error) throw error;
    appStored = true;
  }

  return { appStored, pushSent };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'knowledge-info-price-alert/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanSymbol(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 30);
}

type AlertMarketSnapshot = {
  price: number;
  changePercent: number | null;
};

async function readAlertPrice(alert: PriceAlertRow): Promise<AlertMarketSnapshot> {
  const symbol = cleanSymbol(alert.symbol);
  if (!symbol) throw new Error('INVALID_SYMBOL');

  if (alert.asset_type === 'stock') {
    const quote = await MarketDataService.getQuoteRow(symbol);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      throw new Error('STOCK_QUOTE_UNAVAILABLE');
    }
    return {
      price: quote.price,
      changePercent: Number.isFinite(quote.changePercent)
        ? quote.changePercent
        : null,
    };
  }

  if (alert.asset_type === 'coin_spot') {
    const market = symbol.startsWith('KRW-') ? symbol : `KRW-${symbol}`;
    const rows = await fetchJson<
      Array<{ trade_price?: unknown; signed_change_rate?: unknown }>
    >(
      `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(market)}`,
    );
    const price = Number(rows[0]?.trade_price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('UPBIT_QUOTE_UNAVAILABLE');
    }
    const changeRate = Number(rows[0]?.signed_change_rate);
    return {
      price,
      changePercent: Number.isFinite(changeRate) ? changeRate * 100 : null,
    };
  }

  const futuresSymbol = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
  const payload = await fetchJson<{
    code?: string;
    data?: Array<{
      lastPr?: unknown;
      markPrice?: unknown;
      change24h?: unknown;
    }>;
  }>(
    `https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${encodeURIComponent(futuresSymbol)}`,
  );
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}`);
  }
  const price = Number(payload.data?.[0]?.markPrice ?? payload.data?.[0]?.lastPr);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('BITGET_QUOTE_UNAVAILABLE');
  }
  const changeRate = Number(payload.data?.[0]?.change24h);
  return {
    price,
    changePercent: Number.isFinite(changeRate) ? changeRate * 100 : null,
  };
}

function conditionTypeOf(
  alert: PriceAlertRow,
): NonNullable<PriceAlertRow['condition_type']> {
  if (
    alert.condition_type === 'price_above' ||
    alert.condition_type === 'price_below' ||
    alert.condition_type === 'change_above' ||
    alert.condition_type === 'change_below'
  ) {
    return alert.condition_type;
  }
  return alert.direction === 'above' ? 'price_above' : 'price_below';
}

function isConditionMet(
  alert: PriceAlertRow,
  snapshot: AlertMarketSnapshot,
): boolean {
  const condition = conditionTypeOf(alert);
  const target = Number(alert.target_value ?? alert.target_price);
  const current = condition.startsWith('change_')
    ? snapshot.changePercent
    : snapshot.price;
  if (current == null || !Number.isFinite(current)) return false;
  return condition.endsWith('_above') ? current >= target : current <= target;
}

function alertUrl(alert: PriceAlertRow): string {
  const symbol = encodeURIComponent(cleanSymbol(alert.symbol));
  if (alert.asset_type === 'stock') {
    const market = encodeURIComponent(String(alert.market || 'KR').toUpperCase());
    return `/stock-info?asset=stock&market=${market}&ticker=${symbol}`;
  }
  const coinMarket = alert.asset_type === 'coin_futures' ? 'futures' : 'spot';
  return `/stock-info?asset=coin&coinMarket=${coinMarket}&symbol=${symbol}`;
}

function formatPrice(value: number, assetType: PriceAlertRow['asset_type']): string {
  if (assetType === 'coin_futures') {
    return value.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
  }
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
}

async function evaluatePriceAlert(alert: PriceAlertRow): Promise<void> {
  const supabase = getSupabase();
  const now = new Date();
  if (alert.expires_at && Date.parse(alert.expires_at) <= now.getTime()) {
    await supabase
      .from('price_alerts')
      .update({ enabled: false, updated_at: now.toISOString() })
      .eq('id', alert.id);
    return;
  }

  try {
    const snapshot = await readAlertPrice(alert);
    const currentPrice = snapshot.price;
    const met = isConditionMet(alert, snapshot);
    const wasMet = alert.condition_met === true;
    const update: Record<string, unknown> = {
      condition_met: met,
      last_checked_price: currentPrice,
      last_checked_change_percent: snapshot.changePercent,
      last_checked_at: now.toISOString(),
      last_error: null,
      updated_at: now.toISOString(),
    };

    if (met && !wasMet) {
      const condition = conditionTypeOf(alert);
      const target = Number(alert.target_value ?? alert.target_price);
      const directionText = condition.endsWith('_above') ? '이상' : '이하';
      const isChange = condition.startsWith('change_');
      await deliverMemberNotification({
        memberId: alert.member_id,
        type: 'price_target',
        title: `${isChange ? '등락률' : '지정가'} 조건 도달 · ${cleanSymbol(alert.symbol)}`,
        body: isChange
          ? `현재 등락률 ${snapshot.changePercent?.toFixed(2) ?? '산출 불가'}% · 설정값 ${target.toFixed(2)}% ${directionText}`
          : `현재가 ${formatPrice(currentPrice, alert.asset_type)} · 설정가 ${formatPrice(target, alert.asset_type)} ${directionText}`,
        url: alertUrl(alert),
        app: alert.app_enabled,
        push: alert.push_enabled,
        metadata: {
          alertId: alert.id,
          assetType: alert.asset_type,
          market: alert.market,
          symbol: cleanSymbol(alert.symbol),
          currentPrice,
          changePercent: snapshot.changePercent,
          targetValue: target,
          conditionType: condition,
          signalId: `price-alert:${alert.id}:${now.toISOString()}`,
          importance: 'high',
        },
      });
      update.last_triggered_at = now.toISOString();
      if (!alert.repeat_enabled) update.enabled = false;
    }

    const { error } = await supabase
      .from('price_alerts')
      .update(update)
      .eq('id', alert.id);
    if (error) throw error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from('price_alerts')
      .update({
        last_checked_at: now.toISOString(),
        last_error: message.slice(0, 300),
        updated_at: now.toISOString(),
      })
      .eq('id', alert.id);
  }
}

export async function runPriceAlertMonitorOnce(): Promise<{
  checked: number;
  skipped?: string;
}> {
  if (priceMonitorRunning) return { checked: 0, skipped: 'ALREADY_RUNNING' };
  if (!isSupabaseConfigured()) return { checked: 0, skipped: 'SUPABASE_NOT_CONFIGURED' };

  priceMonitorRunning = true;
  try {
    const now = new Date().toISOString();
    const { data, error } = await getSupabase()
      .from('price_alerts')
      .select('*')
      .eq('enabled', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('updated_at', { ascending: true })
      .limit(500);
    if (error) throw error;

    const alerts = (data ?? []) as PriceAlertRow[];
    // API 제공처 과부하를 피하기 위해 작은 묶음으로 순차 처리합니다.
    for (let index = 0; index < alerts.length; index += 5) {
      await Promise.all(alerts.slice(index, index + 5).map(evaluatePriceAlert));
    }
    return { checked: alerts.length };
  } finally {
    priceMonitorRunning = false;
  }
}

export function startPriceAlertMonitor(): void {
  if (priceMonitorTimer) return;
  const configured = Number(process.env.PRICE_ALERT_MONITOR_INTERVAL_MS ?? 60_000);
  const intervalMs = Math.max(30_000, Math.min(15 * 60_000, Number.isFinite(configured) ? configured : 60_000));

  const run = () => {
    void runPriceAlertMonitorOnce().catch((error) => {
      console.error('price alert monitor error:', error);
    });
  };

  const initialTimer = setTimeout(run, 10_000);
  initialTimer.unref?.();
  priceMonitorTimer = setInterval(run, intervalMs);
  priceMonitorTimer.unref?.();
  console.log(`[api-server] price alert monitor enabled (${intervalMs}ms)`);
}