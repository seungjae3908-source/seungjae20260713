/**
 * "Signal status" section for the scheduled market-room brief.
 *
 * Read-only: one bounded loopback GET of the Signal V3 snapshot. It never
 * names an entry candidate or any price; individual entry candidates are
 * delivered only by the Signal V3 subscriber after its own full validation.
 * This section only tells each room whether the engine answered, how many
 * current entry candidates it holds, or that there is no new signal, plus
 * A-grade watch items by name only (owner request, 2026-10-18).
 */
import type { TelegramReportDestination } from './telegram-intelligence-report.service';
import { renderNoSignalLineV2, type SignalMessageMarket } from './telegram-signal-message-v2.service';
import {
  boundedTelegramV3Json,
  validTelegramV3CurrentSource,
  verifiedTelegramV3PageCount,
} from './telegram-v3-current-source.service';

const DEFAULT_URL = 'http://127.0.0.1:8790/v1/signals';
const SIGNAL_READ_MAX_MS = 3_000;
const LANE_PREFIX: Record<SignalMessageMarket, string> = {
  KR_STOCK: 'KR_', US_STOCK: 'US_', CRYPTO_SPOT: 'SPOT_', CRYPTO_FUTURES: 'FUTURES_',
};

export type TelegramBriefSignalStatus =
  | { status: 'READY'; snapshot: Record<string, any> }
  | { status: 'UNAVAILABLE' | 'INVALID' };

export function telegramBriefSignalMarket(destination: TelegramReportDestination): SignalMessageMarket {
  switch (destination) {
    case 'KR_STOCK_ROOM': return 'KR_STOCK';
    case 'US_STOCK_ROOM': return 'US_STOCK';
    case 'CRYPTO_SPOT_ROOM': return 'CRYPTO_SPOT';
    case 'CRYPTO_FUTURES_ROOM': return 'CRYPTO_FUTURES';
  }
}

/** Loopback public GET /v1/signals only; anything else reads as UNAVAILABLE. */
function loopbackSignalUrl(configured: string | undefined): string | null {
  try {
    const url = new URL(configured?.trim() || DEFAULT_URL);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.pathname !== '/v1/signals' || url.search || url.hash || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function collectTelegramBriefSignalStatus(
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  configured = process.env.SIGNAL_INTELLIGENCE_URL,
): Promise<TelegramBriefSignalStatus> {
  const url = loopbackSignalUrl(configured);
  if (!url) return { status: 'UNAVAILABLE' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGNAL_READ_MAX_MS);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (!response.ok) return { status: 'UNAVAILABLE' };
    const envelope = await boundedTelegramV3Json(response) as Record<string, any>;
    const snapshot = envelope?.snapshot;
    if (envelope?.ok !== true || envelope.executionAuthority !== 'NONE'
      || envelope.serviceSha !== snapshot?.serviceSha
      || !validTelegramV3CurrentSource(snapshot, now.getTime())) return { status: 'INVALID' };
    return { status: 'READY', snapshot };
  } catch {
    return { status: 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

export function telegramBriefSignalLines(
  signal: TelegramBriefSignalStatus | null,
  destination: TelegramReportDestination,
): string[] {
  const market = telegramBriefSignalMarket(destination);
  const lines = ['', '[신호 현황]'];
  if (!signal || signal.status !== 'READY') {
    lines.push(signal?.status === 'INVALID'
      ? '📡 신호 엔진 자료가 오래되었거나 확인되지 않아 판단 보류'
      : '📡 신호 엔진 응답 없음 · 판단 보류');
    return lines;
  }
  const snapshot = signal.snapshot;
  const lanes = (snapshot.coverage as Record<string, any>[])
    .filter((lane) => String(lane?.laneId ?? '').startsWith(LANE_PREFIX[market]));
  const candidates = Array.isArray(snapshot.events)
    ? new Set(snapshot.events
      .filter((event: Record<string, any>) => event?.type === 'NEW_CANDIDATE' && event.market === market)
      .map((event: Record<string, any>) => event.id)).size
    : 0;
  if (verifiedTelegramV3PageCount(snapshot) === 0
    || lanes.every((lane) => lane.status === 'BLOCKED_DATA' || lane.status === 'SEARCH_FAILURE')) {
    lines.push('📡 신호 엔진이 이 시장 자료를 확인하는 중 · 판단 보류');
    return lines;
  }
  if (candidates > 0) {
    lines.push(`🟢 현재 진입 후보 ${candidates}개 · 종목별 알림으로 따로 안내`);
  } else {
    const scanned = lanes.reduce((sum, lane) =>
      sum + (Number.isSafeInteger(lane.scannedCards) && lane.scannedCards > 0 ? lane.scannedCards : 0), 0);
    lines.push(renderNoSignalLineV2(market, '현재', scanned));
  }
  lines.push(...aGradeWatchLines(lanes));
  return lines;
}

const A_GRADE_SHOWN = 5;

/**
 * A-grade cards are watch items, not entry signals: they are only listed here
 * by name, without prices or a plan. S-grade candidates keep their own
 * immediate message from the Signal V3 subscriber.
 */
function aGradeWatchLines(lanes: Record<string, any>[]): string[] {
  const seen = new Map<string, string>();
  for (const lane of lanes) {
    if (lane.status === 'BLOCKED_DATA' || lane.status === 'SEARCH_FAILURE') continue;
    for (const item of Array.isArray(lane.aGradeWatch) ? lane.aGradeWatch.slice(0, 10) : []) {
      const symbol = typeof item?.symbol === 'string' ? item.symbol.trim() : '';
      if (!/^[A-Za-z0-9.\-_/]{1,30}$/u.test(symbol) || seen.has(symbol)) continue;
      const name = typeof item?.name === 'string' && item.name.trim() && item.name.trim().length <= 40
        ? item.name.trim() : null;
      seen.set(symbol, name && name !== symbol ? `${name}(${symbol})` : symbol);
    }
  }
  if (!seen.size) return [];
  const shown = [...seen.values()].slice(0, A_GRADE_SHOWN);
  const more = seen.size > shown.length ? ` 외 ${seen.size - shown.length}개` : '';
  return [
    `👀 A등급 관심 ${seen.size}개: ${shown.join(', ')}${more}`,
    '· 진입 신호는 아니에요. S등급이 되면 종목별로 바로 알려드려요.',
  ];
}
