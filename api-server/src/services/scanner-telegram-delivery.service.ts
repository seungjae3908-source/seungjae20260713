import { logger } from '../lib/logger';
import type { ScannerAlertCandidate } from './scanner-signal.types';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

export type ScannerTelegramSender = (
  input: TelegramAlertInput,
) => Promise<TelegramAlertResult>;

function pricePlanDetails(alert: ScannerAlertCandidate): string {
  const entry = alert.entryZone
    ? `${alert.entryZone.from}~${alert.entryZone.to}`
    : '미확정';
  const stop = alert.stopLoss == null ? '미확정' : String(alert.stopLoss);
  const targets = alert.targets.length > 0 ? alert.targets.join(', ') : '미확정';
  return `승인 대기 신호 · 진입구간 ${entry} · 손절 ${stop} · 목표 ${targets}`;
}

export function scannerTelegramInput(
  alert: ScannerAlertCandidate,
): TelegramAlertInput | null {
  if (alert.state !== 'APPROVAL_PENDING' && alert.state !== 'READY_FOR_APPROVAL') return null;

  if (alert.assetClass === 'stock') {
    if (alert.direction !== 'LONG') return null;
    return {
      type: 'strong_buy',
      symbol: alert.symbol,
      market: alert.market,
      details: pricePlanDetails(alert),
      dedupeKey: alert.idempotencyKey,
    };
  }

  if (alert.assetClass === 'coin_futures') {
    if (alert.direction !== 'LONG' && alert.direction !== 'SHORT') return null;
    return {
      type: alert.direction === 'LONG' ? 'crypto_futures_long' : 'crypto_futures_short',
      symbol: alert.symbol,
      market: alert.market,
      details: pricePlanDetails(alert),
      dedupeKey: alert.idempotencyKey,
    };
  }

  return null;
}

export async function deliverScannerTelegramAlerts(
  alerts: ScannerAlertCandidate[],
  sender: ScannerTelegramSender = sendTelegramAlert,
): Promise<void> {
  await Promise.all(alerts.map(async (alert) => {
    const input = scannerTelegramInput(alert);
    if (!input) return;
    try {
      await sender(input);
    } catch (error) {
      logger.warn(
        {
          alertType: input.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'scanner Telegram delivery failed open',
      );
    }
  }));
}
