import { logger } from '../lib/logger';
import { deliverMemberNotification } from './notification.service';
import {
  buildTelegramSignalIntelligenceInput,
  collectTelegramSignalIntelligence,
  type TelegramSignalDeliveryContext,
  type TelegramSignalIntelligenceEvidence,
} from './telegram-investment-intelligence.service';
import {
  fanoutMemberHoldingScannerAlert,
  type MemberHoldingProducerSummary,
} from './member-holdings-telegram-producer.service';
import type { ScannerAlertCandidate, ScannerAssetClass } from './scanner-signal.types';
import { markTelegramSignalAnnounced } from './telegram-signal-followup.service';
import {
  sendTelegramAlert,
  sendTelegramAlertWithReceipt,
  type TelegramAlertInput,
  type TelegramAlertResult,
  type TelegramDeliveryReceipt,
} from './telegram-notification.service';
import {
  evaluateTelegramSignalFreshness,
  formatTelegramAge,
  type TelegramSignalFreshness,
} from './telegram-signal-freshness.service';

export type ScannerTelegramSender = (
  input: TelegramAlertInput,
) => Promise<TelegramAlertResult>;

export type ScannerTelegramRoom = 'STOCK_ROOM' | 'CRYPTO_ROOM';
export type ScannerTelegramRoomResolver = (room: ScannerTelegramRoom) => string | null;
export type ScannerMemberHoldingProducer = (
  alert: ScannerAlertCandidate,
) => Promise<MemberHoldingProducerSummary>;
export type ScannerTelegramDeliveryContext = TelegramSignalDeliveryContext & {
  memberId?: string;
};
export type ScannerMemberNotificationDeliverer = typeof deliverMemberNotification;

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

export function scannerInAppNotificationInput(
  alert: ScannerAlertCandidate,
  context: ScannerTelegramDeliveryContext = {},
): Parameters<typeof deliverMemberNotification>[0] | null {
  const memberId = context.memberId?.trim();
  if (!memberId) return null;
  if (alert.assetClass === 'stock' && alert.direction !== 'LONG') return null;
  if (alert.assetClass === 'coin_spot' && alert.direction !== 'LONG') return null;
  if (alert.assetClass === 'coin_futures' && alert.direction !== 'LONG' && alert.direction !== 'SHORT') return null;

  const lane = alert.assetClass === 'coin_futures'
    ? '코인선물'
    : alert.assetClass === 'coin_spot'
      ? '코인현물'
      : alert.market.trim().toUpperCase() === 'US'
        ? '미국주식'
        : '국내주식';
  const reasons = alert.evidence.map((item) => item.trim()).filter(Boolean).slice(0, 3);
  return {
    memberId,
    type: alert.direction === 'SHORT' ? 'ai_sell_signal' : 'ai_strong_buy',
    title: `검색기 ${alert.direction} · ${alert.symbol}`,
    body: `${lane} · ${alert.market}${reasons.length ? ` · 근거 ${reasons.join(' / ')}` : ''} · 실제 주문/체결 아님`,
    url: '/scanner',
    app: true,
    push: false,
    metadata: {
      source: 'SCANNER',
      signalId: alert.signalId,
      idempotencyKey: alert.idempotencyKey,
      assetClass: alert.assetClass,
      market: alert.market,
      symbol: alert.symbol,
      direction: alert.direction,
      state: alert.state,
      timeframe: context.timeframe ?? null,
      generatedAt: context.generatedAt ?? null,
    },
  };
}

async function runScannerInAppNotification(
  alert: ScannerAlertCandidate,
  context: ScannerTelegramDeliveryContext,
  deliver: ScannerMemberNotificationDeliverer,
): Promise<void> {
  const input = scannerInAppNotificationInput(alert, context);
  if (!input) return;
  try {
    await deliver(input);
  } catch (error) {
    logger.warn(
      {
        signalId: alert.signalId,
        memberId: input.memberId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'scanner in-app notification_history delivery failed open',
    );
  }
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

function freshnessWarning(freshness: TelegramSignalFreshness): string | null {
  if (freshness.status === 'FRESH') return null;
  if (freshness.status === 'PARTIAL') return '⚠️ 일부 Evidence 미확인 · 표시된 근거만 사용';
  return '⛔ 재검증 전 실시간 신호로 사용 금지';
}

export function addTelegramSignalFreshness(
  input: TelegramAlertInput,
  alert: ScannerAlertCandidate,
  context: TelegramSignalDeliveryContext,
  evidence: TelegramSignalIntelligenceEvidence | null = null,
  nowMs?: number,
): TelegramAlertInput {
  const freshness = evaluateTelegramSignalFreshness({
    generatedAt: context.generatedAt,
    expiresAt: alert.expiresAt,
    chart: evidence?.chart ?? null,
    warnings: evidence?.warnings ?? [],
    nowMs,
  });
  const warning = freshnessWarning(freshness);
  const lines = input.details ? input.details.split('\n') : [];

  lines.push(
    `Freshness: ${freshness.status} · 유효성 ${freshness.validity}`,
    `신호 생성 ${freshness.signalGeneratedAt ?? 'N/A'} · 신호 나이 ${formatTelegramAge(freshness.signalAgeMs)}`,
    `데이터 기준 ${freshness.dataAsOf ?? 'N/A'} · 데이터 나이 ${formatTelegramAge(freshness.dataAgeMs)}`,
    `신호 만료 ${freshness.expiresAt ?? 'N/A'} · 남은 유효시간 ${formatTelegramAge(freshness.remainingMs)}`,
  );
  if (warning) lines.push(warning);
  if (freshness.reasonCodes.length) lines.push(`Freshness 근거: ${freshness.reasonCodes.join(', ')}`);

  return { ...input, details: lines.join('\n') };
}

async function richInput(
  base: TelegramAlertInput,
  alert: ScannerAlertCandidate,
  context: TelegramSignalDeliveryContext,
): Promise<TelegramAlertInput> {
  if (process.env.TELEGRAM_SIGNAL_RICH_MEDIA_ENABLED !== 'true') {
    return addTelegramSignalFreshness(base, alert, context);
  }
  try {
    const evidence = await collectTelegramSignalIntelligence(alert, context);
    return addTelegramSignalFreshness(
      normalizeRichTradePlan(
        buildTelegramSignalIntelligenceInput(base, alert, evidence, context),
        alert,
      ),
      alert,
      context,
      evidence,
    );
  } catch (error) {
    logger.warn(
      { signalId: alert.signalId, errorName: error instanceof Error ? error.name : 'UnknownError' },
      'scanner Telegram rich evidence unavailable; falling back to base alert',
    );
    return addTelegramSignalFreshness(base, alert, context);
  }
}

async function runMemberHoldingProducer(
  alert: ScannerAlertCandidate,
  producer: ScannerMemberHoldingProducer,
): Promise<void> {
  try {
    const result = await producer(alert);
    if (result.status === 'DISABLED' || result.status === 'UNSUPPORTED_ASSET') return;
    logger.info(
      {
        symbol: alert.symbol,
        memberHoldingsStatus: result.status,
        matchedCount: result.matchedCount,
        policyCount: result.policyCount,
        skippedCount: result.skippedCount,
        errorCount: result.errorCount,
      },
      'member holdings Telegram producer evaluated scanner alert',
    );
  } catch (error) {
    logger.warn(
      {
        symbol: alert.symbol,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'member holdings Telegram producer failed closed',
    );
  }
}

export async function deliverScannerTelegramAlerts(
  alerts: ScannerAlertCandidate[],
  sender: ScannerTelegramSender = sendTelegramAlert,
  resolveRoomChatId: ScannerTelegramRoomResolver = scannerTelegramRoomChatId,
  context: ScannerTelegramDeliveryContext = {},
  memberHoldingProducer: ScannerMemberHoldingProducer = fanoutMemberHoldingScannerAlert,
  memberNotificationDeliverer: ScannerMemberNotificationDeliverer = deliverMemberNotification,
): Promise<void> {
  await Promise.all(alerts.map(async (alert, index) => {
    // Central app history is member-scoped to the authenticated scanner caller
    // and uses the existing notification_history writer. Push remains disabled.
    const inAppEvaluation = runScannerInAppNotification(alert, context, memberNotificationDeliverer);
    // Start the independently default-off member path without serializing the
    // existing public-room path behind member DB/quote/Telegram latency.
    const memberEvaluation = runMemberHoldingProducer(alert, memberHoldingProducer);

    const base = scannerTelegramInput(alert, resolveRoomChatId);
    if (!base) {
      await Promise.all([inAppEvaluation, memberEvaluation]);
      return;
    }
    const input = index < MAX_RICH_ALERTS_PER_BATCH
      ? await richInput(base, alert, context)
      : addTelegramSignalFreshness(base, alert, context);

    let result: TelegramAlertResult;
    let receipt: TelegramDeliveryReceipt | null = null;
    try {
      if (sender === sendTelegramAlert) {
        const tracked = await sendTelegramAlertWithReceipt(input);
        result = tracked.ok ? { ok: true, attempts: tracked.attempts } : tracked;
        receipt = tracked.ok ? tracked.receipt : null;
      } else {
        result = await sender(input);
      }
    } catch (error) {
      logger.warn(
        {
          alertType: input.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'scanner Telegram delivery failed open',
      );
      await Promise.all([inAppEvaluation, memberEvaluation]);
      return;
    }

    if (result.ok) {
      try {
        await markTelegramSignalAnnounced(alert, Date.now(), undefined, receipt);
      } catch (error) {
        logger.warn(
          {
            signalId: alert.signalId,
            alertType: input.type,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'scanner Telegram initial alert lacks durable followup checkpoint; failing closed until persistence recovers',
        );
        await Promise.all([inAppEvaluation, memberEvaluation]);
        throw error;
      }
    }
    await Promise.all([inAppEvaluation, memberEvaluation]);
  }));
}
