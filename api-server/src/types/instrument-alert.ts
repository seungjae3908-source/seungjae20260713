import type { MemberProfile } from '../middleware/auth';

export const ALERT_TYPES = [
  'disclosure',
  'news',
  'target_price',
  'change_rate',
  'buy',
  'strong_buy',
  'sell',
  'strong_sell',
  'stop_loss',
  'take_profit_1',
  'take_profit_2',
  'final_target',
  'add_buy_zone_1',
  'add_buy_zone_2',
  'add_buy_prohibited',
  'pattern_completed',
  'pattern_invalidated',
  'target_changed',
  'stop_changed',
  'auto_trade',
] as const;

export type InstrumentAlertType = (typeof ALERT_TYPES)[number];
export type MemberRole = MemberProfile['role'];
export type AlertAssetType = 'stock' | 'coin_spot' | 'coin_futures';

export const ALERT_TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H', '1D',
  '3D', '5D', '10D', '20D', '1W', '1M', '1Y', 'ALL',
] as const;
export type AlertTimeframe = (typeof ALERT_TIMEFRAMES)[number];

export const BASIC_ALERT_TYPES: readonly InstrumentAlertType[] = [
  'disclosure', 'news', 'target_price', 'change_rate',
];
export const MEMBER_ALERT_TYPES: readonly InstrumentAlertType[] = ALERT_TYPES.filter(
  (type) => type !== 'auto_trade',
);

export function isInstrumentAlertType(value: unknown): value is InstrumentAlertType {
  return typeof value === 'string' && ALERT_TYPES.some((type) => type === value);
}

export function isAlertTimeframe(value: unknown): value is AlertTimeframe {
  return typeof value === 'string' && ALERT_TIMEFRAMES.some((timeframe) => timeframe === value);
}

export function isAlertAssetType(value: unknown): value is AlertAssetType {
  return value === 'stock' || value === 'coin_spot' || value === 'coin_futures';
}

export function allowedAlertTypes(role: MemberRole): readonly InstrumentAlertType[] {
  if (role === 'admin') return ALERT_TYPES;
  if (role === 'user') return MEMBER_ALERT_TYPES;
  return BASIC_ALERT_TYPES;
}

export function roleCanUseAlert(role: MemberRole, alertType: InstrumentAlertType): boolean {
  return allowedAlertTypes(role).includes(alertType);
}
