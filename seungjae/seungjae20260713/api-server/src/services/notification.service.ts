import webPush, { type PushSubscription } from 'web-push';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { MarketDataService } from './market-data.service';
import {
  ALERT_TYPES,
  type AlertAssetType,
  type AlertTimeframe,
  type InstrumentAlertType,
  roleCanUseAlert,
} from '../types/instrument-alert';

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
  ...ALERT_TYPES,
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
  eventKey?: string;
  assetType?: AlertAssetType;
  market?: string;
  symbol?: string;
  timeframe?: AlertTimeframe;
  conditions?: string[];
  confidence?: number;
};

type DeliverInstrumentNotificationInput = {
  memberId: string;
  alertType: InstrumentAlertType;
  assetType: AlertAssetType;
  market: string;
  symbol: string;
  instrumentName: string;
  timeframe: AlertTimeframe;
  eventKey: string;
  conditions: string[];
  confidence: number;
  currentPrice?: number;
  targetPrice?: number;
  stopPrice?: number;
  signalTime: string;
  dataTime: string;
  autoTradingStatus?: string;
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

  const appAllowed = input.app !== false && preferences.app_enabled !== false;
  const pushAllowed =
    input.push !== false && preferences.push_enabled === true && isVapidReady();

  if (!appAllowed && !pushAllowed) {
    return {
      appStored: false,
      pushSent: 0,
      skipped: input.push !== false && !isVapidReady() ? 'PUSH_NOT_CONFIGURED' : 'CHANNEL_DISABLED',
    };
  }

  const historyRow = {
    member_id: input.memberId,
    notification_type: input.type,
    title: input.title,
    body: input.body,
    url: input.url ?? null,
    channel: appAllowed && pushAllowed ? 'both' : pushAllowed ? 'push' : 'app',
    asset_type: input.assetType ?? null,
    market: input.market ?? null,
    symbol: input.symbol ?? null,
    timeframe: input.timeframe ?? null,
    conditions: input.conditions ?? [],
    confidence: input.confidence ?? null,
    event_key: input.eventKey ?? null,
    delivery_status: pushAllowed ? 'sending' : 'stored',
  };

  const { data: history, error: historyError } = await getSupabase()
    .from('notification_history')
    .insert(historyRow)
    .select('id')
    .single();
  if (historyError) {
    if (historyError.code === '23505' && input.eventKey) {
      return { appStored: false, pushSent: 0, skipped: 'DUPLICATE_EVENT' };
    }
    throw historyError;
  }

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
      (data ?? []).map(async (row: { endpoint: string; subscription: unknown }) => {
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

  const pushRequested = input.push !== false && preferences.push_enabled === true;
  const failureReason = pushRequested && !isVapidReady()
    ? 'PUSH_NOT_CONFIGURED'
    : pushAllowed && pushSent === 0
      ? 'NO_VALID_PUSH_SUBSCRIPTION'
      : null;
  await getSupabase()
    .from('notification_history')
    .update({
      delivery_status: failureReason ? 'partial' : pushSent > 0 ? 'delivered' : 'stored',
      failure_reason: failureReason,
      delivered_at: pushSent > 0 ? new Date().toISOString() : null,
    })
    .eq('id', history.id);

  return {
    appStored: appAllowed,
    pushSent,
    ...(failureReason ? { skipped: failureReason } : {}),
  };
}

function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function isInsideWindow(now: number, startValue: string | null, endValue: string | null): boolean {
  if (!startValue || !endValue) return true;
  const start = minuteOfDay(startValue);
  const end = minuteOfDay(endValue);
  if (start === null || end === null) return true;
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

export async function deliverInstrumentNotification(
  input: DeliverInstrumentNotificationInput,
): Promise<{ appStored: boolean; pushSent: number; skipped?: string }> {
  const supabase = getSupabase();
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role,status')
    .eq('id', input.memberId)
    .single();
  if (profileError) throw profileError;
  if (profile.status !== 'approved' || !roleCanUseAlert(profile.role, input.alertType)) {
    return { appStored: false, pushSent: 0, skipped: 'ROLE_NOT_ALLOWED' };
  }

  const { data: setting, error: settingError } = await supabase
    .from('instrument_alert_settings')
    .select('*')
    .eq('member_id', input.memberId)
    .eq('asset_type', input.assetType)
    .eq('market', input.market)
    .eq('symbol', input.symbol.toUpperCase())
    .eq('alert_type', input.alertType)
    .maybeSingle();
  if (settingError) throw settingError;
  if (!setting?.enabled) return { appStored: false, pushSent: 0, skipped: 'INSTRUMENT_ALERT_DISABLED' };
  if (setting.timeframe !== input.timeframe) return { appStored: false, pushSent: 0, skipped: 'TIMEFRAME_MISMATCH' };
  if (input.confidence < Number(setting.min_confidence)) return { appStored: false, pushSent: 0, skipped: 'CONFIDENCE_BELOW_MINIMUM' };
  if (input.conditions.length < Number(setting.min_condition_count)) return { appStored: false, pushSent: 0, skipped: 'CONDITION_COUNT_BELOW_MINIMUM' };

  const seoulTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const nowMinute = minuteOfDay(seoulTime) ?? 0;
  if (!isInsideWindow(nowMinute, setting.allowed_start, setting.allowed_end)) {
    return { appStored: false, pushSent: 0, skipped: 'OUTSIDE_ALLOWED_TIME' };
  }
  if (setting.dnd_start && setting.dnd_end && isInsideWindow(nowMinute, setting.dnd_start, setting.dnd_end)) {
    return { appStored: false, pushSent: 0, skipped: 'DO_NOT_DISTURB' };
  }

  const cooldownStart = new Date(Date.now() - Number(setting.cooldown_minutes) * 60_000).toISOString();
  const { count, error: cooldownError } = await supabase
    .from('notification_history')
    .select('id', { count: 'exact', head: true })
    .eq('member_id', input.memberId)
    .eq('symbol', input.symbol.toUpperCase())
    .eq('timeframe', input.timeframe)
    .eq('notification_type', input.alertType)
    .gte('created_at', cooldownStart);
  if (cooldownError) throw cooldownError;
  if ((count ?? 0) > 0) return { appStored: false, pushSent: 0, skipped: 'COOLDOWN_ACTIVE' };

  const priceFacts = [
    input.currentPrice === undefined ? null : `현재가 ${input.currentPrice.toLocaleString('ko-KR')}`,
    input.targetPrice === undefined ? null : `목표가 ${input.targetPrice.toLocaleString('ko-KR')}`,
    input.stopPrice === undefined ? null : `손절가 ${input.stopPrice.toLocaleString('ko-KR')}`,
  ].filter((value): value is string => value !== null);
  const body = [
    `${input.timeframe} 조건 ${input.conditions.length}개 충족`,
    ...input.conditions,
    ...priceFacts,
    `신뢰도 ${input.confidence}%`,
    `신호 ${input.signalTime} · 데이터 ${input.dataTime}`,
    input.autoTradingStatus ? `자동매매 ${input.autoTradingStatus}` : null,
  ].filter((value): value is string => value !== null).join(' · ');

  const market = encodeURIComponent(input.market);
  const symbol = encodeURIComponent(input.symbol.toUpperCase());
  return deliverMemberNotification({
    memberId: input.memberId,
    type: input.alertType,
    title: `${input.instrumentName} · ${input.alertType}`,
    body,
    url: `/stock-info?asset=${input.assetType === 'stock' ? 'stock' : 'coin'}&market=${market}&ticker=${symbol}&tab=ai-chart`,
    push: setting.push_enabled === true,
    eventKey: input.eventKey,
    assetType: input.assetType,
    market: input.market,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    conditions: input.conditions,
    confidence: input.confidence,
    metadata: { signalTime: input.signalTime, dataTime: input.dataTime },
  });
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
