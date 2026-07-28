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

const router: IRouter = Router();

type PriceAlertAssetType = 'stock' | 'coin_spot' | 'coin_futures';
type PriceAlertConditionType =
  | 'price_above'
  | 'price_below'
  | 'change_above'
  | 'change_below';

const PRICE_ALERT_ASSETS: readonly PriceAlertAssetType[] = [
  'stock',
  'coin_spot',
  'coin_futures',
];
const PRICE_ALERT_CONDITIONS: readonly PriceAlertConditionType[] = [
  'price_above',
  'price_below',
  'change_above',
  'change_below',
];

function isPriceAlertAsset(value: string): value is PriceAlertAssetType {
  return PRICE_ALERT_ASSETS.some((item) => item === value);
}

function isPriceAlertCondition(
  value: string,
): value is PriceAlertConditionType {
  return PRICE_ALERT_CONDITIONS.some((item) => item === value);
}

function parsePriceAlertBody(
  body: unknown,
):
  | {
      assetType: PriceAlertAssetType;
      conditionType: PriceAlertConditionType;
      market: string;
      symbol: string;
      targetValue: number;
      repeatEnabled: boolean;
      appEnabled: boolean;
      pushEnabled: boolean;
      enabled: boolean;
      expiresAt: string | null;
    }
  | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const assetTypeText = String(raw.assetType ?? '');
  const legacyDirection = String(raw.direction ?? '');
  const conditionText = String(
    raw.conditionType ??
      (legacyDirection === 'below' ? 'price_below' : 'price_above'),
  );
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const targetValue = Number(raw.targetValue ?? raw.targetPrice);
  if (
    !isPriceAlertAsset(assetTypeText) ||
    !isPriceAlertCondition(conditionText) ||
    !symbol ||
    !Number.isFinite(targetValue) ||
    (conditionText.startsWith('price_') && targetValue <= 0)
  ) {
    return null;
  }
  return {
    assetType: assetTypeText,
    conditionType: conditionText,
    market: String(raw.market ?? ''),
    symbol,
    targetValue,
    repeatEnabled: raw.repeatEnabled === true,
    appEnabled: raw.appEnabled !== false,
    pushEnabled: raw.pushEnabled !== false,
    enabled: raw.enabled !== false,
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
  };
}

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
        (item: string) =>
          DEFAULT_NOTIFICATION_TYPES.some((allowed) => allowed === item),
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

router.patch(
  '/notifications/history/read-all',
  async (req: AuthenticatedRequest, res) => {
    const { error } = await db(req)
      .from('notification_history')
      .update({ read_at: new Date().toISOString() })
      .eq('member_id', req.member!.id)
      .is('read_at', null);

    if (error) {
      return res
        .status(500)
        .json({ error: 'NOTIFICATION_HISTORY_UPDATE_FAILED' });
    }
    return res.json({ ok: true });
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
    const input = parsePriceAlertBody(req.body);
    if (!input) {
      return res.status(400).json({ error: 'INVALID_PRICE_ALERT' });
    }

    const row = {
      member_id: req.member!.id,
      asset_type: input.assetType,
      market: input.market,
      symbol: input.symbol,
      direction: input.conditionType.endsWith('_above') ? 'above' : 'below',
      target_price: input.targetValue,
      condition_type: input.conditionType,
      target_value: input.targetValue,
      repeat_enabled: input.repeatEnabled,
      app_enabled: input.appEnabled,
      push_enabled: input.pushEnabled,
      expires_at: input.expiresAt,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await db(req)
      .from('price_alerts')
      .upsert(row, {
        onConflict:
          'member_id,asset_type,market,symbol,condition_type,target_value',
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'PRICE_ALERT_SAVE_FAILED' });
    }

    return res.json({ alert: data });
  },
);

router.patch(
  '/notifications/price-alerts/:id',
  async (req: AuthenticatedRequest, res) => {
    const input = parsePriceAlertBody(req.body);
    if (!input) {
      return res.status(400).json({ error: 'INVALID_PRICE_ALERT' });
    }

    const { data, error } = await db(req)
      .from('price_alerts')
      .update({
        asset_type: input.assetType,
        market: input.market,
        symbol: input.symbol,
        direction: input.conditionType.endsWith('_above') ? 'above' : 'below',
        target_price: input.targetValue,
        condition_type: input.conditionType,
        target_value: input.targetValue,
        repeat_enabled: input.repeatEnabled,
        app_enabled: input.appEnabled,
        push_enabled: input.pushEnabled,
        expires_at: input.expiresAt,
        enabled: input.enabled,
        condition_met: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('member_id', req.member!.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: 'PRICE_ALERT_UPDATE_FAILED' });
    }
    if (!data) return res.status(404).json({ error: 'PRICE_ALERT_NOT_FOUND' });
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
