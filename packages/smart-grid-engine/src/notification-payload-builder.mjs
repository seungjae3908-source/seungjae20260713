// notification-payload-builder.mjs
// BLOCK 19 Step 7-Lite — 알림 Payload 생성기 (순수 함수, 네트워크 0건)
//
// 안전 원칙:
//   - 네트워크/파일/Bot Token 접근 없음
//   - orchestrator 반환값을 입력받아 payload 객체만 생성
//   - 존재하지 않는 값은 null (임의 생성 금지)
//   - 실주문 관련 함수 호출 없음
//
// 지원 이벤트:
//   AI_PAPER_ENTRY, NEUTRAL_BUY, NEUTRAL_SELL, B_TRAILING_CYCLE,
//   RISK_BLOCK, FAIL_CLOSED, DAILY_SUMMARY

import { createHash } from 'node:crypto';

const SOURCE_LABEL = 'MOCK_DATA';
const BUILDER_VERSION = '1.0.0';

export function buildEventId(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function baseEnvelope(eventType, eventId, extras = {}) {
  return {
    eventId,
    eventType,
    source: SOURCE_LABEL,
    symbol: null,
    strategy: null,
    direction: null,
    regime: null,
    fills: [],
    pnl: null,
    fees: null,
    status: 'UNKNOWN',
    reason: null,
    boundaryState: null,
    allowNewEntry: null,
    decidedAtMs: null,
    ...extras,
    builderVersion: BUILDER_VERSION,
  };
}

export function buildAIPaperPayload({
  symbol, strategy, direction, regime, paperResult, decidedAtMs,
} = {}) {
  const p = paperResult;
  const orderKey = p?.orderKey ?? null;
  const eventId = buildEventId('AI_PAPER', orderKey ?? '', decidedAtMs ?? 0, strategy ?? '');

  const fills = [];
  let totalFees = 0;
  if (p?.ok === true && p.fill) {
    fills.push({
      type: p.fill.side ?? null,
      price: p.fill.price ?? null,
      qty: p.fill.quantity ?? null,
      fee: p.fill.fee ?? null,
      pnl: null,
    });
    totalFees = p.fill.fee ?? 0;
  }

  const status = p?.ok === true ? 'FILLED'
    : p?.ok === false ? 'REJECTED'
    : 'NONE';

  return baseEnvelope('AI_PAPER_ENTRY', eventId, {
    symbol: symbol ?? null,
    strategy: strategy ?? null,
    direction: direction ?? null,
    regime: regime ?? null,
    fills,
    fees: fills.length > 0 ? totalFees : null,
    status,
    reason: p?.reason ?? null,
    decidedAtMs: decidedAtMs ?? null,
  });
}

export function buildNeutralGridPayload({
  symbol, strategy, fill, boundaryState, decidedAtMs,
} = {}) {
  if (!fill || typeof fill !== 'object') {
    return baseEnvelope('NEUTRAL_UNKNOWN', buildEventId('NEUTRAL_NULL', decidedAtMs ?? 0), {
      symbol: symbol ?? null,
      strategy: strategy ?? 'NEUTRAL_GRID',
      boundaryState: boundaryState ?? null,
      status: 'MISSING_FILL',
      decidedAtMs: decidedAtMs ?? null,
    });
  }
  const eventId = buildEventId(
    'NEUTRAL', fill.type ?? '', fill.levelIdx ?? '',
    fill.price ?? '', fill.ts ?? decidedAtMs ?? 0,
  );
  const eventType = fill.type === 'BUY' ? 'NEUTRAL_BUY'
    : fill.type === 'SELL' ? 'NEUTRAL_SELL'
    : 'NEUTRAL_UNKNOWN';

  return baseEnvelope(eventType, eventId, {
    symbol: symbol ?? null,
    strategy: strategy ?? 'NEUTRAL_GRID',
    direction: 'NEUTRAL',
    fills: [{
      type: fill.type ?? null,
      levelIdx: fill.levelIdx ?? null,
      price: fill.price ?? null,
      qty: fill.qty ?? null,
      fee: fill.fee ?? null,
      pnl: fill.pnl ?? null,
    }],
    pnl: fill.pnl ?? null,
    fees: fill.fee ?? null,
    status: 'FILLED',
    boundaryState: boundaryState ?? null,
    decidedAtMs: decidedAtMs ?? fill.ts ?? null,
  });
}

export function buildBTrailingPayload({ symbol, bResult, decidedAtMs } = {}) {
  const eventId = buildEventId('B_TRAILING', symbol ?? '', decidedAtMs ?? 0);
  return baseEnvelope('B_TRAILING_CYCLE', eventId, {
    symbol: symbol ?? null,
    strategy: 'B_TRAILING',
    status: bResult?.ok === true ? 'COMPLETED'
      : bResult?.ok === false ? 'FAILED'
      : 'UNKNOWN',
    reason: bResult?.reason ?? null,
    decidedAtMs: decidedAtMs ?? null,
  });
}

export function buildRiskBlockPayload({ symbol, strategy, reason, decidedAtMs } = {}) {
  const eventId = buildEventId('RISK_BLOCK', symbol ?? '', decidedAtMs ?? 0, strategy ?? '');
  return baseEnvelope('RISK_BLOCK', eventId, {
    symbol: symbol ?? null,
    strategy: strategy ?? null,
    reason: reason ?? 'PRECONDITIONS_NOT_MET',
    status: 'BLOCKED',
    decidedAtMs: decidedAtMs ?? null,
  });
}

export function buildFailClosedPayload({ symbol, reason, decidedAtMs } = {}) {
  const eventId = buildEventId('FAIL_CLOSED', symbol ?? '', decidedAtMs ?? 0, reason ?? '');
  return baseEnvelope('FAIL_CLOSED', eventId, {
    symbol: symbol ?? null,
    reason: reason ?? 'FAIL_CLOSED',
    status: 'FAIL_CLOSED',
    decidedAtMs: decidedAtMs ?? null,
  });
}

export function buildDailySummaryPayload({ date, aiState, bState, neutralState, nowMs } = {}) {
  const eventId = buildEventId('DAILY_SUMMARY', date ?? '', nowMs ?? 0);
  const aiPositions = Object.keys(aiState?.positions || {}).length;
  const aiFills = (aiState?.fills || []).length;
  const neutralFills = (neutralState?.fills || []).length;

  return baseEnvelope('DAILY_SUMMARY', eventId, {
    summary: {
      aiUsdtBalance: aiState?.usdtBalance ?? null,
      aiPositions,
      aiFills,
      aiFees: aiState?.feesPaid ?? null,
      aiRealizedPnl: aiState?.realizedPnl ?? null,
      neutralFills,
      neutralRealizedPnl: neutralState?.realizedPnl ?? null,
      neutralRoundTrips: neutralState?.roundTrips ?? null,
      bInitialized: Boolean(bState),
    },
    status: 'SUMMARY',
    decidedAtMs: nowMs ?? null,
  });
}

export function buildPayloadsFromCycle(result) {
  const payloads = [];
  const ai = result?.aiDecision;

  // 1) fail-closed / risk block 우선
  if (ai?.failClosed) {
    payloads.push(buildFailClosedPayload({
      symbol: result.symbol,
      reason: (Array.isArray(ai.reasons) && ai.reasons[0]) || 'FAIL_CLOSED',
      decidedAtMs: result.nowMs,
    }));
  } else if (ai && ai.allowNewEntry === false) {
    payloads.push(buildRiskBlockPayload({
      symbol: result.symbol,
      strategy: ai.strategy,
      reason: (result.paperResult?.reason)
        || (Array.isArray(ai.reasons) && ai.reasons[0])
        || 'NO_ENTRY',
      decidedAtMs: result.nowMs,
    }));
  }

  // 2) Paper fills
  const p = result?.paperResult;
  if (p?.ok === true) {
    if (p.kind === 'NEUTRAL_GRID' && Array.isArray(p.fills)) {
      for (const f of p.fills) {
        payloads.push(buildNeutralGridPayload({
          symbol: result.symbol,
          fill: f,
          boundaryState: p.boundaryState,
          decidedAtMs: result.nowMs,
        }));
      }
    } else if (p.fill) {
      payloads.push(buildAIPaperPayload({
        symbol: result.symbol,
        strategy: ai?.strategy,
        direction: ai?.direction,
        regime: ai?.regime,
        paperResult: p,
        decidedAtMs: result.nowMs,
      }));
    }
  }

  // 3) B Trailing cycle
  if (result?.bResult) {
    payloads.push(bBuildBTrailingSafe(result));
  }

  return payloads;
}

function bBuildBTrailingSafe(result) {
  return buildBTrailingPayload({
    symbol: result.symbol,
    bResult: result.bResult,
    decidedAtMs: result.nowMs,
  });
}

export const PAYLOAD_BUILDER_VERSION = BUILDER_VERSION;
