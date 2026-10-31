// mock-telegram-adapter.mjs
// BLOCK 19 Step 7-Lite — Mock Telegram 어댑터 (실전송 0건)
//
// 안전 원칙:
//   - 네트워크 호출 절대 금지 (fetch/axios/http/https import 없음)
//   - Telegram Bot API URL 문자열 자체 없음
//   - Bot Token / .env 접근 없음
//   - 모든 반환값에 realApiCalled:false, mock:true 강제

export const MOCK_ADAPTER_VERSION = '1.0.0';
const MOCK_CHANNEL = 'MOCK_TELEGRAM';
const REQUIRED_FIELDS = ['eventId', 'eventType', 'source'];

export function validatePayload(payload) {
  const violations = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, violations: ['PAYLOAD_NOT_OBJECT'] };
  }
  for (const f of REQUIRED_FIELDS) {
    if (payload[f] == null || payload[f] === '') violations.push(`MISSING:${f}`);
  }
  if (payload.eventId != null && typeof payload.eventId !== 'string') violations.push('INVALID:eventId');
  if (payload.eventType != null && typeof payload.eventType !== 'string') violations.push('INVALID:eventType');
  if (payload.source != null && payload.source !== 'MOCK_DATA' && payload.source !== 'LIVE') {
    violations.push('INVALID:source');
  }
  return { ok: violations.length === 0, violations };
}

export function formatMockMessage(payload) {
  const v = validatePayload(payload);
  if (!v.ok) return { ok: false, violations: v.violations, text: null };
  const lines = [
    '[MOCK TELEGRAM]',
    `channel: ${MOCK_CHANNEL}`,
    `eventType: ${payload.eventType}`,
    `eventId: ${payload.eventId}`,
    `source: ${payload.source}`,
    `symbol: ${payload.symbol ?? 'null'}`,
    `strategy: ${payload.strategy ?? 'null'}`,
    `direction: ${payload.direction ?? 'null'}`,
    `regime: ${payload.regime ?? 'null'}`,
    `status: ${payload.status ?? 'null'}`,
    `fills: ${payload.fills?.length ?? 0}`,
    `pnl: ${payload.pnl ?? 'null'}`,
    `fees: ${payload.fees ?? 'null'}`,
    `reason: ${payload.reason ?? 'null'}`,
    `decidedAtMs: ${payload.decidedAtMs ?? 'null'}`,
  ];
  return { ok: true, text: lines.join('\n'), violations: [] };
}

export function simulateSend(payload) {
  const v = validatePayload(payload);
  if (!v.ok) {
    return {
      ok: false, mock: true, realApiCalled: false,
      violations: v.violations, text: null, channel: MOCK_CHANNEL,
    };
  }
  const fmt = formatMockMessage(payload);
  return {
    ok: true, mock: true, realApiCalled: false,
    text: fmt.text, deliveredAtMs: Date.now(), channel: MOCK_CHANNEL,
  };
}

export { MOCK_CHANNEL };
