import { logger } from '../lib/logger';
import {
  buildTelegramSignalIntelligenceInput,
  collectTelegramSignalIntelligence,
  type TelegramSignalDeliveryContext,
} from './telegram-investment-intelligence.service';
import type { ScannerAlertCandidate, ScannerAssetClass } from './scanner-signal.types';
import { markTelegramSignalAnnounced } from './telegram-signal-followup.service';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

export type ScannerTelegramSender = (
  input: TelegramAlertInput,
) => Promise<TelegramAlertResult>;

export type ScannerTelegramRoom = 'STOCK_ROOM' | 'CRYPTO_ROOM';
export type ScannerTelegramRoomResolver = (room: ScannerTelegramRoom) => string | null;

const MAX_RICH_ALERTS_PER_BATCH = 3;

function formatTargetPlan(targets: readonly number[]): string {
  if (!targets.length) return 'N/A';
  return targets.slice(0, 3).map((target, index) => `TP${index + 1} ${target}`).join(' · ');
}

function tradePlanLines(alert: ScannerAlertCandidate): string[] {
  const entry = alert.entryZone
    ? `${alert.entryZone.from}~${alert.entryZone.to}`
    : 'N/A';
  const stop = alert.stopLoss == null ? 'N/A' : String(alert.stopLoss);
  return [
    `진입가/진입구간 ${entry}`,
    '분할 매수 N/A (검증된 1·2·3차 분할 진입가 미제공)',
    `분할 매도가 ${formatTargetPlan(alert.targets)}`,
    `손절가 ${stop}`,
    '실제 주문/체결 아님',
  ];
}

function pricePlanDetails(alert: ScannerAlertCandidate): string {
  const evidence = alert.evidence.length ? ` · 근거 ${alert.evidence.slice(0, 5).join(' / ')}` : '';
  return `승인 대기 신호 · ${tradePlanLines(alert).join(' · ')}${evidence}`;
}

export function scannerTelegramRoomFor(assetClass: ScannerAssetClass): ScannerTelegramRoom {
  return assetClass === 'stock' ? 'STOCK_ROOM' : 'CRYPTO_ROOM';
}

export function scannerTelegramRoomChatId(room: ScannerTelegramRoom): string | null {
  switch (room) {
    case 'STOCK_ROOM':
      return process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || null;
    case 'CRYPTO_ROOM':
      return process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || null;
  }
}

export function scannerTelegramInput(
  alert: ScannerAlertCandidate,
  resolveRoomChatId: ScannerTelegramRoomResolver = scannerTelegramRoomChatId,
): TelegramAlertInput | null {
  if (alert.state !== 'APPROVAL_PENDING' && alert.state !== 'READY_FOR_APPROVAL') return null;

  const destinationChatId = resolveRoomChatId(scannerTelegramRoomFor(alert.assetClass));
  if (!destinationChatId) return null;

  if (alert.assetClass === 'stock') {
    if (alert.direction !== 'LONG') return null;
    return {
      type: 'strong_buy',
      symbol: alert.symbol,
      market: alert.market,
      details: pricePlanDetails(alert),
      dedupeKey: alert.idempotencyKey,
      destinationChatId,
    };
  }

  if (alert.assetClass === 'coin_spot') {
    if (alert.direction !== 'LONG') return null;
    return {
      type: 'crypto_spot_buy',
      symbol: alert.symbol,
      market: alert.market,
      details: pricePlanDetails(alert),
      dedupeKey: alert.idempotencyKey,
      destinationChatId,
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
      destinationChatId,
    };
  }

  return null;
}

function normalizeRichTradePlan(
  input: TelegramAlertInput,
  alert: ScannerAlertCandidate,
): TelegramAlertInput {
  if (!input.details) return input;
  const lines = input.details.split('\n');
  // buildTelegramSignalIntelligenceInput puts its legacy compact price-plan on
  // line 2. Replace only that canonical line so evidence/news/AI stay intact.
  if (lines.length >= 2) lines.splice(1, 1, ...tradePlanLines(alert));
  else lines.push(...tradePlanLines(alert));
  return { ...input, details: lines.join('\n') };
}

async function richInput(
  base: TelegramAlertInput,
  alert: ScannerAlertCandidate,
  context: TelegramSignalDeliveryContext,
): Promise<TelegramAlertInput> {
  if (process.env.TELEGRAM_SIGNAL_RICH_MEDIA_ENABLED !== 'true') return base;
  try {
    const evidence = await collectTelegramSignalIntelligence(alert, context);
    return normalizeRichTradePlan(
      buildTelegramSignalIntelligenceInput(base, alert, evidence, context),
      alert,
    );
  } catch (error) {
    logger.warn(
      { signalId: alert.signalId, errorName: error instanceof Error ? error.name : 'UnknownError' },
      'scanner Telegram rich evidence unavailable; falling back to base alert',
    );
    return base;
  }
}

export async function deliverScannerTelegramAlerts(
  alerts: ScannerAlertCandidate[],
  sender: ScannerTelegramSender = sendTelegramAlert,
  resolveRoomChatId: ScannerTelegramRoomResolver = scannerTelegramRoomChatId,
  context: TelegramSignalDeliveryContext = {},
): Promise<void> {
  await Promise.all(alerts.map(async (alert, index) => {
    const base = scannerTelegramInput(alert, resolveRoomChatId);
    if (!base) return;
    const input = index < MAX_RICH_ALERTS_PER_BATCH ? await richInput(base, alert, context) : base;
    try {
      const result = await sender(input);
      if (result.ok || result.skipped === 'DUPLICATE') {
        markTelegramSignalAnnounced(alert);
      }
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
