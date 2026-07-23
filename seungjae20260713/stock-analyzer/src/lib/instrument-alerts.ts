export const INSTRUMENT_ALERT_TYPES = [
  'disclosure', 'news', 'target_price', 'change_rate', 'buy', 'strong_buy',
  'sell', 'strong_sell', 'stop_loss', 'take_profit_1', 'take_profit_2',
  'final_target', 'add_buy_zone_1', 'add_buy_zone_2', 'add_buy_prohibited',
  'pattern_completed', 'pattern_invalidated', 'target_changed', 'stop_changed',
  'auto_trade',
] as const;

export type InstrumentAlertType = (typeof INSTRUMENT_ALERT_TYPES)[number];
export type AlertAssetType = 'stock' | 'coin_spot' | 'coin_futures';

export const ALERT_TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H', '1D',
  '3D', '5D', '10D', '20D', '1W', '1M', '1Y', 'ALL',
] as const;

export const ALERT_LABELS: Record<InstrumentAlertType, string> = {
  disclosure: '공시',
  news: '뉴스',
  target_price: '지정가',
  change_rate: '등락률',
  buy: '매수',
  strong_buy: '강력 매수',
  sell: '매도',
  strong_sell: '강력 매도',
  stop_loss: '손절',
  take_profit_1: '1차 익절',
  take_profit_2: '2차 익절',
  final_target: '최종 목표가',
  add_buy_zone_1: '1차 추가매수 검토구간 진입',
  add_buy_zone_2: '2차 추가매수 검토구간 진입',
  add_buy_prohibited: '추가매수 금지 전환',
  pattern_completed: '패턴 완성',
  pattern_invalidated: '패턴 무효화',
  target_changed: '목표가 변경',
  stop_changed: '손절가 변경',
  auto_trade: '자동매매 주문·체결·오류',
};

export interface InstrumentAlertSetting {
  alertType: InstrumentAlertType;
  enabled: boolean;
  timeframe: string;
  triggerValue: number | null;
  minConfidence: number;
  minConditionCount: number;
  cooldownMinutes: number;
  allowedStart: string | null;
  allowedEnd: string | null;
  dndStart: string | null;
  dndEnd: string | null;
  pushEnabled: boolean;
}

export interface InstrumentAlertSettingsResponse {
  settings: Array<Record<string, unknown>>;
  allowedTypes: InstrumentAlertType[];
  vapidReady: boolean;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeAlertSetting(row: Record<string, unknown>): InstrumentAlertSetting {
  return {
    alertType: String(row.alert_type) as InstrumentAlertType,
    enabled: row.enabled === true,
    timeframe: String(row.timeframe ?? '1D'),
    triggerValue: row.trigger_value == null ? null : numberOr(row.trigger_value, 0),
    minConfidence: numberOr(row.min_confidence, 70),
    minConditionCount: numberOr(row.min_condition_count, 2),
    cooldownMinutes: numberOr(row.cooldown_minutes, 60),
    allowedStart: typeof row.allowed_start === 'string' ? row.allowed_start.slice(0, 5) : null,
    allowedEnd: typeof row.allowed_end === 'string' ? row.allowed_end.slice(0, 5) : null,
    dndStart: typeof row.dnd_start === 'string' ? row.dnd_start.slice(0, 5) : null,
    dndEnd: typeof row.dnd_end === 'string' ? row.dnd_end.slice(0, 5) : null,
    pushEnabled: row.push_enabled === true,
  };
}
