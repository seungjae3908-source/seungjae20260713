const STOCK_MARKETS = new Set(['KR_STOCK', 'US_STOCK']);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function format(value, digits = 2) {
  const parsed = finite(value);
  return parsed == null ? 'N/A' : parsed.toFixed(digits);
}

function alertTypeFor(event) {
  if (event.type !== 'NEW_CANDIDATE') return 'intelligence_report';
  if (STOCK_MARKETS.has(event.market)) return event.direction === 'BUY' ? 'strong_buy' : null;
  if (event.market === 'CRYPTO_SPOT') return event.direction === 'BUY' ? 'crypto_spot_buy' : null;
  if (event.market === 'CRYPTO_FUTURES') {
    if (event.direction === 'LONG') return 'crypto_futures_long';
    if (event.direction === 'SHORT') return 'crypto_futures_short';
  }
  return null;
}

export function telegramRoomForSignalEvent(event) {
  return STOCK_MARKETS.has(event.market) ? 'STOCK_ROOM' : 'CRYPTO_ROOM';
}

function leverageText(leverage) {
  if (!leverage || leverage.status !== 'INDICATIVE_ONLY') return null;
  const range = leverage.recommendedRange;
  if (!range) return null;
  return `적정 레버리지 ${format(range.min, 1)}x~${format(range.max, 1)}x · Hard max ${format(leverage.hardMaximum, 1)}x · INDICATIVE_ONLY`;
}

function detailsFor(event) {
  if (event.type === 'NEW_CANDIDATE') {
    const parts = [
      `${event.strategy}/${event.timeframe}`,
      `방향 ${event.direction}`,
      `Net utility ${format(event.utilityR)}R`,
    ];
    const leverage = leverageText(event.leverage);
    if (leverage) parts.push(leverage);
    parts.push('실주문 권한 없음');
    return parts.join(' · ');
  }

  if (event.type === 'STATE_CHANGED') {
    const reasons = Array.isArray(event.reasons) && event.reasons.length ? ` · 원인 ${event.reasons.join(', ')}` : '';
    return `${event.strategy}/${event.timeframe} · ${event.previousState} → ${event.state}${reasons} · 신규 진입 재평가`;
  }

  if (event.type === 'RESCAN_REQUESTED') {
    return `${event.strategy}/${event.timeframe} · AI/시장 변화 감지 · 즉시 Quant 재평가 요청 · 현재 ${event.state}`;
  }

  return 'Signal Intelligence V3 event';
}

export function toCanonicalTelegramAlert(event, resolveRoomChatId) {
  const type = alertTypeFor(event);
  if (!type) return null;
  const room = telegramRoomForSignalEvent(event);
  const destinationChatId = typeof resolveRoomChatId === 'function' ? resolveRoomChatId(room) : null;
  if (!destinationChatId) return null;

  return Object.freeze({
    type,
    symbol: event.symbol,
    market: event.market,
    details: detailsFor(event),
    dedupeKey: `signal-intelligence-v3:${event.type}:${event.id}:${event.state ?? ''}:${event.previousState ?? ''}`,
    destinationChatId,
  });
}

export async function deliverSignalIntelligenceEvents(events, { sender, resolveRoomChatId }) {
  if (typeof sender !== 'function') throw new TypeError('sender is required');
  const results = [];
  for (const event of Array.isArray(events) ? events : []) {
    const alert = toCanonicalTelegramAlert(event, resolveRoomChatId);
    if (!alert) continue;
    try {
      results.push(await sender(alert));
    } catch (error) {
      // Telegram delivery must never grant or mutate trading authority.
      results.push({ ok: false, skipped: 'DELIVERY_FAILED', errorName: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
  return Object.freeze(results);
}
