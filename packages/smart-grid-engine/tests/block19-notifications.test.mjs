// block19-notifications.test.mjs
// BLOCK 19 Step 7-Lite — 알림 인터페이스 테스트 (네트워크 0건)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildEventId, buildAIPaperPayload, buildNeutralGridPayload,
  buildBTrailingPayload, buildRiskBlockPayload,
  buildFailClosedPayload, buildDailySummaryPayload,
  buildPayloadsFromCycle, PAYLOAD_BUILDER_VERSION,
} from '../src/notification-payload-builder.mjs';

import {
  QUEUE_VERSION, STATUS, createQueue, enqueueEvent,
  markDelivered, markFailed, getPending,
  saveQueue, loadQueueSafe, drainPending,
} from '../src/notification-queue.mjs';

import {
  MOCK_ADAPTER_VERSION, MOCK_CHANNEL,
  validatePayload, formatMockMessage, simulateSend,
} from '../src/mock-telegram-adapter.mjs';

const NOW = 1_700_000_000_000;
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'b19nq-')); }

// ════════════════════════════════════════════════════
// A. Payload Builder
// ════════════════════════════════════════════════════
test('P1: buildEventId — 결정론적 16자', () => {
  const a = buildEventId('X', 'Y', 1);
  const b = buildEventId('X', 'Y', 1);
  const c = buildEventId('X', 'Y', 2);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test('P2: buildAIPaperPayload — 정상 fill', () => {
  const p = buildAIPaperPayload({
    symbol: 'BTCUSDT',
    strategy: 'LONG_TRAILING_GRID',
    direction: 'LONG',
    regime: 'STRONG_UPTREND',
    paperResult: {
      ok: true,
      orderKey: 'abc123',
      fill: { side: 'LONG', price: 100, quantity: 0.1, fee: 0.006 },
    },
    decidedAtMs: NOW,
  });
  assert.equal(p.eventType, 'AI_PAPER_ENTRY');
  assert.equal(p.source, 'MOCK_DATA');
  assert.equal(p.fills.length, 1);
  assert.equal(p.fees, 0.006);
  assert.equal(p.status, 'FILLED');
  assert.equal(p.builderVersion, PAYLOAD_BUILDER_VERSION);
});

test('P3: buildAIPaperPayload — reject', () => {
  const p = buildAIPaperPayload({
    symbol: 'BTCUSDT',
    strategy: 'LONG_TRAILING_GRID',
    paperResult: { ok: false, reason: 'SAVE_FAILED' },
    decidedAtMs: NOW,
  });
  assert.equal(p.fills.length, 0);
  assert.equal(p.fees, null);
  assert.equal(p.pnl, null);
  assert.equal(p.status, 'REJECTED');
  assert.equal(p.reason, 'SAVE_FAILED');
});

test('P4: buildNeutralGridPayload — BUY', () => {
  const p = buildNeutralGridPayload({
    symbol: 'BTCUSDT',
    fill: { type: 'BUY', levelIdx: 1, price: 94, qty: 10, fee: 0.564, ts: NOW },
    boundaryState: 'IN_RANGE',
    decidedAtMs: NOW,
  });
  assert.equal(p.eventType, 'NEUTRAL_BUY');
  assert.equal(p.direction, 'NEUTRAL');
  assert.equal(p.fills[0].levelIdx, 1);
  assert.equal(p.boundaryState, 'IN_RANGE');
});

test('P5: buildNeutralGridPayload — SELL', () => {
  const p = buildNeutralGridPayload({
    symbol: 'BTCUSDT',
    fill: { type: 'SELL', levelIdx: 1, price: 98, qty: 10, fee: 0.588, pnl: 40, ts: NOW },
    decidedAtMs: NOW,
  });
  assert.equal(p.eventType, 'NEUTRAL_SELL');
  assert.equal(p.pnl, 40);
});

test('P6: buildBTrailingPayload — ok / fail', () => {
  const ok = buildBTrailingPayload({ symbol: 'BTCUSDT', bResult: { ok: true }, decidedAtMs: NOW });
  const fail = buildBTrailingPayload({ symbol: 'BTCUSDT', bResult: { ok: false, reason: 'X' }, decidedAtMs: NOW });
  assert.equal(ok.eventType, 'B_TRAILING_CYCLE');
  assert.equal(ok.status, 'COMPLETED');
  assert.equal(fail.status, 'FAILED');
  assert.equal(fail.reason, 'X');
});

test('P7: buildRiskBlockPayload', () => {
  const p = buildRiskBlockPayload({
    symbol: 'BTCUSDT', strategy: 'LONG_TRAILING_GRID',
    reason: 'LIQUIDATION_SAFETY_TOO_LOW', decidedAtMs: NOW,
  });
  assert.equal(p.eventType, 'RISK_BLOCK');
  assert.equal(p.status, 'BLOCKED');
  assert.equal(p.reason, 'LIQUIDATION_SAFETY_TOO_LOW');
});

test('P8: buildFailClosedPayload', () => {
  const p = buildFailClosedPayload({ symbol: 'BTCUSDT', reason: 'STALE_DATA', decidedAtMs: NOW });
  assert.equal(p.eventType, 'FAIL_CLOSED');
  assert.equal(p.status, 'FAIL_CLOSED');
});

test('P9: buildDailySummaryPayload — counts, no fabrication', () => {
  const p = buildDailySummaryPayload({
    date: '2026-10-30',
    aiState: { usdtBalance: 991.12, positions: { BTCUSDT: {} }, fills: [1], feesPaid: 8.87, realizedPnl: 0 },
    bState: { version: 1 },
    neutralState: { fills: [1, 2], realizedPnl: 40, roundTrips: 1 },
    nowMs: NOW,
  });
  assert.equal(p.eventType, 'DAILY_SUMMARY');
  assert.equal(p.summary.aiPositions, 1);
  assert.equal(p.summary.aiFills, 1);
  assert.equal(p.summary.neutralFills, 2);
  assert.equal(p.summary.neutralRealizedPnl, 40);
  assert.equal(p.summary.bInitialized, true);
});

test('P10: buildPayloadsFromCycle — fail-closed 우선', () => {
  const list = buildPayloadsFromCycle({
    symbol: 'BTCUSDT', nowMs: NOW,
    aiDecision: { failClosed: true, allowNewEntry: false, reasons: ['STALE_DATA'], strategy: 'NEUTRAL_GRID' },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].eventType, 'FAIL_CLOSED');
});

test('P11: buildPayloadsFromCycle — risk block', () => {
  const list = buildPayloadsFromCycle({
    symbol: 'BTCUSDT', nowMs: NOW,
    aiDecision: { failClosed: false, allowNewEntry: false, reasons: ['LIQUIDATION_SAFETY_TOO_LOW'], strategy: 'LONG_TRAILING_GRID' },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].eventType, 'RISK_BLOCK');
  assert.equal(list[0].reason, 'LIQUIDATION_SAFETY_TOO_LOW');
});

test('P12: buildPayloadsFromCycle — AI fill + B 병렬', () => {
  const list = buildPayloadsFromCycle({
    symbol: 'BTCUSDT', nowMs: NOW,
    aiDecision: { allowNewEntry: true, strategy: 'LONG_TRAILING_GRID', direction: 'LONG', regime: 'UP' },
    paperResult: { ok: true, orderKey: 'k1', fill: { side: 'LONG', price: 100, quantity: 0.1, fee: 0.006 } },
    bResult: { ok: true },
  });
  const types = list.map((p) => p.eventType).sort();
  assert.deepEqual(types, ['AI_PAPER_ENTRY', 'B_TRAILING_CYCLE']);
});

test('P13: buildPayloadsFromCycle — NEUTRAL 다중 fill', () => {
  const list = buildPayloadsFromCycle({
    symbol: 'BTCUSDT', nowMs: NOW,
    aiDecision: { allowNewEntry: true, strategy: 'NEUTRAL_GRID', direction: 'NEUTRAL' },
    paperResult: {
      ok: true, kind: 'NEUTRAL_GRID', boundaryState: 'IN_RANGE',
      fills: [
        { type: 'BUY', levelIdx: 1, price: 94, qty: 10, fee: 0.564, ts: NOW + 1 },
        { type: 'SELL', levelIdx: 1, price: 98, qty: 10, fee: 0.588, pnl: 40, ts: NOW + 2 },
      ],
    },
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].eventType, 'NEUTRAL_BUY');
  assert.equal(list[1].eventType, 'NEUTRAL_SELL');
});

test('P14: payload — 존재하지 않는 값은 null', () => {
  const p = buildAIPaperPayload({
    symbol: null, strategy: null, direction: null, regime: null,
    paperResult: null, decidedAtMs: null,
  });
  assert.equal(p.symbol, null);
  assert.equal(p.strategy, null);
  assert.equal(p.direction, null);
  assert.equal(p.regime, null);
  assert.equal(p.fills.length, 0);
  assert.equal(p.pnl, null);
  assert.equal(p.fees, null);
});

// ════════════════════════════════════════════════════
// B. Queue
// ════════════════════════════════════════════════════
function simpleEvent(id) {
  return { eventId: id, eventType: 'TEST', source: 'MOCK_DATA' };
}

test('Q1: createQueue 초기 상태', () => {
  const q = createQueue();
  assert.equal(q.version, QUEUE_VERSION);
  assert.equal(q.events.length, 0);
});

test('Q2: enqueueEvent — 정상, 순서 유지', () => {
  let q = createQueue();
  for (const id of ['e1', 'e2', 'e3']) {
    const r = enqueueEvent(q, simpleEvent(id));
    assert.equal(r.ok, true);
    q = r.queue;
  }
  assert.deepEqual(getPending(q).map((e) => e.eventId), ['e1', 'e2', 'e3']);
});

test('Q3: enqueueEvent — 중복 eventId', () => {
  let q = createQueue();
  q = enqueueEvent(q, simpleEvent('e1')).queue;
  const dup = enqueueEvent(q, simpleEvent('e1'));
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.queue.events.length, 1);
});

test('Q4: markDelivered / markFailed', () => {
  let q = createQueue();
  q = enqueueEvent(q, simpleEvent('e1')).queue;
  q = enqueueEvent(q, simpleEvent('e2')).queue;
  const d = markDelivered(q, 'e1', NOW);
  assert.equal(d.ok, true);
  assert.equal(d.queue.events[0].status, STATUS.DELIVERED_MOCK);
  assert.equal(d.queue.events[0].processedAtMs, NOW);
  const f = markFailed(d.queue, 'e2', 'TEST_ERROR', NOW);
  assert.equal(f.event.status, STATUS.FAILED);
  assert.equal(f.event.error, 'TEST_ERROR');
  assert.equal(getPending(f.queue).length, 0);
});

test('Q5: saveQueue + loadQueueSafe — 재시작 복구', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'q.json');
  let q = createQueue();
  q = enqueueEvent(q, simpleEvent('a')).queue;
  q = enqueueEvent(q, simpleEvent('b')).queue;
  q = markDelivered(q, 'a', NOW).queue;

  const save = saveQueue(sp, q);
  assert.equal(save.saved, true);
  assert.equal(fs.existsSync(sp), true);

  const load = loadQueueSafe(sp);
  assert.equal(load.ok, true);
  assert.equal(load.queue.events.length, 2);
  assert.equal(load.queue.events[0].status, STATUS.DELIVERED_MOCK);
  assert.equal(load.queue.events[1].status, STATUS.PENDING);
});

test('Q6: loadQueueSafe — 파일 없음 (ENOENT)', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'nonexistent.json');
  const load = loadQueueSafe(sp);
  assert.equal(load.ok, true);
  assert.equal(load.initialized, true);
  assert.equal(load.queue.events.length, 0);
});

test('Q7: loadQueueSafe — 손상 파일 → 격리', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'q.json');
  fs.writeFileSync(sp, 'NOT_JSON_AT_ALL', 'utf8');
  const load = loadQueueSafe(sp);
  assert.equal(load.ok, false);
  assert.equal(load.corrupt, true);
  assert.ok(load.quarantinePath);
  assert.equal(fs.existsSync(load.quarantinePath), true);
  assert.equal(fs.existsSync(sp), false);
});

test('Q8: loadQueueSafe — version 불일치 격리', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'q.json');
  fs.writeFileSync(sp, JSON.stringify({ version: 99, events: [] }), 'utf8');
  const load = loadQueueSafe(sp);
  assert.equal(load.ok, false);
  assert.equal(load.corrupt, true);
});

test('Q9: drainPending — 순서 유지, delivered_mock', () => {
  let q = createQueue();
  q = enqueueEvent(q, simpleEvent('x1')).queue;
  q = enqueueEvent(q, simpleEvent('x2')).queue;
  const r = drainPending(q, NOW);
  assert.equal(r.delivered.length, 2);
  assert.deepEqual(r.delivered.map((e) => e.eventId), ['x1', 'x2']);
  assert.equal(r.queue.events[0].status, STATUS.DELIVERED_MOCK);
  assert.equal(getPending(r.queue).length, 0);
});

// ════════════════════════════════════════════════════
// C. Mock Adapter
// ════════════════════════════════════════════════════
test('M1: validatePayload — 유효 payload', () => {
  const p = buildAIPaperPayload({ symbol: 'BTCUSDT', strategy: 'X', decidedAtMs: NOW });
  const v = validatePayload(p);
  assert.equal(v.ok, true);
  assert.equal(v.violations.length, 0);
});

test('M2: validatePayload — 필수 필드 누락', () => {
  const v = validatePayload({ eventId: null, eventType: undefined });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.includes('eventId')));
  assert.ok(v.violations.some((x) => x.includes('eventType')));
});

test('M3: formatMockMessage — 포함 항목', () => {
  const p = buildAIPaperPayload({ symbol: 'BTCUSDT', strategy: 'LONG_TRAILING_GRID', decidedAtMs: NOW });
  const fmt = formatMockMessage(p);
  assert.equal(fmt.ok, true);
  assert.ok(fmt.text.includes('[MOCK TELEGRAM]'));
  assert.ok(fmt.text.includes(p.eventId));
  assert.ok(fmt.text.includes('AI_PAPER_ENTRY'));
  assert.ok(fmt.text.includes('BTCUSDT'));
});

test('M4: simulateSend — realApiCalled:false 강제', () => {
  const p = buildAIPaperPayload({ symbol: 'BTCUSDT', strategy: 'X', decidedAtMs: NOW });
  const r = simulateSend(p);
  assert.equal(r.ok, true);
  assert.equal(r.mock, true);
  assert.equal(r.realApiCalled, false);
  assert.equal(r.channel, MOCK_CHANNEL);
});

test('M5: simulateSend — 무효 payload', () => {
  const r = simulateSend({ eventId: '', eventType: null });
  assert.equal(r.ok, false);
  assert.equal(r.realApiCalled, false);
  assert.ok(r.violations.length >= 2);
});

test('M6: MOCK_ADAPTER_VERSION 상수', () => {
  assert.equal(typeof MOCK_ADAPTER_VERSION, 'string');
});

// ════════════════════════════════════════════════════
// D. Safety — 네트워크/Bot Token/stock-app 0건
// ════════════════════════════════════════════════════
test('S1: 3개 모듈 정적 — fetch/axios/http/https/telegram API 없음', () => {
  const files = [
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/notification-payload-builder.mjs',
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/notification-queue.mjs',
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/mock-telegram-adapter.mjs',
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(/\bfetch\s*\(/.test(src), false, `${f}: fetch 금지`);
    assert.equal(/import.*axios/.test(src), false, `${f}: axios 금지`);
    assert.equal(/node:http|node:https/.test(src), false, `${f}: http/https import 금지`);
    assert.equal(/api\.telegram\.org/.test(src), false, `${f}: Telegram Bot API URL 금지`);
    assert.equal(/BOT_TOKEN|TELEGRAM_BOT/i.test(src), false, `${f}: Bot Token 금지`);
    assert.equal(/from ['"]\.\/bitget-adapter/.test(src), false, `${f}: bitget-adapter import 금지`);
    assert.equal(/placeOrder|submitOrder|createOrder/.test(src), false, `${f}: 실주문 함수 금지`);
    assert.equal(/from ['"]\.\.\/features\/account-readonly/.test(src), false, `${f}: account-readonly 금지`);
    assert.equal(src.includes('/opt/stock-app'), false, `${f}: stock-app 경로 금지`);
    assert.equal(src.includes('paper-abc'), false, `${f}: paper-abc 금지`);
  }
});

test('S2: .env 참조 없음', () => {
  const files = [
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/notification-payload-builder.mjs',
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/notification-queue.mjs',
    '/opt/smart-grid-dev/packages/smart-grid-engine/src/mock-telegram-adapter.mjs',
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(/dotenv|process\.env/.test(src), false, `${f}: .env 접근 금지`);
  }
});

test('S3: payload에 LIVE 게이트 우회 필드 없음', () => {
  const p = buildAIPaperPayload({ symbol: 'X', strategy: 'Y', decidedAtMs: NOW });
  assert.equal('allowed' in p, false);
  assert.equal('wouldExecute' in p, false);
  assert.equal('realApiCalled' in p, false);
  // 이 필드들은 orchestrator gate에만 있어야 함
});
