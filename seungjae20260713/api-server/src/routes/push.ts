import { Router, type IRouter } from 'express';
import { type AuthenticatedRequest } from '../middleware/auth';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  DEFAULT_NOTIFICATION_TYPES,
  deliverMemberNotification,
  ensureNotificationPreferences,
  isVapidReady,
  runPriceAlertMonitorOnce,
} from '../services/notification.service';
import {
  ALERT_TYPES,
  allowedAlertTypes,
  isAlertAssetType,
  isAlertTimeframe,
  isInstrumentAlertType,
  type InstrumentAlertType,
} from '../types/instrument-alert';

const router: IRouter = Router();

// 서비스 역할 키가 없으면 로그인한 회원 본인 토큰으로 DB에 접근한다 (RLS 준수).
function db(req: AuthenticatedRequest) {
  return hasSupabaseServerKey() ? getSupabase() : getUserSupabase(req.accessToken!);
}

function getEndpoint(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null;
}

router.get('/notifications/preferences', async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({
      preferences: await ensureNotificationPreferences(req.member!.id, db(req)),
      vapidReady: isVapidReady(),
    });
  } catch (error) {
    console.error('notification preferences read error:', error);
    return res.status(500).json({ error: 'NOTIFICATION_PREFERENCES_READ_FAILED' });
  }
});

router.put('/notifications/preferences', async (req: AuthenticatedRequest, res) => {
  const enabledTypes = Array.isArray(req.body?.enabledTypes)
    ? [...new Set<string>((req.body.enabledTypes as unknown[]).map(String))].filter(
        (item: string) => DEFAULT_NOTIFICATION_TYPES.some((type) => type === item),
      )
    : [...DEFAULT_NOTIFICATION_TYPES];

  const changes = {
    member_id: req.member!.id,
    enabled_types: enabledTypes,
    app_enabled: req.body?.appEnabled !== false,
    push_enabled: req.body?.pushEnabled === true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db(req)
    .from('notification_preferences')
    .upsert(changes, { onConflict: 'member_id' })
    .select('*')
    .single();

  if (error) {
    return res.status(500).json({ error: 'NOTIFICATION_PREFERENCES_SAVE_FAILED' });
  }

  return res.json({ preferences: data });
});

router.post('/push/subscribe', async (req: AuthenticatedRequest, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });

  const { error } = await db(req)
    .from('push_subscriptions')
    .upsert(
      {
        member_id: req.member!.id,
        endpoint,
        subscription: req.body,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );

  if (error) return res.status(500).json({ error: 'PUSH_SUBSCRIPTION_SAVE_FAILED' });

  await db(req)
    .from('notification_preferences')
    .upsert(
      {
        member_id: req.member!.id,
        push_enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'member_id' },
    );

  const { count } = await db(req)
    .from('push_subscriptions')
    .select('*', { count: 'exact', head: true })
    .eq('member_id', req.member!.id);

  return res.json({ ok: true, count: count ?? 0, vapidReady: isVapidReady() });
});

router.post('/push/unsubscribe', async (req: AuthenticatedRequest, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: 'INVALID_ENDPOINT' });

  const { error } = await db(req)
    .from('push_subscriptions')
    .delete()
    .eq('member_id', req.member!.id)
    .eq('endpoint', endpoint);

  if (error) return res.status(500).json({ error: 'PUSH_UNSUBSCRIBE_FAILED' });

  return res.json({ ok: true });
});

router.post('/push/test', async (req: AuthenticatedRequest, res) => {
  // 발송 파이프라인은 서버(서비스 역할) 키가 필요하다. 없으면 조용히 실패하는 대신 명시적으로 알린다.
  if (!hasSupabaseServerKey()) {
    return res.status(503).json({
      error: 'SERVICE_KEY_REQUIRED',
      message: 'SUPABASE_SERVICE_ROLE_KEY가 등록되어야 알림 발송을 사용할 수 있습니다.',
    });
  }

  const body =
    typeof req.body === 'object' && req.body
      ? (req.body as Record<string, unknown>)
      : {};

  const result = await deliverMemberNotification({
    memberId: req.member!.id,
    type: 'system',
    title: String(body.title ?? '지식정보 테스트 알림'),
    body: String(body.body ?? '회원별 통합 알림 연결 테스트입니다.'),
    url: String(body.url ?? '/alerts'),
    app: true,
    push: true,
  });

  return res.json({ ok: true, ...result, vapidReady: isVapidReady() });
});

router.post(
  '/notifications/price-alerts/check-now',
  async (_req: AuthenticatedRequest, res) => {
    if (!hasSupabaseServerKey()) {
      return res.status(503).json({
        error: 'SERVICE_KEY_REQUIRED',
        message:
          'SUPABASE_SERVICE_ROLE_KEY가 등록되어야 가격 알림 모니터를 실행할 수 있습니다.',
      });
    }

    try {
      return res.json({ ok: true, ...(await runPriceAlertMonitorOnce()) });
    } catch (error) {
      console.error('price alert manual check error:', error);
      return res.status(500).json({ error: 'PRICE_ALERT_CHECK_FAILED' });
    }
  },
);

function cleanInstrumentSegment(value: unknown, maxLength = 30): string | null {
  const result = String(value ?? '').trim().toUpperCase();
  return result.length > 0 && result.length <= maxLength && /^[A-Z0-9._-]+$/.test(result)
    ? result
    : null;
}

function optionalTime(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  return value;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

router.get(
  '/notifications/instruments/:assetType/:market/:symbol',
  async (req: AuthenticatedRequest, res) => {
    const assetType = isAlertAssetType(req.params.assetType) ? req.params.assetType : null;
    const market = cleanInstrumentSegment(req.params.market, 20);
    const symbol = cleanInstrumentSegment(req.params.symbol);
    if (!assetType || !market || !symbol) {
      return res.status(400).json({ error: 'INVALID_INSTRUMENT' });
    }

    const allowed = allowedAlertTypes(req.member!.role);
    const { data, error } = await db(req)
      .from('instrument_alert_settings')
      .select('*')
      .eq('member_id', req.member!.id)
      .eq('asset_type', assetType)
      .eq('market', market)
      .eq('symbol', symbol)
      .in('alert_type', [...allowed]);
    if (error) return res.status(500).json({ error: 'INSTRUMENT_ALERT_SETTINGS_READ_FAILED' });

    const saved = new Map(
      (data ?? []).map((row: Record<string, unknown>) => [String(row.alert_type), row]),
    );
    return res.json({
      instrument: { assetType, market, symbol },
      settings: allowed.map((alertType) => saved.get(alertType) ?? {
        alert_type: alertType,
        enabled: false,
        timeframe: '1D',
        trigger_value: null,
        trigger_unit: alertType === 'change_rate' ? 'percent' : alertType === 'target_price' ? 'price' : null,
        min_confidence: 70,
        min_condition_count: 2,
        cooldown_minutes: 60,
        allowed_start: null,
        allowed_end: null,
        dnd_start: null,
        dnd_end: null,
        push_enabled: false,
      }),
      allowedTypes: allowed,
      allTypes: ALERT_TYPES,
      vapidReady: isVapidReady(),
    });
  },
);

router.put(
  '/notifications/instruments/:assetType/:market/:symbol',
  async (req: AuthenticatedRequest, res) => {
    const assetType = isAlertAssetType(req.params.assetType) ? req.params.assetType : null;
    const market = cleanInstrumentSegment(req.params.market, 20);
    const symbol = cleanInstrumentSegment(req.params.symbol);
    const instrumentName = String(req.body?.instrumentName ?? symbol ?? '').trim().slice(0, 120);
    const rawSettings = Array.isArray(req.body?.settings) ? req.body.settings : null;
    if (!assetType || !market || !symbol || !rawSettings) {
      return res.status(400).json({ error: 'INVALID_INSTRUMENT_ALERT_SETTINGS' });
    }

    const allowed = allowedAlertTypes(req.member!.role);
    const normalized: Array<Record<string, unknown>> = [];
    const seen = new Set<InstrumentAlertType>();
    for (const rawValue of rawSettings) {
      if (!rawValue || typeof rawValue !== 'object') {
        return res.status(400).json({ error: 'INVALID_INSTRUMENT_ALERT_SETTING' });
      }
      const raw = rawValue as Record<string, unknown>;
      if (!isInstrumentAlertType(raw.alertType) || seen.has(raw.alertType)) {
        return res.status(400).json({ error: 'INVALID_OR_DUPLICATE_ALERT_TYPE' });
      }
      if (!allowed.includes(raw.alertType)) {
        return res.status(403).json({ error: 'ALERT_TYPE_NOT_ALLOWED', alertType: raw.alertType });
      }
      if (!isAlertTimeframe(raw.timeframe)) {
        return res.status(400).json({ error: 'INVALID_ALERT_TIMEFRAME', alertType: raw.alertType });
      }
      const minConfidence = finiteNumber(raw.minConfidence, 0, 100);
      const minConditionCount = finiteNumber(raw.minConditionCount, 1, 20);
      const cooldownMinutes = finiteNumber(raw.cooldownMinutes, 1, 10080);
      const allowedStart = optionalTime(raw.allowedStart);
      const allowedEnd = optionalTime(raw.allowedEnd);
      const dndStart = optionalTime(raw.dndStart);
      const dndEnd = optionalTime(raw.dndEnd);
      if (
        minConfidence === null || minConditionCount === null || cooldownMinutes === null ||
        allowedStart === undefined || allowedEnd === undefined ||
        dndStart === undefined || dndEnd === undefined
      ) {
        return res.status(400).json({ error: 'INVALID_ALERT_LIMIT', alertType: raw.alertType });
      }

      const triggerUnit = raw.alertType === 'target_price'
        ? 'price'
        : raw.alertType === 'change_rate'
          ? 'percent'
          : null;
      const triggerValue = triggerUnit === null || raw.triggerValue === null || raw.triggerValue === ''
        ? null
        : Number(raw.triggerValue);
      if (triggerValue !== null && !Number.isFinite(triggerValue)) {
        return res.status(400).json({ error: 'INVALID_TRIGGER_VALUE', alertType: raw.alertType });
      }
      if (raw.enabled === true && triggerUnit === 'price' && (triggerValue === null || triggerValue <= 0)) {
        return res.status(400).json({ error: 'TARGET_PRICE_REQUIRED', alertType: raw.alertType });
      }
      if (raw.pushEnabled === true && !isVapidReady()) {
        return res.status(503).json({
          error: 'PUSH_NOT_CONFIGURED',
          message: 'VAPID 서버 자격증명이 없어 휴대폰 푸시 설정을 저장할 수 없습니다.',
        });
      }

      seen.add(raw.alertType);
      normalized.push({
        member_id: req.member!.id,
        asset_type: assetType,
        market,
        symbol,
        instrument_name: instrumentName || symbol,
        alert_type: raw.alertType,
        enabled: raw.enabled === true,
        timeframe: raw.timeframe,
        trigger_value: triggerValue,
        trigger_unit: triggerUnit,
        min_confidence: minConfidence,
        min_condition_count: Math.trunc(minConditionCount),
        cooldown_minutes: Math.trunc(cooldownMinutes),
        allowed_start: allowedStart,
        allowed_end: allowedEnd,
        dnd_start: dndStart,
        dnd_end: dndEnd,
        push_enabled: raw.pushEnabled === true,
        updated_at: new Date().toISOString(),
      });
    }

    if (normalized.length > 0) {
      const { error } = await db(req)
        .from('instrument_alert_settings')
        .upsert(normalized, { onConflict: 'member_id,asset_type,market,symbol,alert_type' });
      if (error) return res.status(500).json({ error: 'INSTRUMENT_ALERT_SETTINGS_SAVE_FAILED' });
    }
    return res.json({ ok: true, saved: normalized.length, vapidReady: isVapidReady() });
  },
);

router.get('/notifications/history', async (req: AuthenticatedRequest, res) => {
  const limit = Math.max(
    1,
    Math.min(200, Number(req.query.limit ?? 100) || 100),
  );

  const { data, error } = await db(req)
    .from('notification_history')
    .select('*')
    .eq('member_id', req.member!.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: 'NOTIFICATION_HISTORY_READ_FAILED' });
  }

  return res.json({ notifications: data ?? [], count: data?.length ?? 0 });
});

router.patch(
  '/notifications/history/:id/read',
  async (req: AuthenticatedRequest, res) => {
    const { data, error } = await db(req)
      .from('notification_history')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('member_id', req.member!.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return res
        .status(500)
        .json({ error: 'NOTIFICATION_HISTORY_UPDATE_FAILED' });
    }

    return res.json({ notification: data });
  },
);

router.get(
  '/notifications/price-alerts',
  async (req: AuthenticatedRequest, res) => {
    const { data, error } = await db(req)
      .from('price_alerts')
      .select('*')
      .eq('member_id', req.member!.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'PRICE_ALERT_LIST_FAILED' });
    }

    return res.json({ alerts: data ?? [] });
  },
);

router.post(
  '/notifications/price-alerts',
  async (req: AuthenticatedRequest, res) => {
    const assetType = ['stock', 'coin_spot', 'coin_futures'].includes(
      String(req.body?.assetType),
    )
      ? String(req.body.assetType)
      : null;

    const direction = ['above', 'below'].includes(String(req.body?.direction))
      ? String(req.body.direction)
      : null;

    const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
    const targetPrice = Number(req.body?.targetPrice);

    if (
      !assetType ||
      !direction ||
      !symbol ||
      !Number.isFinite(targetPrice) ||
      targetPrice <= 0
    ) {
      return res.status(400).json({ error: 'INVALID_PRICE_ALERT' });
    }

    const row = {
      member_id: req.member!.id,
      asset_type: assetType,
      market: String(req.body?.market ?? ''),
      symbol,
      direction,
      target_price: targetPrice,
      repeat_enabled: req.body?.repeatEnabled === true,
      app_enabled: req.body?.appEnabled !== false,
      push_enabled: req.body?.pushEnabled !== false,
      expires_at: req.body?.expiresAt || null,
      enabled: true,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await db(req)
      .from('price_alerts')
      .upsert(row, {
        onConflict:
          'member_id,asset_type,market,symbol,direction,target_price',
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'PRICE_ALERT_SAVE_FAILED' });
    }

    return res.json({ alert: data });
  },
);

router.delete(
  '/notifications/price-alerts/:id',
  async (req: AuthenticatedRequest, res) => {
    const alertId = String(req.params.id ?? '').trim();

    if (!alertId) {
      return res.status(400).json({
        error: 'INVALID_PRICE_ALERT_ID',
        message: '삭제할 지정가 알림 ID가 없습니다.',
      });
    }

    try {
      const { data, error } = await db(req)
        .from('price_alerts')
        .delete()
        .eq('id', alertId)
        .eq('member_id', req.member!.id)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('price alert delete error:', {
          alertId,
          memberId: req.member!.id,
          error,
        });

        return res.status(500).json({
          error: 'PRICE_ALERT_DELETE_FAILED',
          message: '지정가 알림을 삭제하지 못했습니다.',
          detail: error.message,
        });
      }

      if (!data) {
        return res.status(404).json({
          error: 'PRICE_ALERT_NOT_FOUND',
          message:
            '삭제할 지정가 알림을 찾지 못했거나 현재 회원의 알림이 아닙니다.',
        });
      }

      return res.json({
        ok: true,
        deletedId: String(data.id),
      });
    } catch (error) {
      console.error('price alert delete unexpected error:', error);

      return res.status(500).json({
        error: 'PRICE_ALERT_DELETE_FAILED',
        message: '지정가 알림 삭제 중 서버 오류가 발생했습니다.',
      });
    }
  },
);

export default router;
