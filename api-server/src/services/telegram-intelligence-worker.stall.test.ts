import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryTelegramIntelligenceStateStore,
  TelegramIntelligenceWorker,
  telegramBriefTickStalled,
  type TelegramBriefStage,
} from './telegram-intelligence-worker.service';

test('stalled tick detection allows ten minutes and never treats future/private text as time', () => {
  const timestamp = '2026-10-14T06:50:00.000Z';
  const started = Date.parse(timestamp);
  assert.equal(telegramBriefTickStalled(timestamp, started + 600_000), false);
  assert.equal(telegramBriefTickStalled(timestamp, started + 600_001), true);
  assert.equal(telegramBriefTickStalled(timestamp, started - 1), false);
  for (const bad of [null, '', 'PRIVATE_BOT_TOKEN', '2026-10-14Tbad', 'garbage']) {
    assert.equal(telegramBriefTickStalled(bad, started + 3_000_000), false);
  }
  assert.equal(telegramBriefTickStalled(timestamp, NaN), false);
  assert.equal(telegramBriefTickStalled(timestamp, Infinity), false);
});

test('a hung Telegram Bot POST retains durable reservation and cannot re-enter', async () => {
  const original = process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED;
  process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED = 'false';
  // Wednesday, October 14 15:50 KST. Exactly one KR_CLOSING plan.
  const date = new Date('2026-10-14T06:50:00.000Z');
  const stages: TelegramBriefStage[] = [];
  let complete: (v: any) => void = () => {};
  let sendAttempts = 0;
  const blocked = new Promise<any>(resolve => { complete = resolve; });
  const ledger = new MemoryTelegramIntelligenceStateStore();
  const worker = new TelegramIntelligenceWorker(
    ledger,
    async () => {
      sendAttempts += 1;
      return await blocked;
    },
    () => '-1001234567890123',
    async () => { throw new Error('TEST_MUST_NOT_FETCH_REAL_BRIEF'); },
    stage => { stages.push(stage); },
  );
  try {
    const first = worker.runOnce(date);
    for (let i = 0; i < 60 && !stages.includes('BOT_POST'); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    assert.equal(stages.includes('BOT_POST'), true, stages.join(','));
    assert.equal(stages.includes('RESERVE_UNCONFIRMED'), true);
    assert.equal(ledger.unconfirmed.size, 1, 'reservation must exist before Bot POST');
    assert.equal(sendAttempts, 1);

    const concurrent = await worker.runOnce(date);
    assert.equal(concurrent.attempted, 0);
    assert.equal(concurrent.delivered, 0);
    assert.equal(sendAttempts, 1, 'one unknown POST is never retried');

    complete({ok: true, attempts: 1, receipt: {}});
    const firstResult = await first;
    assert.equal(firstResult.attempted, 1);
    assert.equal(firstResult.delivered, 1);
    assert.equal(ledger.unconfirmed.size, 0);
    assert.equal(ledger.delivered.size, 1);
    assert.equal(stages.includes('DURABLE_RECEIPT_WRITE'), true);
    assert.equal(stages.at(-1), 'IDLE');

    const later = await worker.runOnce(date);
    assert.equal(later.attempted, 0);
    assert.equal(sendAttempts, 1, 'existing delivered key suppresses replay');
    assert.equal(stages.join('|').includes('-1001234567890123'), false);
  } finally {
    complete({ok: true, attempts: 1, receipt: {}});
    if (original === undefined) delete process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED;
    else process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED = original;
  }
});
