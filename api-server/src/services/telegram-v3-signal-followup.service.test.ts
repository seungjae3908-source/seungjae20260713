import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TelegramV3FollowupStore,
  recordTelegramV3SignalAnnounced,
  runTelegramV3SignalFollowupOnce,
  telegramV3FollowupSteps,
  type TelegramV3SignalAnnouncement,
} from './telegram-v3-signal-followup.service';

const NOW = Date.parse('2026-10-18T01:00:00.000Z');
const HOUR = 60 * 60_000;

function announcement(over: Partial<TelegramV3SignalAnnouncement> = {}): TelegramV3SignalAnnouncement {
  return {
    key: 'signal-intelligence-v3:episode:aapl',
    market: 'US_STOCK', symbol: 'AAPL', name: 'Apple', direction: 'BUY', timeframe: '60m',
    entryZone: { from: 229, to: 231 }, stopLoss: 224, targets: [238, 245],
    chatId: '-10083004999999',
    receipt: { messageId: 77, messageKind: 'TEXT', renderedText: '<b>🟢 [해외주식] Apple (AAPL) · 매수 신호</b>\n본문' },
    buttons: [[{ text: '🛒 구매', url: 'https://lsj119.com/telegram-order?symbol=AAPL' },
      { text: '📊 차트', url: 'https://lsj119.com/ai-chart?symbol=AAPL' }]],
    announcedAt: new Date(NOW),
    ...over,
  };
}

async function harness(prices: Array<number | null>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'telegram-v3-followup-'));
  const store = new TelegramV3FollowupStore(path.join(dir, 'state.json'));
  const sent: any[] = [];
  const edits: any[] = [];
  let tick = 0;
  const deps = {
    store,
    readMark: async () => {
      const price = prices[Math.min(tick, prices.length - 1)];
      if (price == null) throw new Error('BACKGROUND_EXIT_MARK_STALE');
      return { market: 'US_STOCK' as const, symbol: 'AAPL', price, observedAt: new Date(NOW).toISOString(), source: 'test' };
    },
    send: async (input: any) => { sent.push(input); return { ok: true as const, attempts: 1 }; },
    edit: async (input: any) => { edits.push(input); return { ok: true as const, attempts: 1 }; },
  };
  const run = async (at: number) => { const result = await runTelegramV3SignalFollowupOnce(new Date(at), deps); tick += 1; return result; };
  return { dir, store, sent, edits, run };
}

test('targets are announced once each; the last target closes the signal and removes only [구매]', async () => {
  const h = await harness([230, 239, 239.5, 246]);
  assert.equal(await recordTelegramV3SignalAnnounced(announcement(), h.store), true);
  await h.run(NOW + 60_000);
  assert.equal(h.sent.length, 0);
  await h.run(NOW + 2 * 60_000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].title, '🎯 [해외주식] Apple (AAPL) · 1차 목표 도달');
  assert.match(h.sent[0].details, /목표 238\.00\n현재가 239\.00 \(진입 기준 \+3\.9%\)\n계획: 1차 매도 구간이에요/u);
  assert.equal(h.sent[0].destinationChatId, '-10083004999999');
  await h.run(NOW + 3 * 60_000);
  assert.equal(h.sent.length, 1, 'the same target is never announced twice');
  const result = await h.run(NOW + 4 * 60_000);
  assert.equal(result.closed, 1);
  assert.equal(h.sent[1].title, '🏁 [해외주식] Apple (AAPL) · 신호 종료');
  assert.match(h.sent[1].details, /사유: 마지막 목표 도달/u);
  assert.equal(h.edits.length, 1);
  assert.equal(h.edits[0].messageId, 77);
  assert.deepEqual(h.edits[0].buttons, [[{ text: '📊 차트', url: 'https://lsj119.com/ai-chart?symbol=AAPL' }]]);
  assert.match(h.edits[0].text, /^<b>🏁 종료: 마지막 목표 도달 · /u);
  assert.match(h.edits[0].text, /매수 신호<\/b>\n본문$/u);
  await h.run(NOW + 5 * 60_000);
  assert.equal(h.sent.length, 2, 'a closed signal stays closed');
});

test('stop after entry closes as 손절; stop before entry closes as invalidated', async () => {
  const stopped = await harness([230, 223]);
  await recordTelegramV3SignalAnnounced(announcement(), stopped.store);
  await stopped.run(NOW + 60_000);
  await stopped.run(NOW + 2 * 60_000);
  assert.match(stopped.sent[0].details, /사유: 손절가 도달/u);
  assert.equal(stopped.edits.length, 1);

  const before = await harness([223]);
  await recordTelegramV3SignalAnnounced(announcement({ entryZone: { from: 225, to: 226 } }), before.store);
  await before.run(NOW + 60_000);
  assert.match(before.sent[0].details, /사유: 진입가에 오기 전에 손절가를 넘음/u);
});

test('an unentered signal expires after its entry window; an entered one only loses [구매]', async () => {
  const idle = await harness([235]);
  await recordTelegramV3SignalAnnounced(announcement(), idle.store);
  await idle.run(NOW + HOUR);
  assert.equal(idle.sent.length, 0);
  await idle.run(NOW + 3 * HOUR + 60_000);
  assert.match(idle.sent[0].details, /사유: 진입 시간 지남/u);
  assert.equal(idle.edits.length, 1);

  const open = await harness([230, 233, null]);
  await recordTelegramV3SignalAnnounced(announcement(), open.store);
  await open.run(NOW + 60_000);
  await open.run(NOW + 3 * HOUR + 60_000);
  assert.equal(open.sent.length, 0, 'no chat message for the entry window ending');
  assert.equal(open.edits.length, 1);
  assert.match(open.edits[0].text, /진입 시간 끝남 · 새 주문 금지/u);
  // Without a fresh mark only time rules apply; holding period is 30 bars.
  await open.run(NOW + 31 * HOUR);
  assert.match(open.sent[0].details, /사유: 보유 기간 끝남/u);
  assert.equal(open.edits.length, 1, '[구매] was already removed');
});

test('SHORT plans read targets downward', () => {
  const entry = {
    key: 'k', market: 'CRYPTO_FUTURES' as const, symbol: 'BTCUSDT', name: null, direction: 'SHORT' as const,
    timeframe: '60m', entryLow: 100, entryHigh: 101, stopLoss: 104, targets: [97, 94],
    chatId: '-1', messageId: 1, messageKind: 'TEXT' as const, baseText: '', chartButton: null,
    announcedAt: new Date(NOW).toISOString(), entryUntil: new Date(NOW + 3 * HOUR).toISOString(),
    holdUntil: new Date(NOW + 30 * HOUR).toISOString(), entered: true, reachedTargets: [],
    buyButtonRemoved: false, closed: null,
  };
  assert.deepEqual(telegramV3FollowupSteps(entry, 96.5, NOW).steps, [{ kind: 'TARGET', index: 0 }]);
  assert.deepEqual(telegramV3FollowupSteps(entry, 104.5, NOW).steps, [{ kind: 'CLOSE', reason: 'STOP' }]);
});

test('a message without an id is not tracked, and a corrupt ledger pauses follow-ups', async () => {
  const h = await harness([239]);
  const untracked = announcement({ receipt: { messageId: null, messageKind: 'TEXT', renderedText: 'x' } });
  assert.equal(await recordTelegramV3SignalAnnounced(untracked, h.store), false);
  assert.equal((await h.store.list()).length, 0);

  const file = path.join(h.dir, 'corrupt.json');
  await writeFile(file, '{"version":1,"entries":[{"key":1}]}');
  const corrupt = new TelegramV3FollowupStore(file);
  await assert.rejects(corrupt.list(), /TELEGRAM_V3_FOLLOWUP_STATE_UNAVAILABLE/u);
  await assert.rejects(recordTelegramV3SignalAnnounced(announcement(), corrupt), /TELEGRAM_V3_FOLLOWUP_STATE_UNAVAILABLE/u);
});
