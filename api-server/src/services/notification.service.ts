import webPush, { type PushSubscription } from 'web-push';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { MarketDataService } from './market-data.service';

export const DEFAULT_NOTIFICATION_TYPES = [
  'news_positive',
  'news_negative',
  'disclosure_positive',
  'disclosure_negative',
  'ai_strong_buy',
  'ai_sell_signal',
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
): Promise<NotificationPreferences> {
  const supabase = getSupabase();
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

async function readAlertPrice(alert: PriceAlertRow): Promise<number> {
  const symbol = cleanSymbol(alert.symbol);
  if (!symbol) throw new Error('INVALID_SYMBOL');

  if (alert.asset_type === 'stock') {
    const quote = await MarketDataService.getQuoteRow(symbol);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      throw new Error('STOCK_QUOTE_UNAVAILABLE');
    }
    return quote.price;
  }

  if (alert.asset_type === 'coin_spot') {
    const market = symbol.startsWith('KRW-') ? symbol : `KRW-${symbol}`;
    const rows = await fetchJson<Array<{ trade_price?: unknown }>>(
      `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(market)}`,
    );
    const price = Number(rows[0]?.trade_price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('UPBIT_QUOTE_UNAVAILABLE');
    }
    return price;
  }

  const futuresSymbol = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
  const payload = await fetchJson<{
    code?: string;
    data?: Array<{ lastPr?: unknown; markPrice?: unknown }>;
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
  return price;
}

function isConditionMet(alert: PriceAlertRow, price: number): boolean {
  const target = Number(alert.target_price);
  return alert.direction === 'above' ? price >= target : price <= target;
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
    const currentPrice = await readAlertPrice(alert);
    const met = isConditionMet(alert, currentPrice);
    const wasMet = alert.condition_met === true;
    const update: Record<string, unknown> = {
      condition_met: met,
      last_checked_price: currentPrice,
      last_checked_at: now.toISOString(),
      last_error: null,
      updated_at: now.toISOString(),
    };

    if (met && !wasMet) {
      const target = Number(alert.target_price);
      const directionText = alert.direction === 'above' ? '이상' : '이하';
      await deliverMemberNotification({
        memberId: alert.member_id,
        type: 'price_target',
        title: `지정가 도달 · ${cleanSymbol(alert.symbol)}`,
        body: `현재가 ${formatPrice(currentPrice, alert.asset_type)} · 설정가 ${formatPrice(target, alert.asset_type)} ${directionText}`,
        url: alertUrl(alert),
        app: alert.app_enabled,
        push: alert.push_enabled,
        metadata: {
          alertId: alert.id,
          assetType: alert.asset_type,
          market: alert.market,
          symbol: cleanSymbol(alert.symbol),
          currentPrice,
          targetPrice: target,
          direction: alert.direction,
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
